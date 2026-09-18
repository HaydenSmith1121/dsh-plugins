/**
 * dsh-plugins-market —— 构建脚本
 *
 *   node plugins-src/dsh-plugins-market/build.mjs [--check]
 *
 * 它做四件事，全部是确定性的（同输入必得同输出）：
 *
 *   [1] 生成**包内离线兜底目录**
 *       从仓库根的 catalog/index.json 里筛出 `install.method === 'tarball'` 的条目
 *       （也就是**字节由本仓库或插件集合仓库托管**的那几条 —— 离线时真的装得上），
 *       连同每条对应的 catalog/plugins/<slug>.json 一起打进包内。
 *       ★ 完整目录（7000+ 条）**不进包**：打进包意味着每次目录变化都要重打市场包
 *         并换版本号，而那正是 0.4.0 要拆掉的东西。包内这份的作用只有一个 ——
 *         没网时市场至少还能把已验证插件列出来并装上。
 *
 *   [2] 生成 catalog/compat-snapshot.json
 *       运行时矩阵的包内快照。开发机上插件会优先读仓库里那份活的 compatibility.json，
 *       但装到别的机器上时包里必须有兜底。
 *
 *   [3] 组装 lib/ + 拷入 catalog/，生成最终 package.json
 *       客户端半**不打包、不转译** —— 源码 src/client/app.js 本身就是可运行的
 *       经典脚本（自注册 __ModuleLoader__ 工厂），直接拷成 lib/client.js。
 *       少一层构建，就少一类「产物与源码不一致」的故障。
 *
 *   [4] 产出 tarball 到 plugins/dsh-plugins-market/<dsh 版本>/
 *       目录结构与仓库既有约定一致（那一层是 dsh 运行时版本，不是插件版本）。
 *
 * ★ 改了源码之后有**两步**，缺一不可：
 *     node plugins-src/dsh-plugins-market/build.mjs   # 重打 tarball（版本号也要 bump）
 *     node scripts/sync-catalog.mjs                   # 刷新 catalog/plugins/dsh-plugins-market.json
 *   不重打 → tarball 还是旧的（CI 会用 git diff 拦下来）；
 *   不换版本号 → pnpm 会因 `file:` 路径没变而跳过解包，已装的人收不到更新；
 *   不跑 sync → 目录里还是旧版本号，本文件 [1] 的自注册校验会直接报错。
 *
 * --check 只做校验不写文件：用于 CI 与提交前自检（产物是否与源码一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PKG_NAME = 'dsh-plugins-market';
const CHECK_ONLY = process.argv.includes('--check');

/**
 * 产物一律落在**暂存目录**里，绝不写回源码树。
 *
 * 早先的版本把生成的 package.json / README.md / lib/ 直接写在包根上，结果
 * 「源码」和「产物」混在一起：源码里的 package.json 被生成版覆盖、
 * README.md 被一个 21 字节的占位符顶掉。构建不该改动它自己的输入。
 */
const STAGE_ROOT = path.join(HERE, '.build');
const STAGE = path.join(STAGE_ROOT, 'package');

/**
 * 归档里每个成员固定的 mtime。
 *
 * ★ 必须是**常量**，不能是 `Date.now()`。
 *
 *   tar 头部里存着每个文件的修改时间；用当前时间的话，同一个源码在同一台机器上
 *   连打两次也会得到不同的字节 —— 于是：
 *     · `.tgz.sha256` 每次都不一样，那个「权威校验和」变成一句空话；
 *     · 采集脚本写进目录的实测 hash 每次都变，目录天天产生无意义的 diff；
 *     · CI 里「build 之后 git diff 必须干净」这条检查永远失败。
 *   本文件头注释写着「确定性的（同输入必得同输出）」，这里就是兑现它的地方。
 *
 *   取值是一个固定的历史时刻（2024-01-01T00:00:00Z）。想让归档时间反映真实发版时间，
 *   请用 SOURCE_DATE_EPOCH 环境变量显式传入 —— 那也是可复现构建的通行做法。
 *
 * ★ 必须声明在**文件顶部**：底部的函数声明会提升，`const` 不会 ——
 *   放在文件末尾会以 "Cannot access 'MTIME' before initialization" 直接崩掉，
 *   而那时 tarball 还没写出来（症状是「构建好像成功了，产物却没变」）。
 */
