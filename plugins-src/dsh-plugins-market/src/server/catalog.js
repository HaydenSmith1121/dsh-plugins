/**
 * dsh-plugins-market —— 服务器半：目录层
 *
 * 三层目录（这是本市场与公共市场的核心差别）：
 *
 *   verified  本仓库自带、已按 dsh 版本实测过的插件。
 *             离线 tarball、版本精确匹配 → 装前检查为「必须全绿」，可一键直装。
 *   reviewed  维护者**人工审核**过、写进 catalog/curated.json 的第三方插件。
 *             每条都带审核人/日期/证据/结论；再过一遍装前检查后才允许安装。
 *   community 公共索引（dsh.market）里的全部插件，**未经本仓库审核**。
 *             默认提示「可能有兼容性风险」，装前检查只做尽力而为的静态探测，
 *             且必须用户显式确认风险才能继续。
 *
 * 目录来源全部是公开静态资源，不需要任何自建服务器：
 *   verified  → 打包进插件包内（离线可用）
 *   reviewed  → 仓库 raw + 包内兜底副本
 *   community → 公共索引 + 本地磁盘缓存（带 TTL，在线刷新）
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
    summary: '本仓库自带，已按当前 dsh 版本实测通过，离线 tarball，可直接安装。',
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
    summary: '来自公共索引，本仓库未做适配验证，可能存在不兼容或其它风险。',
  },
};

/**
 * 条目上的**审核状态标签**。
 *
 * 三层目录（verified / reviewed / community）本来被做成了三个平级的页签，
 * 但那个切分方式对用户没有意义：他要回答的是「这个插件装得安不安全」，
 * 而 verified 与 reviewed 在这件事上给出的答案是**同一个** —— 都经过本仓库
 * 的适配验证，都可以直接装。把它们拆成两个页签只会让人来回切。
 *
 * 所以界面收敛成一个列表，用这里的标签区分：
 *
 *   verified   已验证   ← 仓库自带 + 按当前 dsh 实测
 *   reviewed   已审核   ← 维护者人工审核后收录
 *   community  未审核   ← 公共索引，没做过任何验证
 *
 * ★ label 里的「已」/「未」是有意义的：用户原话就是「通过插件上面的标签
 *   （已经审核、未审核）来区分」，这里如实照做。
 */
export const REVIEW_STATUS = {
  verified: { id: 'verified', label: '已验证', badge: 'verified', reviewed: true, summary: TIER_META.verified.summary },
  reviewed: { id: 'reviewed', label: '已审核', badge: 'reviewed', reviewed: true, summary: TIER_META.reviewed.summary },
  community: { id: 'community', label: '未审核', badge: 'community', reviewed: false, summary: TIER_META.community.summary },
};

export function reviewStatusOf(tier) {
  return REVIEW_STATUS[tier] ?? REVIEW_STATUS.community;
}

/** 公共索引地址（与 @dsh-market 同源，公开静态资源） */
export const COMMUNITY_INDEX_URL = 'https://2bingling.github.io/dsh-market/plugins.json';
/** 本仓库 raw 地址：用于取最新的 curated 目录 */
export const REPO_RAW_BASE = 'https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main';
export const REPO_CURATED_URL = `${REPO_RAW_BASE}/catalog/curated.json`;
export const REPO_HOMEPAGE = 'https://github.com/HaydenSmith1121/dsh-plugins';

const COMMUNITY_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const FETCH_TIMEOUT_MS = 60_000;

function bundledCatalogFile(name) {
  return path.join(pluginDir(), 'catalog', name);
}

function cacheFile(name) {
  return path.join(resolveDataDir(), name);
}

async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-market' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────
// verified 层：包内自带，离线可用
// ─────────────────────────────────────────────────────────────

export function loadVerified() {
  const file = bundledCatalogFile('verified.json');
  const data = readJsonSafe(file);
  if (!data) {
    return { available: false, error: `缺少包内目录文件：${file}`, generatedFrom: null, plugins: [] };
  }
  return {
    available: true,
    error: null,
    generatedFrom: data.generatedFrom ?? null,
    generatedAt: data.generatedAt ?? null,
    plugins: (data.plugins ?? []).map((p) => normalizeEntry(p, 'verified')),
  };
}

// ─────────────────────────────────────────────────────────────
// reviewed 层：仓库 raw 优先，包内兜底
// ─────────────────────────────────────────────────────────────

