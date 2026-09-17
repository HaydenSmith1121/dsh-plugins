/**
 * dsh-plugins-market —— 服务器半：目录层
 *
 * ── 这一版的目录长什么样 ──────────────────────────────────────
 *
 * **一个插件一个配置文件**，全部放在市场仓库的 `catalog/plugins/<slug>.json`。
 * 每个文件里写着这个插件的版本号、收藏量、仓库地址和**安装方法** ——
 * 市场要装一个插件，就是把这个文件读下来，然后按 `install.method` 去装。
 *
 *   catalog/plugins/<slug>.json   ← 一个插件一份（人可读、可 diff、可单独 review）
 *   catalog/index.json            ← 由上面派生的轻量索引，列表页只读这一份
 *
 * 因此「市场」与「市场里的插件」是彻底分开的：
 * 插件发新版只改市场仓库里的**那一个配置文件**，市场插件本身不用换版本号。
 *
 * ── 三个信任层级（写在配置文件的 tier 字段里）───────────────────
 *
 *   verified   由插件集合仓库（dsh-plugin-collection）托管 tarball、按 dsh 版本实测过。
 *              离线 tarball + sha256，装前检查必须全绿，可一键直装。
 *   reviewed   维护者**人工审核**过、写进 catalog/overrides/reviewed.json 的第三方插件。
 *              每条都带审核人 / 日期 / 证据 / 结论；再过一遍装前检查后才允许安装。
 *   community  公开索引里的全部插件，**未经本仓库审核**。
 *              默认提示风险，装前检查只做尽力而为的静态探测，且必须用户显式确认。
 *
 * ── 数据的取法：远程 → 缓存 → 包内兜底 ─────────────────────────
 *
 * 三层都走同一条路。包内那份是**离线兜底**（没网时市场至少还能列出插件），
 * 不再是「唯一来源」—— 这正是插件发新版不必重打市场包的原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic, resolveDataDir, ensureDir, readTextSafe, pluginDir } from './util.js';

export const TIERS = ['verified', 'reviewed', 'community'];

export const TIER_META = {
  verified: {
    id: 'verified',
    label: '已验证',
    badge: 'verified',
    severity: 'ok',
    summary: '由插件集合仓库托管 tarball、已按当前 dsh 版本实测通过，带 sha256，可直接安装。',
  },
  reviewed: {
    id: 'reviewed',
    label: '已审核',
    badge: 'reviewed',
    severity: 'ok',
    summary: '维护者人工审核并记录证据后收录，仍需通过装前检查。',
  },
  community: {
    id: 'community',
    label: '未审核',
    badge: 'community',
    severity: 'risk',
    summary: '来自公开索引，本仓库未做适配验证，可能存在不兼容或其它风险。',
  },
};

/**
 * 条目上的**审核状态标签**。
 *
 * 三层目录本来被做成了三个平级的页签，但那个切分方式对用户没有意义：
 * 他要回答的是「这个插件装得安不安全」，而 verified 与 reviewed 在这件事上
 * 给出的答案是**同一个** —— 都经过本仓库的适配验证，都可以直接装。
 * 所以界面收敛成一个列表，用这里的标签区分。
 */
export const REVIEW_STATUS = {
  verified: { id: 'verified', label: '已验证', badge: 'verified', reviewed: true, summary: TIER_META.verified.summary },
  reviewed: { id: 'reviewed', label: '已审核', badge: 'reviewed', reviewed: true, summary: TIER_META.reviewed.summary },
  community: { id: 'community', label: '未审核', badge: 'community', reviewed: false, summary: TIER_META.community.summary },
};

export function reviewStatusOf(tier) {
  return REVIEW_STATUS[tier] ?? REVIEW_STATUS.community;
}

/** 本仓库的 raw 地址：目录、单条配置、tarball 全部从这里取 */
export const REPO_RAW_BASE = 'https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main';
export const REPO_HOMEPAGE = 'https://github.com/HaydenSmith1121/dsh-plugins';
export const REPO_INDEX_URL = `${REPO_RAW_BASE}/catalog/index.json`;
/** 单条配置文件的 raw 地址。slug 里只会有 [a-z0-9._-]，不需要再转义。 */
export function repoPluginConfigUrl(slug) {
  return `${REPO_RAW_BASE}/catalog/plugins/${slug}.json`;
}

