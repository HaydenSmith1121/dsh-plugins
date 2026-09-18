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
  loadCatalogIndex, loadPluginConfig, entryFromConfig,
  normalizeEntry, searchCatalog,
  catalogStatus, findEntry,
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
    _catalog: null,
    _catalogAt: 0,
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
 * 从这个路径反推仓库根，就能用**本地**的目录与 tarball（离线、快、且与开发机一致）。
 * 也支持用环境变量 DSH_PLUGINS_REPO 显式指定。
 *
 * ★ 判定标记从 `compatibility.json` 换成了 `catalog/index.json`：
 *   自 0.4.0 起，本仓库的插件**目录**是 catalog/ 下的「一个插件一个配置文件」，
 *   而 compatibility.json 已经瘦身成只描述运行时矩阵（插件清单搬去了
 *   dsh-plugin-collection）。用目录做标记才代表「这里真的是市场仓库」。
 */
function detectRepoRoot(ctx) {
  return detectRepoRootRaw(ctx.env);
}

const REPO_MARKER = path.join('catalog', 'index.json');

function detectRepoRootRaw(env) {
  const explicit = process.env.DSH_PLUGINS_REPO;
  if (explicit && fs.existsSync(path.join(explicit, REPO_MARKER))) return path.resolve(explicit);

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
    if (fs.existsSync(path.join(native, REPO_MARKER))) return native;
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

/**
 * 取整个目录。
 *
 * ★ 目录只有一个来源：市场仓库里的 **catalog/index.json**，
 *   而它是由「一个插件一个配置文件」（catalog/plugins/<slug>.json）派生的。
 *
 *   ★ 0.5.0 之前这里还会把索引**按 tier 分成三层**再交给界面（兼容旧的三个页签）。
 *     信任分级去掉之后没有层可分了：目录就是一份平铺列表，
 *     `ctx._catalog` 里直接挂 entries + meta，不再有 verified / reviewed / community 三个桶。
 *
 * @param {object}  ctx
 * @param {boolean} [opts.refresh] 忽略 TTL，去服务端确认一次（走条件请求，通常是 304）
 */
async function layers(ctx, { refresh = false } = {}) {
  if (!refresh && ctx._catalog && Date.now() - ctx._catalogAt < 10_000) return ctx._catalog;

  const index = await loadCatalogIndex({ force: refresh });

  ctx._catalog = {
    index,
    entries: index.entries,
    meta: {
      source: index.source,
      error: index.error,
      generatedAt: index.generatedAt,
      ageMs: index.ageMs ?? null,
      counts: index.counts,
      sourceIndex: index.sourceIndex,
    },
  };
  ctx._catalogAt = Date.now();
  return ctx._catalog;
}

/**
 * 读某个插件的**配置文件**，并换成闸门 / 安装器认的条目。
 *
 * ★ 这是「市场与插件分离」在运行时的落点：索引只负责让用户看到有哪些插件，
 *   **真正要装的时候必须去读那一个插件自己的配置文件**，再按它写的
 *   install.method 去装。读不到就如实报错 —— 不拿索引里的字段凑一个安装方法，
 *   因为那正是「配置说该这么装、实际却那么装」这类事故的来源。
 */
async function resolveEntryConfig(ctx, entry) {
  if (!entry) return { entry: null, config: null, source: null, error: null };
  const { config, source, error } = await loadPluginConfig(entry);
  if (!config) {
    return {
      entry,
      config: null,
      source: null,
      error: error ?? `读不到 catalog/plugins/${entry.slug}.json`,
    };
  }
  const merged = entryFromConfig(config, entry);
  // 索引带出来的 slug 是定位符，配置文件里也写了，但以索引为准更稳
  merged.slug = entry.slug ?? merged.slug;
  merged.__config = config;
  merged.__configSource = source;
  return { entry: merged, config, source, error: null };
}

/**
 * 合并后的条目池 + 每个条目的安装状态。
 *
 * 这是界面唯一的数据来源：目录去重成一份列表，每条都带上
 * 「第几层（已审核 / 未审核）」「装没装」「装了是不是最新」。
 *
 * 缓存 10 秒：一次页面加载会连着打好几个请求（列表 + 状态 + 收藏筛选），
 * 每次重算合并 + 全量 scanInstalled 太浪费；但也不能缓存太久，
 * 否则装完插件界面还显示「未安装」。
 */
function pool(ctx, { recalc = false } = {}) {
  if (!recalc && ctx._pool && Date.now() - ctx._poolAt < 10_000) return ctx._pool;
  const l = ctx._catalog;
  // 0.5.0：目录是平铺列表，不再需要 mergeEntries 去跨层合并
  const { index } = installStateIndex(ctx.profileName, process.env, l.entries);
  const built = { entries: l.entries, state: index, layers: l, at: Date.now() };
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
          catalog: catalogStatus({ index: l.index, env: ctx.env, meta: l.meta }),
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

      // ── 目录（一份平铺列表；没有层级可筛了）────────
      case 'catalog': {
        const l = await layers(ctx, { refresh: Boolean(args.refresh) });
        const p = pool(ctx, { recalc: Boolean(args.refresh) });
        const marks = userMarks(process.env);
        const stateIndex = p.state;

        const result = searchCatalog(p.entries, {
          query: args.query ?? '',
          limit: clamp(args.limit ?? 30, 1, 200),
          offset: clamp(args.offset ?? 0, 0, 1e6),
          only: ['favorited', 'installed', 'upgradable'].includes(args.only) ? args.only : null,
          marks,
          installed: stateIndex,
        });

        return {
          total: result.total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 30,
          items: result.items.map((e) => publicEntry(e, stateIndex.get(e.id), marks[e.id])),
          // 目录本身是从哪来的（远程 / 304 / 缓存 / 离线包内）—— 界面据此提示「目录可能不是最新」
          indexMeta: l.meta,
          marks: {
            favorited: Object.values(marks).filter((m) => m.favorited).length,
          },
        };
      }

      case 'entry': {
        const l = await layers(ctx);
        const p = pool(ctx);
        const id = String(args.id ?? '');
        const foundIndex = p.entries.find((e) => e.id === id || e.package === id || e.slug === id)
          ?? findEntry(l, id);
        if (!foundIndex) throw new Error(`目录里没有这个插件：${args.id}`);
        // 详情页给的是**配置文件里的**权威内容，不是索引里的展示摘要
        const { entry: found, config, source: configSource, error: configError } = await resolveEntryConfig(ctx, foundIndex);
        const marks = userMarks(process.env);
        return {
          entry: publicEntry(found, p.state.get(found.id), marks[found.id], { full: true }),
          installed: p.state.get(found.id) ?? null,
          // 配置文件本身的取用情况：读不到时要如实说，而不是假装读到了一份
          config: {
            slug: foundIndex.slug,
            source: configSource,
            error: configError,
            installMethod: config?.install?.method ?? null,
            raw: config ?? null,
          },
          // 同一插件在本机装了几份 / 目录里有没有同包名的别的记录 —— 详情页如实展示
          duplicates: [],
        };
      }

      // ── 收藏（点赞已删除：见 state.js 的说明）────────
      case 'mark': {
        if (args.action !== 'favorite') throw new Error(`未知的标记动作：${args.action}（只支持 favorite）`);
        const r = toggleUserMark('favorite', args.id, args.value === undefined ? undefined : Boolean(args.value));
        appendOp({ op: 'mark-favorite', pluginId: r.id, ok: true, detail: `favorited=${r.favorited}` });
        return r;
      }

      case 'marks': {
        return { items: userMarks(process.env), stats: userDataStats(process.env) };
      }

      // ── 装前检查 ────────────────────────────────────────
      case 'gate': {
        const p = await ensurePool(ctx);
        const { entry: found, source: configSource, error: configError } = await resolveEntryConfig(ctx, lookupEntry(p, args.id));
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);

        const state = p.state.get(found.id) ?? null;
        // ★ 已经是最新版本时闸门直接短路。
        //   这不是省事，而是**必须**：让用户对着一个「已是最新」的插件点开
        //   装前检查、勾风险确认、然后装出一个完全一样的版本，是纯粹的误导。
        if (state?.status === 'current') {
          const report = alreadyLatestReport(found, ctx, state);
          appendOp({ op: 'gate', pluginId: found.id, verdict: report.verdict, canInstall: false, reason: 'up-to-date' });
          return { ...report, configSource, configError };
        }

        /**
         * 静态探测：只在本地没有 tarball 时才需要。
         *
         * ★ 0.5.0 之前这条判据是 `found.tier !== 'verified'`（「不是我们自己托管的
         *   那几条才要去探」）。信任分级去掉之后换成了更直接的问法：
         *   **这个包的字节在不在本地**。在本地就已经能逐字节看清它声明了什么，
         *   再去网上探一遍纯属浪费；不在本地就必须探 —— 探的是「能不能装」，
         *   与谁托管无关。
         */
        let probe = null;
        if (found.install?.method !== 'tarball') {
          probe = await probeEntry(found, { force: Boolean(args.refreshProbe) });
        }

        const report = runGate(found, await gctx(ctx), {
          acknowledgeRisk: Boolean(args.acknowledgeRisk),
          targetProfile: ctx.profileName,
          probe,
        });
        appendOp({
          op: 'gate', pluginId: found.id, verdict: report.verdict,
          canInstall: report.canInstall, blockedBy: report.blockedBy,
          counts: report.counts,
        });
        // ★ 手动安装方案：装前就给。用户明确要求「自动安装不行时，要能停下来自己装」——
        //   而「能不能自己装、要敲什么命令」这个问题的答案不该等到失败后才出现。
        const manual = manualInstallPlan(found, await gctx(ctx), report.installSpec);
        return { ...report, installState: state, upgrade: state?.status === 'upgradable', manual, configSource, configError };
      }

      // ── 安装 / 卸载 / 修复 ──────────────────────────────
      case 'install': {
        const p = await ensurePool(ctx);
        const { entry: found, source: configSource, error: configError } = await resolveEntryConfig(ctx, lookupEntry(p, args.id));
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);

        // ★ 配置文件读不到就不装。索引里的字段只够「展示」，不足以决定怎么装 ——
        //   按索引猜一个安装方法，等于把「配置说了算」这条约定作废。
        if (found.__config == null) {
          appendOp({ op: 'install-refused', pluginId: found.id, reason: 'config-unavailable', detail: configError });
          return {
            ok: false, refused: true, configUnavailable: true, steps: [],
            message: `读不到这个插件的配置文件（catalog/plugins/${found.slug}.json）：${configError ?? '未知原因'}。`
              + '安装必须按配置文件里写的方法走，所以这次没有开始。可以点「刷新目录」重试，或按详情页里的手动命令自己装。',
          };
        }

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

        const probe = found.install?.method === 'tarball' ? null : await probeEntry(found);
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
        const { entry: found } = await resolveEntryConfig(ctx, lookupEntry(p, args.id));
        if (!found) throw new Error(`目录里没有这个插件：${args.id}`);
        const g = await gctx(ctx);
        const probe = found.install?.method === 'tarball' ? null : await probeEntry(found);
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
        ctx._catalog = null;
        ctx._catalogAt = 0;
        const l = await layers(ctx, { refresh: true });
        // ★ 目录的来源要如实回报：一个插件发新版之后，用户唯一能判断
        //   「我看到的是不是最新的」依据就是这个 source（远程 / 304 / 缓存 / 离线包内）。
        return {
          ok: true,
          source: l.meta.source,
          generatedAt: l.meta.generatedAt,
          ageMs: l.meta.ageMs ?? null,
          counts: l.meta.counts ?? null,
          upstreamGeneratedAt: l.meta.sourceIndex?.generatedAt ?? null,
          error: l.meta.error ?? null,
        };
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

/** 确保目录已就绪，返回条目池 */
async function ensurePool(ctx) {
  await layers(ctx);
  return pool(ctx);
}

/** 在条目池里按 id / 包名 / slug 查一条 */
function lookupEntry(p, id) {
  const key = String(id ?? '');
  return p.entries.find((e) => e.id === key || e.package === key || e.slug === key)
    ?? findEntry(p.entries, key);
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
    slug: e.slug ?? null,
    package: e.package,
    version: e.version,
    // 版本号是从哪儿取来的（npm / GitHub release / tag / package.json / 取不到）——
    // 目录里的版本号是采集来的，如实标注来源，用户才知道该信到什么程度
    versionSource: e.versionSource ?? null,
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
    // 安装方法（配置文件里写的那个）——界面据此决定按钮文案与命令示例
    installMethod: e.install?.method ?? null,
    installKind: e.install?.kind ?? null,
    installSpec: e.install?.spec ?? null,
    installUrl: e.install?.url ?? null,
    // 字节是不是由本仓库（或插件集合仓库）托管的 —— 界面据此决定「离线可装」的措辞
    localBytes: e.install?.method === 'tarball',

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
    favorited: Boolean(mark?.favorited),
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
