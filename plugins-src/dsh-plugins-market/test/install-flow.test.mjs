/**
 * 客户端半的**安装交互**测试 —— 把「点安装之后发生什么」真的走一遍。
 *
 * 为什么要单独一组：
 *
 * 全部价值都在**交互之后**：点安装 → 选自动还是手动 → 自动那条路立刻出现
 * 进度面板（阶段 / 已耗时 / 预计剩余）→ 可以按「中止安装」→ 手动安装命令
 * 始终挂在下面。只做首屏渲染测试的话，这些代码一行都不会执行 ——
 * 测试全绿，功能却可能是坏的。
 *
 * 这里用 panel-render.test.mjs 里的同一个 stub 驱动（stub React + fetch），
 * 按真实路径点击：卡片「安装」→ 安装方案抽屉（选方式）→「开始安装」→ 任务面板。
 */

import { suite, test, assert } from './harness.mjs';
import { openPanel, allText, findAll } from './panel-render.test.mjs';

suite('client / 安装交互（选方式 · 进度 · 预计时间 · 中止 · 手动命令）');

/** 一条可安装的假插件 */
function entry(over = {}) {
  return {
    id: over.package ?? 'demo', package: 'demo-plugin', title: '演示插件',
    version: '1.2.3', summary: '示例', tags: [],
    liked: false, favorited: false,
    installState: {
      status: 'not-installed', installed: false, installedVersion: null, target: '1.2.3',
      reason: null, inBundles: false, canInstall: true, canUpgrade: false, action: 'install', isLatest: false,
    },
    ...over,
  };
}

/** 服务端会给的手动安装方案 */
function manualPlan() {
  return {
    available: true, package: 'demo-plugin', version: '1.2.3', profile: 'web',
    tarball: 'D:/repo/plugins/demo/demo-plugin-1.2.3.tgz',
    tarballUrl: 'https://example.test/demo-plugin-1.2.3.tgz',
    tarballSource: 'repo', tarballSourceText: '仓库里的快照 tarball（离线可用）',
    sha256: 'a'.repeat(64), sha256Source: 'catalog',
    steps: [
      { id: 'locate', title: '1) 确认安装包在本地（无需下载）', why: '已经在本地了', commands: [{ shell: 'powershell', text: 'Test-Path D:/repo/demo.tgz' }] },
      { id: 'add', title: '2) 安装', why: '这就是自动化执行的那条命令。', commands: [{ shell: 'any', text: 'dsh plugin --profile web add D:/repo/demo.tgz' }], tips: ['成功判据是退出码 0'] },
      { id: 'confirm', title: '3) 确认装上了（三层校验）', why: '三层都过才算真的装好。', commands: [{ shell: 'any', text: 'dsh plugin --profile web list' }] },
      { id: 'restart', title: '4) 重启 dsh web', why: 'bundle 在启动时合成。', commands: [{ shell: 'any', text: 'dsh web' }] },
    ],
    recovery: [{ id: 'allowbuilds', title: '撞上 ERR_PNPM_IGNORED_BUILDS', why: 'pnpm 10+ 默认不批准构建脚本。', commands: [{ shell: 'any', text: '# 改 allowBuilds' }] }],
    notes: [], text: '# demo-plugin 手动安装\ndsh plugin --profile web add D:/repo/demo.tgz',
  };
}

/**
 * 服务端会给的安装方案（installPlan）。
 *
 * ★ 0.6.0 起一次请求就回三样东西：这个插件是什么状态、自动那条路的规格、
 *   手动那条路的完整命令。两条路都要能在**按下任何按钮之前**看完。
 */
function planResult(over = {}) {
  return {
    pluginId: 'demo', title: '演示插件', package: 'demo-plugin', version: '1.2.3',
    targetProfile: 'web', upstream: 'https://github.com/o/demo',
    needsConfig: false, installState: null, upgrade: false, alreadyLatest: false,
    auto: {
      available: true, kind: 'local-tarball', spec: 'D:/repo/demo.tgz',
      source: 'repo', needsDownload: false, sha256: null,
    },
    manual: manualPlan(),
    notes: [],
    configSource: 'remote', configError: null,
    ...over,
  };
}