export async function loadReviewed({ preferRemote = true } = {}) {
  const fallbackFile = bundledCatalogFile('curated.json');
  const fallback = readJsonSafe(fallbackFile) ?? { plugins: [] };
  const cache = cacheFile('curated-cache.json');

  if (!preferRemote) {
    return {
      available: true,
      source: 'bundled',
      plugins: (fallback.plugins ?? []).map((p) => normalizeEntry(p, 'reviewed')),
      reviewedAt: fallback.reviewedAt ?? null,
      error: null,
    };
  }

  try {
    const remote = await fetchJson(REPO_CURATED_URL);
    writeJsonAtomic(cache, remote);
    return {
      available: true,
      source: 'remote',
      plugins: (remote.plugins ?? []).map((p) => normalizeEntry(p, 'reviewed')),
      reviewedAt: remote.reviewedAt ?? null,
      error: null,
    };
  } catch (err) {
    const cached = readJsonSafe(cache);
    const chosen = cached ?? fallback;
    return {
      available: true,
      source: cached ? 'cache' : 'bundled',
      plugins: (chosen.plugins ?? []).map((p) => normalizeEntry(p, 'reviewed')),
      reviewedAt: chosen.reviewedAt ?? null,
      error: `拉取最新审核目录失败（已用${cached ? '缓存' : '包内'}副本）：${err?.message ?? err}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// community 层：公共索引 + 磁盘缓存 + 服务器端分页/搜索
// ─────────────────────────────────────────────────────────────

/**
 * 把 22MB 的公共索引压成只含界面需要的字段的瘦身版再落盘。
 * 既省磁盘也省内存 —— 原始索引里 70% 以上的字段界面根本不用。
 */
function slimCommunityPlugin(p) {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    owner: p.owner,
    repo: p.repo,
    fullName: p.fullName,
    descriptionZh: p.descriptionZh ?? null,
    description: p.description ?? null,
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 12) : [],
    stars: p.stars ?? 0,
    pushedAt: p.pushedAt ?? null,
    license: p.license ?? null,
    homepage: p.homepage ?? null,
    installMethod: p.install?.method ?? null,
    installCommands: Array.isArray(p.install?.commands) ? p.install.commands.slice(0, 4) : [],
    needsConfig: Boolean(p.install?.needsConfig),
    usageNeedsConfig: Boolean(p.install?.usageNeedsConfig),
    risky: p.install?.risky === true,
    scoreTotal: p.score?.total ?? 0,
    confidence: p.score?.confidence ?? null,
  };
}

export function loadCommunityCache() {
  const file = cacheFile('community-slim.json');
  const data = readJsonSafe(file);
  if (!data) return null;
  return {
    source: 'cache',
    generatedAt: data.generatedAt ?? null,
    fetchedAt: data.fetchedAt ?? null,
    stale: Date.now() - (data.fetchedAt ?? 0) > COMMUNITY_TTL_MS,
    ageMs: Date.now() - (data.fetchedAt ?? 0),
    plugins: data.plugins ?? [],
  };
}

export async function fetchCommunity({ force = false } = {}) {
  const cached = loadCommunityCache();
  if (cached && !force && !cached.stale) return cached;

  try {
    const raw = await fetchJson(COMMUNITY_INDEX_URL, { timeout: 120_000 });
    const plugins = (raw.plugins ?? []).map(slimCommunityPlugin);
    const payload = {
      schemaVersion: raw.schemaVersion ?? null,
      generatedAt: raw.generatedAt ?? null,
      fetchedAt: Date.now(),
      count: plugins.length,
      plugins,
    };
    writeJsonAtomic(cacheFile('community-slim.json'), payload);
    return {
      source: 'remote',
      generatedAt: payload.generatedAt,
      fetchedAt: payload.fetchedAt,
      stale: false,
      ageMs: 0,
      plugins,
    };
  } catch (err) {
    if (cached) {
      return { ...cached, source: 'cache-error', error: String(err?.message ?? err) };
    }
    return {
      source: 'unavailable',
      error: String(err?.message ?? err),
      generatedAt: null,
      fetchedAt: null,
      stale: true,
      ageMs: 0,
      plugins: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 归一化 / 检索 / 分页
// ─────────────────────────────────────────────────────────────

/**
 * 统一条目形状。界面只认这一种结构，不需要知道它来自哪一层。
 * install 的语义：
 *   kind: 'local-tarball'  包内/仓库自带的离线 tarball（唯一「直装」路径）
 *         'npm'            npm 包名
 *         'github'         github:owner/repo
 *         'manual'         没有可靠的一键安装方式，只能看说明
 */
export function normalizeEntry(p, tier) {
  const install = p.install ?? {};
  return {
    tier,
    tierLabel: TIER_META[tier]?.label ?? tier,
    reviewStatus: reviewStatusOf(tier),
    id: p.id ?? p.package ?? p.name,
    package: p.package ?? p.name ?? null,
    version: p.version ?? null,
    title: p.title ?? p.package ?? p.name ?? p.id,
    summary: p.summary ?? p.descriptionZh ?? p.description ?? '',
    tags: Array.isArray(p.tags) ? p.tags : [],
    author: p.author ?? p.owner ?? null,
    upstream: p.upstream ?? (p.fullName ? `https://github.com/${p.fullName}` : null),
    homepage: p.homepage ?? null,
    license: p.license ?? null,
    stars: p.stars ?? null,
    pushedAt: p.pushedAt ?? null,
    review: p.review ?? null,

    // 兼容性事实（verified/reviewed 层有，community 层没有）
    peerRuntimePin: p.peerRuntimePin ?? null,
    peerVerdict: p.peerVerdict ?? null,
    peerNote: p.peerNote ?? null,
    coexistenceWarning: p.coexistenceWarning ?? null,
    notes: p.notes ?? null,
    origin: p.origin ?? null,
    sha256: p.sha256 ?? null,
    // 自引用条目（本插件指向自己的 tarball）无法自包含 hash，靠这个字段如实说明原因
    sha256Note: p.sha256Note ?? null,

    install: {
      kind: install.kind ?? 'manual',
      spec: install.spec ?? null,
      method: install.method ?? p.installMethod ?? null,
      commands: install.commands ?? p.installCommands ?? [],
      needsConfig: install.needsConfig ?? Boolean(p.needsConfig),
      usageNeedsConfig: install.usageNeedsConfig ?? Boolean(p.usageNeedsConfig),
      risky: install.risky ?? p.risky === true,
      tarball: install.tarball ?? p.tarball ?? null,
      files: install.files ?? p.files ?? null,
    },
  };
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
 * 为什么必须去重：同一个包经常同时出现在多层 —— 仓库自带的 dsh-memory 既是
 * 「已验证」，又会原样出现在公共索引里；@dsh-market/plugin 也一样。不去重的话
 * 用户会在一个列表里看到两条一模一样的插件，而且价格（能不能装）还不一样。
 *
 * 保留哪一条：层级更高的那条，因为它是**我们验证过**的说法；
 * 但把被合并条目的 star 数等展示信息补过来 —— 那些是上游事实，不该因为
 * 我们收编了它就消失。
 *
 * @returns {{merged:object[], shadowed:Map<string,object[]>}} shadowed 供详情页用
 */
export function mergeEntries(layers) {
  const byKey = new Map();
  const shadowed = new Map();
  const rank = { verified: 0, reviewed: 1, community: 2 };

  /**
   * ★ 层可能是 `{ plugins: [...] }`（loadVerified / loadReviewed 的产物），
   *   也可能已经是裸数组（社区层就是裸数组）。两种都要认。
   *
   *   这里曾经只写 `layers.verified?.plugins ?? []` —— 传裸数组时它静默返回
   *   空，于是**整整一层凭空消失**：已验证的插件全都不见，而列表看起来完全
   *   正常（还有社区层撑着），只是数量对不上、层级标签全变成「未审核」。
   *   静默丢数据比抛错难查得多，所以显式两种都收，并且下面还兜一次底。
   */
  const tierOf = (tier) => {
    const raw = layers?.[tier];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.plugins)) return raw.plugins;
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
 * 筛选放在服务端做 —— 公共索引 7000+ 条，全丢给浏览器筛是不可行的。
 *
 * @param {object[]} entries 合并后的池
 * @param {object} opts { query, limit, offset, review, only, marks, installedOnly }
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
export function catalogStatus({ verified, reviewed, community, env }) {
  // 同 mergeEntries：层既可能是 { plugins: [...] } 也可能是裸数组
  const countOf = (tier) => {
    const raw = { verified, reviewed, community }[tier];
    if (Array.isArray(raw)) return raw.length;
    if (Array.isArray(raw?.plugins)) return raw.plugins.length;
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

/** 查找单条：先精确 id，再包名 */
export function findEntry(layers, id) {
  for (const tier of TIERS) {
    const hit = layers[tier]?.find((e) => e.id === id || e.package === id);
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
    communityCache: fs.existsSync(cacheFile('community-slim.json')),
    curatedCache: fs.existsSync(cacheFile('curated-cache.json')),
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
