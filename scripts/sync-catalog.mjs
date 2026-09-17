/**
 * 插件目录的**采集与生成器** —— 市场仓库里唯一会写 catalog/ 的脚本。
 *
 *   node scripts/sync-catalog.mjs                 # 采集 + 生成（联网，每日任务跑的就是它）
 *   node scripts/sync-catalog.mjs --check         # ★ 只读校验：只读磁盘，不联网、不写盘
 *   node scripts/sync-catalog.mjs --offline       # 不联网，只把磁盘上已有的配置归一化并重建索引
 *   node scripts/sync-catalog.mjs --only <slug>   # 只刷新一个插件（调试用）
 *   node scripts/sync-catalog.mjs --limit 200     # 只解析前 N 个的版本（试跑，默认不写盘）
 *
 * ── 三条路径的能力边界（别混）─────────────────────────────────
 *
 *   --check    读 catalog/plugins/*.json → 核对「能否原样往返」「索引是不是它的派生结果」
 *              「文件数与索引条数是否相等」。**没有任何写操作，没有任何网络调用。**
 *              它不回答「上游是不是发了新版」—— 那需要网络，是每日任务的职责。
 *   --offline  同样不联网，但**会写** index.json（以及归一化修正过的配置文件）。
 *              手工改了展示字段之后用它把索引对齐；它不会删任何文件。
 *   （无参数） 联网采集。只有这条路径会新增 / 删除配置文件。
 *
 * ── 它产出什么 ────────────────────────────────────────────────
 *
 *   catalog/plugins/<slug>.json   一个插件一份配置：版本号 / 收藏量 / 仓库地址 / 安装方法
 *   catalog/index.json            由上面派生，列表页读这一份
 *
 * ── 数据从哪来（四路合并，优先级从高到低）───────────────────────
 *
 *   1. catalog/overrides/reviewed.json   人工审核过的第三方插件（带审核证据）
 *   2. 插件集合仓库的 manifest.json       本仓库自己维护、托管 tarball 的插件
 *   3. 公开索引 plugins.json              社区插件（默认层级）
 *   4. 已有的 catalog/plugins/*.json      上一轮的结果 —— 人工审核结论、首次发现时间、
 *                                         collection 的安装信息都靠它传承，**绝不能被覆盖掉**
 *
 * ── 三条硬规矩 ────────────────────────────────────────────────
 *
 *   · **内容没变就不动时间戳**。每天一次定时任务，如果无脑刷新 lastSyncedAt，
 *     7000 个文件会天天全部显示为「已修改」，真正的变更就被噪音淹没了。
 *   · **拿不到就是 null**。版本号解析不出来时写 `versionSource: "none"`，
 *     而不是拿 star 数或别的东西凑一个看起来像版本的字符串。
 *   · **人工审核结论只增不减**。review 字段只能由 overrides 文件产生，
 *     采集器不会去改它，也不会因为上游改了简介就把它冲掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION, TIERS, INSTALL_METHODS,
  PLUGINS_DIR_REL, INDEX_REL,
  slugify, extractCleanSpec, githubSlug, looksLikeNpmName,
  blankRecord, normalizeRecord, serializeRecord, contentEquals,
  buildIndex, readJsonSafe, writeJsonAtomic, listRecordFiles,
} from './lib/catalog-format.mjs';
import {
  resolveNpmLatest, fetchGithubAll, githubTokenFromEnv, DEFAULT_BATCH,
} from './lib/version-resolve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE_DIR = path.join(REPO, '.cache');

export const PUBLIC_INDEX_URL = 'https://2bingling.github.io/dsh-market/plugins.json';
export const COLLECTION_REPO = 'HaydenSmith1121/dsh-plugin-collection';
export const COLLECTION_MANIFEST_URL = `https://raw.githubusercontent.com/${COLLECTION_REPO}/main/manifest.json`;
/** 本仓库的 raw 地址：市场插件自己的 tarball 与配置文件都从这里取 */
export const REPO_RAW_BASE = 'https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main';