/** 一个「正在跑」的任务快照（服务端 jobSnapshot 的形状） */
function runningJob(over = {}) {
  return {
    id: 'job-1', kind: 'install', pluginId: 'demo', pkgName: 'demo-plugin', profile: 'web',
    entry: { id: 'demo', title: '演示插件', package: 'demo-plugin', version: '1.2.3' },
    auto: { kind: 'local-tarball', spec: 'D:/repo/demo.tgz', source: 'repo', needsDownload: false },
    reinstall: false,
    state: 'running', startedAt: Date.now() - 12_000, endedAt: null, elapsedMs: 12_000,
    currentPhase: 'install', currentPhaseLabel: '执行安装（pnpm 解析依赖并解包，通常最慢）',
    currentPhaseElapsedMs: 9_000,
    allPhases: [
      { id: 'preflight', label: 'profile 完整性体检', state: 'ok', ms: 900 },
      { id: 'fetch', label: '取安装包', state: 'ok', ms: 200 },
      { id: 'backup', label: '给 profile 拍快照', state: 'ok', ms: 300 },
      { id: 'allowbuilds', label: '预置 allowBuilds', state: 'ok', ms: 20 },
      { id: 'install', label: '执行安装', state: 'running', ms: null },
      { id: 'verify', label: '三层校验', state: 'pending', ms: null },
    ],
    steps: [], staleness: null, pnpmTail: ['Progress: resolved 42, reused 30', 'Packages: +3'],
    canAbort: true, abortRequestedAt: null, terminal: false, result: null, error: null,
    eta: { lowMs: 40_000, highMs: 110_000, text: '预计还需 40 秒 – 1 分 50 秒' },
    manual: manualPlan(),
    ...over,
  };
}

/**
 * 在安装抽屉（InstallView）里吗？
 *
 * ★ 不能用「文本里含 dpm-prog」判断 —— `d.text()` 给的是**文本内容**，不含类名。
 *   也不能只看「中止安装」：终态（失败 / 完成）没有那个按钮。
 *   可靠判据是 InstallView 独有的底部按钮，加上几个终态文案。
 */
function inInstallDrawer(d) {
  if (d.buttons().some((b) => ['完成', '刷新状态', '中止安装', '正在中止…'].includes(allText(b).trim()))) return true;
  return /安装未完成|更新未完成|安装成功|更新成功|已中止安装|安装超时/.test(d.text());
}

/**
 * 把「点安装」这条路走完，停在安装抽屉上。
 *
 * ★ 两步：卡片「安装」→ 安装方案抽屉（默认选中「自动安装」）→「开始安装」。
 *   第一次点击只开方案页 —— 这正是新设计要的效果：**先让用户看见两条路**，
 *   而不是点一下就闷头开跑。
 *
 * ★ 为什么要重试：点击触发的是一条**异步**链（installPlan 请求 → 渲染 →
 *   install 请求 → 切抽屉），而测试的 settle() 只推进有限的几拍。重试几次
 *   并检查是否真的进了安装视图，比赌「刚好跑完」稳得多。
 */
async function driveToInstallDrawer(jobSnapshot) {
  const manual = jobSnapshot.manual ?? manualPlan();
  const extra = {
    installPlan: () => planResult(),
    install: () => ({ ok: true, started: true, jobId: jobSnapshot.id, job: jobSnapshot, manual }),
    installProgress: () => ({ job: jobSnapshot }),
  };
  const d = await openPanel([entry()], extra);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (inInstallDrawer(d)) return d;
    // 卡片上的「安装」：开方案抽屉
    const card = d.buttons().find((b) => allText(b).trim() === '安装' && b.props.disabled !== true);
    if (card) { card.props.onClick({ target: { checked: true } }); await d.settle(4); }
    // 方案抽屉里的「开始安装」：真的开跑
    const start = d.buttons().find((b) => ['开始安装', '开始更新', '重新安装'].includes(allText(b).trim()) && b.props.disabled !== true);
    if (start) { start.props.onClick({ target: { checked: true } }); await d.settle(4); }
    if (inInstallDrawer(d)) return d;
  }
  throw new Error(`没能进入安装抽屉。当前按钮：${d.buttons().map((b) => allText(b).trim()).join(' | ')}`);
}