/**
 * 目录的 TTL。
 *
 * 与上一版不同：这里不再需要「6 小时后必须重下 4.8MB」。索引现在是仓库里的
 * 静态文件（约几百 KB，服务端支持 ETag/304），所以刷新很便宜；
 * TTL 只用来避免同一分钟内反复打网络。
 */
const INDEX_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;

function bundledCatalogFile(name) {
  return path.join(pluginDir(), 'catalog', name);
}

function cacheFile(name) {
  return path.join(resolveDataDir(), name);
}

/** 单条配置的磁盘缓存目录 */
function configCacheDir() {
  return path.join(resolveDataDir(), 'plugin-configs');
}

async function fetchJsonConditional(url, { timeout = FETCH_TIMEOUT_MS, etag, lastModified } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'dsh-plugins-market' };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  // 304：目录没变。**不读 body** —— 这正是省下带宽的地方。
  if (res.status === 304) return { notModified: true, etag: etag ?? null, lastModified: lastModified ?? null };
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return {
    notModified: false,
    data: await res.json(),
    etag: res.headers.get('etag') ?? null,
    lastModified: res.headers.get('last-modified') ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// 索引：列表页的唯一数据源
// ─────────────────────────────────────────────────────────────

/**
 * 加载目录索引。
 *
 * @param {object}  [options]
 * @param {boolean} [options.preferRemote] false 时只用包内那份（离线自检用）
 * @param {boolean} [options.force]        忽略 TTL，强制去问服务端（仍走条件请求）
 * @returns {Promise<object>} { available, source, error, generatedAt, counts, entries }
 */
export async function loadCatalogIndex({ preferRemote = true, force = false } = {}) {
  const fallbackFile = bundledCatalogFile('index.json');
  const fallback = readJsonSafe(fallbackFile);
  const cache = cacheFile('catalog-index.json');
  const cached = readJsonSafe(cache);

  const shape = (data, source, error, extra = {}) => ({
    available: data !== null,
    source,
    error: error ?? null,
    generatedAt: data?.generatedAt ?? null,
    counts: data?.counts ?? { total: 0, verified: 0, reviewed: 0, community: 0 },
    sourceIndex: data?.sourceIndex ?? null,
    entries: (data?.plugins ?? []).map((p) => normalizeEntry(p, p.tier)),
    ...extra,
  });

  if (!preferRemote) return shape(fallback, 'bundled');

  // TTL 内直接用缓存：目录是静态文件，没必要每次开页面都去问
  if (!force && cached && Date.now() - (cached.fetchedAt ?? 0) < INDEX_TTL_MS) {
    return shape(cached.data, 'cache', cached.error ?? null, { ageMs: Date.now() - (cached.fetchedAt ?? 0) });
  }

  let probe;
  try {
    probe = await fetchJsonConditional(REPO_INDEX_URL, {
      timeout: 120_000,
      etag: cached?.etag ?? null,
      lastModified: cached?.lastModified ?? null,
    });
  } catch (err) {
    const chosen = cached?.data ?? fallback;
    return shape(
      chosen,
      cached ? 'cache' : 'bundled',
      `拉取市场目录失败（已用${cached ? '缓存' : '包内'}副本）：${err?.message ?? err}`,
    );
  }

  if (probe.notModified && cached) {
    // 目录没变：沿用缓存内容，只把「确认时刻」推到现在
    const payload = { ...cached, fetchedAt: Date.now(), etag: probe.etag, lastModified: probe.lastModified };
    try { writeJsonAtomic(cache, payload); } catch { /* 缓存写不进去不影响本次结果 */ }
    return shape(payload.data, 'remote-304', null, { ageMs: 0 });
  }

  const payload = {
    data: probe.data,
    fetchedAt: Date.now(),
    etag: probe.etag,
    lastModified: probe.lastModified,
    error: null,
  };
  try { writeJsonAtomic(cache, payload); } catch { /* 同上 */ }
  return shape(probe.data, 'remote', null, { ageMs: 0 });
}

// ─────────────────────────────────────────────────────────────
// 单条配置：装前检查与安装**只认这一份**
// ─────────────────────────────────────────────────────────────

/**
 * 读取某个插件的**配置文件**。
 *
 * ★ 这是本版市场最核心的一条约定：安装不是「按索引里的字段拼一条命令」，
 *   而是**先把这个插件自己的配置文件读下来，再按它写的 install.method 去装**。
 *   索引只用于列表展示。
 *
 * 取法同样是远程 → 缓存 → （仅包内收录的插件）包内兜底。取不到就返回 null，
 * 由调用方决定是报错还是退回索引条目 —— 绝不「猜」一个安装方法来继续。
 *
 * @param {object} entry 归一化后的索引条目（至少要带 slug）
 * @returns {Promise<{config: object|null, source: string|null, error: string|null}>}
 */
export async function loadPluginConfig(entry) {
  const slug = entry?.slug ?? null;
  if (!slug) return { config: null, source: null, error: '这条目录记录没有 slug，无法定位配置文件' };

  const cache = path.join(configCacheDir(), `${slug}.json`);
  const cached = readJsonSafe(cache);

  try {
    const res = await fetch(repoPluginConfigUrl(slug), {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-market' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const data = await res.json();
      try {
        ensureDir(configCacheDir());
        writeJsonAtomic(cache, data);
      } catch { /* 缓存失败不影响本次 */ }
      return { config: data, source: 'remote', error: null };
    }
    if (res.status !== 404) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } catch (err) {
    if (cached) return { config: cached, source: 'cache', error: String(err?.message ?? err) };
    const bundled = readJsonSafe(path.join(bundledCatalogFile('plugins'), `${slug}.json`));
    if (bundled) return { config: bundled, source: 'bundled', error: String(err?.message ?? err) };
    return { config: null, source: null, error: String(err?.message ?? err) };
  }

  // 远程明确 404：这个配置文件在仓库里不存在（新插件还没同步、或者已下架）
  const bundled = readJsonSafe(path.join(bundledCatalogFile('plugins'), `${slug}.json`));
  if (bundled) return { config: bundled, source: 'bundled', error: null };
  return { config: null, source: null, error: `仓库里没有 catalog/plugins/${slug}.json` };
}

/** 把配置文件换成界面/闸门认的条目形状（配置文件是权威，索引只是展示层）。 */
export function entryFromConfig(config, indexEntry = null) {
  const tier = TIERS.includes(config?.tier) ? config.tier : (indexEntry?.tier ?? 'community');
  return normalizeEntry(
    {
      ...indexEntry,
      ...config,
      // 索引里有的展示字段在配置文件缺省时兜底（配置是权威，但不该因为少个 title 就变空白）
      title: config?.title ?? indexEntry?.title,
      summary: config?.summary ?? indexEntry?.summary,
      tags: (config?.tags?.length ? config.tags : indexEntry?.tags) ?? [],
      install: config?.install ?? indexEntry?.install,
    },
    tier,
  );
}

// ─────────────────────────────────────────────────────────────
// 归一化 / 检索 / 分页
// ─────────────────────────────────────────────────────────────

/**
 * 统一条目形状。界面只认这一种结构，不需要知道它来自哪一层。
 *
 * install.method 的语义（与 catalog 配置文件里的枚举一致）：
 *   'tarball'  仓库托管的离线 .tgz —— url + sha256，唯一「直装」路径
 *   'npm'      npm 包名
 *   'github'   github:owner/repo
 *   'skills'   上游走的是 skills 机制，不是 dsh 插件，市场不代劳
 *   'manual'   没有可靠的一键安装方式，只能看说明
 */
export function normalizeEntry(p, tier) {
  /**
   * ★ 两种形状都要认，而且必须都认对。
   *
   *   索引条目（catalog/index.json）里的安装信息是**扁平**的：
   *     { installMethod: 'github', installSpec: 'github:o/r', needsConfig, risky }
   *   配置文件（catalog/plugins/<slug>.json）里是**嵌套**的：
   *     install: { method, spec, url, sha256, tarball, ... }
   *
   *   只认嵌套那种的后果不是报错，而是**静默退化**：索引条目会全部变成
   *   `method: 'manual'` —— 而 'manual' 在这套语义里正是「不可安装」。
   *   于是「列表里每个插件都装不了」，原因却只是一个字段层级。
   */
  const install = {
    ...(p.installMethod !== undefined ? { method: p.installMethod, spec: p.installSpec ?? null } : {}),
    ...(p.install ?? {}),
  };
  return {
    // slug 是配置文件的定位符（catalog/plugins/<slug>.json），缺了它就没法读配置
    slug: p.slug ?? null,
    tier: TIERS.includes(tier) ? tier : 'community',
    tierLabel: TIER_META[tier]?.label ?? tier,
    reviewStatus: reviewStatusOf(tier),
    id: p.id ?? p.package ?? p.name,
    /**
     * ★ `package` 只认**真的包名**，绝不退回 `name`。
     *
     *   索引里的 `name` 是**仓库名**（公开索引按仓库一条记录），它跟 npm 包名毫无关系：
     *   几十个互不相干的仓库都叫 `dsh-plugins` / `dsh-plugin` / `dsh-memory`。早先这里写的是
     *   `p.package ?? p.name`，于是这些**不同的插件**在合并去重时被算成了同一个 ——
     *   7496 条目录只剩 6542 条，954 条被吃掉。而列表看起来完全正常，只是数量对不上，
     *   被吃掉的那些在界面上永远不会出现（`mergeEntries` 把后到的当成了重复项）。
     *
     *   `name` 仍然参与展示（标题兜底）与检索，只是不再参与「这是不是同一个插件」的判定 ——
     *   那条判据必须硬：只有真的包名才能代表「同一个包」。
     */
    package: p.package ?? null,
    name: p.name ?? p.package ?? null,
    version: p.version ?? null,
    versionSource: p.versionSource ?? null,
    title: p.title ?? p.package ?? p.name ?? p.id,
    summary: p.summary ?? p.descriptionZh ?? p.description ?? '',
    tags: Array.isArray(p.tags) ? p.tags : [],
    author: p.author ?? p.owner ?? null,
    upstream: p.repo ?? p.upstream ?? (p.fullName ? `https://github.com/${p.fullName}` : null),
    homepage: p.homepage ?? null,
    license: p.license ?? null,
    stars: p.stars ?? null,
    pushedAt: p.pushedAt ?? null,
    review: p.review ?? null,

    // 兼容性事实（verified / reviewed 两层有，community 层没有）
    peerRuntimePin: p.peerRuntimePin ?? null,
    peerVerdict: p.peerVerdict ?? null,
    peerNote: p.peerNote ?? null,
    coexistenceWarning: p.coexistenceWarning ?? null,
    notes: p.notes ?? null,
    origin: p.origin ?? null,
    sha256: p.install?.sha256 ?? p.sha256 ?? null,
    // 自引用条目（本插件指向自己的 tarball）无法自包含 hash，靠这个字段如实说明原因
    sha256Note: p.sha256Note ?? null,

    install: {
      method: normalizeMethod(install),
      // kind 是上一版的字段名，这里保留一列以兼容还没换过来的调用方
      kind: legacyKindOf(install),
      spec: install.spec ?? null,
      commands: install.commands ?? p.installCommands ?? [],
      needsConfig: install.needsConfig ?? Boolean(p.needsConfig),
      usageNeedsConfig: install.usageNeedsConfig ?? Boolean(p.usageNeedsConfig),
      risky: install.risky ?? p.risky === true,
      riskyReasons: install.riskyReasons ?? [],
      tarball: install.tarball ?? p.tarball ?? null,
      url: install.url ?? null,
      dshVersion: install.dshVersion ?? null,
      files: install.files ?? p.files ?? null,
    },
  };
}

/**
 * 把任意来源的 `install` 归一成新的 method 枚举。
 *
 * 要同时认两种写法，而且**方向只能是旧的 → 新的**：
 *   · 新写法：`{ method: 'tarball' | 'npm' | 'github' | 'skills' | 'manual' }`
 *   · 旧写法（≤0.3.0 的目录）：`{ kind: 'local-tarball' | 'npm' | 'github' | 'manual' }`
 *
 * 早先这里写的是 `install.method ?? install.kind`，于是旧目录里的
 * `kind: 'local-tarball'` 会原样变成 method，落到安装器那里**匹配不上任何分支** ——
 * 症状是「闸门说不可安装」，而原因只是一个字段名的历史遗留。
 */
function normalizeMethod(install) {
  const raw = install?.method ?? install?.kind ?? null;
  if (raw === 'local-tarball' || raw === 'tarball') return 'tarball';
  if (['npm', 'github', 'skills', 'manual'].includes(raw)) return raw;
  return 'manual';
}

/**
 * 把新的 method 映射回上一版的 `kind`。
 *
 * 保留这一列是为了让闸门 / 安装器 / 手动方案这几个模块各自改造时不必一次性全改完，
 * 也免得旧书签或外部调用方拿不到它熟悉的字段。新代码请一律用 `install.method`。
 */
function legacyKindOf(install) {
  const method = normalizeMethod(install);
  if (method === 'tarball') return 'local-tarball';
  if (method === 'skills') return 'manual';
  return method ?? 'manual';
}

function haystack(entry) {
  return [
    entry.id,
    entry.package,
    entry.title,
    entry.summary,
    entry.author,
    entry.upstream,
    ...(entry.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 简单但可用的相关度打分：完全匹配 > 前缀 > 词命中 > 子串 */
function scoreEntry(entry, terms) {
  const hay = haystack(entry);
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const inTitle = String(entry.title ?? '').toLowerCase();
    const inId = String(entry.id ?? '').toLowerCase();
    if (inId === term) score += 100;
    else if (inTitle === term) score += 80;
    else if (inId.startsWith(term)) score += 40;
    else if (inTitle.startsWith(term)) score += 30;
    else if (inTitle.includes(term)) score += 15;
    else if (hay.includes(term)) score += 6;
    else return -1; // 任一关键词不命中 → 整条不匹配
  }
  // 同分时：已验证 > 已审核 > 未审核；再看 star 数
  const tierBonus = entry.tier === 'verified' ? 60 : entry.tier === 'reviewed' ? 30 : 0;
  return score + tierBonus + Math.min(20, Math.log10(1 + (entry.stars ?? 0)) * 8);
}

/**
 * 把三层目录**合并成一池**。
 *
 * 为什么必须去重：同一个包经常同时出现在多层 —— 本仓库收录的 dsh-memory 既是
 * 「已验证」，又会原样出现在公开索引里；@dsh-market/plugin 也一样。不去重的话
 * 用户会在一个列表里看到两条一模一样的插件，而且能不能装还不一样。
 *
 * 保留哪一条：层级更高的那条，因为它是**我们验证过**的说法；
 * 但把被合并条目的 star 数等展示信息补过来 —— 那些是上游事实，不该因为
 * 我们收编了它就消失。
 *
 * ★ 层可能来自两种形状：`{ plugins: [...] }`（历史形态）或裸数组。
 *   早先这里只认前者，传裸数组时会**静默丢掉整整一层** ——
 *   列表看起来完全正常（还有别的层撑着），只是数量对不上、标签全错。
 *   静默丢数据比抛错难查得多，所以两种都收，并且下面还兜一次底。
 *
 * @returns {{merged:object[], shadowed:Map<string,object[]>}} shadowed 供详情页用
 */
export function mergeEntries(layers) {
  const byKey = new Map();
  const shadowed = new Map();
  const rank = { verified: 0, reviewed: 1, community: 2 };

  const tierOf = (tier) => {
    const raw = layers?.[tier];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.plugins)) return raw.plugins;
    if (Array.isArray(raw?.entries)) return raw.entries;
    return [];
  };

  // 按层级从高到低喂进来，第一条赢
  const ordered = [
    ...tierOf('verified'),
    ...tierOf('reviewed'),
    ...tierOf('community'),
  ].sort((a, b) => (rank[a.tier] ?? 3) - (rank[b.tier] ?? 3));

  for (const entry of ordered) {
    const key = dedupeKey(entry);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...entry });
      continue;
    }
    // 合并展示信息：只补空的，不覆盖已验证层给出的事实
    const merged = { ...prev };
    if (merged.stars == null && entry.stars != null) merged.stars = entry.stars;
    if (merged.pushedAt == null && entry.pushedAt != null) merged.pushedAt = entry.pushedAt;
    if (merged.license == null && entry.license != null) merged.license = entry.license;
    if (merged.homepage == null && entry.homepage != null) merged.homepage = entry.homepage;
    if (merged.upstream == null && entry.upstream != null) merged.upstream = entry.upstream;
    if (merged.summary === '' && entry.summary) merged.summary = entry.summary;
    if (!merged.author && entry.author) merged.author = entry.author;
    byKey.set(key, merged);

    const list = shadowed.get(key) ?? [];
    list.push(entry);
    shadowed.set(key, list);
  }

  return { merged: [...byKey.values()], shadowed };
}

