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
 * ★ 唯一的例外是**安装**：它不再在一次请求里跑完，而是变成一个后台任务
 *   （见 jobs.js）。理由是安装可能真的要好几分钟，而且必须能被中止 ——
 *   这两件事都要求「请求」与「执行」解耦：
 *       install        → 立刻拿回 jobId
 *       installProgress→ 轮询阶段 / 耗时 / 预计剩余 / 实时输出
 *       installAbort   → 真正中断（杀 pnpm 整棵进程树）
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
  loadVerified, loadReviewed, fetchCommunity,
  normalizeEntry, searchCatalog, mergeEntries,
  catalogStatus, findEntry, TIER_META, REVIEW_STATUS,
  REPO_RAW_BASE, REPO_HOMEPAGE, ensureDataDir, readCacheMeta,
} from './catalog.js';
import {
  installStateIndex, installedOverview,
  toggleUserMark, userMarks, userDataStats,
} from './state.js';
import { runGate } from './gate.js';
import { probeEntry, clearProbeCache } from './probe.js';
import {
  installPlugin, uninstallPlugin, repairProfile, rollbackTo, bootVerify,
  verifyInstalled, applyAllowBuilds, tarballCacheDir, preflight, removeDependency,
} from './installer.js';
import { manualInstallPlan, writeManualScript } from './manual.js';
import {
  startJob, currentJob, findJob, latestJob, requestAbort, jobSnapshot, listJobs, phasePlan,
} from './jobs.js';
import { DEFAULT_TOTAL_TIMEOUT_MS, phasesWithTimings, readTimings } from './progress.js';
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
    _pool: null,
    _poolAt: 0,
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

/**
 * 装配树缓存 8 秒：装前检查里要用，连着点多个插件不必反复跑。
 *
 * ★ 这里包了一层「同时只跑一个 dump-config」的合流：一次页面加载会并发打进来
 *   好几个请求（列表 + 状态 + 闸门），每个都要装配树。不合并的话会同时起
 *   好几个 dsh 进程，白烧 CPU 还把首屏拖慢。
 */
let treeInflight = null;

async function tree(ctx, { force = false } = {}) {
  if (force || !ctx._tree || Date.now() - ctx._treeAt > 8000) {
    if (!treeInflight) {
      // 不传 launcher：让 composedTree 自己解析「怎么调 dsh」（优先 lib/bin.js）
      treeInflight = composedTree(ctx.profileName, process.env)
        .then((t) => {
          ctx._tree = t;
          ctx._treeAt = Date.now();
          return t;
        })
        .finally(() => { treeInflight = null; });
    }
    // 强制刷新时也要等前一次结束，避免两次 dump-config 同时改 cordis.yml
    return treeInflight;
  }
  return ctx._tree;
}

function invalidate(ctx) {
  ctx._tree = null;
  ctx._treeAt = 0;
  invalidatePool(ctx);
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
  ctx._layers = {
    verified: ctx._verified,
    reviewed: ctx._reviewed,
    community,
    communityMeta: ctx._community,
  };
  return ctx._layers;
}

/**
 * 合并后的条目池 + 每个条目的安装状态。
 *
 * 这是界面唯一的数据来源：三层目录去重成一份列表，每条都带上
 * 「第几层（已审核 / 未审核）」「装没装」「装了是不是最新」。
 *
 * 缓存 10 秒：一次页面加载会连着打好几个请求（列表 + 状态 + 收藏筛选），
 * 每次重算合并 + 全量 scanInstalled 太浪费；但也不能缓存太久，
 * 否则装完插件界面还显示「未安装」。
 */
function pool(ctx, { recalc = false } = {}) {
  if (!recalc && ctx._pool && Date.now() - ctx._poolAt < 10_000) return ctx._pool;
  const l = ctx._layers;
  const { merged, shadowed } = mergeEntries(l);
  const { index } = installStateIndex(ctx.profileName, process.env, merged);
  const built = { entries: merged, shadowed, state: index, layers: l, at: Date.now() };
  ctx._pool = built;
  ctx._poolAt = Date.now();
  return built;
}

