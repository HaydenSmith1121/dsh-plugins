/**
 * 版本号与收藏量的**采集器**。
 *
 * 目标是 7000+ 个插件，而 GitHub 的配额是每小时 5000 点 —— 逐个仓库打 REST
 * 必然撞墙（7487 个仓库光是 releases 就要 7487 次请求，还没算 tags 与
 * package.json）。所以这里全部走**批量 GraphQL**：
 *
 *   一次查询里用别名把几十个仓库并排问，每个仓库一次拿全
 *   （latestRelease / 最新 tag / 默认分支的 package.json / star 数 / license），
 *   于是「一个仓库一次往返」变成「一个批次一次往返」。
 *
 * 另一条便宜得多的路是 npm registry：`/<name>/latest` 一个几十字节的 JSON，
 * 没有严格配额。所以**优先查 npm**，查不到才去 GitHub。这样既省钱又更准
 * （npm 上的 latest 就是用户 `pnpm add` 会拿到的那一版）。
 *
 * ★ 这里只负责「取到数据」，不负责「信不信」：
 *   拿不到就是 null，绝不用别处的值凑数。调用方按 VERSION_SOURCES 的优先级决定用哪个。
 *
 * @module scripts/lib/version-resolve
 */

const NPM_REGISTRY = 'https://registry.npmjs.org';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

/** 默认每批多少个仓库。太大时单次请求体与响应体都会很可观，50 是实测的稳妥值。 */
export const DEFAULT_BATCH = 50;

/** 带重试的 fetch：GitHub 会偶发 502 / 连接重置，一次失败不该让整轮同步丢掉一批。 */
async function fetchWithRetry(url, options = {}, { attempts = 3, timeoutMs = 45_000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      // 5xx 与 429 值得重试；4xx 里的其它码是确定性失败，直接返回让调用方处理。
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(600 * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(600 * (i + 1));
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// npm
// ─────────────────────────────────────────────────────────────

/**
 * 查一个 npm 包的 latest 版本。
 *
 * 用 `/<name>/latest` 而不是整个包文档：后者对大包是几百 KB 到几 MB，
 * 而我们只要一个 version 字段。
 *
 * ★ 返回值刻意区分三种结果，而不是笼统的 null：
 *
 *     { status: 'ok', version, ... }   查到了
 *     { status: 'not-found' }          **确定**这个包不在 npm 上（404）
 *     { status: 'error', reason }      这次没查成（超时 / 429 / 5xx）
 *
 *   为什么必须区分：调用方据此决定「回退到 GitHub」还是「保留上一轮的值」。
 *   把 429 当成 404，就会在 CI 被限流时把上千条记录的版本来源从 npm 改成 GitHub ——
 *   实测过一次：GitHub runner 是数据中心 IP，npm 对它限流，那次运行只命中 349 条
 *   npm（本机 1300 条），于是 1004 个文件的内容变了，而其中大部分只是「这次没查成」。
 *
 * @param {string} name 包名（可带 @scope）
 */
export async function resolveNpmLatest(name, { fetchImpl = fetch, attempts = 3 } = {}) {
  const pkg = String(name ?? '').trim();
  if (pkg === '') return { status: 'not-found' };

  const url = `${NPM_REGISTRY}/${encodeURIComponent(pkg).replace(/^%40/, '@')}/latest`;
  let lastReason = 'unknown';

  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-catalog-sync' },
        signal: AbortSignal.timeout(20_000),
      });
      // 404：包确实不在 npm 上。这是**确定**的答案 —— 不重试、也不当成故障。
      if (res.status === 404) return { status: 'not-found' };
      // 429 / 5xx：限流或服务端抖动，退避后重试。
      if (res.status === 429 || res.status >= 500) {
        lastReason = `HTTP ${res.status}`;
        await sleep(400 * (i + 1) ** 2);
        continue;
      }
      if (!res.ok) return { status: 'not-found' };

      const doc = await res.json();
      if (!doc || typeof doc.version !== 'string') return { status: 'not-found' };
      const repo = typeof doc.repository === 'string' ? doc.repository : (doc.repository?.url ?? null);
      return {
        status: 'ok',
        version: doc.version,
        deprecated: Boolean(doc.deprecated),
        license: typeof doc.license === 'string' ? doc.license : (doc.license?.type ?? null),
        repository: repo,
      };
    } catch (err) {
      lastReason = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err);
      await sleep(400 * (i + 1) ** 2);
    }
  }

  return { status: 'error', reason: lastReason };
}

// ─────────────────────────────────────────────────────────────
// GitHub GraphQL
// ─────────────────────────────────────────────────────────────

/** 一个仓库节点要问的全部字段。合成一段查询片段，供别名复用。 */
const REPO_FIELDS = `
    stargazerCount
    forkCount
    pushedAt
    homepageUrl
    licenseInfo { spdxId }
    latestRelease { tagName publishedAt url }
    refs(refPrefix: "refs/tags/", last: 1, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes { name }
    }
    defaultBranchRef {
      target {
        ... on Commit {
          committedDate
          file(path: "package.json") { object { ... on Blob { text } } }
        }
      }
    }`;

/** 把 `owner/repo` 拆成 GraphQL 需要的两段；不合法返回 null。 */
function splitSlug(slug) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(slug ?? '').trim());
  if (!m) return null;
  return { owner: m[1], name: m[2].replace(/\.git$/i, '') };
}