/**
 * 去重键。
 *
 * 用包名优先 —— 同一个 npm 包名就是同一个插件，这条判据最硬。
 * 没有包名时才退到 id；再没有就退到 upstream 仓库地址
 * （公共索引里大量条目 id 五花八门，但指向同一个仓库）。
 */
function dedupeKey(entry) {
  if (entry.package) return `pkg:${String(entry.package).toLowerCase()}`;
  if (entry.id) return `id:${String(entry.id).toLowerCase()}`;
  if (entry.upstream) return `up:${String(entry.upstream).toLowerCase()}`;
  return `title:${String(entry.title ?? '').toLowerCase()}`;
}

/**
 * 统一检索。
 *
 * 除了关键词，还支持两个**筛选器**：来源审核状态、以及用户自己的标记。
 * 筛选放在服务端做 —— 目录有 7000+ 条，全丢给浏览器筛是不可行的。
 *
 * @param {object[]} entries 合并后的池
 * @param {object} opts { query, limit, offset, review, only, marks, installed }
 *        review   'reviewed' | 'unreviewed' | null
 *        only     'liked' | 'favorited' | 'installed' | 'upgradable' | null
 */
export function searchCatalog(entries, opts = {}) {
  const {
    query = '', limit = 50, offset = 0,
    review = null, only = null, marks = {}, installed = null,
  } = opts;

  const filtered = entries.filter((entry) => {
    if (review === 'reviewed' && !reviewStatusOf(entry.tier).reviewed) return false;
    if (review === 'unreviewed' && reviewStatusOf(entry.tier).reviewed) return false;

    if (only === 'liked' && !marks[entry.id]?.liked) return false;
    if (only === 'favorited' && !marks[entry.id]?.favorited) return false;
    if (only === 'installed' || only === 'upgradable') {
      const st = installed?.get(entry.id) ?? null;
      if (!st?.installed) return false;
      if (only === 'upgradable' && st.status !== 'upgradable') return false;
    }
    return true;
  });

  const result = searchEntries(filtered, query, { limit, offset });
  return { ...result, filteredTotal: filtered.length };
}