const MTIME = (() => {
  const raw = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1704067200;
})();

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
let problems = 0;
const fail = (msg) => { problems++; console.error(`  ✗ ${msg}`); };

// ─────────────────────────────────────────────────────────────
// 读输入
// ─────────────────────────────────────────────────────────────

const compatPath = path.join(REPO, 'compatibility.json');
if (!fs.existsSync(compatPath)) {
  console.error(`找不到 ${compatPath} —— 请在仓库根目录结构完整的情况下运行。`);
  process.exit(3);
}
const compat = readJson(compatPath);
// 尽早读进来：自注册校验要用到版本号（它在文件后半段才第一次被用到）
const srcPkg = readJson(path.join(HERE, 'package.json'));

const runtime = (compat.runtimes ?? []).find((r) => r.status === 'supported' && r.recommended)
  ?? (compat.runtimes ?? []).find((r) => r.status === 'supported');

if (!runtime) {
  console.error('compatibility.json 里没有任何 status=supported 的 runtime，无法生成目录。');
  process.exit(3);
}

/**
 * ★ 自注册校验（bundles 那一半）。
 *
 * 市场插件的目录条目现在由 `catalog/overrides/self.json` 声明、由
 * `scripts/sync-catalog.mjs` 生成（见 [1] 那一节的自注册校验）。
 * 这里只剩**另一半**：compatibility.json 的 bundles 数组里必须有它 ——
 * 少了这一条，装进 profile 也不会被当成一个 bundle 层装配，市场根本不出现。
 */
if (!(runtime.bundles ?? []).includes(PKG_NAME)) {
  console.error('');
  console.error(`  ✗ compatibility.json 的 runtime ${runtime.dshVersion} 的 bundles 数组里没有 "${PKG_NAME}"。`);
  console.error('    请把它追加到数组末尾（安装顺序 = 层级顺序，市场排在最后）。');
  console.error('');
  process.exit(3);
}

log('');
log(`  dsh-plugins-market 构建${CHECK_ONLY ? '（仅校验）' : ''}`);
log(`  ${'-'.repeat(72)}`);
log(`  仓库            ${REPO}`);
log(`  dsh 运行时基线   ${runtime.dshVersion}（${runtime.distTag ?? '—'}）`);
log(`  市场版本         ${srcPkg.version}`);
log('');

// ─────────────────────────────────────────────────────────────
// [1] 打进包内的**离线兜底目录**
// ─────────────────────────────────────────────────────────────
//
// ★ 自 0.4.0 起，目录是「一个插件一个配置文件」：仓库根的
//   catalog/plugins/<slug>.json（全部 7000+ 条）+ catalog/index.json（派生索引）。
//   这些东西**不进包** —— 打进包意味着每次目录变化都要重打市场包并换版本号，
//   而那正是这一版要拆掉的东西（同一个 tarball 路径内容变了时 pnpm 会跳过解包，
//   不换版本号已装的人根本收不到）。
//
//   包里只放一份**很小的离线兜底**：**本仓库托管 tarball 的那几条**
//   （插件集合仓库里的 6 个 + 市场插件自己），也就是 `install.method === 'tarball'`
//   的那一批。作用是「没网时市场至少还能把收录的插件列出来并装上」，
//   而不是「离线目录全集」。
//
//   判据为什么是「有没有 tarball」：这些条目的字节由**我们自己的仓库**托管，
//   sha256 由构建 / 采集实测得出，离线也真的装得上。公开索引来的条目装的是
//   上游的 npm / GitHub 产物 —— 没网的时候列出来也装不了，塞进包里只是让包变大。
//   （0.5.0 之前这条判据写的是 `tier === 'verified'`；去掉信任分级之后，
//     分级字段没了，但**同一批条目**由「谁托管字节」这个更硬的事实筛出来。）

