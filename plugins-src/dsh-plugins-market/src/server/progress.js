/**
 * dsh-plugins-market —— 服务器半：安装进度模型
 *
 * 这一层解决的问题是「点了安装之后，用户看到什么」。
 *
 * 早先的版本在这一点上是空白：整个安装跑在一次 HTTP 请求里，前端只显示一句
 * 「正在安装…请勿关闭页面」，既没有阶段、没有耗时、也没有任何出口。一旦
 * pnpm 卡住（在慢镜像、大依赖树、或 profile 里有断链的 file: 依赖时很常见），
 * 用户看到的就是「转圈转到天荒地老」，而且**连刷新都不敢**。
 *
 * 所以这里把一次安装拆成**有名字的阶段**，每个阶段带：
 *
 *   - est      本阶段的典型耗时（用于算预计剩余时间）
 *   - timeout  本阶段的硬上限（到点当作超时，主动中止并回滚）
 *   - weight   计入总进度的权重
 *   - silence  多久没有新输出就判定「疑似卡住」（只提示，不擅自中止）
 *
 * ★ 关于预计时间的一个取舍：这里给的是**区间**，不是精确值。
 *   「预计还需 40–90 秒」是有用且诚实的；「还需 47 秒」会在 20 秒后变成谎话。
 *   区间由阶段典型值 × 系数得出，并且会随着本机历史（timings.json）自我修正。
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir, readJsonSafe, writeJsonAtomic, ensureDir } from './util.js';

export const DEFAULT_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 阶段表。
 *
 * ★ 顺序即执行顺序；id 会被 installer.js 用来上报「我进到哪一步了」。
 *   权重按典型耗时分配，让进度条走起来大致均匀 —— 一个「按阶段数量平均」
 *   的进度条会在最慢的那一步（执行安装）原地停很久，那正是最需要动起来的时候。
 */
export const PHASES = [
  {
    id: 'preflight', label: 'profile 完整性体检', weight: 3, est: 1_500, timeout: 60_000, silence: 60_000,
  },
  {
    id: 'fetch', label: '取安装包', weight: 8, est: 4_000, timeout: 180_000, silence: 90_000,
  },
  {
    id: 'backup', label: '给 profile 拍快照', weight: 4, est: 1_500, timeout: 60_000, silence: 60_000,
  },
  {
    id: 'allowbuilds', label: '预置 allowBuilds', weight: 2, est: 400, timeout: 30_000, silence: 30_000,
  },
  {
    id: 'remove', label: '移除旧版本', weight: 8, est: 20_000, timeout: 180_000, silence: 120_000,
  },
  {
    id: 'install', label: '执行安装（pnpm 解析依赖并解包，通常最慢）', weight: 55, est: 60_000, timeout: 900_000, silence: 180_000,
  },
  {
    id: 'verify', label: '三层校验（依赖 / 注册表 / 装配）', weight: 12, est: 8_000, timeout: 180_000, silence: 120_000,
  },
  {
    id: 'rollback', label: '回滚到安装前的快照', weight: 8, est: 25_000, timeout: 300_000, silence: 180_000,
  },
];

export const PHASE_BY_ID = new Map(PHASES.map((p) => [p.id, p]));

export const PHASE_LABEL = (id) => PHASE_BY_ID.get(id)?.label ?? String(id ?? '—');

/** 用户主动中止时的结果码（与 installPlugin 的 failure 区分开） */
export const CANCEL_FAILURE = 'aborted-by-user';

// ─────────────────────────────────────────────────────────────
// 预计时间
// ─────────────────────────────────────────────────────────────

function human(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
}

/**
 * 把「当前阶段已跑时间 + 剩余阶段典型耗时」换算成预计剩余区间。
 *
 * 两个刻意的设计：
 *   - 当前阶段**只算超出典型值的部分的一半**：pnpm 慢起来是指数级的，
 *     但如果用户只是遇到一个稍慢的镜像，也不该让预计时间立刻翻倍吓人。
 *   - 区间上下界是 [0.6×, 1.8×]：下界防止「还需 0 秒」的假希望，
 *     上界在真的卡住时如实反映「可能还要很久」，从而推动用户去按中止。
 */
export function estimateRemaining({ phases, currentId, elapsedInCurrent, timings = {} }) {
  const idx = phases.findIndex((p) => p.id === currentId);
  if (idx < 0) return { lowMs: 0, highMs: 0, text: '—' };

  const estOf = (p) => Math.max(200, Number(timings[p.id]?.est ?? p.est));
  const behind = Math.max(0, elapsedInCurrent - estOf(phases[idx]));

  let rest = 0;
  for (let i = idx; i < phases.length; i++) rest += estOf(phases[i]);
  rest = rest - Math.min(elapsedInCurrent, estOf(phases[idx])) + behind * 0.5;

  const low = rest * 0.6;
  const high = rest * 1.8;
  return {
    lowMs: Math.round(low),
    highMs: Math.round(high),
    text: high < 3_000 ? '马上就好' : `预计还需 ${human(low)} – ${human(high)}`,
  };
}

// ─────────────────────────────────────────────────────────────
// 本机耗时学习（让预计时间越用越准）
// ─────────────────────────────────────────────────────────────

const TIMINGS_FILE = 'timings.json';
const MAX_SAMPLES = 8;

export function timingsFile() {
  return path.join(resolveDataDir(), TIMINGS_FILE);
}