/** GraphQL 字符串字面量转义（owner/repo 里理论上不会有引号，但不赌）。 */
const q = (s) => JSON.stringify(String(s));

/**
 * 批量取一个批次内所有仓库的元数据。
 *
 * @param {string[]} slugs `owner/repo` 列表
 * @param {object}   options
 * @param {string}   options.token GitHub token（没有就返回全 null，不抛错）
 * @returns {Promise<{results: Map<string, object>, cost: number|null, remaining: number|null, errors: string[]}>}
 */
export async function fetchGithubBatch(slugs, { token, fetchImpl = fetch } = {}) {
  const results = new Map();
  const errors = [];
  const valid = [];
  for (const slug of slugs) {
    const parts = splitSlug(slug);
    if (!parts) {
      errors.push(`不是合法的 owner/repo：${slug}`);
      continue;
    }
    valid.push({ slug, ...parts });
  }
  if (valid.length === 0) return { results, cost: null, remaining: null, errors };
  if (!token) {
    errors.push('没有 GitHub token，跳过这批（GitHub 数据只能留空）');
    return { results, cost: null, remaining: null, errors };
  }

  const aliases = valid
    .map((v, i) => `  r${i}: repository(owner: ${q(v.owner)}, name: ${q(v.name)}) {${REPO_FIELDS}\n  }`)
    .join('\n');

  const query = `query(${''}){
  rateLimit { cost remaining resetAt }
${aliases}
}`;

  let payload;
  try {
    const res = await fetchWithRetry(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'dsh-plugins-catalog-sync',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errors.push(`GraphQL HTTP ${res.status}：${text.slice(0, 200)}`);
      return { results, cost: null, remaining: null, errors };
    }
    payload = await res.json();
  } catch (err) {
    errors.push(`GraphQL 请求失败：${err?.message ?? err}`);
    return { results, cost: null, remaining: null, errors };
  }

  const cost = payload?.data?.rateLimit?.cost ?? null;
  const remaining = payload?.data?.rateLimit?.remaining ?? null;

  // GraphQL 的部分失败是**正常**的（仓库改名 / 删除 / 私有），
  // data 里对应的别名会是 null 并带一条 errors —— 只记下来，不要整批丢掉。
  for (const e of payload?.errors ?? []) {
    errors.push(`${e?.type ?? 'ERROR'}：${e?.message ?? ''}`);
  }

  for (let i = 0; i < valid.length; i += 1) {
    const node = payload?.data?.[`r${i}`] ?? null;
    if (!node) continue;
    const text = node.defaultBranchRef?.target?.file?.object?.text ?? null;
    let packageJson = null;
    if (typeof text === 'string') {
      try {
        packageJson = JSON.parse(text);
      } catch {
        packageJson = null; // package.json 存在但不是合法 JSON —— 如实当作没有
      }
    }
    results.set(valid[i].slug, {
      stars: node.stargazerCount ?? null,
      forks: node.forkCount ?? null,
      pushedAt: node.pushedAt ?? null,
      homepage: node.homepageUrl || null,
      license: node.licenseInfo?.spdxId ?? null,
      latestRelease: node.latestRelease
        ? {
          tag: node.latestRelease.tagName ?? null,
          publishedAt: node.latestRelease.publishedAt ?? null,
          url: node.latestRelease.url ?? null,
        }
        : null,
      latestTag: node.refs?.nodes?.[0]?.name ?? null,
      committedAt: node.defaultBranchRef?.target?.committedDate ?? null,
      packageVersion: typeof packageJson?.version === 'string' ? packageJson.version : null,
      packageName: typeof packageJson?.name === 'string' ? packageJson.name : null,
    });
  }

  return { results, cost, remaining, errors };
}

/**
 * 按批次把所有仓库问一遍。
 *
 * @param {string[]} slugs
 * @param {object}   options
 * @param {string}   options.token
 * @param {number}   [options.batch]
 * @param {number}   [options.budget] 本次最多花多少点；到点就停，剩下的留给下一轮
 * @param {(p:object)=>void} [options.onProgress]
 */
export async function fetchGithubAll(slugs, { token, batch = DEFAULT_BATCH, budget = 4500, onProgress = null } = {}) {
  const results = new Map();
  const errors = [];
  let spent = 0;
  let remaining = null;
  let stopped = null;

  const unique = [...new Set(slugs.filter(Boolean))];
  for (let i = 0; i < unique.length; i += batch) {
    if (spent >= budget) {
      stopped = `已达本次配额上限（${budget} 点），剩余 ${unique.length - i} 个仓库留到下一轮`;
      break;
    }
    const slice = unique.slice(i, i + batch);
    const res = await fetchGithubBatch(slice, { token });
    for (const [k, v] of res.results) results.set(k, v);
    errors.push(...res.errors);
    // cost 拿不到时按 1 点/仓库保守估算，免得配额被打爆才发现
    spent += res.cost ?? slice.length;
    if (res.remaining !== null) remaining = res.remaining;
    onProgress?.({ done: Math.min(i + batch, unique.length), total: unique.length, spent, remaining });
  }

  return { results, errors, spent, remaining, stopped };
}

/** 找一个可用的 GitHub token：环境变量优先，其次 gh CLI 的登录态。 */
export function githubTokenFromEnv(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || env.DSH_CATALOG_GITHUB_TOKEN || null;
}
