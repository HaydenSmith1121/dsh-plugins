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
  // 包内只放**离线兜底目录**：派生索引 + tier=verified 的逐条配置文件。
  // 完整目录（7000+ 条）不进包 —— 那会让每次目录变化都必须重打市场包。
  for (const rel of [
    'catalog/index.json',
    'catalog/plugins/dsh-plugins-market.json',
    'catalog/compat-snapshot.json',
    'cordis.patch.yml',
    'lib/client.js',
  ]) {
    assert(fs.existsSync(path.join(dir, rel)), `打包后应当存在 ${rel}`);
  }
  // 反过来的不变量：完整目录与采集脚本**不能**被打进包里
  for (const rel of ['catalog/plugins/zzz.json', 'scripts', 'catalog/overrides']) {
    assert(!fs.existsSync(path.join(dir, rel)), `包里不该出现 ${rel}`);
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

test('包内兜底目录含本插件自己，且逐条配置齐备', async () => {
  const { loadCatalogIndex, loadPluginConfig, entryFromConfig } = await importBuilt('lib/catalog.js');
  const { resolveDataDir } = await importBuilt('lib/util.js');

  // ★ 先清掉单条配置的磁盘缓存。
  //   catalog-refresh.test.mjs 会往那里写一份**伪造的**「远程」配置；它留在磁盘上，
  //   后面的用例就会读到那份假数据 —— 表现为「包内兜底目录里的 sha256 是上一轮构建的」，
  //   看起来像是构建坏了，其实是测试之间互相污染。
  const cacheDir = path.join(resolveDataDir(), 'plugin-configs');
  fs.rmSync(cacheDir, { recursive: true, force: true });

  // ★ preferRemote:false —— 这里测的是**包内兜底那份**的内容形态（离线可用性），
  // 不该让单元测试依赖网络。远程优先那条路有专门的 catalog-refresh.test.mjs 覆盖。
  const idx = await loadCatalogIndex({ preferRemote: false });
  assert(idx.available, `包内目录不可用：${idx.error}`);

  // 刻意不写死数字：仓库会继续加插件。
  // 不变量是「包内兜底目录 == tier=verified 的那些」，而且市场自己必须在内。
  assert(idx.entries.length > 0, '包内兜底目录不能是空的');
  for (const p of idx.entries) {
    eq(p.tier, 'verified', `${p.id} 出现在包内兜底目录里就必须是 verified 层`);
    assert(p.slug, `${p.id} 缺少 slug —— 没有它就读不到这个插件的配置文件`);
    assert(p.summary, `${p.id} 缺少展示用的简介`);
  }

  const self = idx.entries.find((p) => p.package === 'dsh-plugins-market');
  assert(self, '本插件应当把自己也列进目录（否则面板里看不到引导插件、也升不了级）');

  // ★ 索引里没有安装字段是**设计如此**：真正要装的时候去读单条配置文件。
  //   这里逐条确认「读取配置文件 → 合并成可安装条目」这条路是通的。
  for (const p of idx.entries) {
    const { config, source, error } = await loadPluginConfig(p);
    assert(config, `${p.slug}: 读不到配置文件（来源 ${source}，${error ?? ''}）`);
    const merged = entryFromConfig(config, p);
    eq(merged.install.method, 'tarball', `${p.package} 的安装方法应当是 tarball`);
    assert(merged.install.tarball, `${p.package} 缺少 tarball 路径`);
    assert(merged.install.url, `${p.package} 缺少可下载地址`);

    if (p.package === 'dsh-plugins-market') {
      eq(merged.sha256, null, '自引用条目无法自包含 hash，应当为 null 并附说明');
      assert(merged.sha256Note, '自引用条目必须说明为什么没有校验和');
    } else {
      assert(merged.sha256?.length === 64, `${p.package} 缺少 sha256（tarball 无法校验字节）`);
    }
  }
});

test('★ 包内兜底目录是目录的稳定投影，不是副本', () => {
  // ★ 这条测的是**一个真实发生过的不动点**，不是洁癖。
  //
  //   兜底目录原本原样复制仓库里的记录，于是任何一次目录刷新都会改到包：
  //     · versionCheckedAt / metricsCheckedAt / source.lastSyncedAt 每次采集都前移；
  //     · stars / pushedAt 随上游仓库变化；
  //     · 索引顶层的 generatedAt「只要 7496 条里有一条变了它就变」。
  //   后果一：一个社区插件多了一颗 star 就要重打市场 tarball —— 而 tarball 路径按版本号定，
  //   字节变了路径没变，pnpm 会跳过解包，等于既没发出更新又在 git 里写了个二进制。
  //   后果二：CI 的「产物必须已提交」断言会自己把自己打红 —— 每日同步改了目录，
  //   包里嵌的是旧时间戳，于是构建出来的字节与已提交的不同，被报成「源码改了没重新构建」。
  //
  //   修法：进包前把这些**登记性**字段清空（清空而非删除，字段与仓库那份保持同形）。
  //   这里反过来断言「一个都不许漏」—— 漏掉任何一个，上面两条后果就会回来。
  const dir = BUILT;
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'catalog', 'index.json'), 'utf8'));

  eq(idx.generatedAt, null, '索引顶层的 generatedAt 描述「什么时候查的」，不该进包');
  if (idx.sourceIndex) {
    eq(idx.sourceIndex.generatedAt, null, '上游索引的生成时间会变，不该进包');
    eq(idx.sourceIndex.fetchedAt, null, '上游索引的抓取时间每次采集都变，不该进包');
    eq(idx.sourceIndex.count, null, '上游索引条数随上游增长而变，不该进包');
  }

  const volatile = ['versionCheckedAt', 'metricsCheckedAt', 'stars', 'forks', 'pushedAt'];
  const leaked = [];
  for (const p of idx.plugins) {
    for (const k of volatile) {
      if (p[k] !== undefined && p[k] !== null) leaked.push(`index.plugins[${p.slug}].${k}=${p[k]}`);
    }
  }

  // 逐条配置文件里也必须干净（它比索引多带 source 块）
  const cfgDir = path.join(dir, 'catalog', 'plugins');
  for (const f of fs.readdirSync(cfgDir)) {
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
    for (const k of volatile) {
      if (cfg[k] !== undefined && cfg[k] !== null) leaked.push(`${f}.${k}=${cfg[k]}`);
    }
    for (const k of ['firstSeenAt', 'lastSyncedAt']) {
      if (cfg.source?.[k] !== undefined && cfg.source?.[k] !== null) leaked.push(`${f}.source.${k}=${cfg.source[k]}`);
    }
  }
  eq(leaked, [], '包内兜底目录里不许留下登记性字段（每留下一个，目录的日常刷洗就会改到包）');
});

