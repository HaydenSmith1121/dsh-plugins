/**
 * GitHub 采集的**传输层** —— 只用 Node 内置的 fetch，不引第三方 SDK。
 *
 * ── 为什么主力是 REST 搜索，而不是 GraphQL ────────────────────
 *
 * 上一版用批量 GraphQL 逐仓库取字段（star / release / tag / package.json），
 * 一轮要花掉几百到几千点配额。这一版要的东西少得多 —— 描述、地址、作者、star 数 ——
 * 而 GitHub 的**搜索接口一次就返回 100 个完整仓库对象**，上述字段全在里面。
 * 同样的信息量，请求数从「每仓库一次查询节点」降到「每 100 个仓库一次 HTTP」。
 *
 * 代价是搜索接口有自己的限流（认证后 30 次/分钟，每次最多 100 条、每个查询最多
 * 1000 条结果）。所以采集器靠**多个查询**覆盖不同切面，而不是靠翻页翻到底。
 *
 * 认证：`GITHUB_TOKEN` / `GH_TOKEN`。没有 token 时搜索接口只给 10 次/分钟，
 * 采集会自动降速到能跑完为止；CI 里用工作流自带的 GITHUB_TOKEN。
 */

const API = 'https://api.github.com';

export const DEFAULT_PER_PAGE = 100;
/** 搜索接口每个查询最多能翻到 1000 条结果 —— 这是 GitHub 的硬限制，不是我们的选择 */
export const SEARCH_RESULT_CAP = 1000;

export function githubToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || env.DSH_PLUGINS_GITHUB_TOKEN || null;
}

/** 日志里永远不出现 token 本身 */
export function describeToken(token) {
  return token ? `已提供（${String(token).slice(0, 4)}…，长度 ${String(token).length}）` : '未提供（限流更严）';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rateLimitOf(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  const reset = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');
  return {
    remaining: remaining === null ? null : Number(remaining),
    limit: limit === null ? null : Number(limit),
    resetAt: reset === null ? null : new Date(Number(reset) * 1000).toISOString(),
    resetInMs: reset === null ? null : Math.max(0, Number(reset) * 1000 - Date.now()),
    retryAfterMs: retryAfter === null ? null : Number(retryAfter) * 1000,
  };
}

/**
 * 搜索仓库。
 *
 * @param {string} query           GitHub 搜索语法
 * @param {object} options
 * @param {string|null} options.token
 * @param {number} [options.pages] 最多翻几页（每页 100 条）
 * @param {number} [options.perPage]
 * @param {number} [options.maxWaitMs] 单次等待限流恢复的上限
 * @param {(p:object)=>void} [options.onProgress]
 * @returns {Promise<{items:object[], pages:number, error:string|null, rateLimit:object|null}>}
 */
export async function searchRepositories(query, {
  token = null,
  pages = 3,
  perPage = DEFAULT_PER_PAGE,
  maxWaitMs = 65_000,
  fetchImpl = fetch,
  onProgress = null,
} = {}) {
  const items = [];
  let lastRateLimit = null;
  let fetchedPages = 0;

  for (let page = 1; page <= pages; page += 1) {
    const url = `${API}/search/repositories?q=${encodeURIComponent(query)}`
      + `&sort=stars&order=desc&per_page=${perPage}&page=${page}`;

    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugins-collector',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    let res;
    let attempt = 0;
    // 限流与瞬时故障都重试，但有上限 —— 采集宁可少采一轮，也不能挂死在 CI 里
    for (;;) {
      attempt += 1;
      try {
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(45_000) });
      } catch (err) {
        if (attempt >= 3) return { items, pages: fetchedPages, error: `请求失败：${err?.message ?? err}`, rateLimit: lastRateLimit };
        await sleep(1500 * attempt);
        continue;
      }

      lastRateLimit = rateLimitOf(res.headers);
      if (res.ok) break;

      const exhausted = res.status === 403 || res.status === 429;
      const waitMs = Math.min(
        lastRateLimit.retryAfterMs ?? lastRateLimit.resetInMs ?? 5000,
        maxWaitMs,
      );
      if (exhausted && attempt < 4 && waitMs > 0) {
        onProgress?.({ query, page, waiting: waitMs, status: res.status });
        await sleep(waitMs + 500);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      const text = await res.text().catch(() => '');
      return {
        items,
        pages: fetchedPages,
        error: `HTTP ${res.status}${res.status === 403 || res.status === 429 ? '（限流）' : ''}：${text.slice(0, 200)}`,
        rateLimit: lastRateLimit,
      };
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      return { items, pages: fetchedPages, error: `响应不是 JSON：${err?.message ?? err}`, rateLimit: lastRateLimit };
    }

    const batch = Array.isArray(payload?.items) ? payload.items : [];
    items.push(...batch);
    fetchedPages += 1;
    onProgress?.({ query, page, got: batch.length, total: payload?.total_count ?? null, rateLimit: lastRateLimit });

    if (batch.length < perPage) break;                        // 没有下一页了
    if (page * perPage >= Math.min(payload?.total_count ?? 0, SEARCH_RESULT_CAP)) break; // 碰到 1000 条硬顶
    // 认证后 30 次/分钟：礼貌一点，连续翻页之间留出间隔
    await sleep(token ? 2200 : 6500);
  }

  return { items, pages: fetchedPages, error: null, rateLimit: lastRateLimit };
}