// ─────────────────────────────────────────────────────────────
// [0] 兜底目录必须是目录的**稳定投影**，不能是目录的副本
// ─────────────────────────────────────────────────────────────
//
// ★ 这是本文件第二个不动点问题（第一个是自引用条目的 sha256 / bytes）。
//
//   包内兜底目录如果原样复制仓库里的记录，那么**任何**一次目录刷新都会改到包：
//   `versionCheckedAt`、`metricsCheckedAt`、`source.firstSeenAt / lastSyncedAt`
//   这些登记性时间戳每次采集都会前移，`stars` / `pushedAt` 会随上游仓库变化，
//   索引顶层的 `generatedAt` 更是「只要 7496 条里有一条变了它就变」。
//
//   后果有两个，都很隐蔽：
//     ① 一个社区插件的 star 数变化，就要重打一份市场 tarball —— 而 tarball 路径
//        是按版本号定的，字节变了路径没变，pnpm 会跳过解包（见文件头注释），
//        于是「重新构建」既没让任何人收到更新，又在 git 里天天写进一个二进制；
//     ② CI 的「产物必须已提交」断言会**自己把自己打红**：每日同步改了目录 →
//        包里嵌的是旧时间戳 → 构建出来的字节与已提交的不同 → 报「源码改了没重新构建」，
//        可源码明明没改。
//
//   所以进包之前把这些**只对「什么时候查的」有意义、对「离线能装什么」毫无意义**的
//   字段清空。留下的才是兜底目录真正要回答的问题：这是哪个包、什么版本、从哪儿下、
//   校验和是多少。清空后，只有在**实质内容**（版本号 / 安装方式 / 仓库地址 / 说明）
//   真的变了的时候，包才会变 —— 那时也确实该重打。
//
//   注意这是**清空**不是**删除**：字段名和顺序保持与仓库里那份完全一致，
//   值退化为 `null`（运行时对这些字段本来就是 `?? null` 的写法，见 catalog.js）。

/** 登记性时间戳：回答「目录是什么时候查的」，对离线安装无用 */
const VOLATILE_RECORD_FIELDS = ['versionCheckedAt', 'metricsCheckedAt', 'stars', 'forks', 'pushedAt'];
/** 来源登记时间同理 */
const VOLATILE_SOURCE_FIELDS = ['firstSeenAt', 'lastSyncedAt'];

/** 清空一条记录里所有「登记性」字段，返回新对象（不改原对象） */
function stabilizeRecord(rec) {
  const out = { ...rec };
  for (const k of VOLATILE_RECORD_FIELDS) if (k in out) out[k] = null;
  if (out.source && typeof out.source === 'object') {
    out.source = { ...out.source };
    for (const k of VOLATILE_SOURCE_FIELDS) if (k in out.source) out.source[k] = null;
  }
  return out;
}

log('  [1/4] 生成包内离线兜底目录（catalog/index.json + catalog/plugins/）');



const repoIndexFile = path.join(REPO, 'catalog', 'index.json');
const repoIndex = fs.existsSync(repoIndexFile) ? readJson(repoIndexFile) : null;
if (!repoIndex) {
  fail('仓库根没有 catalog/index.json —— 请先运行 node scripts/sync-catalog.mjs');
}

/**
 * 进包的是**本仓库托管字节**的那几条：`install.method === 'tarball'`。
 *
 * ★ 0.5.0 之前这里写的是 `p.tier === 'verified'`。去掉信任分级之后 tier 字段没了，
 *   但**同一批条目**由「谁托管字节」这个更硬的事实筛出来 —— 判据从
 *   「我们给它打了个已验证的标签」变成「这个包的字节就在我们自己的仓库里」，
 *   后者不依赖任何人的判断，也不会因为标签体系变动而漏项。
 */
const bundledEntries = (repoIndex?.plugins ?? [])
  .filter((p) => p.installMethod === 'tarball')
  .map(stabilizeRecord);
if (bundledEntries.length === 0) {
  fail('catalog/index.json 里没有任何 installMethod=tarball 的条目 —— 包内兜底目录会是空的，没网时市场将列不出任何插件。');
}

/**
 * 索引顶层的 `generatedAt`、以及上游索引的抓取元信息，和上面那些字段是同一类：
 * 它们描述的是「这次采集发生在什么时候」。只要 7496 条里有**任何一条**变了，
 * `generatedAt` 就会前移 —— 拿它进包等于「目录一有风吹草动就重打市场包」。
 * 兜底目录要回答的是「离线时有哪些插件可装」，不是「目录是什么时候查的」，所以清空。
 * `url` 保留：它是稳定信息，也是排查「这份兜底是哪来的」时唯一的线索。
 */
const bundledSourceIndex = repoIndex?.sourceIndex
  ? { ...repoIndex.sourceIndex, generatedAt: null, fetchedAt: null, count: null }
  : null;