test('★ 自引用条目在包内既无 sha256 也无 bytes（同一个不动点）', () => {
  // sha256 那半边早就处理了；bytes 那半边是后来才发现的，而且更隐蔽：
  // 它不报错，只是让「采集 → 构建 → 采集」永远差一步 ——
  // 采集读到 tarball 是 147015 字节就写 147015，构建把记录打进包，包变成 147028 字节，
  // 下次采集再读 147028……每天产生一次「只有一个数字变了、而且永远是上一版」的提交。
  const cfg = JSON.parse(
    fs.readFileSync(path.join(BUILT, 'catalog', 'plugins', 'dsh-plugins-market.json'), 'utf8'),
  );
  eq(cfg.install.sha256, null, '自引用条目不能自包含校验和');
  eq(cfg.install.bytes, null, '自引用条目不能自包含字节数 —— 与 sha256 是同一个方程');
  assert(cfg.sha256Note, '剥掉之后必须留下说明，否则下一个读配置的人会以为是漏填');
  assert(!/\b\d{4,}\b/.test(cfg.sha256Note), '说明文字里不能出现具体数字：那会重新引入不动点');

  // 仓库里那份（采集脚本的产物）也必须留空 —— 光靠构建剥是不够的：
  // 采集填一个「上一版包的大小」，构建每次剥掉，两份文件就会长期不一致，
  // 而「不一致」本身又会以每日一次的单数字提交表现出来。两边都不填才是真的收敛。
  const repoCopy = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'catalog', 'plugins', 'dsh-plugins-market.json'), 'utf8'),
  );
  eq(repoCopy.install.sha256, null, '采集脚本不该把实测 hash 写进自引用条目');
  eq(repoCopy.install.bytes, null, '采集脚本不该把实测大小写进自引用条目 —— 那是上一个包的大小');
});