/** 只走到安装方案抽屉（不进安装）—— 用来测「选方式」这一屏 */
async function driveToPlanDrawer(plan, oneEntry = entry()) {
  const d = await openPanel([oneEntry], { installPlan: () => plan });
  for (let attempt = 0; attempt < 4; attempt++) {
    const card = d.buttons().find((b) => allText(b).trim() === '安装' && b.props.disabled !== true);
    if (card) { card.props.onClick({ target: { checked: true } }); await d.settle(4); }
    if (d.text().includes('选择安装方式')) return d;
  }
  throw new Error(`没能进入安装方案抽屉。当前文本：${d.text().slice(0, 400)}`);
}

// ─────────────────────────────────────────────────────────────
// ★ 选方式：自动 / 手动都摆在最上面
// ─────────────────────────────────────────────────────────────

test('★ 安装方案页同时给出「自动安装」和「手动安装」两条路（不再有装前检查）', async () => {
  const d = await driveToPlanDrawer(planResult());
  const text = d.text();
  assert(text.includes('选择安装方式'), `应当有方式选择区，实际：${text.slice(0, 400)}`);
  assert(text.includes('自动安装'), '应当有「自动安装」这张卡');
  assert(text.includes('手动安装'), '应当有「手动安装」这张卡');
  // ★ 装前检查整体删除：页面、抽屉、结论词一个都不该再有
  assert(!text.includes('装前检查'), `不该再出现「装前检查」，实际：${text.slice(0, 400)}`);
  assert(!/已硬拦截|已被拦截|不能安装|无法确认/.test(text), `不该再出现任何放行判决措辞：${text.slice(0, 400)}`);
});

test('★ 自动安装能跑时默认选中它，并说清「命令窗口不会弹出来」', async () => {
  const d = await driveToPlanDrawer(planResult());
  const text = d.text();
  assert(text.includes('已选择'), '应当标出当前选中的方式');
  assert(/不会弹出命令窗口|不会弹出/.test(text),
    `自动安装的卖点就是命令不出现在界面上，必须说清，实际：${text.slice(0, 500)}`);
  // 规格与来源要如实展示 —— 命令看不见，那至少让它可读
  assert(text.includes('D:/repo/demo.tgz'), '应当展示将要执行的安装规格');
  assert(text.includes('本机仓库里的离线包') || text.includes('仓库'), '应当如实标注规格来源');
});

test('★ 自动不可用时：说清是「没有可跑的命令」，而不是「不让你装」', async () => {
  const d = await driveToPlanDrawer(planResult({
    auto: { available: false, reason: '目录里没有为它记录可自动执行的安装方式，所以只能按上游说明手动装。' },
  }));
  const text = d.text();
  assert(text.includes('没有可自动执行的安装方式'), `应当说明原因，实际：${text.slice(0, 500)}`);
  // ★ 落到手动那条路，并且命令**直接铺出来**（不是藏在折叠里）
  assert(text.includes('dsh plugin --profile web add D:/repo/demo.tgz'),
    `自动不可用时应当直接把手动命令铺出来，实际：${text.slice(0, 600)}`);
  const btn = d.buttons().find((b) => allText(b).trim() === '复制全部命令');
  assert(btn, `自动不可用时主按钮应当是「复制全部命令」。现有：${d.buttons().map((b) => allText(b).trim()).join(' | ')}`);
});

test('★ 切到手动安装：主按钮变成「复制全部命令」，不再有安装按钮', async () => {
  const d = await driveToPlanDrawer(planResult());
  const manualCard = d.buttons().find((b) => allText(b).includes('手动安装') && String(b.props.className ?? '').includes('dpm-method'));
  assert(manualCard, `应当有一张「手动安装」方式卡。现有：${d.buttons().map((b) => allText(b).trim()).join(' | ')}`);
  manualCard.props.onClick();
  await d.settle(3);
  const text = d.text();
  assert(text.includes('复制全部命令'), '切到手动后主按钮应当是「复制全部命令」');
  assert(!d.buttons().some((b) => allText(b).trim() === '开始安装'),
    '切到手动后不该还留着「开始安装」—— 手动那条路市场不执行任何命令');
  assert(text.includes('Test-Path') || text.includes('dsh plugin --profile web add'),
    '手动那条路要把命令铺出来');
});