/** 包内 index.json：字段与仓库根那份一致，只是只留「本仓库托管 tarball」的那几条 */
const bundledIndex = {
  schemaVersion: repoIndex?.schemaVersion ?? 1,
  generatedAt: null,
  sourceIndex: bundledSourceIndex,
  counts: {
    total: bundledEntries.length,
  },
  note: '包内离线兜底目录：只含 installMethod=tarball 的条目 —— 也就是字节由本仓库'
    + '（或插件集合仓库）托管、离线也真的装得上的那几个（市场运行时会去仓库 raw 拉完整目录）。'
    + '登记性字段（时间戳 / star 数 / 上游抓取元信息）一律为 null —— 它们是目录的「查询记录」而不是「内容」，'
    + '进了包就会让每次目录刷新都改到包，详见 build.mjs 的 [0] 一节。',
  plugins: bundledEntries,
};

/** 每条兜底条目对应的配置文件原文（运行时读不到远程时用它兜底） */
const bundledConfigs = [];
for (const e of bundledEntries) {
  const file = path.join(REPO, 'catalog', 'plugins', `${e.slug}.json`);
  if (!fs.existsSync(file)) {
    fail(`包内兜底目录需要 catalog/plugins/${e.slug}.json，但仓库里没有`);
    continue;
  }
  let text = readText(file);

  /**
   * ★ 进包前做两件事，都是「让包只取决于内容、不取决于时刻」：
   *
   *   ① 清空登记性字段（见 [0] 一节）：`versionCheckedAt` / `stars` / `source.lastSyncedAt` …
   *      这些每次采集都会变，但它们不改变「离线能装什么」。
   *
   *   ② 自引用条目的 sha256 与 bytes 必须**在包内留空**。
   *
   *   本包内含它自己的目录条目；若那条记录里带着自己的 sha256 或字节数，就构成不动点：
   *   tarball 的字节取决于记录里的值，而那个值又取决于 tarball 的字节。
   *   一旦有人（或某次采集）把它填上，打出来的包就会带着一个**必然过期**的数值 ——
   *   校验和那半边会让闸门对自己报「sha256 不一致，tarball 可能被替换」并硬拦升级；
   *   大小那半边更安静，只是让「构建 → 采集 → 构建」永远差一步，CI 的产物一致性检查天天变红。
   *
   *   所以这里显式剥掉，而不是指望采集脚本永远不填 —— 让不变量由构建来保证。
   *   采集脚本那边也留了空（scripts/sync-catalog.mjs），两边各管一道。
   */
  const cfg = stabilizeRecord(JSON.parse(text));
  if (cfg.package === PKG_NAME) {
    const stripped = [];
    if (cfg.install?.sha256) stripped.push('sha256');
    if (cfg.install?.bytes) stripped.push('bytes');
    if (cfg.install?.sha256) cfg.install.sha256 = null;
    if (cfg.install?.bytes) cfg.install.bytes = null;
    if (stripped.length) {
      cfg.sha256Note = '（包内副本）自引用条目无法自包含校验和与大小：本包内含这份目录，'
        + '写进自己的 sha256 / bytes 会形成不动点。权威值见仓库里那份配置与同目录的 .tgz.sha256 边车文件。';
      log(`      包内副本：已剥掉自引用条目的 ${stripped.join(' / ')}（否则会在升级时稳定地产生假警报）`);
    }
  }
  text = `${JSON.stringify(cfg, null, 2)}\n`;

  bundledConfigs.push([`catalog/plugins/${e.slug}.json`, text]);
}

// 自注册校验：市场自己必须在兜底目录里，否则用户看不到引导插件、也没法从面板里升级它
const selfInBundle = bundledEntries.find((p) => p.package === PKG_NAME);
if (!selfInBundle) {
  fail(`catalog/index.json 里没有 ${PKG_NAME} 这一条（它的 installMethod 必须是 tarball）。`
    + '没有它，市场不会把自己列出来，用户也就无法从面板里升级引导插件。'
    + '它由 catalog/overrides/self.json 声明 —— 检查那个文件，然后重跑 scripts/sync-catalog.mjs。');
} else if (selfInBundle.version !== srcPkg.version) {
  fail(`catalog/index.json 里 ${PKG_NAME} 的版本是 ${selfInBundle.version}，`
    + `而源码 package.json 是 ${srcPkg.version} —— 目录过期了，请重跑 scripts/sync-catalog.mjs。`);
} else {
  log(`      包内兜底：${bundledEntries.length} 条（${bundledEntries.map((p) => p.package ?? p.id).join('、')}）`);
}

