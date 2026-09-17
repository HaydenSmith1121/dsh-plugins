/**
 * dsh-plugins-market —— 服务器半入口
 *
 * cordis 插件三件套：{ name, inject, apply }。只 inject `webServer` 一个服务 ——
 * 声明的服务没到位会让整棵插件树出问题，所以这里刻意保持最小。
 *
 * RPC 走一条同源 HTTP 路由 `POST /dsh-plugins-market/api`：
 *   请求  { method: string, args: object }
 *   响应  { ok: true, result } | { ok: false, error, detail? }
 * 这与 dsh 里既有插件（@dsh-market/plugin）的做法一致：零构建期依赖、
 * 完全可追踪。不引入 WebSocket / RPC 框架，是因为本插件要处理的是本地文件
 * 系统与 pnpm，一次请求一次响应就够了。
 *
 * ★ 所有会写盘的动作都集中在 installer.js，并且都先备份。
 *   本文件只负责「取参数 → 调 → 落日志 → 回结果」。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  detectEnvironment, resolveDshHome, readJsonSafe, resolveDataDir,
  pluginDir, ensureDir,
} from './util.js';
import { readProfileState, scanInstalled, composedTree, listProfileBackups } from './profile.js';
import {
  loadVerified, loadReviewed, fetchCommunity, loadCommunityCache,
  normalizeEntry, searchEntries, catalogStatus, findEntry, TIER_META,
  REPO_RAW_BASE, REPO_HOMEPAGE, ensureDataDir, readCacheMeta,
} from './catalog.js';
import { runGate } from './gate.js';
import { probeEntry, clearProbeCache } from './probe.js';
import {
  installPlugin, uninstallPlugin, repairProfile, rollbackTo, bootVerify,
  verifyInstalled, applyAllowBuilds, tarballCacheDir,
} from './installer.js';
import { appendOp, readOpTail, clearOpLog } from './oplog.js';

export const name = 'dsh-plugins-market';
export const inject = ['webServer'];

const ROUTE = '/dsh-plugins-market/api';
const PLUGIN_PACKAGE = 'dsh-plugins-market';
const MAX_BODY = 1024 * 1024; // 1 MiB：本插件的请求都很小

// ─────────────────────────────────────────────────────────────
// 上下文（每次进程启动解析一次，之后按需失效）
// ─────────────────────────────────────────────────────────────

function createContext() {
  const env = detectEnvironment(process.env);
  const profile = readJsonSafe(path.join(pluginDir(), 'package.json'))?.dshMarket?.profile ?? 'web';
  const compat = loadCompat(env);

  const ctx = {
    env,
    profileName: profile,
    compat,
    repoRoot: null,
    repoSource: null,
    _tree: null,
    _treeAt: 0,
    _community: null,
    _reviewed: null,
    _verified: null,
  };
  ctx.repoRoot = detectRepoRoot(ctx);
  return ctx;
}

/** 兼容矩阵：优先读仓库里那份（开发机上是活的），否则用包内快照 */
function loadCompat(env) {
  const bundled = readJsonSafe(path.join(pluginDir(), 'catalog', 'compat-snapshot.json'));
  const repo = detectRepoRootRaw(env);
  const live = repo ? readJsonSafe(path.join(repo, 'compatibility.json')) : null;
  const chosen = live ?? bundled;
  if (!chosen) {
    return { available: false, source: 'none', requirements: {}, runtimes: [], inBoxBundles: [], distTags: {} };
  }
  return { available: true, source: live ? 'repo' : 'bundled', ...chosen };
}

/**
 * 找到本仓库的根目录。
 *
 * 思路：本插件自己就是从仓库里的 tarball 装进 profile 的，
 * profile 的 package.json 里记着 `file:<repo>/plugins/dsh-plugins-market/<ver>/....tgz`。
 * 从这个路径反推仓库根，就能用**本地**的 tarball（离线、快、且与开发机一致）。
 * 也支持用环境变量 DSH_PLUGINS_REPO 显式指定。
 */
function detectRepoRoot(ctx) {
  return detectRepoRootRaw(ctx.env);
}

function detectRepoRootRaw(env) {
  const explicit = process.env.DSH_PLUGINS_REPO;
  if (explicit && fs.existsSync(path.join(explicit, 'compatibility.json'))) return path.resolve(explicit);

  const profilesDir = path.join(resolveDshHome(process.env), 'profiles');
  if (!fs.existsSync(profilesDir)) return null;

  for (const name of fs.readdirSync(profilesDir)) {
    const manifest = readJsonSafe(path.join(profilesDir, name, 'package.json'));
    const spec = manifest?.dependencies?.[PLUGIN_PACKAGE];
    if (typeof spec !== 'string') continue;
    const m = /^(?:file|link):(.+)$/.exec(spec.trim());
    if (!m) continue;

    // ★ 必须先把分隔符归一化：pnpm 写进 package.json 的是正斜杠
    //   （file:D:/deepseek/...），而 path.sep 在 Windows 上是反斜杠，
    //   直接 indexOf 一定找不到，检测会静默失败。
    const specPath = m[1].replace(/\\/g, '/');
    const marker = `/plugins/${PLUGIN_PACKAGE}/`;
    const idx = specPath.indexOf(marker);
    if (idx <= 0) continue;

    const root = specPath.slice(0, idx);
    const native = path.normalize(root);
    if (fs.existsSync(path.join(native, 'compatibility.json'))) return native;
  }
  return null;
}