test('自引用 tarball 的实际 sha256 有边车文件可查', () => {
  // ★ 版本号与路径必须从源头读，不能写死 —— 写死的话每次 bump 版本都要回来改测试，
  //   改漏了会以「边车文件找不到」的形式失败，看起来像构建坏了，其实是测试过期了。
  //   路径的唯一来源是市场插件自己的配置文件（catalog/plugins/dsh-plugins-market.json）。
  const config = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'catalog', 'plugins', 'dsh-plugins-market.json'), 'utf8'),
  );
  assert(config.install?.tarball, '市场插件的配置文件里应当有 tarball 路径');
  assert(config.version, '市场插件的配置文件里应当有版本号');

  const tgz = path.join(REPO_ROOT, config.install.tarball);
  const sidecar = `${tgz}.sha256`;
  assert(fs.existsSync(tgz), `自引用条目指向的 tarball 应当已构建出来：${tgz}`);
  assert(fs.existsSync(sidecar), `自引用条目的 hash 应当落在边车文件里：${sidecar}`);
  const text = fs.readFileSync(sidecar, 'utf8').trim();
  assert(/^[0-9a-f]{64}\s+/.test(text), '边车文件应当是 "sha256  <文件名>" 格式');
  assert(
    text.includes(`dsh-plugins-market-${config.version}.tgz`),
    `边车文件应当对应 dsh-plugins-market-${config.version}.tgz`,
  );

  // 并且要与磁盘上的 tarball 真的一致
  const actual = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  eq(text.split(/\s+/)[0], actual, '边车文件里的 hash 必须与 tarball 实际 hash 一致');
});

suite('installed layout / repo 探测');

test('★ 从 profile 的 file: 规格反推仓库根（正斜杠形态）', async () => {
  // pnpm 写进 package.json 的是**正斜杠**（file:D:/deepseek/...），而 Windows 上
  // path.sep 是反斜杠。第一版用 path.sep 拼 marker，于是 indexOf 永远 -1、
  // 检测静默失败 —— 表现是「插件照常运行，只是把 tarball 又联网下了一遍」。
  //
  // ★ 这个用例**自己造条件**，不依赖「本机某个 profile 里恰好装过这个插件」。
  //   否则它在 CI（没有 dsh、没有 profile）上恒红、在开发机上恒绿，
  //   而那种测试很快就会被当成噪音忽略掉 —— 恰恰把要防的回归放走了。
  const { ensureTestProfile, TEST_HOME } = await import('./harness.mjs');
  ensureTestProfile({ home: TEST_HOME }); // 确保父目录存在（本用例只用它的 profiles/ 这一层）
  const home = TEST_HOME;

  const PLUGIN_PACKAGE = 'dsh-plugins-market';
  const profileName = '__repo-detect-probe';
  const profileDir = path.join(home, 'profiles', profileName);
  fs.mkdirSync(profileDir, { recursive: true });

  // 造一条**正斜杠**形态的 file: 规格，指向真实仓库里那个 tarball
  const version = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  const relSpec = `plugins/${PLUGIN_PACKAGE}/0.1.6-alpha.1/${PLUGIN_PACKAGE}-${version}.tgz`;
  const forwardSlashSpec = `file:${REPO_ROOT.replace(/\\/g, '/')}/${relSpec}`;
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'probe', private: true, dependencies: { [PLUGIN_PACKAGE]: forwardSlashSpec } }, null, 2)}\n`,
    'utf8',
  );

  try {
    // 复刻 index.js 的探测逻辑（它没有导出，这里用等价实现验证路径处理）
    const profilesDir = path.join(home, 'profiles');
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
      // 仓库根的判定标记：自 0.4.0 起是 catalog/index.json（目录才是市场仓库的本体），
      // compatibility.json 已经瘦身成只描述运行时矩阵，不能再当标记用。
      if (fs.existsSync(path.join(native, 'catalog', 'index.json'))) found = native;
    }

    assert(found, '应当能从 profile 规格里反推出仓库根（若为 null，说明分隔符归一化又漏了）');
    eq(path.resolve(found), path.resolve(REPO_ROOT), '推出来的应当正好是本仓库根');
    assert(fs.existsSync(path.join(found, 'catalog', 'index.json')), '推出来的仓库根里应当有 catalog/index.json');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
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