// ─────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, dflt = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const CHECK_ONLY = has('--check');
const OFFLINE = has('--offline') || CHECK_ONLY;
const ONLY = valueOf('--only');
const LIMIT = Number(valueOf('--limit', '0')) || 0;
const QUIET = has('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn(...a);
const problems = [];
const fail = (m) => { problems.push(m); console.error(`  ✗ ${m}`); };
const ok = (m) => log(`  ✓ ${m}`);

// ─────────────────────────────────────────────────────────────
// 读入：已有的配置文件（传承人工结论与 collection 安装信息）
// ─────────────────────────────────────────────────────────────

function loadExisting() {
  const map = new Map();
  for (const file of listRecordFiles(REPO)) {
    const rec = readJsonSafe(file);
    if (!rec || typeof rec !== 'object') {
      warn(`  ! 跳过损坏的配置文件：${path.relative(REPO, file)}`);
      continue;
    }
    const rec2 = normalizeRecord(rec);
    // 以**文件名**为准而不是内部的 slug：文件被改名时以磁盘为准，
    // 否则会出现「读的是 A 文件、写回 B 文件」这种静默复制。
    rec2.slug = path.basename(file, '.json');
    map.set(rec2.slug, rec2);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// 采集：公开索引
// ─────────────────────────────────────────────────────────────

async function loadPublicIndex() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, 'public-index.json');

  if (OFFLINE) {
    const cached = readJsonSafe(cacheFile);
    if (!cached) return { plugins: [], meta: null, stale: true };
    return { plugins: cached.plugins ?? [], meta: cached.meta ?? null, stale: true };
  }

  try {
    log(`→ 拉取公开索引 ${PUBLIC_INDEX_URL}`);
    const res = await fetch(PUBLIC_INDEX_URL, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-catalog-sync' },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const doc = await res.json();
    const meta = {
      url: PUBLIC_INDEX_URL,
      generatedAt: doc.generatedAt ?? null,
      fetchedAt: new Date().toISOString(),
      count: (doc.plugins ?? []).length,
    };
    // 原始索引 ~22MB，只留采集要用的字段再落盘，免得缓存比仓库还大
    const slim = (doc.plugins ?? []).map((p) => ({
      id: p.id, type: p.type, name: p.name, owner: p.owner, repo: p.repo, fullName: p.fullName,
      stars: p.stars, forks: p.forks, pushedAt: p.pushedAt,
      description: p.description, descriptionZh: p.descriptionZh,
      tags: p.tags, license: p.license, homepage: p.homepage,
      install: p.install ? {
        method: p.install.method,
        commands: Array.isArray(p.install.commands) ? p.install.commands.slice(0, 6) : [],
        needsConfig: p.install.needsConfig === true,
        usageNeedsConfig: p.install.usageNeedsConfig === true,
        risky: p.install.risky === true,
        riskyReasons: Array.isArray(p.install.riskyReasons) ? p.install.riskyReasons.slice(0, 8) : [],
      } : null,
    }));
    writeJsonAtomic(cacheFile, { meta, plugins: slim });
    ok(`公开索引 ${slim.length} 条（上游生成于 ${meta.generatedAt ?? '未知'}）`);
    return { plugins: slim, meta, stale: false };
  } catch (err) {
    const cached = readJsonSafe(cacheFile);
    if (cached) {
      warn(`  ! 拉取公开索引失败（改用本地缓存）：${err?.message ?? err}`);
      return { plugins: cached.plugins ?? [], meta: cached.meta ?? null, stale: true };
    }
    fail(`拉取公开索引失败，且没有本地缓存：${err?.message ?? err}`);
    return { plugins: [], meta: null, stale: true };
  }
}

// ─────────────────────────────────────────────────────────────
// 采集：插件集合仓库（自己维护、托管 tarball 的那批）
// ─────────────────────────────────────────────────────────────

async function loadCollection() {
  const explicit = process.env.DSH_PLUGIN_COLLECTION;
  const localCandidates = [
    explicit,
    path.join(path.dirname(REPO), 'dsh-plugin-collection'),
  ].filter(Boolean);

  for (const dir of localCandidates) {
    const file = path.join(dir, 'manifest.json');
    const doc = readJsonSafe(file);
    if (doc) {
      log(`→ 插件集合仓库（本地）：${file}`);
      return { doc, source: file };
    }
  }

  if (OFFLINE) {
    const cached = readJsonSafe(path.join(CACHE_DIR, 'collection-manifest.json'));
    return cached ? { doc: cached, source: 'cache' } : { doc: null, source: null };
  }

  try {
    log(`→ 拉取插件集合仓库清单 ${COLLECTION_MANIFEST_URL}`);
    const res = await fetch(COLLECTION_MANIFEST_URL, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-catalog-sync' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    writeJsonAtomic(path.join(CACHE_DIR, 'collection-manifest.json'), doc);
    ok(`插件集合仓库 ${(doc.plugins ?? []).length} 个插件`);
    return { doc, source: COLLECTION_MANIFEST_URL };
  } catch (err) {
    const cached = readJsonSafe(path.join(CACHE_DIR, 'collection-manifest.json'));
    if (cached) {
      warn(`  ! 拉取插件集合仓库清单失败（改用缓存）：${err?.message ?? err}`);
      return { doc: cached, source: 'cache' };
    }
    warn(`  ! 插件集合仓库清单取不到（本轮不含自研插件）：${err?.message ?? err}`);
    return { doc: null, source: null };
  }
}

// ─────────────────────────────────────────────────────────────
// 合并：把四路输入变成一组记录
// ─────────────────────────────────────────────────────────────

/** 公开索引的一条 → 记录（tier 默认 community，可被 overrides 提升） */
function recordFromIndexEntry(p) {
  const id = String(p.id ?? p.fullName ?? p.name ?? '').trim();
  if (id === '') return null;

  const repo = p.fullName ? `https://github.com/${p.fullName}` : null;
  const inst = p.install ?? {};
  const rec = blankRecord({ id, tier: 'community' });

  rec.package = null;
  rec.name = p.name ?? null;
  rec.title = p.name ?? id;
  rec.summary = String(p.descriptionZh ?? p.description ?? '').slice(0, 1200);
  rec.tags = Array.isArray(p.tags) ? p.tags : [];
  rec.author = p.owner ?? null;
  rec.repo = repo;
  rec.homepage = p.homepage ?? null;
  rec.license = p.license ?? null;
  rec.stars = Number.isFinite(p.stars) ? p.stars : null;
  rec.forks = Number.isFinite(p.forks) ? p.forks : null;
  rec.pushedAt = p.pushedAt ?? null;
  rec.source = { kind: 'public-index', url: PUBLIC_INDEX_URL, firstSeenAt: null, lastSyncedAt: null };

  // ── 安装方法 ──────────────────────────────────────────────
  // 优先级与市场闸门的历史判据一致：索引里干净的规格 → 从仓库推导 github: → 都不行就 manual。
  // ★ 绝不在这一步猜 npm 包名：公共索引的 name 与真实 npm 包名没有任何保证关系
  //   （实测 `dsh-plugins-market` 在 npm 上确实存在，但那是**另一个**包）。
  //   npm 规格只在下面「解析版本号时确认了同源仓库」才敢用 —— 见 decideInstall()。
  const clean = extractCleanSpec(inst.commands);
  if (clean) {
    rec.install.method = clean.method;
    rec.install.spec = clean.spec;
  } else if (repo && githubSlug(repo)) {
    rec.install.method = 'github';
    rec.install.spec = `github:${githubSlug(repo)}`;
  } else if (inst.method === 'skills-add') {
    rec.install.method = 'skills';
  } else {
    rec.install.method = 'manual';
  }

  rec.install.commands = Array.isArray(inst.commands) ? inst.commands : [];
  rec.install.needsConfig = inst.needsConfig === true;
  rec.install.usageNeedsConfig = inst.usageNeedsConfig === true;
  rec.install.risky = inst.risky === true;
  rec.install.riskyReasons = Array.isArray(inst.riskyReasons) ? inst.riskyReasons : [];

  return rec;
}

/** 插件集合仓库 manifest 的一条 → 记录（tier=verified，安装方法固定是 tarball） */
function recordFromCollectionEntry(p) {
  const id = String(p.package ?? p.id ?? '').trim();
  if (id === '') return null;
  const rec = blankRecord({ id, tier: 'verified' });
  rec.package = p.package ?? id;
  rec.name = rec.package;
  rec.title = p.title ?? rec.package;
  rec.summary = String(p.summary ?? '');
  rec.tags = Array.isArray(p.tags) ? p.tags : [];
  rec.version = p.version ?? null;
  rec.versionSource = p.version ? 'package.json' : 'none';
  rec.author = p.author ?? null;
  rec.repo = p.repo ?? `https://github.com/${COLLECTION_REPO}`;
  rec.homepage = p.homepage ?? null;
  rec.license = p.license ?? 'MIT';
  rec.stars = Number.isFinite(p.stars) ? p.stars : null;
  rec.pushedAt = p.pushedAt ?? null;
  rec.install = {
    method: 'tarball',
    spec: null,
    commands: [
      `# 下载 ${p.tarball ?? ''}`,
      `dsh plugin --profile web add <下载后的 .tgz 绝对路径>`,
    ],
    url: p.install?.url ?? (p.tarball ? `https://raw.githubusercontent.com/${COLLECTION_REPO}/main/${p.tarball}` : null),
    sha256: p.sha256 ?? null,
    bytes: p.bytes ?? null,
    tarball: p.tarball ?? null,
    dshVersion: p.dshVersion ?? null,
    needsConfig: p.needsConfig === true,
    usageNeedsConfig: p.usageNeedsConfig === true,
    risky: p.risky === true,
    riskyReasons: [],
  };
  rec.source = { kind: 'collection', url: `https://github.com/${COLLECTION_REPO}`, firstSeenAt: null, lastSyncedAt: null };
  rec.notes = p.notes ?? null;
  rec.peerRuntimePin = p.peerRuntimePin ?? null;
  rec.peerVerdict = p.peerVerdict ?? null;
  rec.peerNote = p.peerNote ?? null;
  return rec;
}

/** overrides/reviewed.json 的一条 → 记录（tier=reviewed，带审核证据） */
function recordFromReviewed(o) {
  const id = String(o.id ?? o.package ?? '').trim();
  if (id === '') return null;
  const rec = blankRecord({ id, tier: 'reviewed' });
  rec.package = o.package ?? null;
  rec.name = o.package ?? o.name ?? null;
  rec.title = o.title ?? o.package ?? id;
  rec.summary = String(o.summary ?? '');
  rec.tags = Array.isArray(o.tags) ? o.tags : [];
  rec.version = o.version ?? null;
  rec.versionSource = o.version ? 'npm' : 'none';
  rec.author = o.author ?? null;
  rec.repo = o.upstream ?? null;
  rec.homepage = o.homepage ?? null;
  rec.license = o.license ?? null;
  rec.install = {
    method: INSTALL_METHODS.includes(o.install?.kind) ? o.install.kind : 'github',
    spec: o.install?.spec ?? null,
    commands: [`dsh plugin --profile web add ${o.install?.spec ?? ''}`.trim()],
    url: null,
    sha256: o.install?.sha256 ?? null,
    bytes: null,
    tarball: null,
    dshVersion: o.review?.dshVersion ?? null,
    needsConfig: o.install?.needsConfig === true,
    usageNeedsConfig: o.install?.usageNeedsConfig === true,
    risky: o.install?.risky === true,
    riskyReasons: [],
  };
  rec.source = { kind: 'manual', url: `${PUBLIC_INDEX_URL}`, firstSeenAt: null, lastSyncedAt: null };
  rec.review = o.review ?? null;
  rec.peerRuntimePin = o.peerRuntimePin ?? null;
  rec.peerVerdict = o.peerVerdict ?? null;
  rec.peerNote = o.peerNote ?? null;
  return rec;
}

/** overrides/self.json 的一条 → 记录（市场插件自己；版本与 sha256 从本仓库反推） */
function recordFromSelf(o, { dshVersion }) {
  const id = String(o.package ?? o.id ?? '').trim();
  if (id === '') return null;

  // 版本号从源码 package.json 取，sha256 从**打好的 tarball** 算 —— 两者都不手写。
  const srcPkgFile = path.join(REPO, o.versionFrom ?? '');
  const srcPkg = o.versionFrom ? readJsonSafe(srcPkgFile) : null;
  const version = srcPkg?.version ?? null;

  const tarballRel = version && o.tarballTemplate
    ? o.tarballTemplate.replace('{dshVersion}', dshVersion ?? '').replace('{version}', version)
    : null;
  const tarballFile = tarballRel ? path.join(REPO, tarballRel) : null;
  let sha256 = null;
  let bytes = null;
  if (tarballFile && fs.existsSync(tarballFile)) {
    const buf = fs.readFileSync(tarballFile);
    sha256 = createHash('sha256').update(buf).digest('hex');
    bytes = buf.length;
  }

  const rec = blankRecord({ id, tier: 'verified' });
  rec.package = id;
  rec.name = id;
  rec.title = o.title ?? id;
  rec.summary = String(o.summary ?? '');
  rec.tags = Array.isArray(o.tags) ? o.tags : [];
  rec.version = version;
  rec.versionSource = version ? 'package.json' : 'none';
  rec.author = o.author ?? null;
  rec.repo = o.repo ?? null;
  rec.homepage = o.homepage ?? null;
  rec.license = o.license ?? 'MIT';
  rec.peerRuntimePin = o.peerRuntimePin ?? null;
  rec.peerVerdict = o.peerVerdict ?? null;
  rec.peerNote = o.peerNote ?? null;
  rec.coexistenceWarning = o.coexistenceWarning ?? null;
  rec.notes = o.notes ?? null;
  rec.origin = o.origin ?? 'self';
  rec.install = {
    method: 'tarball',
    spec: null,
    commands: [],
    url: tarballRel ? `${REPO_RAW_BASE}/${tarballRel.split(path.sep).join('/')}` : null,
    /**
     * ★ 自引用条目的 sha256 恒为 **null**，这是数学上的必然，不是偷懒。
     *
     *   市场这个包**内含**它自己的目录条目（包内离线兜底目录）。如果这条记录里写了
     *   自己的 sha256，就构成一个不动点方程：tarball 的字节取决于记录里的 hash，
     *   而记录里的 hash 又取决于 tarball 的字节 —— 永远解不出来。
     *   上一版是在构建过程中生成目录（算完 hash 又要重写 tarball），
     *   这一版是构建与采集分成两步，但自指关系没有变。
     *
     *   曾经试过在这里填真 hash，后果是：build 之后 tarball 变了、目录里的 hash 就过期，
     *   于是闸门对着自己报「sha256 不一致，tarball 可能被替换或损坏」并**硬拦截**升级。
     *   一个必然过期的校验和比没有校验和更糟 —— 它会稳定地产生假警报。
     *
     *   所以这里如实留空 + 说明，让闸门走「没有校验和，无法验证字节」那一档（提示，不拦）。
     *   实际校验和在同目录的 .tgz.sha256 边车文件里，也在 build.mjs 的输出里。
     */
    sha256,
    bytes,
    tarball: tarballRel,
    dshVersion: dshVersion ?? null,
    needsConfig: o.needsConfig === true,
    usageNeedsConfig: o.usageNeedsConfig === true,
    risky: o.risky === true,
    riskyReasons: [],
  };
  rec.install.sha256 = null; // 见上面的长注释：自引用条目不能带校验和

  /**
   * ★ 这里**不能**把实测到的 hash 写进说明文字。
   *
   *   之前写过，结果是构建与采集永远收敛不到一起，成了一个死循环：
   *     采集 → 说明里记下 hash H → 构建（说明文字进包）→ tarball 变了，hash 变成 H′
   *     → 下次采集读到 H′，说明又变 → 文件变了 → 再构建 → …
   *   每晚的定时任务都会产生一次「只有一个数字变了」的提交，而那个数字**永远是错的**
   *   （它记的是上一个包的 hash）。校验和属于边车文件，不属于会进包的说明文字。
   */
  rec.sha256Note = tarballRel
    ? '自引用条目：本记录指向的 tarball 就是本仓库构建出来的那个包，而本包**内含**这份目录 —— '
      + '写进它的 sha256 会因为「tarball 内容取决于记录、记录又取决于 tarball」而永远解不出来（不动点）。'
      + '实际校验和见同目录的 .tgz.sha256 边车文件（构建时写出），请不要把它抄进这段文字里。'
    : '本条目指向的 tarball 目前不在仓库里（plugins/dsh-plugins-market/<dsh版本>/ 下没有对应文件）。'
      + '先跑一次 node plugins-src/dsh-plugins-market/build.mjs 打好包。';
  rec.source = { kind: 'self', url: `${REPO_RAW_BASE}/catalog/overrides/self.json`, firstSeenAt: null, lastSyncedAt: null };
  return rec;
}

// ─────────────────────────────────────────────────────────────
// 版本号解析
// ─────────────────────────────────────────────────────────────

/**
 * npm 包的**同源校验**。
 *
 * 这是本文件里最容易被忽略、代价却最大的一条判据：公共索引里的 `name`
 * 跟真实 npm 包名没有任何保证关系。实测 `dsh-plugins-market` 在 npm 上
 * 确实存在 —— 版本 0.1.0，但那是**另一个人写的、完全无关的包**。
 * 拿它当版本号写进配置文件，用户看到的就是一个漂亮且彻底错误的数字。
 *
 * 所以只有当 npm 上那个包声明的 repository 指向**同一个仓库**时才采信。
 */
function npmRepoMatches(npmRepo, repoUrl) {
  const a = githubSlug(normalizeRepoUrl(npmRepo));
  const b = githubSlug(repoUrl);
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function normalizeRepoUrl(url) {
  return String(url ?? '')
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/i, '');
}

/**
 * 按 `npm → github-release → github-tag → package.json` 的优先级定版本。
 *
 * @param {object} rec    记录（会被就地更新 version/versionSource/latestRelease）
 * @param {object} gh     GitHub 那一批取回来的数据（可能为 null）
 * @param {object} npm    npm 查到的数据（可能为 null）
 */
function decideVersion(rec, gh, npm) {
  if (npm && npm.version && npmRepoMatches(npm.repository, rec.repo)) {
    rec.version = npm.version;
    rec.versionSource = 'npm';
    return;
  }
  if (gh?.latestRelease?.tag) {
    // release 的 tag 常带 `v` 前缀，去掉才是版本号；去掉后不像版本就不认
    const v = stripTagPrefix(gh.latestRelease.tag);
    if (v) {
      rec.version = v;
      rec.versionSource = 'github-release';
      rec.latestRelease = gh.latestRelease;
      return;
    }
  }
  if (gh?.latestTag) {
    const v = stripTagPrefix(gh.latestTag);
    if (v) {
      rec.version = v;
      rec.versionSource = 'github-tag';
      return;
    }
  }
  if (gh?.packageVersion) {
    rec.version = gh.packageVersion;
    rec.versionSource = 'package.json';
    return;
  }
  // 什么都没有：如实留空。**不要**退回去用上一轮的旧值 ——
  // 那会让「上游把 release 删了」这件事永远看不出来。
  rec.version = null;
  rec.versionSource = 'none';
}

/** `v1.2.3` / `dsh-x-v1.2.3` / `release-1.2.3` → `1.2.3`；不像版本返回 null。 */
function stripTagPrefix(tag) {
  const s = String(tag ?? '').trim();
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(s);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/**
 * `--check`：**只读磁盘**的一致性校验（CI 与提交前用）。
 *
 * 判据三条，全部不需要网络：
 *   ① 每个 catalog/plugins/<slug>.json 都要能**原样往返** ——
 *      归一化再序列化之后必须与磁盘上的字节完全相同。
 *      对不上说明有人手工改过（字段顺序、空值写法、缺字段），
 *      而那种改动会让每日同步把它当成「变了」，产生没意义的 diff。
 *   ② index.json 必须恰好是这些配置文件的派生结果。
 *   ③ 配置文件的个数必须等于索引条目数 —— 一条配置文件对应一条记录，不做去重。
 *
 * 它**不**检查「上游是不是发了新版」—— 那是每日任务的职责，需要网络。
 */
function checkOnDisk(existing) {
  const records = [...existing.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));

  // ① 逐文件往返
  for (const rec of records) {
    const file = path.join(REPO, PLUGINS_DIR_REL, `${rec.slug}.json`);
    const expected = serializeRecord(rec);
    if (fs.readFileSync(file, 'utf8') !== expected) {
      fail(`catalog/plugins/${rec.slug}.json 的内容不是归一化后的形态`
        + '（字段顺序 / 空值写法 / 缺字段被手工改过？重跑一次 node scripts/sync-catalog.mjs 即可修好）');
    }
  }

  // ② 索引必须与配置文件一致
  const onDiskIndex = readJsonSafe(path.join(REPO, INDEX_REL));
  const expectedIndex = buildIndex(records, { generatedAt: null, sourceIndex: onDiskIndex?.sourceIndex ?? null });
  /** generatedAt 体现的是「上游索引什么时候生成的」，不参与内容比对 */
  const comparable = (o) => JSON.stringify({ ...o, generatedAt: null });
  if (!onDiskIndex) fail('缺少 catalog/index.json');
  else if (comparable(onDiskIndex) !== comparable(expectedIndex)) {
    fail('catalog/index.json 与 catalog/plugins/*.json 的派生结果不一致（请运行 node scripts/sync-catalog.mjs）');
  }

  // ③ 文件数 == 索引条目数
  const onDiskFiles = fs.readdirSync(path.join(REPO, PLUGINS_DIR_REL))
    .filter((f) => f.endsWith('.json') && !f.includes('.tmp-')).length;
  if (onDiskFiles !== records.length) fail(`catalog/plugins/ 有 ${onDiskFiles} 个文件，但读出来 ${records.length} 条记录`);
  if (onDiskIndex && onDiskIndex.counts?.total !== records.length) {
    fail(`index.json 记了 ${onDiskIndex.counts.total} 条，而 catalog/plugins/ 有 ${records.length} 个配置文件 —— 两者必须相等`);
  }

  if (problems.length) {
    console.error(`\n目录校验失败：${problems.length} 项`);
    process.exit(1);
  }
  console.log(`\n目录校验通过：${records.length} 个配置文件，index.json 一致，无冗余或缺失。`);
  process.exit(0);
}

/**
 * `--offline`：不联网，**只**用磁盘上已有的配置文件重建 index.json。
 *
 * 什么时候用：手工改了一个 plugin.json 的展示字段、或者只想把归一化修正落盘。
 * 它**不会**去问上游有没有新版（那必须联网），所以别拿它当「刷新目录」。
 */
function rebuildIndexFromDisk(existing) {
  const records = [...existing.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));

  let written = 0;
  for (const rec of records) {
    const file = path.join(REPO, PLUGINS_DIR_REL, `${rec.slug}.json`);
    const text = serializeRecord(rec);
    if (fs.readFileSync(file, 'utf8') === text) continue;
    writeJsonAtomic(file, null, { raw: text });
    written += 1;
  }

  const onDiskIndex = readJsonSafe(path.join(REPO, INDEX_REL));
  const idx = buildIndex(records, {
    generatedAt: onDiskIndex?.generatedAt ?? null,
    sourceIndex: onDiskIndex?.sourceIndex ?? null,
  });
  writeJsonAtomic(path.join(REPO, INDEX_REL), idx);

  ok(`--offline：把 ${written} 个配置文件归一化后落盘（共 ${records.length} 个）`);
  ok(`索引已重建：${idx.counts.total} 条（已验证 ${idx.counts.verified} / 已审核 ${idx.counts.reviewed} / 未审核 ${idx.counts.community}）`);
  console.log('  （没有联网 —— 这不等于「刷新目录」，上游有没有新版要跑不带参数的那条命令）');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// 入口：先分流，再决定要不要联网
// ─────────────────────────────────────────────────────────────

/**
 * ★ 分流必须发生在这里，而且是**先分流再干活**。
 *
 *   这里出过一次真事故：`--check` / `--offline` 的早退分支被写在了一个已经不再被
 *   调用的 `main()` 里，入口直接调了联网采集那条路 —— 于是 `--check` 拿着一个空的
 *   公开索引缓存去「推演」目录，判定 7482 个配置文件是多余的，**把它们删了**。
 *   一条只读校验命令删掉了 7000 多个文件，而它打印的还是 exit 0。
 *
 *   教训有两条，都体现在下面的代码里：
 *     ① 只读命令的「只读」必须是结构上的，不能靠一个可能被绕过的 if；
 *     ② 校验永远不该有写盘的能力 —— checkOnDisk() 里没有任何写操作。
 */
async function main() {
  log('── dsh-plugins 目录同步 ──────────────────────────────');
  const existing = loadExisting();
  log(`→ 已有配置文件：${existing.size} 个`);

  if (CHECK_ONLY) return checkOnDisk(existing);
  if (OFFLINE) return rebuildIndexFromDisk(existing);
  return collect(existing);
}

// ─────────────────────────────────────────────────────────────
// 主流程：联网采集
// ─────────────────────────────────────────────────────────────

async function collect(existing) {
  // ① overrides（人工审核层）
  const reviewedFile = path.join(REPO, 'catalog', 'overrides', 'reviewed.json');
  const reviewedDoc = readJsonSafe(reviewedFile) ?? { plugins: [] };
  const reviewedRecords = (reviewedDoc.plugins ?? []).map(recordFromReviewed).filter(Boolean);
  log(`→ 人工审核层：${reviewedRecords.length} 条`);

  // ①b 市场插件自己（唯一由本仓库托管 tarball 的插件）
  const selfFile = path.join(REPO, 'catalog', 'overrides', 'self.json');
  const selfDoc = readJsonSafe(selfFile) ?? { plugins: [] };
  const compatDoc = readJsonSafe(path.join(REPO, 'compatibility.json')) ?? {};
  const dshVersion = (compatDoc.runtimes ?? []).find((r) => r.status === 'supported' && r.recommended)?.dshVersion
    ?? (compatDoc.runtimes ?? []).find((r) => r.status === 'supported')?.dshVersion
    ?? null;
  const selfRecords = (selfDoc.plugins ?? []).map((o) => recordFromSelf(o, { dshVersion })).filter(Boolean);
  log(`→ 市场插件自身：${selfRecords.length} 条（dsh ${dshVersion ?? '未知'}）`);

  // ② 插件集合仓库
  const collection = await loadCollection();
  const collectionRecords = (collection.doc?.plugins ?? []).map(recordFromCollectionEntry).filter(Boolean);
  log(`→ 插件集合层：${collectionRecords.length} 条`);

  // ③ 公开索引
  const index = await loadPublicIndex();
  const indexRecords = index.plugins.map(recordFromIndexEntry).filter(Boolean);
  log(`→ 公开索引层：${indexRecords.length} 条`);

  // ── 合成记录表 ────────────────────────────────────────────
  //
  // 后写的层**不覆盖**先写的层（层级从高到低）：同一插件既被人工审核、
  // 又出现在公开索引里时，保留审核过的那一条（带 review 证据）。
  const bySlug = new Map();
  const rank = { verified: 0, reviewed: 1, community: 2 };
  const put = (rec) => {
    if (!rec) return;
    rec.slug = slugify(rec.id);
    const prev = bySlug.get(rec.slug);
    if (!prev || (rank[rec.tier] ?? 3) < (rank[prev.tier] ?? 3)) bySlug.set(rec.slug, rec);
  };
  for (const r of indexRecords) put(r);
  for (const r of collectionRecords) put(r);
  for (const r of selfRecords) put(r);
  for (const r of reviewedRecords) put(r);

  // ── 传承上一轮的结果 ──────────────────────────────────────
  let carried = 0;
  for (const [slug, rec] of bySlug) {
    const prev = existing.get(slug);
    if (!prev) continue;
    carried += 1;
    rec.source.firstSeenAt = prev.source?.firstSeenAt ?? null;
    rec.source.lastSyncedAt = prev.source?.lastSyncedAt ?? null;
    rec.versionCheckedAt = prev.versionCheckedAt ?? null;
    rec.metricsCheckedAt = prev.metricsCheckedAt ?? null;
    // 人工审核结论与 collection 安装信息**只由它们各自的来源产生**，
    // 采集器不碰。这里只在来源本轮缺失时把上一轮的结论接住，避免闪断丢证据。
    if (rec.review === null && prev.review !== null && rec.tier !== 'community') rec.review = prev.review;
    if (rec.tier === 'verified' && !rec.install.url && prev.install?.url) rec.install = prev.install;
    // 上一轮找到过的 npm 包名：这一轮如果安装方法仍是 npm，沿用它的 spec
    if (rec.install.method === 'npm' && !rec.install.spec && prev.install?.method === 'npm') {
      rec.install.spec = prev.install.spec;
    }
  }
  log(`→ 传承上一轮：${carried} 个`);

  // ── 归一化：保证「写出去的东西，读回来一模一样」────────────
  //
  // ★ 这一趟不能省。四条来源各自构造记录，字段的空值写法并不统一
  //   （`''` / `null` / 缺字段都会出现）；而归一化只在**读**已有文件时发生。
  //   于是「写出去的字节」与「读回来再写出去的字节」可能不同 ——
  //   表现就是每日同步认为每个文件都变了、7000 个文件天天 flip-flop，
  //   真正的变更被噪音淹没，`--check` 也会永远红。
  //
  //   在这里统一过一遍，写盘的东西就必然是归一化之后的形态，往返稳定。
  for (const [slug, rec] of bySlug) {
    const n = normalizeRecord(rec);
    n.slug = slug; // slug 是文件名，以 Map 的键为准
    bySlug.set(slug, n);
  }

  // ── 版本与收藏量 ──────────────────────────────────────────
  let targets = [...bySlug.values()];
  if (ONLY) targets = targets.filter((r) => r.slug === slugify(ONLY) || r.id === ONLY);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  log(`→ 待解析：${targets.length} 个`);

  /**
   * ★ 没被选进 targets 的记录，必须**沿用上一轮已经解析出来的版本号**。
   *
   *   否则 `--only <slug>` / `--limit N` 会把其余记录的 version 抹成 null ——
   *   因为那些记录是刚从数据源构造出来的，构造时不带版本号，版本号只在下面
   *   那一轮外部解析里才填上。一次「只刷新一个插件」的调试，就能把整个目录的
   *   版本号清空，而日志只会说「变更 7495」。
   *
   *   本地权威来源（集合仓库的 manifest、市场自己的 package.json）不在此列：
   *   它们的版本号就在本次运行的输入里，比上一轮记录更准。
   */
  const targetSlugs = new Set(targets.map((r) => r.slug));
  if (targetSlugs.size !== bySlug.size) {
    let carriedVersion = 0;
    for (const [slug, rec] of bySlug) {
      if (targetSlugs.has(slug) || isLocallyAuthoritative(rec)) continue;
      const prev = existing.get(slug);
      if (!prev) continue;
      rec.version = prev.version;
      rec.versionSource = prev.versionSource;
      rec.latestRelease = prev.latestRelease;
      rec.versionCheckedAt = prev.versionCheckedAt;
      if (rec.stars === null) rec.stars = prev.stars;
      carriedVersion += 1;
    }
    log(`  （未选中的 ${carriedVersion} 条沿用上一轮的版本号，不会被抹空）`);
  }

  const stats = { npm: 0, githubRelease: 0, githubTag: 0, packageJson: 0, none: 0, notFound: 0, errors: [] };

  {
    // ① npm：便宜且最准，能查到的先解决掉
    //
    // ★ 并发而不是串行。实测有 2000 条左右带着干净的 npm 规格，串行查一遍要十分钟
    //   （每条约 300ms），而 npm registry 本来就能承受并发。8 路是实测的稳妥值：
    //   再高对 registry 不礼貌，收益也已经很小。
    const needGithub = [];
    const npmTargets = [];
    for (const rec of targets) {
      const candidate = npmCandidate(rec);
      if (candidate) npmTargets.push({ rec, candidate });
      else needGithub.push(rec);
    }
    log(`  npm 待查 ${npmTargets.length} 个（并发 8），其余 ${needGithub.length} 个走 GitHub`);

    let npmDone = 0;
    let npmHit = 0;
    await mapLimit(npmTargets, 8, async ({ rec, candidate }) => {
      const npm = await resolveNpmLatest(candidate).catch(() => null);
      npmDone += 1;
      if (npmDone % 250 === 0) log(`    npm ${npmDone}/${npmTargets.length}（命中 ${npmHit}）`);
      if (npm && npm.version && npmRepoMatches(npm.repository, rec.repo)) {
        decideVersion(rec, null, npm);
        if (npm.license && !rec.license) rec.license = npm.license;
        npmHit += 1;
      } else {
        needGithub.push(rec);
      }
    });
    log(`  npm 命中 ${npmHit} 个，其余走 GitHub`);

    // ② GitHub：一次批量查询里并排问几十个仓库
    //
    // ★ 自研插件（source.kind === 'collection'）不查：它们的 repo 指向的是插件集合
    //   仓库本身，查出来会让 6 个插件显示同一个 star 数 —— 那是个假事实。
    //   自研插件的版本以集合仓库的 manifest.json 为准，本来就不需要外部确认。
    const slugToRepo = new Map();
    for (const rec of needGithub) {
      if (rec.source?.kind === 'collection') continue;
      const slug = githubSlug(rec.repo);
      if (slug) slugToRepo.set(slug, rec);
    }
    const token = githubTokenFromEnv();
    if (!token) {
      warn('  ! 没有 GITHUB_TOKEN / GH_TOKEN：GitHub 侧的版本号与 star 数只能留空。');
    }
    const gh = await fetchGithubAll([...slugToRepo.keys()], {
      token,
      batch: DEFAULT_BATCH,
      budget: Number(valueOf('--github-budget', '4500')),
      onProgress: ({ done, total, spent }) => log(`    GitHub ${done}/${total}（已用 ${spent} 点）`),
    });
    for (const e of gh.errors.slice(0, 10)) warn(`    ! ${e}`);
    if (gh.errors.length > 10) warn(`    ! …另有 ${gh.errors.length - 10} 条 GitHub 报错`);
    if (gh.stopped) warn(`    ! ${gh.stopped}`);

    for (const rec of needGithub) {
      // ★ 版本由本地权威来源决定的记录（集合仓库的 manifest、市场插件自己的
      //   package.json）**不走外部解析**。它们被塞进 needGithub 只是因为 npm 那
      //   一轮没有处理它们；真拿 GitHub 的 release/tag 去覆盖，会把集合仓库里
      //   写明的版本号换成一个对不上的数字 —— 或者在没有 release 时直接抹成 null。
      if (isLocallyAuthoritative(rec)) continue;

      const slug = githubSlug(rec.repo);
      const data = slug ? gh.results.get(slug) ?? null : null;
      if (slug && !data) stats.notFound += 1;
      if (data) {
        // 收藏量以 GitHub 为准（比上游索引新）；上游索引是兜底
        if (data.stars !== null) rec.stars = data.stars;
        if (data.forks !== null) rec.forks = data.forks;
        if (data.pushedAt) rec.pushedAt = data.pushedAt;
        if (data.license && !rec.license) rec.license = data.license;
        if (data.homepage && !rec.homepage) rec.homepage = data.homepage;
        // 仓库里真实的包名（用来把 npm 规格纠正过来）—— 只在没有干净规格时采用
        if (data.packageName && !rec.package && rec.install.method !== 'npm') rec.package = data.packageName;
      }
      decideVersion(rec, data, null);
    }

    for (const rec of targets) {
      if (rec.versionSource === 'npm') stats.npm += 1;
      else if (rec.versionSource === 'github-release') stats.githubRelease += 1;
      else if (rec.versionSource === 'github-tag') stats.githubTag += 1;
      else if (rec.versionSource === 'package.json') stats.packageJson += 1;
      else stats.none += 1;
    }
  }

  // ── 收尾：安装方法的自洽性 ────────────────────────────────
  for (const rec of bySlug.values()) {
    if (rec.install.method === 'github' && !githubSlug(rec.repo)) {
      // 没有仓库地址就推不出 github: 规格 —— 降级成 manual，别让闸门拿到空规格
      rec.install.spec = rec.install.spec && /^github:/.test(rec.install.spec) ? rec.install.spec : null;
      if (!rec.install.spec) rec.install.method = 'manual';
    }
    // 展示用的命令：没有就按规格补一条，让界面任何时候都有可复制的命令
    if (rec.install.commands.length === 0 && rec.install.spec) {
      rec.install.commands = [`dsh plugin --profile web add ${rec.install.spec}`];
    }
  }

  // ── 时间戳：只在内容真的变了的时候推进 ────────────────────
  const now = new Date().toISOString();
  const changed = [];
  const added = [];
  const removed = [];

  for (const [slug, rec] of bySlug) {
    const prev = existing.get(slug);
    if (!prev) {
      rec.source.firstSeenAt = now;
      rec.source.lastSyncedAt = now;
      rec.versionCheckedAt = now;
      rec.metricsCheckedAt = now;
      added.push(slug);
      continue;
    }
    const versionChanged = prev.version !== rec.version || prev.versionSource !== rec.versionSource;
    const metricsChanged = prev.stars !== rec.stars || prev.forks !== rec.forks || prev.pushedAt !== rec.pushedAt;
    rec.versionCheckedAt = versionChanged ? now : (prev.versionCheckedAt ?? now);
    rec.metricsCheckedAt = metricsChanged ? now : (prev.metricsCheckedAt ?? now);
    // contentEquals 会忽略这三个时间戳，所以这里比的是「实质内容」
    if (!contentEquals(prev, rec)) {
      rec.source.lastSyncedAt = now;
      changed.push(slug);
    } else {
      rec.source.lastSyncedAt = prev.source?.lastSyncedAt ?? now;
      // 内容一致时整体沿用上一轮的对象，保证写出去是**逐字节相同**的
      bySlug.set(slug, prev);
    }
  }

  // 消失的条目：community 层直接删（可再生）；带人工结论的一律保留
  for (const [slug, prev] of existing) {
    if (bySlug.has(slug)) continue;
    if (prev.tier === 'community' && prev.source?.kind === 'public-index') removed.push(slug);
    else bySlug.set(slug, prev);
  }

  log(`→ 新增 ${added.length}、变更 ${changed.length}、移除 ${removed.length}、保留 ${bySlug.size}`);

  // ── 校验模式 ──────────────────────────────────────────────
  const records = [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));

  // ★ --limit 是**试跑**：它只解析前 N 个插件的版本，其余条目会带着空版本写出去。
  //   真写盘的话，一次试跑就能把整个目录的版本号抹掉一大片 —— 所以默认拒绝写，
  //   要看落盘效果请显式加 --allow-partial-write。
  if (LIMIT > 0 && !has('--allow-partial-write') && !CHECK_ONLY) {
    console.log(`\n--limit ${LIMIT} 是试跑模式，未写盘。`);
    console.log('  · 要看落盘效果：加 --allow-partial-write');
    console.log('  · 要生成完整目录：去掉 --limit');
    const sample = targets.slice(0, LIMIT).map((r) => `  ${r.slug}  ${r.version ?? '(取不到)'}  [${r.versionSource}]  stars=${r.stars ?? '-'}`);
    console.log(`\n前 ${sample.length} 个的解析结果：`);
    console.log(sample.join('\n'));
    process.exit(problems.length ? 1 : 0);
  }

  // `--check` 与 `--offline` 在 main() 开头就早退了（那两条路径只读磁盘，不联网），
  // 所以走到这里的必然是联网采集，直接写盘。

  // ── 写盘 ──────────────────────────────────────────────────
  const dir = path.join(REPO, PLUGINS_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const rec of records) {
    const file = path.join(dir, `${rec.slug}.json`);
    const text = serializeRecord(rec);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
    writeJsonAtomic(file, null, { raw: text });
    written += 1;
  }
  for (const slug of removed) fs.rmSync(path.join(dir, `${slug}.json`), { force: true });

  const idx = buildIndex(records, {
    // generatedAt 会随每次运行变化，所以它只体现「索引什么时候生成的」，
    // 不参与内容比对（否则每天必然全量重写一次 index.json）
    generatedAt: index.meta?.generatedAt ?? null,
    sourceIndex: index.meta,
  });
  writeJsonAtomic(path.join(REPO, INDEX_REL), idx);

  ok(`写出 ${written} 个配置文件（共 ${records.length} 个）`);
  ok(`索引：${idx.counts.total} 条（已验证 ${idx.counts.verified} / 已审核 ${idx.counts.reviewed} / 未审核 ${idx.counts.community}）`);
  if (!OFFLINE) {
    log(`  版本来源：npm ${stats.npm} / GitHub release ${stats.githubRelease} / tag ${stats.githubTag} / package.json ${stats.packageJson} / 取不到 ${stats.none}`);
    if (stats.notFound) log(`  仓库已不存在或不可访问：${stats.notFound}`);
  }

  if (problems.length) {
    console.error(`\n同步完成，但有 ${problems.length} 项问题：`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }
}

/**
 * 这个记录的版本号是不是由**本地权威来源**决定的。
 *
 *   collection  插件集合仓库的 manifest.json —— 那是那个仓库里 tarball 的实际版本
 *   self        市场插件自己的 package.json —— 那是本次构建打出来的版本
 *
 * 这两类的共同点：版本号就在本机、就在这次运行的输入里，比任何外部查询都准。
 * 拿 npm / GitHub 的结果去覆盖它们，只会把正确的东西改成错的。
 *
 * ★ 注意 `manual`（人工写进 overrides 的 reviewed 条目）**不在**这一类里。
 *   那些条目的 `version` 记的是「审核时那一版」，而面板要显示的是上游**现在**是
 *   哪一版 —— 两者不是一回事，后者靠采集刷新。审核结论本身记在 review 字段里，
 *   不会被版本刷新动到。
 */
function isLocallyAuthoritative(rec) {
  return rec.source?.kind === 'collection' || rec.source?.kind === 'self';
}

/**
 * 这个记录该拿哪个名字去查 npm。
 *
 * ★ 只在**有明确依据**时查：索引里的安装命令本身就是一条干净的 npm 规格
 *   （也就是说，上游 README 自己写的就是 `dsh plugin add <包名>`）。
 *
 *   早先这里还会「拿仓库名去 npm 碰碰运气」——那是错的，而且代价很大：
 *   公共索引里的 name 与真实 npm 包名毫无关系，实测 `dsh-plugins-market`
 *   在 npm 上确实存在（版本 0.1.0），但那是**另一个人的另一个包**。
 *   虽然下面有 npmRepoMatches 把关不至于写错版本号，但为此要多打几千次
 *   registry，换来的命中率极低，不值。
 */
function npmCandidate(rec) {
  if (rec.source?.kind === 'collection') return null; // 自研插件不走 npm，版本以集合仓库为准
  if (rec.install.method !== 'npm') return null;
  return looksLikeNpmName(rec.install.spec) ? rec.install.spec : null;
}

/**
 * 带并发上限的 map。
 *
 * 不用 Promise.all 一把梭：2000 个请求同时打出去对 npm registry 不礼貌，
 * 而且失败时会一次性产生 2000 个 rejection。这里固定 8 路，逐个补齐。
 */
async function mapLimit(items, limit, fn) {
  const list = [...items];
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const next = list.shift();
      if (next === undefined) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}

export { TIERS, SCHEMA_VERSION };

await main();