function invalidatePool(ctx) {
  ctx._pool = null;
  ctx._poolAt = 0;
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
        const p = pool(ctx);
        const state = profileState(ctx);
        const installed = installedOverview(ctx.profileName, process.env, p.entries);
        const marks = userMarks(process.env);
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
          reviewStatuses: [REVIEW_STATUS.verified, REVIEW_STATUS.reviewed, REVIEW_STATUS.community],
          installed,
          // 顶部「N 个可更新」提示要用；不单独开接口，省一次往返
          upgradable: installed.filter((i) => i.upgrade).map((i) => ({ name: i.name, from: i.installedVersion, to: i.targetVersion })),
          userData: { ...userDataStats(process.env), marks },
          backups: listProfileBackups(process.env).slice(0, 10),
          cache: readCacheMeta(),

          // ── 安装任务（问题：装的时候只在页面上干等）──
          // 让界面一打开就知道「现在有没有正在跑的安装」，而不是只有点过安装的人知道
          job: jobSnapshot(latestJob()),
          // ── profile 装前体检：断链 file: 依赖是「装很久装不上」的主因之一 ──
          preflight: preflight({ profileState: state, env: ctx.env }),
          // ── 进度模型自述：阶段表 + 本机实测耗时（界面用它渲染 ETA）──
          progressModel: {
            totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
            phases: phasesWithTimings(readTimings()),
          },
        };
      }

      // ── 目录（合并视图：一处列出全部，用标签区分）────────
      case 'catalog': {
        await layers(ctx, { refreshCommunity: Boolean(args.refresh) });
        const p = pool(ctx, { recalc: Boolean(args.refresh) });
        const marks = userMarks(process.env);
        const stateIndex = p.state;

        // ★ tier 参数仍兼容（旧书签 / 深链），但界面不再用它分页签
        const tier = args.tier && TIER_META[args.tier] ? args.tier : null;
        const source = tier ? p.entries.filter((e) => e.tier === tier) : p.entries;

        const result = searchCatalog(source, {
          query: args.query ?? '',
          limit: clamp(args.limit ?? 30, 1, 200),
          offset: clamp(args.offset ?? 0, 0, 1e6),
          review: args.review === 'reviewed' || args.review === 'unreviewed' ? args.review : null,
          only: ['liked', 'favorited', 'installed', 'upgradable'].includes(args.only) ? args.only : null,
          marks,
          installed: stateIndex,
        });

        return {
          total: result.total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 30,
          items: result.items.map((e) => publicEntry(e, stateIndex.get(e.id), marks[e.id])),
          tiers: catalogStatus(p.layers).tiers,
          merged: catalogStatus(p.layers).merged,
          reviewStatuses: [REVIEW_STATUS.verified, REVIEW_STATUS.reviewed, REVIEW_STATUS.community],
          communityMeta: {
            source: p.layers.communityMeta?.source ?? null,
            error: p.layers.communityMeta?.error ?? null,
            count: p.layers.community.length,
            generatedAt: p.layers.communityMeta?.generatedAt ?? null,
          },
          verifiedAvailable: p.layers.verified.available,
          verifiedError: p.layers.verified.error,
          marks: {
            liked: Object.values(marks).filter((m) => m.liked).length,
            favorited: Object.values(marks).filter((m) => m.favorited).length,
          },
        };
      }

      case 'entry': {
        await layers(ctx);
        const p = pool(ctx);
        const id = String(args.id ?? '');
        const found = p.entries.find((e) => e.id === id || e.package === id)
          ?? findEntry({ verified: p.layers.verified.plugins, reviewed: p.layers.reviewed.plugins, community: p.layers.community }, id);
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);
        const marks = userMarks(process.env);
        return {
          entry: publicEntry(found, p.state.get(found.id), marks[found.id], { full: true }),
          installed: p.state.get(found.id) ?? null,
          // 同一插件在其它层里的副本（去重时被合并掉的），详情页可以如实展示
          duplicates: (p.shadowed.get(`pkg:${String(found.package ?? '').toLowerCase()}`) ?? [])
            .map((e) => ({ id: e.id, tier: e.tier, tierLabel: e.tierLabel })),
        };
      }

      // ── 点赞 / 收藏 ─────────────────────────────────────
      case 'mark': {
        const action = args.action === 'favorite' ? 'favorite' : args.action === 'like' ? 'like' : null;
        if (!action) throw new Error(`未知的标记动作：${args.action}`);
        const r = toggleUserMark(action, args.id, args.value === undefined ? undefined : Boolean(args.value));
        appendOp({ op: `mark-${action}`, pluginId: r.id, ok: true, detail: action === 'like' ? `liked=${r.liked}` : `favorited=${r.favorited}` });
        return r;
      }

      case 'marks': {
        return { items: userMarks(process.env), stats: userDataStats(process.env) };
      }

      // ── 装前检查 ────────────────────────────────────────
      case 'gate': {
        const p = await ensurePool(ctx);
        const found = lookupEntry(p, args.id);
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);

        const state = p.state.get(found.id) ?? null;
        // ★ 已经是最新版本时闸门直接短路。
        //   这不是省事，而是**必须**：让用户对着一个「已是最新」的插件点开
        //   装前检查、勾风险确认、然后装出一个完全一样的版本，是纯粹的误导。
        if (state?.status === 'current') {
          const report = alreadyLatestReport(found, ctx, state);
          appendOp({ op: 'gate', pluginId: found.id, tier: found.tier, verdict: report.verdict, canInstall: false, reason: 'up-to-date' });
          return report;
        }

        // 本地没有 tarball 的条目（公共索引 / 已审核但未随包分发）先做一次远程静态探测
        let probe = null;
        const needsProbe = found.tier !== 'verified';
        if (needsProbe) {
          probe = await probeEntry(found, { force: Boolean(args.refreshProbe) });
        }

        const report = runGate(found, await gctx(ctx), {
          acknowledgeRisk: Boolean(args.acknowledgeRisk),
          targetProfile: ctx.profileName,
          probe,
        });
        appendOp({
          op: 'gate', pluginId: found.id, tier: found.tier, verdict: report.verdict,
          canInstall: report.canInstall, blockedBy: report.blockedBy,
          counts: report.counts,
        });
        // ★ 手动安装方案：装前就给。用户明确要求「自动安装不行时，要能停下来自己装」——
        //   而「能不能自己装、要敲什么命令」这个问题的答案不该等到失败后才出现。
        const manual = manualInstallPlan(found, await gctx(ctx), report.installSpec);
        return { ...report, installState: state, upgrade: state?.status === 'upgradable', manual };
      }

      // ── 安装 / 卸载 / 修复 ──────────────────────────────
      case 'install': {
        const p = await ensurePool(ctx);
        const found = lookupEntry(p, args.id);
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);

        // 已经有一个任务在跑（或排队）时不允许再开一个：
        // 两个 pnpm 同时改同一个 profile 必然互相破坏
        const busy = currentJob();
        if (busy && args.force !== true) {
          return {
            ok: false, refused: true, busy: true,
            job: jobSnapshot(busy),
            message: `已经有一个安装任务在跑（${busy.pkgName ?? busy.pluginId}）。同时改同一个 profile 会互相破坏，所以这次没有开始。`,
          };
        }

        const state = p.state.get(found.id) ?? null;
        if (state?.status === 'current') {
          const report = alreadyLatestReport(found, ctx, state);
          appendOp({ op: 'install-refused', pluginId: found.id, verdict: report.verdict, reason: 'up-to-date' });
          return { ok: false, refused: true, upToDate: true, gate: report, steps: [], message: report.message };
        }

        const probe = found.tier === 'verified' ? null : await probeEntry(found);
        const gate = runGate(found, await gctx(ctx), {
          acknowledgeRisk: Boolean(args.acknowledgeRisk),
          targetProfile: ctx.profileName,
          probe,
        });
        if (!gate.canInstall) {
          appendOp({ op: 'install-refused', pluginId: found.id, verdict: gate.verdict, blockedBy: gate.blockedBy });
          return { ok: false, refused: true, gate, steps: [], message: '装前检查未通过，已中止安装（没有改动任何文件）。' };
        }

        ctx.env = detectEnvironment(process.env); // 环境可能在会话期间变了

        // ★ 手动安装方案在**开始之前**就算好：无论自动安装成功还是失败，
        //   用户都应该能立刻看到「同样的效果，我自己敲命令要怎么做」。
        const manual = manualInstallPlan(found, await gctx(ctx), gate.installSpec);

        const isUpgrade = state?.status === 'upgradable';
        const job = startJob({
          kind: isUpgrade ? 'upgrade' : 'install',
          pluginId: found.id,
          pkgName: found.package ?? found.id,
          profile: ctx.profileName,
          entry: { id: found.id, title: found.title, package: found.package, version: found.version },
          manual,
          totalTimeoutMs: clamp(args.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS, 60_000, 60 * 60 * 1000),
          runner: async (j) => {
            // ★ 测试专用：模拟一个「很慢的安装」，用来验证中止链路真的能打断。
            //   没有这个口子，快速机器上安装 300ms 就结束了，中止按钮永远来不及按 ——
            //   而「能不能中止」恰恰是这个功能最关键、也最容易悄悄失效的一环。
            const sim = Number(args.simulateSlowInstallSeconds);
            if (Number.isFinite(sim) && sim > 0) {
              const until = Math.min(sim, 600) * 1000;
              j.phase('install');
              await new Promise((resolve) => {
                const t = setTimeout(resolve, until);
                j.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
              });
              if (j.signal.aborted) {
                return { ok: false, aborted: true, failure: 'aborted-by-user', steps: [{ id: 'sim', label: '模拟安装', status: 'warn', detail: '被中止' }] };
              }
            }
            const result = await installPlugin({ entry: found, ctx: await gctx(ctx), gate, options: {}, job: j });
            invalidate(ctx);
            appendOp({
              op: isUpgrade ? 'upgrade' : 'install',
              pluginId: found.id, ok: result.ok, failure: result.failure ?? null,
              aborted: Boolean(result.aborted),
              from: state?.installedVersion ?? null, to: state?.target ?? null,
              backupDir: result.backupDir ?? null,
              ms: (j.endedAt ?? Date.now()) - (j.startedAt ?? Date.now()),
              timings: result.timings ?? null,
              retried: (result.steps ?? []).some((s) => s.id === 'allowbuilds-retry'),
            });
            return result;
          },
        });

        appendOp({ op: 'install-start', pluginId: found.id, jobId: job.id, upgrade: isUpgrade, profile: ctx.profileName });

        return {
          ok: true,
          started: true,
          jobId: job.id,
          job: jobSnapshot(job),
          gate,
          manual,
          upgrade: isUpgrade,
          fromVersion: state?.installedVersion ?? null,
          toVersion: state?.target ?? null,
          message: '安装已在后台开始。可以随时关掉这个页面 —— 任务会在服务端继续，回来还能看到进度。',
        };
      }

      /** 安装进度：前端每 600ms 轮询一次（关掉页面再回来也能续上看） */
      case 'installProgress': {
        const job = args.jobId ? findJob(args.jobId) : latestJob();
        if (!job) return { job: null, message: '还没有任何安装任务。' };
        // 任务结束时顺手把插件池失效掉，省得用户回来看到「未安装」
        if (job.state === 'succeeded') invalidate(ctx);
        return { job: jobSnapshot(job) };
      }

      /** 中止安装：真正杀 pnpm 的整棵进程树，然后回滚到安装前 */
      case 'installAbort': {
        const job = args.jobId ? findJob(args.jobId) : currentJob();
        if (!job) return { ok: false, error: '没有正在跑的安装任务。' };
        const r = requestAbort(job, args.reason === 'timeout' ? 'timeout' : 'user');
        appendOp({ op: 'install-abort', pluginId: job.pluginId, jobId: job.id, ok: r.ok });
        return {
          ...r,
          job: jobSnapshot(job),
          message: r.ok
            ? '已发出中止请求：先结束 pnpm 进程（连同它的子进程），再用安装前的快照把 profile 还原。'
            : r.error,
        };
      }

      case 'jobs':
        return { items: listJobs(), current: jobSnapshot(currentJob()) };

      /** 手动安装指引：任何时候都能拿（不依赖是否有任务在跑） */
      case 'manualCommands': {
        const p = await ensurePool(ctx);
        const found = lookupEntry(p, args.id);
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);
        const g = await gctx(ctx);
        const probe = found.tier === 'verified' ? null : await probeEntry(found);
        const report = runGate(found, g, { targetProfile: ctx.profileName, probe });
        const plan = manualInstallPlan(found, g, report.installSpec);
        if (args.save) {
          const dir = ensureDir(path.join(resolveDataDir(), 'manual'));
          const saved = writeManualScript(plan, { dir, format: String(args.save) });
          return { plan, saved };
        }
        return { plan };
      }

      /** 一键修掉「断链的 file: 依赖」—— 它会让任何安装都变慢甚至失败 */
      case 'removeDependency': {
        const name = String(args.package ?? '').trim();
        if (!name) throw new Error('缺少 package 参数');
        const busy = currentJob();
        if (busy) {
          return { ok: false, busy: true, job: jobSnapshot(busy), error: '有安装任务在跑，等它结束再动 profile。' };
        }
        const result = await removeDependency({ ctx: await gctx(ctx), pkgName: name });
        invalidate(ctx);
        appendOp({ op: 'remove-dependency', package: name, ok: result.ok, failure: result.failure ?? null });
        return result;
      }

      case 'uninstall': {
        const state = profileState(ctx);
        const target = String(args.id ?? '');
        const installed = scanInstalled(ctx.profileName, process.env).find((i) => i.name === target)
          ?? Object.entries(state.dependencies).map(([n, s]) => ({ name: n, spec: s })).find((i) => i.name === target);
        if (!installed) throw new Error(`${target} 不在这个 profile 里`);
        const result = await uninstallPlugin({ entry: { id: target, package: target }, ctx: await gctx(ctx) });
        invalidate(ctx);
        appendOp({ op: 'uninstall', pluginId: target, ok: result.ok });
        return result;
      }

      case 'repair': {
        const result = await repairProfile({ ctx: await gctx(ctx) });
        invalidate(ctx);
        appendOp({ op: 'repair', ok: result.ok, orphansAfter: result.orphansAfter });
        return result;
      }

      case 'preflight': {
        const state = profileState(ctx);
        return preflight({ profileState: state, env: ctx.env });
      }

      case 'verify': {
        const target = String(args.id ?? '');
        if (target) {
          const v = await verifyInstalled(target, await gctx(ctx));
          return { ok: v.ok, layers: v.layers, bundles: v.bundles };
        }
        invalidate(ctx);
        const t = await tree(ctx, { force: true });
        const state = profileState(ctx);
        const raw = scanInstalled(ctx.profileName, process.env);
        const p = pool(ctx, { recalc: true });
        const byName = new Map(installedOverview(ctx.profileName, process.env, p.entries).map((i) => [i.name, i]));
        const installed = raw.map((i) => byName.get(i.name) ?? i);
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
          upgradable: installed.filter((i) => i.upgrade).map(publicInstalled),
        };
      }

      /** 第四层校验：真实启动一次（默认不跑，需用户显式点）。 */
      case 'bootVerify': {
        const r = await bootVerify(await gctx(ctx), { timeoutMs: clamp(args.timeoutMs ?? 45_000, 10_000, 180_000) });
        appendOp({ op: 'boot-verify', ok: r.ok, sawUrl: r.sawUrl, fatalHits: r.fatalHits });
        return r;
      }

      // ── profile 工具 ────────────────────────────────────
      case 'profileCheck': {
        // 只做 profile 层检查：用一个假条目触发环境/profile 那两组检查
        const dummy = normalizeEntry({ id: '__profile__', package: '__profile__', name: '__profile__', install: {} }, 'community');
        const report = runGate(dummy, await gctx(ctx), { targetProfile: ctx.profileName });
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
        const r = await rollbackTo({ backupDir: dir, ctx: await gctx(ctx) });
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

/**
 * 给闸门 / 安装器用的上下文。
 *
 * ★ 必须 await：装配树是异步拿的（build 一次 dsh 进程），
 *   而闸门是**同步**判定的（它要在一帧里把几十条检查跑完）。
 *   所以这里先把树取好，再整包传进去 —— 闸门本身保持纯函数。
 */
async function gctx(ctx) {
  return {
    env: ctx.env,
    compat: ctx.compat,
    profileState: profileState(ctx),
    installed: scanInstalled(ctx.profileName, process.env),
    tree: await tree(ctx),
    repoRoot: ctx.repoRoot,
    repoRawBase: REPO_RAW_BASE,
  };
}

/** 确保目录层与合并池都已就绪，返回合并池 */
async function ensurePool(ctx) {
  await layers(ctx);
  return pool(ctx);
}

/** 在合并池里按 id / 包名查一条；查不到再退回原始三层（兼容旧 id） */
function lookupEntry(p, id) {
  const key = String(id ?? '');
  const direct = p.entries.find((e) => e.id === key || e.package === key);
  if (direct) return direct;
  return findEntry({
    verified: p.layers.verified.plugins,
    reviewed: p.layers.reviewed.plugins,
    community: p.layers.community,
  }, key);
}

/**
 * 「已经是最新版本」时的闸门结果。
 *
 * 形状与 runGate() 的返回值保持一致（界面里是同一套渲染），但：
 *   - canInstall 恒为 false —— 这是本函数存在的意义
 *   - 只给一条 pass 检查项，不跑环境 / profile / 候选包那三组
 *     （跑了也没意义：反正不会装）
 */
function alreadyLatestReport(entry, ctx, state) {
  const target = state?.target ?? entry.version ?? null;
  return {
    pluginId: entry.id,
    tier: entry.tier,
    tierLabel: entry.tierLabel,
    reviewStatus: entry.reviewStatus,
    targetProfile: ctx.profileName,
    verdict: 'pass',
    upToDate: true,
    canInstall: false,
    installable: false,
    requiresRiskAck: false,
    acknowledged: false,
    blockedBy: [],
    overridableBy: [],
    counts: { pass: 1, warn: 0, fatalBlocking: 0, fatalOverridable: 0, skipped: 0 },
    checks: [{
      id: 'cand.up-to-date',
      title: '已是最新版本',
      severity: 'info',
      status: 'pass',
      detail: `${entry.package ?? entry.id} 已经装的是 ${state?.installedVersion ?? target}`
        + `，与目录里的版本一致，没有需要更新的内容。`,
      hint: '目录里出现更新的版本时，这里的按钮会变成「更新到 x.y.z」。',
    }],
    installSpec: null,
    manifest: null,
    probe: null,
    alreadyInstalled: state ?? null,
    installState: state,
    upgrade: false,
    message: `${entry.package ?? entry.id} 已是最新版本（${state?.installedVersion ?? target}），无需安装。`,
    durationMs: 0,
    ranAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// 出参瘦身（列表页不需要把 notes 全文传过去）
// ─────────────────────────────────────────────────────────────

function publicEntry(e, state = null, mark = null, { full = false } = {}) {
  const st = state ?? null;
  return {
    id: e.id,
    tier: e.tier,
    tierLabel: e.tierLabel,
    // 审核状态标签：界面顶部就是用它区分「已审核 / 未审核」的
    reviewStatus: e.reviewStatus ?? null,
    package: e.package,
    version: e.version,
    title: e.title,
    summary: short(e.summary, full ? 4000 : 220),
    tags: (e.tags ?? []).slice(0, full ? 24 : 8),
    author: e.author,
    upstream: e.upstream,
    homepage: e.homepage,
    license: e.license,
    stars: e.stars,
    pushedAt: e.pushedAt,
    origin: e.origin,
    peerVerdict: e.peerVerdict,
    peerNote: full ? e.peerNote ?? null : null,
    coexistenceWarning: full ? e.coexistenceWarning ?? null : null,
    notes: full ? e.notes ?? null : null,
    needsConfig: e.install?.needsConfig ?? false,
    risky: e.install?.risky ?? false,
    installKind: e.install?.kind ?? null,
    hasReview: Boolean(e.review),
    review: full ? e.review ?? null : null,

    // ── 安装状态（问题 1 / 2 的载体）──
    installState: st ? {
      status: st.status,
      installed: st.installed,
      installedVersion: st.installedVersion,
      target: st.target,
      reason: st.reason,
      inBundles: st.inBundles,
      canInstall: st.canInstall,
      canUpgrade: st.canUpgrade,
      action: st.action,
      isLatest: st.isLatest,
    } : {
      status: 'not-installed', installed: false, installedVersion: null,
      target: null, reason: null, inBundles: false,
      canInstall: true, canUpgrade: false, action: 'install', isLatest: false,
    },

    // ── 用户标记（问题 3 的载体）──
    liked: Boolean(mark?.liked),
    favorited: Boolean(mark?.favorited),
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
    // 新增：能不能升级、升级到哪一版
    inCatalog: Boolean(i.inCatalog),
    targetVersion: i.targetVersion ?? null,
    upgrade: Boolean(i.upgrade),
    state: i.state ?? 'unknown',
    stateReason: i.stateReason ?? null,
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
