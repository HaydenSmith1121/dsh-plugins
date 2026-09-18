/**
 * dsh-plugins-market —— 服务器半：安装任务（作业）管理
 *
 * ★ 这是「长时间装不上」这个问题的正面解法。
 *
 * 早先的形态是：点安装 → 一个 HTTP 请求里同步跑完整个安装 → 请求返回才更新界面。
 * 那条路径有三个致命处：
 *
 *   1. **事件循环被堵死**（spawnSync）。安装期间这个 dsh 进程无法处理任何请求，
 *      连「取消安装」的请求都进不来 —— 没有任何技术手段能中断它。
 *   2. **没有中间状态**。用户能看到的只有「正在安装」五个字，不知道在哪一步、
 *      还要多久、是不是已经卡死了。
 *   3. **没有出口**。只能等，等到超时（15 分钟）或者关掉页面。
 *
 * 现在把安装变成一个**后台任务**：
 *
 *   install         → 立刻返回 jobId（HTTP 请求 100ms 内结束）
 *   installProgress → 前端每 600ms 轮询一次，拿到阶段、耗时、预计剩余、实时输出
 *   installAbort    → 真正可以中断：AbortSignal 一路传到 pnpm 子进程并杀整棵树
 *
 * 而且用户随时可以**离开**安装页：任务在服务端继续跑，回来还能看到进度。
 *
 * 为什么不用 SSE / WebSocket：本插件的传输层刻意只有一条 POST 路由（零依赖、
 * 可追踪）。轮询在这个量级（一次安装几十次请求）完全够，而且天然支持
 * 「关掉页面再回来」—— SSE 断线还要处理重连。
 */

import {
  PHASES, PHASE_BY_ID, DEFAULT_TOTAL_TIMEOUT_MS,
  progressSnapshot, phasesWithTimings, readTimings, recordTimings,
  pushTail, isTerminal,
} from './progress.js';

/** 已完成任务的保留数量（内存里，供「回到页面还能看到上次结果」） */
const KEEP_DONE = 8;

/** 同一时刻只允许一个写 profile 的任务 —— 两个 pnpm 同时改一个 profile 必然互相破坏 */
let running = null;
let queueTail = Promise.resolve();
/** 链尾是否已经落定（首尾判据，比看 running 更早、更准） */
let tailSettled = true;
const finished = [];
const byId = new Map();
let seq = 0;

export function newJobId() {
  seq += 1;
  return `job-${Date.now().toString(36)}-${seq}`;
}

/**
 * 创建一个任务，并把它排进队列（同时只有一个真正在跑）。
 *
 * @param {(job)=>Promise<any>} runner 执行体；返回值写进 job.result
 */
export function startJob({ kind, pluginId, pkgName, profile, entry, manual, auto = null, reinstall = false, runner, totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS }) {
  // ★ 排队判据必须是「前一个任务还没结束」，而不是「running 变量非空」——
  //   上一个任务结束时 begin() 是异步收尾的，那一瞬间 running 还是 null，
  //   用它判断会让第二个任务直接开跑，两个 pnpm 同时改一个 profile。
  const previous = queueTail;
  const busyAhead = !tailSettled;

  const job = {
    id: newJobId(),
    kind,
    pluginId,
    pkgName,
    profile,
    entry,
    manual,
    auto,
    reinstall,
    state: busyAhead ? 'queued' : 'running',
    queuePosition: busyAhead ? 1 : 0,
    queuedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    currentPhase: null,
    currentPhaseAt: null,
    phaseState: {},
    lastOutputAt: Date.now(),
    tailLines: [],
    steps: [],
    step: null,
    result: null,
    error: null,
    abortRequestedAt: null,
    abortReason: null,
    totalTimedOut: false,
    controller: new AbortController(),
    totalTimeoutMs,
    totalTimer: null,
    done: null,

    // ── 给 installer 用的进度接口 ──
    get signal() { return job.controller.signal; },
    phase(id) {
      if (job.currentPhase && job.currentPhase !== id && job.phaseState[job.currentPhase] === 'running') {
        job.phaseState[job.currentPhase] = 'ok';
      }
      job.currentPhase = id;
      job.currentPhaseAt = Date.now();
      if (PHASE_BY_ID.has(id) && job.phaseState[id] !== 'ok') job.phaseState[id] = 'running';
    },
    noteOutput(chunk) {
      pushTail(job, chunk);
      job.lastOutputAt = Date.now();
    },
  };

  byId.set(job.id, job);

  const begin = async () => {
    // 排队期间就被中止了 —— 不用真的跑
    if (job.controller.signal.aborted) {
      return finalize(job, 'cancelled');
    }
    running = job;
    job.state = 'running';
    job.queuePosition = 0;
    job.startedAt = Date.now();
    job.lastOutputAt = Date.now();

    // ★ 总超时从**真正开始跑**那一刻算起，排队时间不计入
    job.totalTimer = setTimeout(() => {
      if (!isTerminal(job)) {
        job.totalTimedOut = true;
        job.abortRequestedAt = job.abortRequestedAt ?? Date.now();
        job.abortReason = job.abortReason ?? 'total-timeout';
        try { job.controller.abort(); } catch { /* 忽略 */ }
      }
    }, totalTimeoutMs);
    job.totalTimer.unref?.();

    try {
      job.result = await runner(job);
      if (job.result?.ok) finalize(job, 'succeeded');
      else if (job.result?.aborted || job.controller.signal.aborted) finalize(job, 'cancelled');
      else if (job.result?.timedOut || job.result?.failure === 'timeout' || job.result?.failure === 'total-timeout') finalize(job, 'timeout');
      else finalize(job, 'failed');
    } catch (err) {
      job.error = String(err?.message ?? err);
      finalize(job, 'failed');
    }
  };

  job.done = previous.then(begin, begin);
  tailSettled = false;
  queueTail = job.done.then(
    () => { tailSettled = true; },
    () => { tailSettled = true; },
  );

  return job;
}

