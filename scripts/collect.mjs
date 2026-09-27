/**
 * 插件项目索引的**采集器** —— 仓库里唯一会写 catalog/ 的脚本。
 *
 *   node scripts/collect.mjs                  # 联网采集（每 6 小时由 CI 跑的就是它）
 *   node scripts/collect.mjs --check          # ★ 只读校验：不联网、不写盘
 *   node scripts/collect.mjs --offline        # 不联网，用 .cache/ 里上一轮的原始数据重采
 *   node scripts/collect.mjs --only owner/repo# 只处理一个仓库（调试 / 手工补录）
 *   node scripts/collect.mjs --limit 200      # 只保留 star 最高的 N 条（试跑，不写盘）
 *   node scripts/collect.mjs --pages 5        # 每个查询最多翻几页（默认 3 页 = 300 条）
 *
 * ── 三条路径的能力边界（别混）─────────────────────────────────
 *
 *   --check    读磁盘 → 核对「索引是否自洽」「包内快照是不是索引的稳定投影」
 *              「记录是不是严格按 star 降序」。**没有任何写操作，没有任何网络调用。**
 *   --offline  同样不联网，但**会写** catalog/（用缓存里的原始数据重跑一遍归一化）。
 *   （无参数） 联网采集 —— 只有这条路径会发现新项目、更新 star 数与描述。
 *
 * ── 数据从哪来（三路合并）──────────────────────────────────────
 *
 *   1. GitHub 搜索            按 topic / 关键词检索，直读仓库元数据（最权威，优先级最高）
 *   2. 公开索引 plugins.json   第三方维护的 DSH 插件索引（覆盖面最广，优先级最低）
 *   3. catalog/seed.json      手工收录 / 手工排除（人工写下的东西优先级高于第三方转述）
 *
 *   ★ 同一仓库取并集：GitHub 搜索给出的描述 / star 数最准；公开索引覆盖了大量
 *     没打 topic、搜不到的仓库；seed 用来补两者都漏掉的，以及明确排除某些仓库。
 *
 * ── 三条硬规矩 ────────────────────────────────────────────────
 *
 *   · **内容没变就不动时间戳**（见 lib/catalog-format.mjs 的说明）。
 *   · **没看过就不删**。某个来源这一轮失败了（限流、网络），那么由它发现、
 *     这一轮又没被别的来源看到的记录**原样保留** —— 把「没查到」当成「不存在」
 *     是这类采集器最容易犯、也最难发现的错误。只有 90 天没再被任何来源看到过的
 *     记录才会被清掉。
 *   · **绝不猜**。描述取不到就 null，star 数取不到就 null。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  INDEX_REL, SNAPSHOT_REL, SOURCE_LABELS,
  buildIndex, buildSnapshot, contentEquals, indexContent, mergeRecords,
  normalizeRecord, readJsonSafe, recordContent, sortRecords, serializeIndex, sourceRank,
  toRepoId, writeTextAtomic,
} from './lib/catalog-format.mjs';
import { describeToken, githubToken, searchRepositories } from './lib/github.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE_DIR = path.join(REPO, '.cache');
const INDEX_FILE = path.join(REPO, INDEX_REL);
const SNAPSHOT_FILE = path.join(REPO, SNAPSHOT_REL);
const SEED_FILE = path.join(REPO, 'catalog', 'seed.json');

/** 公开索引（第三方维护的 DSH 插件清单）—— 覆盖面最广的一路 */
export const PUBLIC_INDEX_URL = 'https://2bingling.github.io/dsh-market/plugins.json';

/**
 * 搜索查询表。
 *
 * ★ 为什么是「多个窄查询」而不是「一个宽查询翻到底」：
 *   GitHub 搜索接口每个查询最多返回 1000 条，且认证后只有 30 次/分钟。
 *   与其在一个查询里翻 10 页（1000 条封顶），不如用多个切面各取前几页 ——
 *   覆盖面更广，也天然按 star 数排序取到了每类的头部。
 */
