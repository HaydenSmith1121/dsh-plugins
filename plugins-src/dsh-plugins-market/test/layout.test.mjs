/**
 * 安装布局测试 —— 针对**打包后的产物**（lib/），而不是源码树。
 *
 * 为什么单独写这一组：源码树里服务器半在 `src/server/*.js`，打包后平铺到 `lib/*.js`，
 * 两者的相对深度不同。第一版 `pluginDir()` 写的是「往上两层」，在源码里正确、
 * 装到 profile 后却指向**包的父目录** —— 代码照常运行，只是 catalog/*.json 与
 * package.json 全部读不到，界面表现为「目录空、版本号是 ?」。
 *
 * 这类错「能跑但全错」，只测源码树是发现不了的，所以这里直接 import lib/ 下的产物。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { suite, test, assert, eq, BUILT, PKG_ROOT as PKG, REPO_ROOT, importBuilt } from './harness.mjs';

suite('installed layout / lib');

test('pluginDir() 在打包布局下指向包根', async () => {
  const { pluginDir } = await importBuilt('lib/util.js');
  const dir = pluginDir();
  eq(path.resolve(dir), path.resolve(BUILT), 'pluginDir() 应当解析到包根，而不是它的父目录');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  eq(manifest.name, 'dsh-plugins-market', '包里读到的应当是本插件自己的 package.json');
});

test('包内资源在打包布局下都读得到', async () => {
  const { pluginDir } = await importBuilt('lib/util.js');
  const dir = pluginDir();
  for (const rel of ['catalog/verified.json', 'catalog/compat-snapshot.json', 'catalog/curated.json', 'cordis.patch.yml', 'lib/client.js']) {
    assert(fs.existsSync(path.join(dir, rel)), `打包后应当存在 ${rel}`);
  }
});

test('源码树里不再混入构建产物', () => {
  // 构建脚本曾经把生成的 package.json / README.md / lib/ 直接写回包根，
  // 结果「源码」被自己的产物覆盖。产物应当只出现在 .build/ 里。
  for (const rel of ['lib', 'catalog']) {
    assert(!fs.existsSync(path.join(PKG, rel)), `源码树里不应出现 ${rel}/（那是构建产物，应当在 .build/ 下）`);
  }
  const readme = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8');
  assert(readme.length > 500, '源码树的 README.md 应当是真文档，而不是构建脚本写的占位符');
});

test('loadVerified() 的条数与兼容矩阵一致，且含本插件自己', async () => {
  const { loadVerified } = await importBuilt('lib/catalog.js');
  // ★ preferRemote:false —— 这里测的是**包内兜底那份**的内容形态（离线可用性），
  // 不该让单元测试依赖网络。远程优先那条路有专门的 catalog-refresh.test.mjs 覆盖。
  const v = await loadVerified({ preferRemote: false });
  assert(v.available, `verified 目录不可用：${v.error}`);

  // 刻意不写死数字：仓库会继续加插件（并行的另一条会话刚加了 dsh-memory）。
  // 唯一的不变量是「目录条数 == 兼容矩阵里该 runtime 的插件数」。
  const compat = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'compatibility.json'), 'utf8'));
  const runtime = compat.runtimes.find((r) => r.status === 'supported' && r.recommended);
  eq(v.plugins.length, runtime.plugins.length, '目录条数应等于兼容矩阵里的插件数');

  for (const p of v.plugins) {
    if (p.id === 'dsh-plugins-market') {
      eq(p.sha256, null, '自引用条目无法自包含 hash，应当为 null 并附说明');
      assert(p.sha256Note, '自引用条目必须说明为什么没有校验和');
    } else {
      assert(p.sha256?.length === 64, `${p.id} 缺少 sha256`);
    }
    assert(p.install.tarball, `${p.id} 缺少 tarball 路径`);
    assert(p.summary, `${p.id} 缺少展示用的简介（verified-meta.json 没覆盖到？）`);
  }
  assert(v.plugins.some((p) => p.id === 'dsh-plugins-market'), '本插件应当把自己也列进目录');
  assert(v.plugins.length >= 9, `目录至少应含仓库原有 8 个 + 本插件，实际 ${v.plugins.length}`);
});

test('自引用 tarball 的实际 sha256 有边车文件可查', () => {
  // ★ 版本号必须从源头读，不能写死。
  //   写死的话每次 bump 版本都要回来改测试，改漏了会以「边车文件找不到」的形式失败 ——
  //   看起来像构建坏了，其实是测试过期了。
  //   tarball 路径的唯一来源是 compatibility.json 里那条自引用条目。
  const compat = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'compatibility.json'), 'utf8'));
  const runtime = compat.runtimes.find((r) => r.status === 'supported' && r.recommended);
  const self = runtime.plugins.find((p) => p.package === 'dsh-plugins-market');
  assert(self, '兼容矩阵里应当有 dsh-plugins-market 这一条');

  const tgz = path.join(REPO_ROOT, self.tarball);
  const sidecar = `${tgz}.sha256`;
  assert(fs.existsSync(tgz), `自引用条目指向的 tarball 应当已构建出来：${tgz}`);
  assert(fs.existsSync(sidecar), `自引用条目的 hash 应当落在边车文件里：${sidecar}`);
  const text = fs.readFileSync(sidecar, 'utf8').trim();
  assert(/^[0-9a-f]{64}\s+/.test(text), '边车文件应当是 "sha256  <文件名>" 格式');
  assert(text.includes(`${self.package}-${self.version}.tgz`), `边车文件应当对应 ${self.package}-${self.version}.tgz`);

  // 并且要与磁盘上的 tarball 真的一致
  const actual = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  eq(text.split(/\s+/)[0], actual, '边车文件里的 hash 必须与 tarball 实际 hash 一致');
});

suite('installed layout / repo 探测');

test('从 profile 的 file: 规格反推仓库根（正斜杠形态）', async () => {
  // pnpm 写进 package.json 的是正斜杠（file:D:/deepseek/...），而 Windows 上 path.sep
  // 是反斜杠。第一版用 path.sep 拼 marker，导致 indexOf 永远 -1、检测静默失败。
  const { detectEnvironment } = await importBuilt('lib/util.js');
  const env = detectEnvironment(process.env);

  // 复刻 index.js 的探测逻辑（它没有导出，这里用等价实现验证路径处理）
  const PLUGIN_PACKAGE = 'dsh-plugins-market';
  const profilesDir = path.join(env.home, 'profiles');
  assert(fs.existsSync(profilesDir), `测试前置：${profilesDir} 应当存在`);

  let found = null;
  for (const name of fs.readdirSync(profilesDir)) {
    const manifestPath = path.join(profilesDir, name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const spec = manifest?.dependencies?.[PLUGIN_PACKAGE];
    if (typeof spec !== 'string') continue;
    const m = /^(?:file|link):(.+)$/.exec(spec.trim());
    if (!m) continue;
    const specPath = m[1].replace(/\\/g, '/');
    const idx = specPath.indexOf(`/plugins/${PLUGIN_PACKAGE}/`);
    if (idx <= 0) continue;
    const native = path.normalize(specPath.slice(0, idx));
    if (fs.existsSync(path.join(native, 'compatibility.json'))) found = native;
  }

  assert(found, '应当能从 profile 规格里反推出仓库根（若为 null，说明分隔符归一化又漏了）');
  assert(fs.existsSync(path.join(found, 'compatibility.json')), '推出来的仓库根里应当有 compatibility.json');
  assert(fs.existsSync(path.join(found, 'plugins')), '推出来的仓库根里应当有 plugins/');
});

test('生产 profile 里那份过期的 file: 依赖应当被检出（本仓库真实存在的隐患）', async () => {
  // 这不是「造出来」的用例：两种情况在本机真实存在过 ——
  //   生产 profile 指向 dsh-session-cleanup-0.1.1.tgz（仓库里已删）
  //   隔离 profile 曾指向 dsh-session-cleanup-0.1.0.tgz（仓库里已删）
  // 只要引用还在，之后**任何** pnpm install / dsh plugin 操作都会失败。
  // 闸门必须能把它检出来并硬拦（overridable: false）。
  const { runGate } = await importBuilt('lib/gate.js');
  const { readJsonSafe } = await importBuilt('lib/util.js');
  const { readProfileState, scanInstalled, composedTree, resolveLocalSpecPath } = await importBuilt('lib/profile.js');
  const { detectEnvironment } = await importBuilt('lib/util.js');
  const { normalizeEntry } = await importBuilt('lib/catalog.js');

  const prodHome = path.join(process.env.USERPROFILE ?? '', '.dsh');
  const prodProfile = path.join(prodHome, 'profiles', 'web', 'package.json');
  if (!fs.existsSync(prodProfile)) {
    assert(true, '本机没有生产 profile，跳过'); // 不算失败
    return;
  }
  const manifest = readJsonSafe(prodProfile);
  const dangling = Object.entries(manifest?.dependencies ?? {})
    .map(([name, spec]) => ({ name, spec, local: resolveLocalSpecPath(spec, path.dirname(prodProfile)) }))
    .filter((d) => d.local && !fs.existsSync(d.local));

  if (dangling.length === 0) {
    assert(true, '生产 profile 目前没有悬空的 file: 依赖（已被修复），跳过');
    return;
  }

  // 有悬空依赖时：闸门必须硬拦，且不可覆盖
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = prodHome;
  try {
    const env = detectEnvironment(process.env);
    const profile = 'web';
    const ctx = {
      env,
      compat: readJsonSafe(path.join(PKG, 'catalog', 'compat-snapshot.json')) ?? {},
      profileState: readProfileState(profile, process.env),
      installed: scanInstalled(profile, process.env),
      tree: composedTree(profile, process.env, { launcher: env.dsh.launcher }),
      repoRoot: path.resolve(PKG, '..', '..'),
      repoRawBase: 'https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main',
    };
    ctx.compat = { ...ctx.compat, available: true, runtimes: ctx.compat.runtimes ?? [], inBoxBundles: ctx.compat.inBoxBundles ?? [] };
    const entry = normalizeEntry({ id: 'dsh-ark-plans', package: 'dsh-ark-plans', version: '0.1.0', install: {} }, 'community');
    const report = runGate(entry, ctx, { acknowledgeRisk: true });
    const check = report.checks.find((c) => c.id === 'profile.file-specs');
    eq(check?.status, 'fail', '应当检出悬空的 file: 依赖');
    eq(check?.overridable, false, '这一项必须不可覆盖');
    eq(report.canInstall, false, '存在悬空依赖时必须拦住安装');
    assert(
      report.blockedBy.includes('profile.file-specs'),
      `blockedBy 应当含 profile.file-specs，实际：${report.blockedBy.join(',')}`,
    );
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  }
});