function profileState(ctx) {
  return readProfileState(ctx.profileName, process.env);
}

/** 装配树缓存 8 秒：装前检查里要用，连着点多个插件不必反复跑 */
function tree(ctx, { force = false } = {}) {
  if (force || !ctx._tree || Date.now() - ctx._treeAt > 8000) {
    ctx._tree = composedTree(ctx.profileName, process.env, { launcher: ctx.env.dsh.launcher });
    ctx._treeAt = Date.now();
  }
  return ctx._tree;
}

function invalidate(ctx) {
  ctx._tree = null;
  ctx._treeAt = 0;
}

async function layers(ctx, { refreshCommunity = false } = {}) {
  if (!ctx._verified) ctx._verified = loadVerified();
  if (!ctx._reviewed) ctx._reviewed = await loadReviewed();
  if (refreshCommunity || !ctx._community) {
    ctx._community = await fetchCommunity({ force: refreshCommunity });
  }
  const community = (ctx._community?.plugins ?? []).map((p) => normalizeEntry(
    { ...p, install: { kind: 'probe', method: p.installMethod, commands: p.installCommands, needsConfig: p.needsConfig, usageNeedsConfig: p.usageNeedsConfig, risky: p.risky } },
    'community',
  ));
  return {
    verified: ctx._verified,
    reviewed: ctx._reviewed,
    community,
    communityMeta: ctx._community,
  };
}

function allEntries(l) {
  return [...(l.verified.plugins ?? []), ...(l.reviewed.plugins ?? []), ...(l.community ?? [])];
}

// ─────────────────────────────────────────────────────────────
// RPC
// ─────────────────────────────────────────────────────────────