const QUERIES = [
  'topic:dsh-plugin',
  'topic:deepseek-harness',
  'topic:dsh-plugins',
  'topic:dsh-bundle',
  'topic:deepseek-dsh',
  'dsh-plugin in:name',
  '"deepseek harness" in:name,description',
  '"dsh plugin" in:description',
];

/** 明确表示「这是 DSH 生态」的 topic */
const RELEVANT_TOPICS = new Set([
  'dsh', 'dsh-plugin', 'dsh-plugins', 'dsh-bundle', 'dsh-extension', 'dsh-theme',
  'deepseek-harness', 'deepseek-dsh', 'deepseekharness',
]);

/** 兜底相关性判断：名字 / 描述里出现 dsh 或 deepseek harness 这个词 */
const RELEVANT_TEXT = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|deepseek[-_ ]?harness/i;

/** 多久没被任何来源看到就从索引里清掉 */
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

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
const ONLY = toRepoId(valueOf('--only'));
const LIMIT = Number(valueOf('--limit', '0')) || 0;
const PAGES = Number(valueOf('--pages', '3')) || 3;
const QUIET = has('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn(...a);
const problems = [];
const fail = (m) => { problems.push(m); console.error(`  ✗ ${m}`); };
const ok = (m) => log(`  ✓ ${m}`);
const now = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// 读写
// ─────────────────────────────────────────────────────────────

function loadExistingIndex() {
  const doc = readJsonSafe(INDEX_FILE);
  const map = new Map();
  for (const raw of doc?.plugins ?? []) {
    const rec = normalizeRecord(raw);
    if (rec) map.set(rec.id, rec);
  }
  return { doc, map };
}

function loadSeed() {
  const doc = readJsonSafe(SEED_FILE);
  return {
    include: (doc?.include ?? []).map(toRepoId).filter(Boolean),
    exclude: new Set((doc?.exclude ?? []).map(toRepoId).filter(Boolean)),
  };
}

function writeJsonCache(name, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  writeTextAtomic(path.join(CACHE_DIR, name), `${JSON.stringify(value)}\n`);
}

function readJsonCache(name) {
  return readJsonSafe(path.join(CACHE_DIR, name));
}

// ─────────────────────────────────────────────────────────────
// 来源 ①：GitHub 搜索
// ─────────────────────────────────────────────────────────────

function repoFromSearchItem(item) {
  return normalizeRecord({
    id: item.full_name,
    description: item.description,
    stars: item.stargazers_count,
    forks: item.forks_count,
    language: item.language,
    topics: item.topics,
    license: item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION' ? item.license.spdx_id : null,
    homepage: item.homepage,
    pushedAt: item.pushed_at,
    archived: item.archived,
    sources: ['github-search'],
  });
}

/**
 * 每个查询一个缓存文件。
 *
 * ★ 文件名必须由**整个查询串**的散列得出，不能拿查询串开头几个字节去转十六进制：
 *   `topic:dsh-plugin` 与 `topic:dsh-plugins` 的前 12 个字符完全一样
 *   （`topic:dsh-pl`），截断之后两者会**共用同一个缓存文件** ——
 *   离线重跑时一个查询会读到另一个查询的结果，而且两边的写入还会互相覆盖。
 *   这个错误不会当场报错，只会让 --offline 的结果慢慢变得不可信。
 */
function searchCacheName(query) {
  return `search-${createHash('sha256').update(query).digest('hex').slice(0, 16)}.json`;
}

async function collectFromGithubSearch() {
  const token = githubToken();
  log(`→ GitHub 搜索（token ${describeToken(token)}，每个查询最多 ${PAGES} 页）`);

  const out = new Map();
  const queries = [];
  let hardError = null;
  let missingCache = 0;

  for (const query of QUERIES) {
    const cacheName = searchCacheName(query);
    let result;

    if (OFFLINE) {
      const cached = readJsonCache(cacheName);
      if (!cached) {
        missingCache += 1;
        queries.push({ query, found: 0, pages: 0, error: '离线模式：没有缓存' });
        continue;
      }
      result = { items: cached.items ?? [], pages: cached.pages ?? 0, error: cached.error ?? null };
    } else {
      result = await searchRepositories(query, {
        token,
        pages: PAGES,
        onProgress: (p) => {
          if (p.waiting) warn(`  ! ${query}：命中限流（HTTP ${p.status}），等待 ${Math.round(p.waiting / 1000)} 秒`);
        },
      });
      writeJsonCache(cacheName, { query, items: result.items, pages: result.pages, error: result.error, fetchedAt: now() });
    }

    let kept = 0;
    for (const item of result.items) {
      const rec = repoFromSearchItem(item);
      if (!rec) continue;
      if (!looksRelevant(item)) continue;
      out.set(rec.id, out.has(rec.id) ? mergeRecords(out.get(rec.id), rec) : rec);
      kept += 1;
    }

    if (result.error) {
      hardError = hardError ?? result.error;
      warn(`  ! 查询失败「${query}」：${result.error}`);
    }
    queries.push({ query, found: kept, pages: result.pages, error: result.error ?? null });
    log(`    ${query} → ${kept} 条（${result.pages} 页）`);
  }

  ok(`GitHub 搜索：${out.size} 个仓库（${queries.filter((q) => !q.error).length}/${queries.length} 个查询成功）`);

  return {
    kind: 'github-search',
    label: SOURCE_LABELS['github-search'],
    url: 'https://github.com/search',
    queries,
    records: out,
    /*
     * ★ `failed` 的含义是「**这一轮没有完整地看过**」，而不是「出错了」。
     *
     *   离线模式下一个查询没有缓存 = 我们压根没去看那一块，所以必须算作没看过：
     *   否则下一节的合并会把「这一路没跑」当成「这一路不再收录它」，
     *   于是把记录上的 github-search 来源抹掉 —— 那是**知识的倒退**，
     *   而它不会报错，只会让索引悄悄变得比上一轮更差。
     */
    failed: Boolean(hardError) || missingCache > 0,
  };
}

/**
 * 相关性过滤。
 *
 * ★ 只作用于**搜索结果**。公开索引与 seed 是别人/自己明确为 DSH 收的，
 *   不拿我们的启发式去二次判断 —— 那会把「我确定它是插件」变成「我觉得它是」。
 */
function looksRelevant(item) {
  const topics = (item.topics ?? []).map((t) => String(t).toLowerCase());
  if (topics.some((t) => RELEVANT_TOPICS.has(t))) return true;
  const haystack = `${item.full_name ?? ''} ${item.name ?? ''} ${item.description ?? ''}`;
  return RELEVANT_TEXT.test(haystack);
}

// ─────────────────────────────────────────────────────────────
// 来源 ②：公开索引
// ─────────────────────────────────────────────────────────────

async function collectFromPublicIndex() {
  let doc = null;
  let error = null;

  if (OFFLINE) {
    doc = readJsonCache('public-index.json');
    if (!doc) {
      warn('  ! 离线模式：没有公开索引缓存，这一路跳过');
      return { kind: 'public-index', label: SOURCE_LABELS['public-index'], url: PUBLIC_INDEX_URL, records: new Map(), failed: true };
    }
  } else {
    log(`→ 公开索引 ${PUBLIC_INDEX_URL}`);
    try {
      const res = await fetch(PUBLIC_INDEX_URL, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-collector' },
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      doc = await res.json();
      // 原始索引 ~22MB；只留采集要用的字段再落盘，免得缓存比仓库还大
      writeJsonCache('public-index.json', {
        generatedAt: doc?.generatedAt ?? null,
        fetchedAt: now(),
        plugins: (doc?.plugins ?? []).map(slimIndexEntry),
      });
    } catch (err) {
      error = err?.message ?? String(err);
      warn(`  ! 拉取公开索引失败（改用缓存）：${error}`);
      doc = readJsonCache('public-index.json');
    }
  }

  const plugins = Array.isArray(doc?.plugins) ? doc.plugins : [];
  const out = new Map();
  for (const entry of plugins) {
    const rec = normalizeRecord({
      id: entry.fullName ?? entry.full_name ?? entry.id ?? entry.repo,
      description: entry.description,
      descriptionZh: entry.descriptionZh,
      stars: entry.stars,
      forks: entry.forks,
      language: entry.language,
      topics: entry.tags,
      license: entry.license,
      homepage: entry.homepage,
      pushedAt: entry.pushedAt,
      sources: ['public-index'],
    });
    if (!rec) continue;
    out.set(rec.id, out.has(rec.id) ? mergeRecords(out.get(rec.id), rec) : rec);
  }

  if (error) warn(`  ! 公开索引这一路本轮不完整：${error}`);
  ok(`公开索引：${out.size} 个仓库`);
  return {
    kind: 'public-index',
    label: SOURCE_LABELS['public-index'],
    url: PUBLIC_INDEX_URL,
    records: out,
    failed: Boolean(error) && out.size === 0,
    error: error ?? undefined,
  };
}

/** 公开索引的一条 → 只留采集要用的字段 */
function slimIndexEntry(p) {
  return {
    id: p.id,
    fullName: p.fullName ?? p.full_name,
    repo: p.repo,
    description: p.description,
    descriptionZh: p.descriptionZh,
    stars: p.stars,
    forks: p.forks,
    pushedAt: p.pushedAt,
    tags: p.tags,
    license: p.license,
    homepage: p.homepage,
    language: p.language,
  };
}

// ─────────────────────────────────────────────────────────────
// 来源 ③：seed（手工收录）
// ─────────────────────────────────────────────────────────────

/**
 * 手工收录的仓库。
 *
 * ★ 刻意**不**在这里手写 star 数 / 描述：联网时它们会被 GitHub 搜索那一路覆盖，
 *   离线时就用公开索引或上一轮的值。人工只回答「这个仓库要收 / 不要收」。
 */
async function collectFromSeed(include) {
  const records = new Map();
  if (include.length === 0) {
    return { kind: 'seed', label: SOURCE_LABELS.seed, url: 'catalog/seed.json', records, failed: false };
  }

  const token = githubToken();
  log(`→ 手工收录 ${include.length} 个仓库`);

  for (const id of include) {
    const existing = records.get(id);
    const placeholder = normalizeRecord({ id, sources: ['seed'] });
    if (existing) continue;

    let rec = placeholder;
    if (!OFFLINE) {
      try {
        const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugins-collector' };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(`https://api.github.com/repos/${id}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const item = await res.json();
          rec = mergeRecords(placeholder, repoFromSearchItem({ ...item, full_name: id }));
        } else {
          warn(`  ! ${id}：HTTP ${res.status}（仍然收录，元数据留空）`);
        }
      } catch (err) {
        warn(`  ! ${id}：${err?.message ?? err}（仍然收录，元数据留空）`);
      }
    }
    records.set(id, rec);
  }

  ok(`手工收录：${records.size} 个仓库`);
  return { kind: 'seed', label: SOURCE_LABELS.seed, url: 'catalog/seed.json', records, failed: false };
}

// ─────────────────────────────────────────────────────────────
// 合并 + 时间戳
// ─────────────────────────────────────────────────────────────

function mergeAll(sources) {
  const merged = new Map();
  // 顺序即优先级：GitHub 搜索 → seed → 公开索引（mergeRecords 内部还会按来源排名校正）
  for (const source of sources) {
    for (const [id, rec] of source.records) {
      merged.set(id, merged.has(id) ? mergeRecords(merged.get(id), rec) : rec);
    }
  }
  return merged;
}

/**
 * 套用「内容没变就不动时间戳」与「没看过就不删」两条规矩。
 *
 * @param {boolean} [opts.keepAll] `--only` 专用：这一轮只看了**一个**仓库，
 *   其余记录根本没被看过，所以一律原样保留 —— 哪怕它已经很旧。
 *   否则一条「只补录一个仓库」的调试命令会顺手把几百条陈旧记录清掉。
 * @returns {{records:object[], stats:{added:number,updated:number,kept:number,removed:number,unseen:number}}}
 */
/** 会被来源影响、因而需要「接住上一轮」的字段 */
const CARRY_FIELDS = [
  'description', 'descriptionZh', 'stars', 'forks',
  'language', 'topics', 'license', 'homepage', 'pushedAt',
];

/**
 * 某个来源这一轮没跑时，把上一轮的值接住。
 *
 * 两种情形，语义不同，所以分成两档：
 *
 *   · `force = false`（这一轮的来源排名**不低于**上一轮）：
 *     只补空 —— 本轮跑过的来源说「这里是 null」是有效信息，但没说的地方别丢。
 *
 *   · `force = true`（上一轮有**排名更高**的来源，而它这一轮没跑）：
 *     字段级以**上一轮**为准。理由：高排名来源（直读 GitHub）与低排名来源
 *     （第三方转述）本来就常常给出不同的值，让低排名的那份去覆盖高排名的那份，
 *     换来的不是「更新」而是「来回横跳」—— 每跑一次离线就翻一次，而且没有提示。
 *
 * ★ 拿不到就是 null 这条规矩，针对的是「**去看过**但没看到」，不是「压根没去看」。
 *   少了这一档，一次 `--offline`（或某一路被限流）就会把几千条记录的
 *   语言、topic、许可、star 数悄悄改写成另一份来源的版本。
 */
function carryForward(rec, prev, { force }) {
  const out = { ...rec };
  for (const key of CARRY_FIELDS) {
    const value = out[key];
    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    if (!empty && !force) continue;
    if (prev[key] !== null && prev[key] !== undefined) out[key] = prev[key];
  }
  if ((force || !out.archived) && prev.archived) out.archived = true;
  return out;
}

function reconcile(fresh, existing, { failedSources, ranSources, keepAll = false } = {}) {
  const stamp = now();
  const records = [];
  const stats = { added: 0, updated: 0, kept: 0, removed: 0, unseen: 0 };

  for (const [id, rec] of fresh) {
    const prev = existing.get(id);
    if (!prev) {
      records.push({ ...rec, firstSeenAt: rec.firstSeenAt ?? stamp, lastSyncedAt: rec.lastSyncedAt ?? stamp });
      stats.added += 1;
      continue;
    }

    /*
     * ★ 来源只会累积，不会因为「这一路这轮没跑」而被抹掉。
     *
     *   一个来源这一轮**跑过**却没产出这个仓库，说明它确实不再知道它了，
     *   去掉是对的；但这一轮**没跑**（离线、失败、没缓存）时去掉，
     *   就是把「没去看」当成了「不在了」—— 索引会一轮比一轮差，且毫无提示。
     */
    const stillClaimed = (prev.sources ?? []).filter((s) => !ranSources.has(s));
    // 上一轮有排名更高的来源、而它这一轮没跑 → 本轮无权改写它的字段值
    const force = stillClaimed.length > 0 && sourceRank(prev) > sourceRank(rec);
    const merged = stillClaimed.length === 0
      ? rec
      : carryForward(
        { ...rec, sources: [...new Set([...(rec.sources ?? []), ...stillClaimed])].sort() },
        prev,
        { force },
      );

    if (contentEquals(recordContent(prev), recordContent(merged))) {
      records.push({ ...merged, firstSeenAt: prev.firstSeenAt, lastSyncedAt: prev.lastSyncedAt });
      stats.kept += 1;
    } else {
      records.push({ ...merged, firstSeenAt: prev.firstSeenAt ?? stamp, lastSyncedAt: stamp });
      stats.updated += 1;
    }
  }

  // 这一轮没被任何来源看到、但上一轮在索引里的记录
  const unseen = [];
  for (const [id, prev] of existing) {
    if (fresh.has(id)) continue;
    // ★ 产生过它的来源这一轮失败了 → 我们**没有看过**，不能当成不存在
    const sourcesFailed = (prev.sources ?? []).some((s) => failedSources.has(s));
    const age = prev.lastSyncedAt ? Date.now() - Date.parse(prev.lastSyncedAt) : Infinity;
    if (keepAll || sourcesFailed || age < STALE_MS) {
      records.push(prev);
      stats.unseen += 1;
      unseen.push(id);
    } else {
      stats.removed += 1;
    }
  }

  return { records, stats, unseen };
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

async function collect() {
  const { map: existing } = loadExistingIndex();
  const seed = loadSeed();

  log(`  已有索引 ${existing.size} 条${CHECK_ONLY ? '（校验模式）' : ''}`);
  log('');

  const sources = [];
  if (ONLY) {
    // --only：只处理一个仓库，其余记录原样继承（手工补录用）
    log(`→ 只处理 ${ONLY}`);
    const single = OFFLINE ? new Map() : await (async () => {
      const token = githubToken();
      const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugins-collector' };
      if (token) headers.authorization = `Bearer ${token}`;
      try {
        const res = await fetch(`https://api.github.com/repos/${ONLY}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const item = await res.json();
        const rec = repoFromSearchItem({ ...item, full_name: ONLY });
        return rec ? new Map([[rec.id, rec]]) : new Map();
      } catch (err) {
        fail(`读取 ${ONLY} 失败：${err?.message ?? err}`);
        return new Map();
      }
    })();
    sources.push({ kind: 'github-search', label: SOURCE_LABELS['github-search'], url: `https://github.com/${ONLY}`, records: single, failed: single.size === 0 });
  } else {
    sources.push(await collectFromGithubSearch());
    sources.push(await collectFromSeed(seed.include));
    sources.push(await collectFromPublicIndex());
  }

  const failedSources = new Set(sources.filter((s) => s.failed).map((s) => s.kind));
  /** 这一轮**真的看过**的来源 —— 只有它们才有资格「撤销」一条记录的来源标注 */
  const ranSources = new Set(sources.filter((s) => !s.failed).map((s) => s.kind));
  const fresh = mergeAll(sources);

  // 手工排除：无论哪一路发现它，都不进索引
  for (const id of seed.exclude) fresh.delete(id);

  const { records, stats, unseen } = reconcile(fresh, existing, {
    failedSources,
    ranSources,
    keepAll: Boolean(ONLY),
  });

  const sourceMeta = sources.map((s) => ({
    kind: s.kind,
    label: s.label,
    url: s.url,
    found: s.records.size,
    failed: s.failed,
    ...(s.queries ? { queries: s.queries } : {}),
    ...(s.error ? { error: s.error } : {}),
  }));

  const sorted = sortRecords(records);
  const limited = LIMIT > 0 ? sorted.slice(0, LIMIT) : sorted;
  const previousDoc = readJsonSafe(INDEX_FILE);
  const previous = previousDoc ? buildIndex(previousDoc.plugins ?? [], { generatedAt: previousDoc.generatedAt, sources: previousDoc.sources ?? [] }) : null;

  // ★ generatedAt 只在内容真的变了时推进（否则每 6 小时一次的空跑都会留一条 diff）
  const next = buildIndex(limited, { generatedAt: now(), sources: sourceMeta });
  const changed = !previous || !contentEquals(indexContent(previous), indexContent(next));
  if (!changed && previous?.generatedAt) next.generatedAt = previous.generatedAt;

  log('');
  log(`  采集结果：新增 ${stats.added} · 更新 ${stats.updated} · 未变 ${stats.kept} · 留观 ${stats.unseen} · 清理 ${stats.removed}`);
  log(`  索引共 ${next.plugins.length} 条（star 最高 ${next.plugins[0]?.id ?? '—'} / ${next.plugins[0]?.stars ?? '—'}）`);
  if (failedSources.size > 0) {
    warn(`  ! 本轮有来源不完整（${[...failedSources].join('、')}）—— 由它们发现的记录一律保留，不做删除。`);
  }

  if (LIMIT > 0) {
    warn(`  ! --limit ${LIMIT}：试跑模式，**没有写盘**。`);
    return next;
  }
  if (!changed && !CHECK_ONLY) {
    ok('内容没有实质变化，索引与快照保持原样（不产生空提交）。');
    return next;
  }

  writeTextAtomic(INDEX_FILE, serializeIndex(next));
  ok(`已写入 ${INDEX_REL}（${next.plugins.length} 条）`);

  const snapshot = buildSnapshot(next);
  writeTextAtomic(SNAPSHOT_FILE, serializeIndex(snapshot));
  ok(`已写入 ${SNAPSHOT_REL}（包内离线兜底，${snapshot.plugins.length} 条）`);

  return next;
}

// ─────────────────────────────────────────────────────────────
// --check：只读校验
// ─────────────────────────────────────────────────────────────

function check() {
  log('  --check：只读校验（不联网、不写盘）');
  log('');

  const raw = readJsonSafe(INDEX_FILE);
  if (!raw) {
    fail(`读不到 ${INDEX_REL} —— 请先跑一次 node scripts/collect.mjs`);
    return;
  }

  const records = (raw.plugins ?? []).map(normalizeRecord);
  if (records.some((r) => r === null)) fail('索引里有无法归一化的记录（id 不是 owner/repo 形状）');
  const valid = records.filter(Boolean);

  // ① 不允许重复 id
  const seen = new Set();
  for (const r of valid) {
    if (seen.has(r.id)) fail(`重复记录：${r.id}`);
    seen.add(r.id);
  }

  // ② 记录必须严格按 star 降序（排序规则只实现一次，索引落盘时必须已经是最终顺序）
  const sorted = sortRecords(valid);
  if (JSON.stringify(sorted.map((r) => r.id)) !== JSON.stringify(valid.map((r) => r.id))) {
    fail('索引的记录顺序不是「star 降序 → id 升序」—— 请重跑 collect.mjs');
  }

  // ③ 计数要对得上
  const expected = buildIndex(valid, { generatedAt: raw.generatedAt, sources: raw.sources ?? [] });
  if (!contentEquals(expected.counts, raw.counts)) {
    fail(`counts 与实际记录不一致：索引里写的是 ${JSON.stringify(raw.counts)}，实际算出来是 ${JSON.stringify(expected.counts)}`);
  }

  // ④ 序列化必须能原样往返（否则每轮采集都会产生假 diff）
  const roundTrip = serializeIndex(expected);
  if (roundTrip !== fs.readFileSync(INDEX_FILE, 'utf8')) {
    fail(`${INDEX_REL} 的文本与「重新序列化同一份数据」的结果不同 —— 说明它被手工改过，或序列化规则变了。`);
  }

  // ⑤ 包内快照必须是索引的稳定投影
  const snapshotText = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
  const expectedSnapshot = serializeIndex(buildSnapshot(expected));
  if (snapshotText !== expectedSnapshot) {
    fail(`${SNAPSHOT_REL} 不是当前索引的稳定投影 —— 请重跑 collect.mjs（它是打进插件包的离线兜底，必须与索引同一次提交）。`);
  }

  // ⑥ 每条记录都要有最基本的展示字段
  const noDesc = valid.filter((r) => !r.description && !r.descriptionZh).length;
  const noStars = valid.filter((r) => r.stars === null).length;

  log(`  记录 ${valid.length} 条 · 有描述 ${valid.length - noDesc} · 有 star ${valid.length - noStars}`);
  log(`  来源 ${JSON.stringify(raw.counts?.bySource ?? {})}`);
}

// ─────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  log('');
  log(`  插件项目采集${CHECK_ONLY ? '（--check）' : OFFLINE ? '（--offline）' : ''}`);
  log(`  ${'-'.repeat(66)}`);
  log(`  仓库  ${REPO}`);
  log('');

  if (CHECK_ONLY) check();
  else await collect();

  log('');
  if (problems.length > 0) {
    console.error(`  ✗ 有 ${problems.length} 个问题：`);
    for (const p of problems) console.error(`    · ${p}`);
    console.error('');
    process.exit(1);
  }
  log(`  ✓ 完成（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  log('');
}

main().catch((err) => {
  console.error(`\n  ✗ 采集失败：${err?.stack ?? err}\n`);
  process.exit(1);
});