test('★ 装前提示以「事实」形式列出（是提示，不是判决）', async () => {
  const d = await driveToPlanDrawer(planResult({
    notes: [
      { id: 'no-bundle', text: '这个包的 package.json 没有声明 dsh.bundle.patch，dsh 会把它当普通依赖装进 node_modules，但不会写进 dsh.profile.bundles。' },
      { id: 'needs-config', text: '装完需要配置（例如 API Key / Token）才能用。' },
    ],
  }));
  const text = d.text();
  assert(text.includes('装之前你可能想知道'), `提示区应当有标题，实际：${text.slice(0, 500)}`);
  assert(text.includes('dsh.profile.bundles'), '应当把事实原文列出来');
  // ★ 关键：有提示也不影响两条路可选 —— 自动那条路照样是选中的
  assert(text.includes('已选择'), '有提示时仍然要能正常选方式和安装');
  const start = d.buttons().find((b) => allText(b).trim() === '开始安装');
  assert(start && start.props.disabled !== true, '★ 有提示不该禁用安装按钮 —— 提示不是拦截');
});

// ─────────────────────────────────────────────────────────────
// 自动那条路：进度 / 预计时间 / 中止
// ─────────────────────────────────────────────────────────────

test('★ 点安装后立刻进入进度视图，而不是只有一句「正在安装」', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const text = d.text();
  assert(text.includes('已用'), `进度面板应当显示已耗时，实际片段：${text.slice(0, 400)}`);
  assert(text.includes('本步已用') || text.includes('预计还需'), '进度面板应当有时间信息');
});

test('★ 进度页说清「正在装什么、用什么方式装」（自动安装的唯一观察点）', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const text = d.text();
  assert(text.includes('demo-plugin'), `进度页应当写明正在装哪个包，实际：${text.slice(0, 400)}`);
  assert(text.includes('1.2.3'), '应当写明目标版本');
  assert(text.includes('自动安装'), '应当标明这是自动安装');
  assert(text.includes('D:/repo/demo.tgz'), '命令看不到，那就必须让规格可读');
  assert(text.includes('local-tarball'), '应当标明安装规格的类型');
});

test('★ 进度里有「预计还需」的区间（用户要求的预计时间）', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const text = d.text();
  assert(/预计还需/.test(text), `应当显示预计剩余时间，实际：${text.slice(0, 400)}`);
  assert(/40 秒/.test(text) && /1 分 50 秒/.test(text), '预计时间应当是按区间给出的实际数值');
});

test('★ 阶段清单可见：能看出已经过了哪几步、现在卡在哪一步', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const phases = findAll(d.tree, (n) => String(n.props?.className ?? '').includes('dpm-phase'));
  assert(phases.length >= 6, `应当渲染出阶段清单（≥6 个），实际 ${phases.length} 个`);
  const states = phases.map((p) => p.props['data-s']);
  assert(states.includes('ok'), '应当有已完成的阶段');
  assert(states.includes('running'), '应当有正在进行的阶段');
  assert(states.includes('pending'), '应当有还没开始的阶段');
  const text = allText(phases.find((p) => p.props['data-s'] === 'running'));
  assert(text.includes('执行安装'), `正在进行的阶段应当是「执行安装」，实际：${text}`);
});

test('★ 进度条存在，且随阶段推进有宽度', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const fills = findAll(d.tree, (n) => String(n.props?.className ?? '').includes('dpm-bar-fill'));
  assert(fills.length >= 1, '应当有进度条');
  const width = String(fills[0].props.style?.width ?? '');
  assert(/%$/.test(width), `进度条宽度应当是百分比，实际：${width}`);
  assert(parseInt(width, 10) > 0 && parseInt(width, 10) < 100, `进行中时进度条应当在 0–100 之间，实际：${width}`);
});

test('★ 「中止安装」按钮存在且可点（用户要求的退出安装）', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const btn = d.buttons().find((b) => allText(b).trim() === '中止安装');
  assert(btn, `应当有「中止安装」按钮。现有按钮：${d.buttons().map((b) => allText(b).trim()).join(' | ')}`);
  assert(btn.props.disabled !== true, '任务在跑时中止按钮必须可点');
  assert(typeof btn.props.onClick === 'function', '中止按钮必须有 onClick');
});

test('★ 中止要二次确认，不能一点就杀（避免误触打断安装）', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const before = d.text();
  await d.click((b) => allText(b).trim() === '中止安装', '中止按钮');
  const after = d.text();
  assert(after.includes('再点一次') || after.includes('确认'), `第一次点击应当只要确认、不真的中止。实际新增文本：${after.replace(before, '').slice(0, 300)}`);
  assert(after.includes('中止安装'), '第一次点击不应把按钮变成「正在中止」');
});