// ─────────────────────────────────────────────────────────────
// [2] compat-snapshot.json
// ─────────────────────────────────────────────────────────────

log('  [2/4] 生成 catalog/compat-snapshot.json');

// 包内快照只保留判定需要的字段，不把整份文档（含长篇 notes）塞进去
const compatSnapshot = {
  schemaVersion: compat.schemaVersion,
  snapshotOf: compat.updated ?? null,
  profile: compat.profile ?? 'web',
  requirements: compat.requirements ?? {},
  distTags: compat.distTags ?? {},
  inBoxBundles: compat.inBoxBundles ?? [],
  allowBuilds: compat.allowBuilds ?? null,
  runtimes: (compat.runtimes ?? []).map((r) => ({
    dshVersion: r.dshVersion,
    distTag: r.distTag ?? null,
    status: r.status,
    recommended: Boolean(r.recommended),
    reason: r.reason ?? null,
    upgradeTo: r.upgradeTo ?? null,
    danger: r.danger ?? null,
    verifiedAt: r.verifiedAt ?? null,
    installCommand: r.installCommand ?? null,
  })),
};

// ─────────────────────────────────────────────────────────────
// [3] 组装 lib/ 与最终 package.json
// ─────────────────────────────────────────────────────────────

log('  [3/4] 组装 lib/ 与 catalog/');

// srcPkg 已在文件顶部读取（自注册校验要用），这里不再重复声明
const clientSrc = path.join(HERE, 'src', 'client', 'app.js');
const serverSrc = path.join(HERE, 'src', 'server', 'index.js');

if (!fs.existsSync(clientSrc)) fail(`缺少客户端半源码：${clientSrc}`);
if (!fs.existsSync(serverSrc)) fail(`缺少服务器半源码：${serverSrc}`);

const serverFiles = fs.existsSync(path.join(HERE, 'src', 'server'))
  ? fs.readdirSync(path.join(HERE, 'src', 'server')).filter((f) => f.endsWith('.js'))
  : [];

// 客户端半的自检：这些错误一旦出现就是「整个页面的插件树起不来」，必须在打包前拦住
if (fs.existsSync(clientSrc)) {
  const text = readText(clientSrc);
  const checks = [
    [new RegExp(`__ModuleLoader__\\s*\\.\\s*load\\s*\\(`), '缺少 window.__ModuleLoader__.load(...) 自注册'],
    [new RegExp(`id\\s*:\\s*["']${PKG_NAME}["']`), `load() 的 id 必须严格等于包名 "${PKG_NAME}"`],
    [/\bfactory\s*:\s*\(?\s*require\s*\)?\s*=>/, '缺少 factory(require) 工厂'],
    [/exports\s*\.\s*apply\s*=/, '缺少 exports.apply'],
    [/exports\s*\.\s*inject\s*=/, '缺少 exports.inject'],
  ];
  for (const [re, msg] of checks) if (!re.test(text)) fail(`客户端半 ${msg}`);

  // 经典脚本里出现 ESM 语法 = SyntaxError = 整页白屏
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/^\s*(import|export)\s/m.test(stripped)) {
    fail('客户端半含 import/export 语句 —— 它是经典脚本，这会导致 SyntaxError 并让整页功能加载失败');
  }
  if (/^\s*await\s/m.test(stripped) && !/async\s+function/.test(stripped)) {
    fail('客户端半疑似含顶层 await —— 经典脚本不支持');
  }
  if (!/data-plugin/.test(text) || !/data-plugin-css/.test(text)) {
    warn('  ! 客户端半没有按约定给 <style> 打 data-plugin / data-plugin-css 标记（HMR 会无法正确回收样式）');
  }
  if (/sidebar\.panellist/.test(text) && !/slots\s*\.\s*inject\s*\(\s*["']sidebar\.panellist["']/.test(text)) {
    fail('客户端半直接 register 了 sidebar.panellist —— 必须先 slots.inject(slotKey, cb)');
  }
} else {
  fail('客户端半源码不存在，跳过自检');
}

// 把包名/版本写进客户端半的调试标记（保持源码可读，产物带版本）
const builtClient = fs.existsSync(clientSrc)
  ? readText(clientSrc).replace('__DPM_VERSION__', srcPkg.version)
  : '';

const builtPackageJson = {
  ...srcPkg,
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },
    client: { platform: 'web', inject: [], external: [] },
    market: { profile: 'web' },
  },
};