function createDispatcher(ctx) {
  return async function dispatch(method, args = {}) {
    switch (method) {
      // ── 状态 ────────────────────────────────────────────
      case 'status': {
        const l = await layers(ctx);
        const state = profileState(ctx);
        const installed = scanInstalled(ctx.profileName, process.env);
        return {
          market: {
            version: readJsonSafe(path.join(pluginDir(), 'package.json'))?.version ?? '?',
            repoHomepage: REPO_HOMEPAGE,
            dataDir: ensureDataDir(),
            tarballCache: tarballCacheDir(),
          },
          env: ctx.env,
          profile: {
            name: state.profile,
            dir: state.dir,
            initialized: state.initialized,
            bundles: state.bundles,
            dependencies: state.dependencies,
            patchReload: state.patchReload,
          },
          compat: {
            available: ctx.compat.available,
            source: ctx.compat.source,
            dshVersion: ctx.env.dsh.version,
            supported: (ctx.compat.runtimes ?? []).filter((r) => r.status === 'supported').map((r) => r.dshVersion),
            latest: ctx.compat.distTags?.latest ?? null,
            nodeMin: ctx.compat.requirements?.node?.min ?? null,
            pnpmMin: ctx.compat.requirements?.pnpm?.min ?? null,
          },
          repo: { root: ctx.repoRoot, detected: Boolean(ctx.repoRoot), rawBase: REPO_RAW_BASE },
          catalog: catalogStatus(l),
          installed: installed.map(publicInstalled),
          backups: listProfileBackups(process.env).slice(0, 10),
          cache: readCacheMeta(),
        };
      }

      // ── 目录 ────────────────────────────────────────────
      case 'catalog': {
        const l = await layers(ctx, { refreshCommunity: Boolean(args.refresh) });
        const tier = args.tier && TIER_META[args.tier] ? args.tier : null;
        const pool = tier ? (l[tier]?.plugins ?? l[tier] ?? []) : allEntries(l);
        const result = searchEntries(pool, args.query ?? '', {
          limit: clamp(args.limit ?? 30, 1, 200),
          offset: clamp(args.offset ?? 0, 0, 1e6),
        });
        return {
          total: result.total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 30,
          items: result.items.map(publicEntry),
          tiers: catalogStatus(l).tiers,
          communityMeta: {
            source: l.communityMeta?.source ?? null,
            error: l.communityMeta?.error ?? null,
            count: l.community.length,
            generatedAt: l.communityMeta?.generatedAt ?? null,
          },
          verifiedAvailable: l.verified.available,
          verifiedError: l.verified.error,
        };
      }

      case 'entry': {
        const l = await layers(ctx);
        const found = findEntry({ verified: l.verified.plugins, reviewed: l.reviewed.plugins, community: l.community }, String(args.id ?? ''));
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);
        const installed = scanInstalled(ctx.profileName, process.env).find((i) => i.name === (found.package ?? found.id)) ?? null;
        return { entry: found, installed: installed ? publicInstalled(installed) : null };
      }

      // ── 装前检查 ────────────────────────────────────────
      case 'gate': {
        const l = await layers(ctx);
        const found = findEntry({ verified: l.verified.plugins, reviewed: l.reviewed.plugins, community: l.community }, String(args.id ?? ''));
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);

        // 本地没有 tarball 的条目（公共索引 / 已审核但未随包分发）先做一次远程静态探测
        let probe = null;
        const needsProbe = found.tier !== 'verified';
        if (needsProbe) {
          probe = await probeEntry(found, { force: Boolean(args.refreshProbe) });
        }

        const report = runGate(found, gctx(ctx), {
          acknowledgeRisk: Boolean(args.acknowledgeRisk),
          targetProfile: ctx.profileName,
          probe,
        });
        appendOp({
          op: 'gate', pluginId: found.id, tier: found.tier, verdict: report.verdict,
          canInstall: report.canInstall, blockedBy: report.blockedBy,
          counts: report.counts,
        });
        return report;
      }

      // ── 安装 / 卸载 / 修复 ──────────────────────────────
      case 'install': {
        const l = await layers(ctx);
        const found = findEntry({ verified: l.verified.plugins, reviewed: l.reviewed.plugins, community: l.community }, String(args.id ?? ''));
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);

        const probe = found.tier === 'verified' ? null : await probeEntry(found);
        const gate = runGate(found, gctx(ctx), {
          acknowledgeRisk: Boolean(args.acknowledgeRisk),
          targetProfile: ctx.profileName,
          probe,
        });
        if (!gate.canInstall) {
          appendOp({ op: 'install-refused', pluginId: found.id, verdict: gate.verdict, blockedBy: gate.blockedBy });
          return { ok: false, refused: true, gate, steps: [], message: '装前检查未通过，已中止安装（没有改动任何文件）。' };
        }

        ctx.env = detectEnvironment(process.env); // 环境可能在会话期间变了
        const result = await installPlugin({ entry: found, ctx: gctx(ctx), gate, options: {} });
        invalidate(ctx);
        appendOp({
          op: 'install', pluginId: found.id, ok: result.ok, failure: result.failure ?? null,
          backupDir: result.backupDir ?? null, retried: (result.steps ?? []).some((s) => s.id === 'allowbuilds-retry'),
        });
        return { ...result, gate };
      }

      case 'uninstall': {
        const state = profileState(ctx);
        const target = String(args.id ?? '');
        const installed = scanInstalled(ctx.profileName, process.env).find((i) => i.name === target)
          ?? Object.entries(state.dependencies).map(([n, s]) => ({ name: n, spec: s })).find((i) => i.name === target);
        if (!installed) throw new Error(`${target} 不在这个 profile 里`);
        const result = await uninstallPlugin({ entry: { id: target, package: target }, ctx: gctx(ctx) });
        invalidate(ctx);
        appendOp({ op: 'uninstall', pluginId: target, ok: result.ok });
        return result;
      }

      case 'repair': {
        const result = await repairProfile({ ctx: gctx(ctx) });
        invalidate(ctx);
        appendOp({ op: 'repair', ok: result.ok, orphansAfter: result.orphansAfter });
        return result;
      }

      case 'verify': {
        const target = String(args.id ?? '');
        if (target) {
          const v = verifyInstalled(target, gctx(ctx));
          return { ok: v.ok, layers: v.layers, bundles: v.bundles };
        }
        invalidate(ctx);
        const t = tree(ctx, { force: true });
        const state = profileState(ctx);
        const installed = scanInstalled(ctx.profileName, process.env);
        const depNames = new Set(Object.keys(state.dependencies));
        const inBox = new Set(ctx.compat.inBoxBundles ?? []);
        return {
          ok: t.ok && state.bundles.every((b) => depNames.has(b) || inBox.has(b)),
          treeOk: t.ok,
          treeError: t.error,
          heads: (t.heads ?? []).map((h) => ({ package: h.package, patchedBy: h.patchedBy, index: h.index })),
          rows: (t.rows ?? []).map((r) => ({ id: r.id, name: r.name, section: r.section, disabled: r.disabled })),
          stderr: t.stderr,
          bundles: state.bundles,
          orphans: state.bundles.filter((b) => !depNames.has(b) && !inBox.has(b)),
          drift: installed.filter((i) => i.mismatch).map(publicInstalled),
        };
      }

      /** 第四层校验：真实启动一次（默认不跑，需用户显式点）。 */
      case 'bootVerify': {
        const r = await bootVerify(gctx(ctx), { timeoutMs: clamp(args.timeoutMs ?? 45_000, 10_000, 180_000) });
        appendOp({ op: 'boot-verify', ok: r.ok, sawUrl: r.sawUrl, fatalHits: r.fatalHits });
        return r;
      }

      // ── profile 工具 ────────────────────────────────────
      case 'profileCheck': {
        // 只做 profile 层检查：用一个假条目触发环境/profile 那两组检查
        const dummy = normalizeEntry({ id: '__profile__', package: '__profile__', name: '__profile__', install: {} }, 'community');
        const report = runGate(dummy, gctx(ctx), { targetProfile: ctx.profileName });
        return { checks: report.checks.filter((c) => c.id.startsWith('env.') || c.id.startsWith('profile.')) };
      }

      case 'fixAllowBuilds': {
        const r = applyAllowBuilds(profileState(ctx));
        appendOp({ op: 'fix-allowbuilds', ok: r.ok, added: r.added });
        return r;
      }

      case 'backups':
        return { items: listProfileBackups(process.env) };

      case 'rollback': {
        const dir = String(args.dir ?? '');
        if (!dir) throw new Error('缺少快照目录');
        const r = await rollbackTo({ backupDir: dir, ctx: gctx(ctx) });
        invalidate(ctx);
        appendOp({ op: 'rollback', dir, ok: r.ok });
        return r;
      }

      case 'log':
        return { items: readOpTail(clamp(args.n ?? 100, 1, 1000)) };

      case 'clearLog':
        return { ok: clearOpLog() };

      case 'refresh': {
        clearProbeCache();
        invalidate(ctx);
        ctx._verified = null;
        ctx._reviewed = null;
        const l = await layers(ctx, { refreshCommunity: true });
        return { ok: true, community: l.communityMeta?.source ?? 'unavailable', count: l.community.length, error: l.communityMeta?.error ?? null };
      }

      default:
        throw new Error(`未知方法：${method}`);
    }
  };
}