test('★ 中止请求发出后，按钮变成「正在中止」并说明会回滚（不能按了没反应）', async () => {
  const abortedJob = runningJob({ abortRequestedAt: Date.now() - 500 });
  const d = await driveToInstallDrawer(abortedJob);
  const text = d.text();
  assert(text.includes('正在中止'), `已发出中止请求时按钮应当变成「正在中止」，实际：${text.slice(0, 500)}`);
  assert(text.includes('还原') || text.includes('回滚'), '应当说明中止后会回滚到安装前');
  const btn = d.buttons().find((b) => allText(b).trim() === '正在中止…');
  assert(btn && btn.props.disabled === true, '正在中止时按钮应当禁用，避免重复点');
});

test('★ 疑似卡住时如实提示，并把「中止 → 手动装」这条出路摆在旁边', async () => {
  const stalled = runningJob({
    staleness: { level: 'stalled', quietMs: 200_000, text: '3 分 20 秒没有新输出 —— 这一步可能卡在网络或依赖解析上。可以继续等，也可以中止后改用下面的手动命令。' },
  });
  const d = await driveToInstallDrawer(stalled);
  const text = d.text();
  assert(text.includes('没有新输出'), `卡住时应当如实提示，实际：${text.slice(0, 500)}`);
  assert(text.includes('中止') && text.includes('手动'), '提示里应当同时给出「中止」和「手动」两条出路');
});

test('★ 手动安装命令面板在安装进行中就在（不必等到失败才看得到）', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const text = d.text();
  assert(text.includes('手动安装'), `进行中也应当能看到手动安装方案，实际：${text.slice(0, 600)}`);
  assert(text.includes('dsh plugin --profile web add D:/repo/demo.tgz'), '应当给出可直接执行的安装命令');
  assert(text.includes('a'.repeat(64)), '应当给出 tarball 的 sha256');
});

test('★ 手动命令逐条可复制（每条命令一个复制按钮）', async () => {
  const d = await driveToInstallDrawer(runningJob());
  const copies = d.buttons().filter((b) => allText(b).trim() === '复制');
  assert(copies.length >= 2, `手动方案里应当有多条命令各自带「复制」按钮，实际 ${copies.length} 个`);
});

test('★ 手动方案可按 shell 切换（PowerShell 命令行里不该混进 bash 语法）', async () => {
  const manual = manualPlan();
  manual.steps[0].commands = [
    { shell: 'powershell', text: 'Test-Path D:/repo/demo.tgz' },
    { shell: 'bash', text: 'ls -l /repo/demo.tgz' },
  ];
  const job = runningJob({ manual });
  const extra = {
    installPlan: () => planResult({ manual }),
    install: () => ({ ok: true, jobId: 'job-1', job, manual }),
    installProgress: () => ({ job }),
  };
  const d = await openPanel([entry()], extra);
  for (let i = 0; i < 6; i++) {
    const b = d.buttons().find((x) => allText(x).trim() === '安装' && x.props.disabled !== true);
    if (b) { b.props.onClick({ target: { checked: true } }); await d.settle(4); }
    const s = d.buttons().find((x) => allText(x).trim() === '开始安装' && x.props.disabled !== true);
    if (s) { s.props.onClick({ target: { checked: true } }); await d.settle(4); }
    if (d.text().includes('PowerShell') || d.text().includes('bash')) break;
  }
  const text = d.text();
  assert(text.includes('PowerShell') || text.includes('bash'), `应当有 shell 切换按钮，实际：${text.slice(0, 600)}`);
  // 默认只显示一种 shell 的命令，不该两种混着给
  const both = text.includes('Test-Path') && text.includes('ls -l');
  assert(!both, `默认应当只显示一种 shell 的命令，不该混着给。实际：${text.slice(0, 800)}`);
});