/** 由条目导出「主键」：优先包名，与 dedupeKey 保持一致 */
export function entryKey(entry) {
  return entry.package ?? entry.id;
}

export function searchEntries(entries, query, { limit = 50, offset = 0 } = {}) {
  const q = String(query ?? '').trim();
  if (q === '') {
    const sorted = [...entries].sort((a, b) => {
      const t = { verified: 0, reviewed: 1, community: 2 };
      const d = (t[a.tier] ?? 3) - (t[b.tier] ?? 3);
      if (d !== 0) return d;
      return (b.stars ?? 0) - (a.stars ?? 0);
    });
    return { total: sorted.length, items: sorted.slice(offset, offset + limit) };
  }
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of entries) {
    const s = scoreEntry(entry, terms);
    if (s >= 0) scored.push({ entry, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return {
    total: scored.length,
    items: scored.slice(offset, offset + limit).map((x) => x.entry),
  };
}

/** 汇总目录状态（界面顶部状态条用） */
export function catalogStatus({ verified, reviewed, community, env, meta }) {
  // 同 mergeEntries：层既可能是 { plugins: [...] } 也可能是裸数组
  const countOf = (tier) => {
    const raw = { verified, reviewed, community }[tier];
    if (Array.isArray(raw)) return raw.length;
    if (Array.isArray(raw?.plugins)) return raw.plugins.length;
    if (Array.isArray(raw?.entries)) return raw.entries.length;
    return 0;
  };
  const tiers = [
    { ...TIER_META.verified, count: countOf('verified') },
    { ...TIER_META.reviewed, count: countOf('reviewed') },
    { ...TIER_META.community, count: countOf('community'), source: community?.source ?? null },
  ];
  return {
    tiers,
    /**
     * 合并视图的口径：三层去重后有多少条，其中「已审核」多少、「未审核」多少。
     * 界面顶部的 已审核 / 未审核 两个数字来自这里，而不是上面三个原始层级 ——
     * 否则一个包同时出现在两层里会被数两次，和用户看到的列表条数对不上。
     */
    merged: mergedCounts({ verified, reviewed, community }),
    verified: { available: verified?.available ?? false, error: verified?.error ?? null, generatedAt: verified?.generatedAt ?? null },
    reviewed: { source: reviewed?.source ?? null, error: reviewed?.error ?? null, reviewedAt: reviewed?.reviewedAt ?? null },
    community: {
      source: community?.source ?? null,
      error: community?.error ?? null,
      generatedAt: community?.generatedAt ?? null,
      stale: community?.stale ?? null,
      ageMs: community?.ageMs ?? null,
    },
    // 目录本身的取用情况：远程 / 304 / 缓存 / 离线包内 —— 用户判断「目录新不新」的唯一依据
    index: meta ?? null,
    env,
    repoHomepage: REPO_HOMEPAGE,
  };
}

export function mergedCounts(layers) {
  const { merged } = mergeEntries(layers);
  let reviewedCount = 0;
  let unreviewedCount = 0;
  const byTier = { verified: 0, reviewed: 0, community: 0 };
  for (const e of merged) {
    byTier[e.tier] = (byTier[e.tier] ?? 0) + 1;
    if (reviewStatusOf(e.tier).reviewed) reviewedCount++;
    else unreviewedCount++;
  }
  return {
    total: merged.length,
    reviewed: reviewedCount,
    unreviewed: unreviewedCount,
    verified: byTier.verified,
    reviewedTier: byTier.reviewed,
    community: byTier.community,
  };
}

/** 查找单条：先精确 id，再包名，最后 slug */
export function findEntry(layers, id) {
  for (const tier of TIERS) {
    const raw = layers[tier];
    const list = Array.isArray(raw) ? raw : (raw?.plugins ?? raw?.entries ?? []);
    const hit = list.find((e) => e.id === id || e.package === id || e.slug === id);
    if (hit) return hit;
  }
  return null;
}

export function ensureDataDir() {
  return ensureDir(resolveDataDir());
}

export function readCacheMeta() {
  return {
    dataDir: resolveDataDir(),
    catalogIndexCache: fs.existsSync(cacheFile('catalog-index.json')),
    configCacheDir: configCacheDir(),
    configCacheCount: fs.existsSync(configCacheDir()) ? fs.readdirSync(configCacheDir()).filter((f) => f.endsWith('.json')).length : 0,
    backups: listBackups(),
  };
}

export function listBackups() {
  const dir = path.join(resolveDataDir(), 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('profile-'))
    .map((name) => ({ name, path: path.join(dir, name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export { readTextSafe };
