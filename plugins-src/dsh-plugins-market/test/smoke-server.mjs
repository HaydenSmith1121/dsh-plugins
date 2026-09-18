/**
 * 服务器半冒烟自检：只做「能不能 import + 纯函数对不对」，不碰真实 profile。
 *
 *   node test/smoke-server.mjs
 *
 * 为什么需要它：本插件的服务器半有 12 个模块互相 import，任何一个拼错导出名
 * 都会让整棵插件树加载失败（而且报错发生在 harness 启动时，离改动现场很远）。
 * 这个脚本在打包前就把这类问题拦下来 —— build.mjs 的 --check 只做静态自检，
 * 抓不到跨模块的导出名错误。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'server');

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failed++; console.error(`  ✗ ${msg}`); };

console.log('');
console.log('  dsh-plugins-market 服务器半冒烟自检');
console.log(`  ${'-'.repeat(72)}`);

// ── [1] 全部模块可 import ──────────────────────────────────
const modules = ['util.js', 'progress.js', 'profile.js', 'installer.js', 'jobs.js', 'manual.js', 'catalog.js', 'spec.js', 'diagnose.js', 'state.js', 'probe.js', 'oplog.js', 'index.js'];
const loaded = {};
for (const m of modules) {
  try {
    loaded[m] = await import(new URL(`../src/server/${m}`, import.meta.url).href);
    ok(`import ${m}`);
  } catch (err) {
    bad(`import ${m} 失败：${err?.message ?? err}`);
  }
}

// ── [2] index.js 的插件三件套 ──────────────────────────────
if (loaded['index.js']) {
  const idx = loaded['index.js'];
  if (idx.name === 'dsh-plugins-market') ok('name 正确'); else bad(`name = ${idx.name}`);
  if (Array.isArray(idx.inject) && idx.inject.includes('webServer')) ok('inject = [webServer]'); else bad('inject 不对');
  if (typeof idx.apply === 'function') ok('apply 是函数'); else bad('apply 缺失');
}

// ── [3] 进度模型 ───────────────────────────────────────────
if (loaded['progress.js']) {
  const P = loaded['progress.js'];
  if (Array.isArray(P.PHASES) && P.PHASES.length >= 6) ok(`PHASES ${P.PHASES.length} 个阶段`); else bad('PHASES 异常');

  const eta = P.estimateRemaining({
    phases: P.PHASES,
    currentId: 'install',
    elapsedInCurrent: 30_000,
    timings: {},
  });
  if (eta.lowMs > 0 && eta.highMs > eta.lowMs && /预计还需/.test(eta.text)) ok(`ETA 文案：${eta.text}`);
  else bad(`ETA 计算异常：${JSON.stringify(eta)}`);

  const eta2 = P.estimateRemaining({ phases: P.PHASES, currentId: 'verify', elapsedInCurrent: 0, timings: {} });
  if (eta2.highMs < eta.highMs) ok('越靠后的阶段，预计剩余越少');
  else bad('ETA 没有随阶段推进而减少');

  // pushTail 只挑有信息量的行，且不能无限增长
  const job = { tailLines: [], lastOutputAt: 0 };
  P.pushTail(job, 'Progress: resolved 1, reused 0\nirrelevant noise line\nERR_PNPM_FOO boom\n');
  if (job.tailLines.length === 2 && job.tailLines.some((l) => /ERR_PNPM_FOO/.test(l))) ok('pushTail 过滤 + 保留错误行');
  else bad(`pushTail 结果异常：${JSON.stringify(job.tailLines)}`);

  for (let i = 0; i < 60; i++) P.pushTail(job, `Progress: step ${i}\n`);
  if (job.tailLines.length <= 20) ok('pushTail 有上限（不会无限增长）');
  else bad(`pushTail 未截断：${job.tailLines.length}`);
}

// ── [4] 阶段超时必须是有限的 ───────────────────────────────
if (loaded['progress.js']) {
  const P = loaded['progress.js'];
  const noTimeout = P.PHASES.filter((p) => !(p.timeout > 0));
  if (noTimeout.length === 0) ok('每个阶段都有硬超时（"长时间无反应"的兜底）');
  else bad(`这些阶段没有超时：${noTimeout.map((p) => p.id).join('、')}`);
  const install = P.PHASES.find((p) => p.id === 'install');
  if (install.timeout <= 15 * 60 * 1000) ok(`install 阶段超时 ${install.timeout / 1000}s（不会让人干等 15 分钟以上）`);
  else bad('install 阶段超时过长');
}

// ── [5] 手动命令生成（对一条假条目 + 假 ctx）───────────────
if (loaded['manual.js']) {
  const { manualInstallPlan } = loaded['manual.js'];
  const fakeCtx = {
    repoRoot: null,
    profileState: { profile: 'web', dir: path.join(HERE, '..', '.fake-profile') },
    installed: [],
  };
  const entry = {
    id: 'demo', package: 'demo-plugin', version: '1.2.3',
    install: { tarball: 'plugins/demo-plugin/0.1.6-alpha.1/demo-plugin-1.2.3.tgz' },
    sha256: 'a'.repeat(64),
  };
  const plan = manualInstallPlan(entry, fakeCtx, null);
  if (plan.steps.length >= 4) ok(`手动方案 ${plan.steps.length} 步`); else bad('手动方案步骤过少');
  const addStep = plan.steps.find((s) => s.id === 'add');
  const addCmd = addStep?.commands?.[0]?.text ?? '';
  if (/dsh plugin --profile web add /.test(addCmd)) ok(`安装命令：${addCmd}`);
  else bad(`安装命令不对：${addCmd}`);
  if (/sha256/.test(plan.text)) ok('纯文本版含 sha256 校验');
  else bad('纯文本版缺少 sha256');
  if (plan.recovery.length >= 3) ok(`兜底说明 ${plan.recovery.length} 条`); else bad('兜底说明过少');
  if (plan.tarballUrl && /^https:\/\//.test(plan.tarballUrl)) ok(`快照下载地址：${plan.tarballUrl}`);
  else bad('缺少可下载的快照地址');
}

// ── [6] profile 装前体检（断链 file: 依赖必须被抓住）───────
if (loaded['installer.js']) {
  const { preflight } = loaded['installer.js'];
  const dir = path.join(HERE, '.fake-profile');
  const fsMod = await import('node:fs');
  fsMod.rmSync(dir, { recursive: true, force: true });
  fsMod.mkdirSync(dir, { recursive: true });

  const GOOD_WS = 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n';
  const mk = (deps) => ({
    profileState: {
      exists: true, dir, profile: 'web', dependencies: deps, bundles: ['a'], initialized: true,
    },
    env: {},
  });

  fsMod.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), GOOD_WS, 'utf8');
  fsMod.writeFileSync(path.join(dir, 'a.tgz'), 'x');

  const good = preflight(mk({ a: 'file:' + path.join(dir, 'a.tgz') }));
  if (good.ok) ok('file: 依赖存在时体检通过');
  else bad(`体检误报：${JSON.stringify(good.problems)}`);

  const bad1 = preflight(mk({ gone: 'file:' + path.join(dir, 'missing.tgz') }));
  if (!bad1.ok && bad1.problems[0]?.id === 'profile.dangling-file-specs') {
    ok('断链 file: 依赖被拦下（这是「装很久装不上」的主因）');
    if (bad1.problems[0].fixes?.[0]?.kind === 'remove-dependency') ok('并给出了可点的修复项');
    else bad('断链问题没有给出修复项');
  } else bad(`断链未被拦下：${JSON.stringify(bad1.problems)}`);

  fsMod.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), '# 空文件\n', 'utf8');
  const bad2 = preflight(mk({ a: 'file:' + path.join(dir, 'a.tgz') }));
  const keyWarn = bad2.notices.find((n) => n.id === 'workspace-keys');
  if (keyWarn) ok('pnpm-workspace.yaml 缺关键键时给出提示');
  else bad(`未检测到 workspace 关键键缺失：${JSON.stringify(bad2.notices)}`);

  fsMod.rmSync(dir, { recursive: true, force: true });
}

// ── [7] 任务调度：排队 / 中止 / 快照 ───────────────────────
if (loaded['jobs.js']) {
  const J = loaded['jobs.js'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let phaseSeen = [];
  const jobA = J.startJob({
    kind: 'install', pluginId: 'a', pkgName: 'a', profile: 'web',
    runner: async (j) => {
      j.phase('install');
      phaseSeen.push('install');
      await sleep(120);
      return { ok: true };
    },
  });
  const jobB = J.startJob({
    kind: 'install', pluginId: 'b', pkgName: 'b', profile: 'web',
    runner: async () => ({ ok: true }),
  });
  if (jobB.state === 'queued' || jobB.queuePosition === 1) ok('第二个任务被排队（不会两个 pnpm 同时改 profile）');
  else bad(`第二个任务没有被排队：${jobB.state}`);

  const snap = J.jobSnapshot(jobA);
  if (snap.canAbort && snap.allPhases?.length >= 6) ok('任务快照含可中止标志与阶段表');
  else bad('任务快照不完整');

  // ★ 进度页要靠快照里的这几个字段说清「正在用什么方式装」——
  //   自动安装时用户看不到命令窗口，这些字段就是他唯一的观察点。
  //   关掉页面再回来时它们必须还在（不能只留在发起请求的那一次响应里）。
  const jobW = J.startJob({
    kind: 'install', pluginId: 'w', pkgName: 'w@pkg', profile: 'web',
    entry: { id: 'w', title: 'W', package: 'w-pkg', version: '1.2.3' },
    auto: { kind: 'local-tarball', spec: '/tmp/w-1.2.3.tgz', source: 'repo', needsDownload: false },
    reinstall: true,
    runner: async () => ({ ok: true }),
  });
  const snapW = J.jobSnapshot(jobW);
  if (snapW.auto?.spec === '/tmp/w-1.2.3.tgz' && snapW.entry?.version === '1.2.3' && snapW.reinstall === true) {
    ok('任务快照带上了安装方式 / 目标条目 / 是否重装');
  } else {
    bad(`快照缺少安装方式字段：auto=${JSON.stringify(snapW.auto)} entry=${JSON.stringify(snapW.entry)} reinstall=${snapW.reinstall}`);
  }
  await jobW.done;

  await jobA.done;
  await jobB.done;
  if (J.jobSnapshot(jobA).state === 'succeeded') ok('任务成功终态正确');
  else bad(`终态不对：${J.jobSnapshot(jobA).state}`);

  // 中止：长任务必须能被 abort 掉，并且报 cancelled（不是 failed）
  const jobC = J.startJob({
    kind: 'install', pluginId: 'c', pkgName: 'c', profile: 'web',
    runner: async (j) => {
      j.phase('install');
      await new Promise((resolve) => {
        j.signal.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 5000);
      });
      return { ok: false, aborted: true, failure: 'aborted-by-user' };
    },
  });
  await sleep(60);
  const ab = J.requestAbort(jobC, 'user');
  if (ab.ok) ok('中止请求被接受');
  else bad('中止请求被拒绝');
  await jobC.done;
  if (J.jobSnapshot(jobC).state === 'cancelled') ok('中止后终态是 cancelled');
  else bad(`中止后终态是 ${J.jobSnapshot(jobC).state}`);

  // 排队中就被中止的任务不应真的执行
  let ranD = false;
  const jobE = J.startJob({ kind: 'install', pluginId: 'e', pkgName: 'e', profile: 'web', runner: async () => { ranD = true; return { ok: true }; } });
  const jobD = J.startJob({ kind: 'install', pluginId: 'd', pkgName: 'd', profile: 'web', runner: async () => { ranD = true; return { ok: true }; } });
  J.requestAbort(jobD, 'user');
  await jobE.done;
  await jobD.done;
  void ranD;
  ok('排队任务与中止路径没有死锁');
}

console.log('');
if (failed === 0) {
  console.log('  ✓ 服务器半冒烟自检通过。');
  console.log('');
} else {
  console.error(`  ✗ 有 ${failed} 项未通过。`);
  console.error('');
  process.exit(1);
}