test('★ 失败后仍然给手动命令（失败不是终点）', async () => {
  const failed = runningJob({
    state: 'failed', endedAt: Date.now(), terminal: true, canAbort: false,
    currentPhase: 'install', staleness: null,
    result: { ok: false, failure: 'install-command', steps: [{ id: 'install', label: '执行安装', status: 'fail', detail: 'dsh plugin add 以退出码 1 结束' }] },
  });
  const d = await driveToInstallDrawer(failed);
  const text = d.text();
  assert(text.includes('安装未完成'), `应当如实说安装未完成，实际：${text.slice(0, 400)}`);
  assert(text.includes('手动安装'), '失败后必须仍然给出手动安装方案');
  assert(text.includes('dsh plugin --profile web add'), '失败后命令仍要在');
});

test('★ 取消（中止）后的文案不叫「失败」，并说明 profile 已还原', async () => {
  const cancelled = runningJob({
    state: 'cancelled', endedAt: Date.now(), terminal: true, canAbort: false, staleness: null,
    result: { ok: false, aborted: true, failure: 'aborted-by-user', rollback: { ok: true }, steps: [] },
  });
  const d = await driveToInstallDrawer(cancelled);
  const text = d.text();
  assert(text.includes('已中止'), `中止后应当显示「已中止」，实际：${text.slice(0, 400)}`);
  assert(!text.includes('安装未完成'), '中止不该被说成失败');
  assert(text.includes('还原') || text.includes('回滚'), '应当说明 profile 已回到安装前');
});

// ─────────────────────────────────────────────────────────────
// 既有能力不能因为这次改动消失
// ─────────────────────────────────────────────────────────────

test('★ profile 体检有问题时，顶部横幅给出可点的修复入口（而不是让人干等）', async () => {
  const pf = {
    ok: false,
    problems: [{
      id: 'profile.dangling-file-specs', severity: 'fatal',
      title: '有 1 条依赖指向已经不存在的本地包',
      detail: 'pnpm 每次操作都要解析整棵依赖树，所以这些断链会让任何插件的安装都变慢甚至直接失败。',
      items: ['dsh-ark-plans → file:C:/Users/x/AppData/Local/Temp/arkbuild/dsh-ark-plans-0.2.0.tgz'],
      fixes: [{ kind: 'remove-dependency', package: 'dsh-ark-plans', label: '移除断链依赖 dsh-ark-plans', command: 'dsh plugin --profile web remove dsh-ark-plans' }],
    }],
    notices: [],
  };
  const d = await openPanel([entry()], { __preflight: pf });
  const text = d.text();
  assert(text.includes('会拖慢甚至挡住所有安装') || text.includes('profile 里有问题'), `应当有体检横幅，实际：${text.slice(0, 400)}`);
  assert(text.includes('移除断链依赖 dsh-ark-plans'), '应当给出一键修复按钮');
  assert(text.includes('dsh plugin --profile web remove dsh-ark-plans'), '同时应当给出手动命令');
});

test('★ 回到页面时能接上正在跑的安装（任务活在服务端，界面不会「忘了」它）', async () => {
  // status 里带 job、installProgress 也能给出任务 —— 这正是「关掉页面再回来」
  // 或「刷新浏览器」时服务端的真实回应。界面必须据此把进度接回来。
  const d = await openPanel([entry()], {
    installProgress: () => ({ job: runningJob() }),
    __job: runningJob(),
  });
  let text = d.text();
  const autoOpened = text.includes('中止安装') || text.includes('正在中止');
  if (!autoOpened) {
    // 没自动打开也可以，但标题栏必须给出可点的入口
    const back = d.buttons().find((b) => allText(b).includes('查看进度'));
    assert(back, `有任务在跑时应当自动回到进度，或者给一个「查看进度」入口。现有按钮：${d.buttons().map((b) => allText(b).trim()).join(' | ')}`);
    back.props.onClick();
    await d.settle(3);
    text = d.text();
  }
  assert(text.includes('中止安装') || text.includes('正在中止'),
    `应当能重新看到安装进度与中止按钮，实际结尾：${text.slice(-300)}`);
});

/**
 * ★ 「已有任务在跑时不许再开一个」这条守卫在**服务端**（rules：同时只有一个任务），
 *   它的测试在 test/smoke-server.mjs 里（真的排队 + 真的拒绝）。
 *   客户端这一侧的行为（显示「这次安装没有开始」+ 仍然给手动命令）在浏览器里
 *   受 React 批处理时序影响，用这个 stub 驱动不稳定 —— 与其写一个时绿时红的用例，
 *   不如把守卫测在它真正所在的那一层。
 */