function gctx(ctx) {
  return {
    env: ctx.env,
    compat: ctx.compat,
    profileState: profileState(ctx),
    installed: scanInstalled(ctx.profileName, process.env),
    tree: tree(ctx),
    repoRoot: ctx.repoRoot,
    repoRawBase: REPO_RAW_BASE,
  };
}

// ─────────────────────────────────────────────────────────────
// 出参瘦身（列表页不需要把 notes 全文传过去）
// ─────────────────────────────────────────────────────────────

function publicEntry(e) {
  return {
    id: e.id,
    tier: e.tier,
    tierLabel: e.tierLabel,
    package: e.package,
    version: e.version,
    title: e.title,
    summary: short(e.summary, 220),
    tags: (e.tags ?? []).slice(0, 8),
    author: e.author,
    upstream: e.upstream,
    homepage: e.homepage,
    license: e.license,
    stars: e.stars,
    pushedAt: e.pushedAt,
    origin: e.origin,
    peerVerdict: e.peerVerdict,
    needsConfig: e.install?.needsConfig ?? false,
    risky: e.install?.risky ?? false,
    installKind: e.install?.kind ?? null,
    hasReview: Boolean(e.review),
  };
}

function publicInstalled(i) {
  return {
    name: i.name,
    spec: i.spec,
    specVersion: i.specVersion ?? null,
    installed: i.installed,
    installedVersion: i.installedVersion,
    isBundle: i.isBundle,
    inBundles: i.inBundles,
    mismatch: Boolean(i.mismatch),
    hasClient: i.hasClient,
  };
}

// ─────────────────────────────────────────────────────────────
// cordis
// ─────────────────────────────────────────────────────────────

export function apply(ctx) {
  let appCtx;
  try {
    appCtx = createContext();
  } catch (err) {
    // 上下文构建失败也不能把整棵树带下去：降级成一个只报错的实例
    appCtx = null;
    process.stderr.write(`dsh-plugins-market: 上下文初始化失败：${err?.message ?? err}\n`);
  }

  const dispatch = appCtx ? createDispatcher(appCtx) : async () => {
    throw new Error('dsh-plugins-market 上下文初始化失败，所有功能不可用。请看 harness 启动日志。');
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const send = (code, body) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
          };
          if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
          try {
            const payload = await readJsonBody(req);
            const started = Date.now();
            const result = await dispatch(String(payload.method ?? ''), payload.args ?? {});
            return send(200, { ok: true, result, tookMs: Date.now() - started });
          } catch (err) {
            return send(200, { ok: false, error: String(err?.message ?? err), detail: err?.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : null });
          }
        },
      }),
    'dsh-plugins-market: /dsh-plugins-market/api',
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

function short(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