// 包内目录清单（全部写进暂存目录，源码树保持干净）
const readmeSrc = path.join(HERE, 'README.md');
if (!fs.existsSync(readmeSrc) || readText(readmeSrc).length < 200) {
  fail('包根缺少像样的 README.md（会原样进包，也是 npm/GitHub 上的门面）');
}
const filesToWrite = [];
filesToWrite.push(['package.json', `${JSON.stringify(builtPackageJson, null, 2)}\n`]);
filesToWrite.push(['cordis.patch.yml', readText(path.join(HERE, 'cordis.patch.yml'))]);
filesToWrite.push(['README.md', fs.existsSync(readmeSrc) ? readText(readmeSrc) : `# ${PKG_NAME}\n`]);
filesToWrite.push(['LICENSE', fs.existsSync(path.join(HERE, 'LICENSE')) ? readText(path.join(HERE, 'LICENSE')) : 'MIT\n']);
filesToWrite.push(['lib/client.js', builtClient]);
filesToWrite.push(['catalog/index.json', `${JSON.stringify(bundledIndex, null, 2)}\n`]);
filesToWrite.push(['catalog/compat-snapshot.json', `${JSON.stringify(compatSnapshot, null, 2)}\n`]);
for (const [rel, content] of bundledConfigs) filesToWrite.push([rel, content]);
for (const f of serverFiles) {
  filesToWrite.push([`lib/${f}`, readText(path.join(HERE, 'src', 'server', f))]);
}

