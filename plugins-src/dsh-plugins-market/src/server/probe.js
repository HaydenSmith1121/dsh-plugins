/**
 * dsh-plugins-market —— 服务器半：远程静态探测
 *
 * 公共索引里的插件是通过 `github:owner/repo` 或 npm 包名安装的，我们手里没有
 * tarball，所以装前检查只能「尽力而为」：去仓库默认分支读一份 package.json。
 *
 * 这能查出来的（确实有用）：
 *   - 仓库/包是否还存在（404 → 死链）
 *   - 有没有声明 dsh.bundle.patch（没有 → 装了也不会加载）
 *   - peerDependencies 里 @deepseek-ai/* 的 pin（这一条最值钱：能提前发现
 *     「插件要求另一个 dsh 版本」这种会让整棵树挂掉的情况）
 *   - 有没有 install 生命周期脚本（供应链信号）
 *
 * 查不出来的（必须在界面上讲清楚）：
 *   - 实际发布产物与仓库源码是否一致
 *   - 运行时行为、依赖闭包、客户端半是否能正确注册
 */

const FETCH_TIMEOUT_MS = 20_000;
const PROBE_TTL_MS = 10 * 60 * 1000;

const cache = new Map();

function cacheKey(entry) {
  return `${entry.upstream ?? entry.id}`;
}

/** 从条目里推出 owner/repo */
export function githubSlug(entry) {
  if (entry.upstream) {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(entry.upstream);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  }
  if (entry.package && /^github:/.test(entry.install?.spec ?? '')) {
    const m = /^github:([^/]+)\/([^#]+)/.exec(entry.install.spec);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-market' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) throw Object.assign(new Error('404 未找到'), { notFound: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 探测一个候选包的 package.json。
 * @returns {{ available:boolean, source:string, manifest:object|null, error:string|null, url:string|null, probedAt:string }}
 */
export async function probeEntry(entry, { force = false } = {}) {
  const key = cacheKey(entry);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;

  const value = await probeEntryUncached(entry);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function probeEntryUncached(entry) {
  const probedAt = new Date().toISOString();
  const slug = githubSlug(entry);

  if (slug) {
    const url = `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/HEAD/package.json`;
    try {
      const manifest = await fetchJson(url);
      // 有些仓库是 monorepo，根 package.json 不是插件本体 —— 如实标注
      const declaresBundle = Boolean(manifest?.dsh?.bundle?.patch);
      return {
        available: true,
        source: `GitHub 仓库 ${slug.owner}/${slug.repo} 默认分支`,
        manifest,
        declaresBundle,
        monorepoHint: !declaresBundle && Boolean(manifest?.workspaces),
        url,
        error: null,
        probedAt,
      };
    } catch (err) {
      return {
        available: false,
        source: 'GitHub',
        manifest: null,
        url,
        error: err?.notFound
          ? `仓库默认分支根目录没有 package.json（可能是 monorepo，插件在子目录里）`
          : String(err?.message ?? err),
        probedAt,
      };
    }
  }

  // npm 规格：问 registry
  const npmName = entry.install?.spec && entry.install.kind === 'npm'
    ? entry.install.spec.replace(/@[^@/]+$/, '')
    : entry.package;
  if (npmName && /^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/i.test(npmName)) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(npmName).replace('%40', '@')}/latest`;
    try {
      const manifest = await fetchJson(url);
      return {
        available: true,
        source: `npm registry（${npmName}）`,
        manifest,
        declaresBundle: Boolean(manifest?.dsh?.bundle?.patch),
        url,
        error: null,
        probedAt,
      };
    } catch (err) {
      return {
        available: false,
        source: 'npm registry',
        manifest: null,
        url,
        error: err?.notFound ? `npm 上没有名为 ${npmName} 的包` : String(err?.message ?? err),
        probedAt,
      };
    }
  }

  return {
    available: false,
    source: '无',
    manifest: null,
    url: null,
    error: '既没有 GitHub 仓库地址，也没有可用的 npm 包名，无法探测',
    probedAt,
  };
}

export function clearProbeCache() {
  cache.clear();
}