export function readTimings() {
  const data = readJsonSafe(timingsFile());
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * 记一次阶段耗时。
 *
 * ★ 只保留最近 MAX_SAMPLES 次，并且用**中位数**而不是平均值 ——
 *   安装耗时是长尾分布（偶尔一次 5 分钟），平均值会被一次异常拖偏很久，
 *   中位数则天然抗离群点。
 */
export function recordTimings(samples) {
  try {
    const data = readTimings();
    for (const [id, ms] of Object.entries(samples ?? {})) {
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const bucket = Array.isArray(data[id]?.samples) ? data[id].samples : [];
      bucket.push(Math.round(ms));
      const trimmed = bucket.slice(-MAX_SAMPLES);
      const sorted = [...trimmed].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      data[id] = { samples: trimmed, est: median, updatedAt: new Date().toISOString() };
    }
    ensureDir(path.dirname(timingsFile()));
    writeJsonAtomic(timingsFile(), data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** 把历史中位数摊回阶段表（用于展示与预计时间） */
export function phasesWithTimings(timings = readTimings()) {
  return PHASES.map((p) => ({ ...p, est: Math.max(200, Number(timings[p.id]?.est ?? p.est)) }));
}

// ─────────────────────────────────────────────────────────────
// 快照 / 归一化（给前端与事件流用）
// ─────────────────────────────────────────────────────────────

export function progressSnapshot(job, { timings = null } = {}) {
  const phases = job.phases ?? PHASES;
  const snap = {
    id: job.id,
    state: job.state,
    pluginId: job.pluginId,
    pkgName: job.pkgName,
    profile: job.profile,
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? null,
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    currentPhase: job.currentPhase ?? null,
    currentPhaseLabel: job.currentPhase ? PHASE_LABEL(job.currentPhase) : null,
    currentPhaseElapsedMs: job.currentPhaseAt ? Date.now() - job.currentPhaseAt : 0,
    allPhases: phases.map((p) => ({
      id: p.id,
      label: p.label,
      state: job.phaseState?.[p.id] ?? 'pending',
      ms: job.phaseMs?.[p.id] ?? null,
    })),
    steps: job.steps ?? [],
    step: job.step ?? null,
    staleness: stalenessOf(job, phases),
    pnpmTail: job.tailLines ?? [],
    queuePosition: job.queuePosition ?? 0,
    canAbort: job.state === 'queued' || job.state === 'running',
    abortRequestedAt: job.abortRequestedAt ?? null,
    manual: job.manual ?? null,
    // ★ 进度页要靠这几个字段说清「正在用什么方式装」：自动安装时用户看不到命令，
    //   所以方式、规格、来源必须由快照带过去 —— 不能只留在发起请求的那一次响应里
    //   （关掉页面再回来时，那次响应早就没了）。
    auto: job.auto ?? null,
    entry: job.entry ?? null,
    reinstall: Boolean(job.reinstall),
    result: job.result ?? null,
    error: job.error ?? null,
    terminal: isTerminal(job),
  };
  if (timings) {
    snap.eta = estimateRemaining({
      phases,
      currentId: job.currentPhase,
      elapsedInCurrent: snap.currentPhaseElapsedMs,
      timings,
    });
  }
  return snap;
}

function stalenessOf(job, phases) {
  if (job.state !== 'running') return null;
  const phase = phases.find((p) => p.id === job.currentPhase);
  if (!phase) return null;
  const since = job.lastOutputAt ?? job.currentPhaseAt ?? job.startedAt;
  const quietFor = Date.now() - since;
  if (quietFor >= (phase.silence ?? 120_000)) {
    return {
      level: 'stalled',
      quietMs: quietFor,
      text: `${human(quietFor)}没有新输出 —— 这一步可能卡在网络或依赖解析上。可以继续等，也可以中止后改用下面的手动命令。`,
    };
  }
  if (quietFor >= Math.min(20_000, (phase.silence ?? 120_000) / 3)) {
    return { level: 'quiet', quietMs: quietFor, text: `${human(quietFor)}没有新输出，仍在等待…` };
  }
  return null;
}

export function isTerminal(job) {
  return ['succeeded', 'failed', 'cancelled', 'timeout'].includes(job.state);
}

/**
 * pnpm 的输出是给终端看的，整段贴到界面上毫无可读性。
 * 这里只挑「有信息量」的行：错误、警告、进度摘要、以及正在下载/解包的包名。
 */
const TAIL_KEEP = [
  /ERR_|error|Error/,
  /WARN|warn/,
  /Progress|Packages:|Downloading|Resolving|Linking|reused|added|removed|up to date/i,
  /Ignored build scripts/,
  /Done in|Done$/,
];

export function pushTail(job, chunk, max = 14) {
  const text = String(chunk ?? '');
  if (!text) return;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trimEnd());
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    job.lastOutputAt = Date.now();
    if (t.length > 240) continue;
    if (!TAIL_KEEP.some((re) => re.test(t))) continue;
    const last = job.tailLines[job.tailLines.length - 1];
    if (last === t) continue;
    job.tailLines.push(t);
  }
  if (job.tailLines.length > max) job.tailLines.splice(0, job.tailLines.length - max);
}

/** 给界面用的一句话状态（进度抽屉的标题行） */
export function progressHeadline(job, timings = null) {
  const snap = progressSnapshot(job, { timings });
  if (snap.state === 'queued') return { kind: 'queued', text: '排队中：前面还有一个安装任务在跑' };
  if (snap.state === 'succeeded') return { kind: 'ok', text: '安装完成' };
  if (snap.state === 'cancelled') return { kind: 'warn', text: '已按你的要求中止' };
  if (snap.state === 'timeout') return { kind: 'warn', text: '超时自动中止' };
  if (snap.state === 'failed') return { kind: 'bad', text: '安装失败' };
  const eta = snap.eta?.text ?? '';
  return { kind: 'running', text: `${snap.currentPhaseLabel ?? '准备中'}${eta ? ` · ${eta}` : ''}` };
}