if (!CHECK_ONLY) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const [rel, content] of filesToWrite) {
    const dst = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, 'utf8');
  }
  log(`      暂存目录 ${path.relative(HERE, STAGE)}：lib/ ${serverFiles.length + 1} 个文件，catalog/ ${bundledConfigs.length + 2} 个文件`);
} else {
  // 校验模式：比对暂存目录里的产物是否与将要生成的一致
  for (const [rel, content] of filesToWrite) {
    const dst = path.join(STAGE, rel);
    if (!fs.existsSync(dst)) { fail(`--check：产物缺失 ${rel}`); continue; }
    if (readText(dst) !== content) {
      fail(`--check：产物与源码不一致 ${rel} —— 请重跑 build.mjs`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 确定性的 gzip 容器
// ─────────────────────────────────────────────────────────────
//
// ★ gzip 头自己写，不用 `zlib.gzipSync`。
//
//   原因只有一条，但代价很大：zlib 往 gzip 头的第 9 字节写的是**编译期**确定的 OS 码
//   —— Windows 上 0x0a、Linux 上 0x03，第 8 字节还会按档位写 XFL。于是同一份源码
//   在 Windows 与 Linux 上构建出来的 tarball **长度一模一样、内容差两个字节**，
//   sha256 自然不同。
//
//   实测代价（真发生过）：本地 Windows 构建并提交 → CI（ubuntu）跑
//   「产物必须已提交，且内容一致」，报「源码改了没重新构建」，
//   而源码一个字节都没改。CI 的 diff 长这样：`Bin 147047 -> 147047 bytes` ——
//   同长不同内容，正是这两个字节。看的人会先去翻源码，翻到最后才发现是压缩器的头。
//
//   接管容器的收益不只是「少两个字节」：MTIME 也一起钉成 0，
//   OS 写 255 = unknown（RFC 1952 就是为「与平台无关」留的这个取值）。
//   压缩体仍旧交给 `zlib.deflateRawSync` —— 那才是真正干活的部分，
//   各平台的 deflate 实现一致（实测：Node 22.19 与 24.14 逐字节相同）。
function gzipDeterministic(buf) {
  const raw = zlib.deflateRawSync(buf, { level: 9 });
  const head = Buffer.from([
    0x1f, 0x8b,             // magic
    0x08,                   // CM = deflate
    0x00,                   // FLG = 0（无额外字段、无文件名、无注释）
    0x00, 0x00, 0x00, 0x00, // MTIME = 0（不把构建时刻写进产物，理由同 MTIME 那一节）
    0x00,                   // XFL = 0（不声明档位：那是本实现的细节，写死反而更难对齐）
    0xff,                   // OS = 255 = unknown —— 跨平台构建必须是这个值
  ]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(buf), 0);      // CRC32（Node ≥ 22.2 自带）
  trailer.writeUInt32LE(buf.length >>> 0, 4);     // ISIZE
  return Buffer.concat([head, raw, trailer]);
}

// ─────────────────────────────────────────────────────────────
// [4] 打包 tarball
// ─────────────────────────────────────────────────────────────

log('  [4/4] 打包 tarball');

const outDir = path.join(REPO, 'plugins', PKG_NAME, runtime.dshVersion);
const tgzName = `${PKG_NAME}-${srcPkg.version}.tgz`;
const tgzPath = path.join(outDir, tgzName);

if (problems > 0) {
  console.error('');
  console.error(`  构建中止：有 ${problems} 个问题需要先修好（没有写任何产物）。`);
  console.error('');
  process.exit(1);
}

if (!CHECK_ONLY) {
  const members = [];
  const walk = (absDir, relPrefix) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else members.push({ rel, abs });
    }
  };
  // 直接从暂存目录打包：该进包的东西都在那里，不会夹带源码
  walk(STAGE, '');
  members.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const tarBuf = makeTar(members.map((m) => ({ name: `package/${m.rel}`, data: fs.readFileSync(m.abs) })));
  const gz = gzipDeterministic(tarBuf);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tgzPath, gz);

  // 自引用条目的实际 hash 落在这里（见 [1] 的说明：它无法自包含进包内目录）
  const selfHash = sha256(tgzPath);
  fs.writeFileSync(`${tgzPath}.sha256`, `${selfHash}  ${tgzName}\n`, 'utf8');

  log(`      ${path.relative(REPO, tgzPath)}  ${kb(gz.length)}  ${members.length} 个文件`);
  log(`      sha256 ${selfHash}`);
  log(`      （已写入 ${tgzName}.sha256；自引用条目的 hash 不进包内目录，原因见 build.mjs 注释）`);
  log('');
  log(`  ✓ 构建完成。装进隔离环境：`);
  log(`      node scripts/dev-env.mjs install "${tgzPath}"`);
  log(`      ⚠ 同一个 tarball 路径内容变了时，pnpm 会跳过解包 —— 必须 remove 再 add。`);
  log('');
} else {
  log('      （--check 模式，未写盘）');
  log('');
  log(`  ✓ 校验通过：目录与产物均与源码一致。`);
  log('');
}

fs.writeFileSync(
  path.join(STAGE_ROOT, 'build-report.json'),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    dshVersion: runtime.dshVersion,
    pluginVersion: srcPkg.version,
    stage: path.relative(HERE, STAGE).replace(/\\/g, '/'),
    tgz: path.relative(REPO, tgzPath).replace(/\\/g, '/'),
    files: filesToWrite.length,
    bundledCatalogCount: bundledEntries.length,
    checkOnly: CHECK_ONLY,
  }, null, 2)}\n`,
  'utf8',
);

// ─────────────────────────────────────────────────────────────
// 极简 tar 写入（ustar），避免依赖 tar 命令
// ─────────────────────────────────────────────────────────────
//
// 归档成员的 mtime 用文件顶部那个固定的 MTIME 常量 —— 理由见那里的说明。

function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    const name = e.name;
    if (Buffer.byteLength(name) > 100) {
      // ustar prefix 拆分
      const idx = name.lastIndexOf('/', 155);
      const prefix = idx > 0 ? name.slice(0, idx) : '';
      const base = idx > 0 ? name.slice(idx + 1) : name;
      header.write(base, 0, 100, 'utf8');
      header.write(prefix, 345, 155, 'utf8');
    } else {
      header.write(name, 0, 100, 'utf8');
    }
    header.write('0000644\0', 100, 8);        // mode
    header.write('0000000\0', 108, 8);        // uid
    header.write('0000000\0', 116, 8);        // gid
    header.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 12); // size
    header.write(`${MTIME.toString(8).padStart(11, '0')}\0`, 136, 12); // mtime（固定值，见上）
    header.write('        ', 148, 8);         // checksum placeholder
    header.write('0', 156, 1);                // typeflag = regular file
    header.write('ustar\0', 257, 6);          // magic
    header.write('00', 263, 2);               // version
    // checksum
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // 结束块
  return Buffer.concat(blocks);
}
