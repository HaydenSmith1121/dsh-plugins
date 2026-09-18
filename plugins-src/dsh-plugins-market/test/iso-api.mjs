/**
 * 隔离环境里的市场 API 实测（打 3090，绝不碰 3080）。
 *
 *   node test/iso-api.mjs <token>
 *
 * 覆盖这次改动的四条验收线：
 *   1. status 里带 job / preflight / progressModel
 *   2. install 立刻返回 jobId（不再是一次请求跑到底）
 *   3. installProgress 能报出阶段、已耗时、预计剩余
 *   4. installAbort 能真的中断，并且终态是 cancelled
 *   5. manualCommands 给得出可执行的命令（含快照 sha256）
 */

const TOKEN = process.argv[2] ?? '';
const BASE = process.env.DPM_BASE ?? 'http://127.0.0.1:3090';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };
const info = (m) => console.log(`    · ${m}`);

async function rpc(method, args = {}) {
  const res = await fetch(`${BASE}/dsh-plugins-market/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': TOKEN },
    body: JSON.stringify({ method, args }),
  });
  const data = await res.json();
  if (!data || data.ok !== true) throw new Error(`${method} 失败：${(data && data.error) || res.status}`);
  return data.result;
}

console.log('');
console.log('  dsh-plugins-market 隔离环境实测');
console.log(`  ${'-'.repeat(72)}`);
console.log(`  ${BASE}`);
console.log('');

// ── [1] status ──────────────────────────────────────────────
const status = await rpc('status');
ok(`status 可用（市场版本 ${status.market?.version}）`);
if (status.job !== undefined) ok('status 里带 job（一打开页面就知道有没有任务在跑）');
else bad('status 缺少 job 字段');
if (status.preflight) ok(`status 里带 preflight（当前 ${status.preflight.ok ? '健康' : '有问题'}）`);
else bad('status 缺少 preflight 字段');
if (status.progressModel?.phases?.length >= 6) ok(`status 里带进度模型（${status.progressModel.phases.length} 个阶段，总超时 ${Math.round(status.progressModel.totalTimeoutMs / 1000)}s）`);
else bad('status 缺少 progressModel');

// ── [2] 目录 + 闸门 + 手动命令 ──────────────────────────────
const catalog = await rpc('catalog', { limit: 100 });
ok(`目录可用：${catalog.total} 条`);

/**
 * 找一条「本仓库托管 tarball、且本机没装」的条目。
 *
 * ★ 不能只翻列表第一页：目录按 star 数排序，本仓库托管的六个插件 star 都不多，
 *   排在 7000+ 条里很靠后。以前这里在首页里 find，改成平铺列表之后就永远找不到 ——
 *   表现是「后续用例全部跳过」，而不是报错。所以改成按名字检索。
 */
async function findHostedNotInstalled(exclude = null) {
  for (const q of ['dsh-memory', 'dsh-ark-plans', 'dsh-plugins-market', 'dsh-session-cleanup']) {
    const r = await rpc('catalog', { query: q, limit: 10 });
    const hit = (r.items || []).find((e) => e.installMethod === 'tarball'
      && !e.installState?.installed && e.id !== exclude);
    if (hit) return hit;
  }
  return null;
}

const notInstalled = await findHostedNotInstalled();
if (!notInstalled) {
  bad('找不到一条「未安装 + 本仓库托管 tarball」的条目，后续用例无法进行');
} else {
  // ★ 0.5.0：条目上不再有 tier，这里也不该再打印它
  info(`选中：${notInstalled.package}@${notInstalled.version}（${notInstalled.installMethod}）`);
  if (notInstalled.tier !== undefined) bad(`条目上还有 tier=${notInstalled.tier}（信任分级已移除）`);
}

const target = notInstalled;
if (target) {
  const gate = await rpc('gate', { id: target.id });
  if (gate.manual?.steps?.length) ok(`gate 里带手动安装方案（${gate.manual.steps.length} 步）`);
  else bad('gate 没有返回 manual');

  const plan = gate.manual;
  const addStep = plan.steps.find((s) => s.id === 'add');
  const cmd = addStep?.commands?.[0]?.text ?? '';
  if (/add /.test(cmd) && /\.tgz/.test(cmd)) ok(`手动安装命令：${cmd.slice(0, 100)}${cmd.length > 100 ? '…' : ''}`);
  else bad(`手动安装命令不完整：${JSON.stringify(cmd)}`);
  if (plan.sha256) ok(`带 sha256 校验：${plan.sha256.slice(0, 16)}…（来源 ${plan.sha256Source}）`);
  else bad('手动方案没有 sha256');

  const manual = await rpc('manualCommands', { id: target.id });
  if (manual.plan?.text && /dsh plugin --profile/.test(manual.plan.text)) ok('manualCommands 返回可直接粘贴的纯文本方案');
  else bad('manualCommands 返回内容不完整');

  // ── [3] 安装：必须立刻返回 jobId ──────────────────────────
  if (gate.canInstall) {
    // 真跑一次：验证「请求立刻返回 + 终态正确 + 三层校验通过」
    const t0 = Date.now();
    const start = await rpc('install', { id: target.id, acknowledgeRisk: true, simulateSlowInstallSeconds: 3 });
    const tookMs = Date.now() - t0;
    if (start.jobId && tookMs < 8000) ok(`install 立刻返回 jobId=${start.jobId}（${tookMs}ms，不再阻塞请求）`);
    else bad(`install 没有立刻返回 jobId（${tookMs}ms）: ${JSON.stringify(start).slice(0, 200)}`);

    let sawRunning = false;
    let sawEta = false;
    let sawPhase = false;
    let last = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const p = (await rpc('installProgress', { jobId: start.jobId })).job;
      last = p;
      if (p.state === 'running' || p.state === 'queued') {
        sawRunning = true;
        if (p.eta?.text) sawEta = true;
        if (p.currentPhase) sawPhase = true;
      } else {
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (sawRunning) ok('轮询拿到 running 快照');
    else bad('没有观察到 running 状态');
    if (sawPhase) ok(`进度里有阶段名：${last?.currentPhaseLabel}`);
    else bad('进度里没有阶段名');
    if (sawEta) ok(`进度里有预计剩余：${last?.eta?.text}`);
    else bad('进度里没有预计剩余');
    if (last?.state === 'succeeded') ok(`真安装成功（用时 ${last.elapsedMs}ms）`);
    else bad(`真安装没有成功：${last?.state} / ${JSON.stringify(last?.result?.failure)}`);
    if (last?.allPhases?.length >= 6) ok(`终态快照仍带阶段清单（${last.allPhases.length} 个）`);
    else bad('终态快照缺少阶段清单');
    if (last?.result?.ok) ok('终态快照带 result（界面据此渲染结论与手动命令）');
    else bad('终态快照缺少 result');

    const installedState = (await rpc('catalog', { query: target.id, limit: 5 })).items?.[0]?.installState;
    if (installedState?.installed) ok(`安装后目录状态已更新：${installedState.status} ${installedState.installedVersion}`);
    else bad(`安装后目录状态没更新：${JSON.stringify(installedState)}`);

    // ── [4] 中止：用一个「慢安装」把中止链路走通 ─────────────
    const second = await findHostedNotInstalled(target.id);
    if (!second) {
      info('没有第二条可安装条目，跳过中止用例');
    } else {
      const s2 = await rpc('install', { id: second.id, acknowledgeRisk: true, simulateSlowInstallSeconds: 30 });
      let abortRes = null;
      let final = null;
      for (let i = 0; i < 40; i++) {
        const p = (await rpc('installProgress', { jobId: s2.jobId })).job;
        final = p;
        if (p.state === 'running' && !abortRes) {
          abortRes = await rpc('installAbort', { jobId: s2.jobId });
        }
        if (p.state !== 'running' && p.state !== 'queued') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (abortRes?.ok) ok('installAbort 被接受（真中断链路走通）');
      else bad(`installAbort 未被接受：${JSON.stringify(abortRes)}`);
      if (final?.state === 'cancelled') ok('中止后终态是 cancelled');
      else bad(`中止后终态是 ${final?.state}`);
      if (final?.result?.aborted) ok('结果里带 aborted 标记（界面据此说明「profile 已还原」）');
      else bad('结果里没有 aborted 标记');

      const v = await rpc('verify', {});
      if (v.bundles && v.bundles.includes(second.package)) bad(`${second.package} 竟然被写进 bundles（中止应当回滚）`);
      else ok('中止后目标包没有残留在 bundles 里');
      if ((v.orphans || []).length === 0) ok('中止后没有孤儿 bundle');
      else bad(`中止后 profile 不干净：orphans=${JSON.stringify(v.orphans)}`);
    }
  } else {
    info('闸门未放行，跳过安装/中止用例');
  }
}

// ── [5] preflight RPC ───────────────────────────────────────
const pf = await rpc('preflight');
if (pf && typeof pf.ok === 'boolean') ok(`preflight RPC 可用（ok=${pf.ok}，问题 ${pf.problems?.length ?? 0} 个，提示 ${pf.notices?.length ?? 0} 条）`);
else bad('preflight RPC 返回异常');

console.log('');
if (failed === 0) {
  console.log('  ✓ 隔离环境实测全部通过。');
  console.log('');
} else {
  console.error(`  ✗ 有 ${failed} 项未通过。`);
  console.error('');
  /*
   * ★ 用 exitCode 而不是 process.exit()。
   *   Windows 上 process.exit() 会在 undici 的 fetch 连接还没关完时强拆 libuv，
   *   实测直接以 0xC0000409 崩掉（"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"），
   *   把「有几项没通过」这个真实结论盖掉了。让事件循环自己排空即可。
   */
  process.exitCode = 1;
}