function finalize(job, state) {
  if (isTerminal(job)) return;
  job.state = state;
  job.endedAt = Date.now();
  if (job.totalTimer) clearTimeout(job.totalTimer);
  if (job.currentPhase && job.phaseState[job.currentPhase] === 'running') {
    job.phaseState[job.currentPhase] = state === 'succeeded' ? 'ok' : state === 'failed' ? 'fail' : 'warn';
  }
  if (job.result?.timings) recordTimings(job.result.timings);
  if (running === job) running = null;
  finished.unshift(job);
  if (finished.length > KEEP_DONE) {
    for (const dropped of finished.splice(KEEP_DONE)) byId.delete(dropped.id);
  }
}

/** 正在跑的任务（没有则 null） */
export function currentJob() {
  return running && !isTerminal(running) ? running : null;
}

export function findJob(id) {
  return byId.get(String(id ?? '')) ?? null;
}

export function latestJob() {
  return currentJob() ?? finished[0] ?? null;
}

/**
 * 请求中止。
 *
 * ★ 刻意**不**在这里把状态改成终态：中止是「请求」，真正的结束点在
 *   子进程死掉、回滚跑完之后。否则界面会在 profile 还是半截状态时就报「已中止」。
 */
export function requestAbort(job, reason = 'user') {
  if (!job || isTerminal(job)) return { ok: false, error: '这个任务已经结束了，无需中止。' };
  job.abortRequestedAt = job.abortRequestedAt ?? Date.now();
  job.abortReason = reason;
  try { job.controller.abort(); } catch { /* 忽略 */ }
  return { ok: true, at: job.abortRequestedAt, reason };
}

/** 轮询用：把任务拍成前端能直接渲染的快照 */
export function jobSnapshot(job) {
  if (!job) return null;
  const timings = readTimings();
  const snap = progressSnapshot(job, { timings });
  snap.phases = phasesWithTimings(timings).map((p) => ({ id: p.id, label: p.label, est: p.est }));
  snap.kind = job.kind;
  snap.totalTimeoutMs = job.totalTimeoutMs;
  snap.abortReason = job.abortReason ?? null;
  snap.totalTimedOut = Boolean(job.totalTimedOut);
  snap.startedAt = job.startedAt ?? job.queuedAt;
  return snap;
}

export function listJobs() {
  const all = currentJob() ? [currentJob(), ...finished.filter((j) => j.id !== currentJob().id)] : [...finished];
  return all.slice(0, KEEP_DONE).map((j) => ({
    id: j.id,
    kind: j.kind,
    pluginId: j.pluginId,
    pkgName: j.pkgName,
    state: j.state,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    ok: j.result?.ok ?? null,
    failure: j.result?.failure ?? null,
    aborted: j.result?.aborted ?? false,
    currentPhase: j.currentPhase,
  }));
}

/** 阶段顺序（诊断/自检用） */
export function phasePlan() {
  return PHASES.map((p) => p.id);
}
