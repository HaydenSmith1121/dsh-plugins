/**
 * 插件配置文件的**格式定义** —— 市场仓库唯一的事实来源。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 *
 * 这一版的插件市场与上一版的根本区别：**目录不再是「几个大 JSON」，而是
 * 「一个插件一个配置文件」**。
 *
 *   catalog/plugins/<slug>.json   一个插件一份，人可读、可 diff、可单独 review
 *   catalog/index.json            由上面那些**派生**出来的轻量索引，给列表页用
 *
 * 这样做的直接好处：某个插件的版本号 / star 数变了，diff 里就是那一个文件的一行，
 * 而不是混在 7000 条里的一坨；某个插件被下架或者需要人工审核，也是碰它自己那份文件。
 *
 * ── 谁写、谁读 ────────────────────────────────────────────────
 *
 *   写：scripts/sync-catalog.mjs（每日 GitHub Actions 定时跑，也可本地手动跑）
 *   读：dsh-plugins-market 插件（运行时从仓库 raw 拉 index.json + 单条配置文件）
 *
 * ── 数据的边界（很重要，别在这里做判断）─────────────────────────
 *
 * 这个模块只负责**形状**：字段名、类型、默认值、slug 规则、索引怎么派生。
 * 「版本号从哪来」「这个插件算不算可安装」属于**采集与判定**，在 sync-catalog.mjs
 * 与市场插件的 gate.js 里，不在这里。
 *
 * @module scripts/lib/catalog-format
 */

import fs from 'node:fs';
import path from 'node:path';

/** 配置文件的 schema 版本。加字段不必动它，改语义才动。 */
export const SCHEMA_VERSION = 1;

/** 三个信任层级。市场界面的标签、排序、闸门强度都按它分档。 */
export const TIERS = ['verified', 'reviewed', 'community'];

/** 安装方式的枚举。market 运行时会按它分派到不同的安装路径。 */
export const INSTALL_METHODS = ['tarball', 'npm', 'github', 'skills', 'manual'];

/** 版本号的来源，按可信度从高到低。写进配置文件供审计。 */
export const VERSION_SOURCES = ['npm', 'github-release', 'github-tag', 'package.json', 'none'];

/** 目录里放配置文件的子目录（相对仓库根）。 */
export const PLUGINS_DIR_REL = path.join('catalog', 'plugins');
/** 派生索引的相对路径。 */
export const INDEX_REL = path.join('catalog', 'index.json');

/**
 * 把插件 id 变成一个稳定的文件名主干。
 *
 * 规则刻意保守：
 *   · 只保留 `[a-z0-9._-]`，其余一律换成 `-`（GitHub 的 owner/repo 里合法字符很少，
 *     但公共索引里的 id 五花八门，什么字符都出现过）
 *   · 全小写 —— 否则 `Foo/Bar` 与 `foo/bar` 会在 macOS / Windows 上撞成同一个文件，
 *     而这两个文件系统是本仓库的主要使用场景
 *   · `@scope/pkg` 形态的包名保留 scope，但把 `/` 换成 `__`
 *
 * @param {string} id 插件 id（`owner/repo` 或包名）
 * @returns {string} 文件名主干（不含 .json）
 */
export function slugify(id) {
  const raw = String(id ?? '').trim();
  if (raw === '') return 'unknown';

  const base = raw
    .replace(/^@/, '') // @scope/pkg → scope/pkg
    .replace(/[/\\]/g, '__') // 路径分隔 → __（保住 owner 与 repo 的边界）
    .replace(/[^A-Za-z0-9._-]+/g, '-') // 其余非法字符 → -
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .toLowerCase();

  return base === '' ? 'unknown' : base.slice(0, 120);
}

/** 把 slug 还原成人能认出的 id 形态（仅用于展示与排错，不参与判定）。 */
export function deslugify(slug) {
  return String(slug ?? '').replace(/__/g, '/');
}

/**
 * 从公共索引的一条记录里挑出「干净的安装规格」。
 *
 * ★ 绝不复用索引里的原始命令。实测 7487 条里混着 `curl … | sh`、`pip install`、
 *   `brew install`、`npm install -g` 这类根本不是 dsh 插件安装的命令。
 *   只接受 `dsh plugin … add <干净规格>` 这一种形态。
 *
 * @param {string[]} commands
 * @returns {{method:'github'|'npm', spec:string, source:string}|null}
 */
export function extractCleanSpec(commands) {
  if (!Array.isArray(commands)) return null;
  for (const raw of commands) {
    const cmd = String(raw ?? '').trim();
    if (cmd === '' || /<[^>]*>/.test(cmd)) continue; // 含占位符的一律不信
    const m = /\bdsh\s+plugin\b[^\n]*?\badd\s+(.+?)\s*$/.exec(cmd);
    if (!m) continue;
    if (/\s&&|\s\|\s|\s;\s/.test(cmd)) continue; // 复合命令不认
    const spec = m[1].replace(/^['"]|['"]$/g, '').trim();
    if (/^github:[^\s]+$/.test(spec)) return { method: 'github', spec, source: 'index-command' };
    if (/^npm:[^\s]+$/.test(spec)) return { method: 'npm', spec: spec.slice(4), source: 'index-command' };
    if (/^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+(@[^\s]+)?$/i.test(spec)) {
      return { method: 'npm', spec, source: 'index-command' };
    }
  }
  return null;
}

/** 从 GitHub 仓库地址里取出 `owner/repo`；取不到返回 null。 */
export function githubSlug(url) {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(String(url ?? '').trim());
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

/**
 * 判断一个规格是否字符串安全（能直接当 npm 包名用）。
 *
 * 公共索引里 `name` 字段与真实 npm 包名没有任何保证关系，所以卡得比较死。
 * 允许带版本标签（`foo@1.2.3` / `@scope/foo@next`）—— 那是合法的 npm 规格，
 * 而且索引里确实出现过；不接受它会让一条本来能装的记录在归一化时被降级成
 * 「无法安装」，属于把数据问题变成能力问题。
 */
export function looksLikeNpmName(s) {
  const t = String(s ?? '').trim();
  if (t === '') return false;
  const NAME = '(?:@[a-z0-9-~][a-z0-9-._~]*\\/)?[a-z0-9-~][a-z0-9-._~]*';
  const withTag = new RegExp(`^${NAME}@[^\\s@]+$`, 'i');
  const bare = new RegExp(`^${NAME}$`, 'i');
  // 包名里至少要有一个字母或数字：`.` / `-` / `__` 这类「看着像名字」的字符串
  // 其实是路径或占位符，放行它们会让闸门拿一个不存在的包去装。
  const base = withTag.test(t) ? t.replace(/@[^\s@]+$/, '') : t;
  if (!/[a-z0-9]/i.test(base)) return false;
  return withTag.test(t) || bare.test(t);
}

/**
 * 造一条**空白的**插件记录。所有字段都在这里显式列出，
 * 免得下游靠 `?.` 到处兜底、也就没人知道到底有哪些字段。
 */
export function blankRecord({ id, tier = 'community' }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    slug: slugify(id),
    tier,
    package: null,
    name: null,
    title: null,
    summary: '',
    tags: [],

    version: null,
    versionSource: 'none',
    versionCheckedAt: null,
    latestRelease: null,

    author: null,
    repo: null,
    homepage: null,
    license: null,
    stars: null,
    forks: null,
    pushedAt: null,
    metricsCheckedAt: null,

    // ── 兼容性事实 ────────────────────────────────────────────
    // 只对「我们实测过」的插件（tier=verified）和人工审核过的（tier=reviewed）有意义；
    // 采集器不会给 community 层编造这些，取不到就是 null。
    origin: null,
    peerRuntimePin: null,
    peerVerdict: null,
    peerNote: null,
    coexistenceWarning: null,
    notes: null,
    // 自引用条目（市场插件指向自己的 tarball）无法自包含 hash，用这个字段如实说明原因
    sha256Note: null,

    install: {
      method: 'manual',
      spec: null,
      commands: [],
      url: null,
      sha256: null,
      bytes: null,
      tarball: null,
      dshVersion: null,
      needsConfig: false,
      usageNeedsConfig: false,
      risky: false,
      riskyReasons: [],
    },

    source: {
      kind: 'public-index',
      url: null,
      firstSeenAt: null,
      lastSyncedAt: null,
    },

    review: null,
  };
}

/**
 * 把任意来源的一条输入**规整**成合法记录：补齐缺字段、夹掉非法值、统一类型。
 *
 * 刻意不抛错 —— 采集侧面对的是 7000 多条来源各异的数据，一条不合规就让整轮同步
 * 失败是不可接受的。规整不了的字段会退化成 null / 默认值，并且由调用方决定要不要
 * 记一条 warning。
 *
 * @param {object} input
 * @returns {object} 新的记录对象（不修改 input）
 */
export function normalizeRecord(input) {
  const id = String(input?.id ?? '').trim();
  const rec = blankRecord({ id, tier: TIERS.includes(input?.tier) ? input.tier : 'community' });

  const str = (v) => {
    const s = v == null ? '' : String(v).trim();
    return s === '' ? null : s;
  };
  /**
   * ★ 数字字段的归一化必须把 null / '' / 非数字**一律还原成 null**。
   *
   *   这里曾经写成 `Number.isFinite(Number(v)) ? Number(v) : null` ——
   *   而 `Number(null) === 0`，于是「没有这个数据」被静默写成了 0。
   *   后果不是显示成 0 那么轻：它让**归一化不幂等** ——
   *   磁盘上写着 `null`，读进来变成 `0`，下次又按 0 写出去，
   *   于是每日同步会认为「每个文件都变了」，7000 个文件天天 flip-flop，
   *   真正的变更被彻底淹没。而 `--check` 也会永远红。
   */
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  rec.package = str(input.package);
  rec.name = str(input.name) ?? rec.package;
  rec.title = str(input.title) ?? rec.package ?? rec.name ?? id;
  rec.summary = String(input.summary ?? '').slice(0, 1200);
  rec.tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 24)
    : [];

  rec.version = str(input.version);
  rec.versionSource = VERSION_SOURCES.includes(input.versionSource) ? input.versionSource : 'none';
  if (rec.version === null) rec.versionSource = 'none';
  rec.versionCheckedAt = str(input.versionCheckedAt);
  rec.latestRelease = input.latestRelease && typeof input.latestRelease === 'object'
    ? {
      tag: str(input.latestRelease.tag),
      publishedAt: str(input.latestRelease.publishedAt),
      url: str(input.latestRelease.url),
    }
    : null;

  rec.author = str(input.author);
  rec.repo = str(input.repo);
  rec.homepage = str(input.homepage);
  rec.license = str(input.license);
  rec.stars = num(input.stars);
  rec.forks = num(input.forks);
  rec.pushedAt = str(input.pushedAt);
  rec.metricsCheckedAt = str(input.metricsCheckedAt);

  rec.origin = str(input.origin);
  rec.peerRuntimePin = str(input.peerRuntimePin);
  rec.peerVerdict = str(input.peerVerdict);
  rec.peerNote = str(input.peerNote);
  rec.coexistenceWarning = str(input.coexistenceWarning);
  rec.notes = str(input.notes);
  rec.sha256Note = str(input.sha256Note);

  const inst = input.install ?? {};
  rec.install = {
    method: INSTALL_METHODS.includes(inst.method) ? inst.method : 'manual',
    spec: str(inst.spec),
    commands: Array.isArray(inst.commands) ? inst.commands.map((c) => String(c)).slice(0, 6) : [],
    url: str(inst.url),
    sha256: str(inst.sha256),
    bytes: num(inst.bytes),
    tarball: str(inst.tarball),
    dshVersion: str(inst.dshVersion),
    needsConfig: inst.needsConfig === true,
    usageNeedsConfig: inst.usageNeedsConfig === true,
    risky: inst.risky === true,
    riskyReasons: Array.isArray(inst.riskyReasons) ? inst.riskyReasons.map((r) => String(r)).slice(0, 8) : [],
  };

  // 安装方式的**自洽性**：声明了怎么装，就必须真的带得动安装所需的那几个字段。
  // 缺了就把这条降级成 manual —— 让闸门去拦，而不是让 pnpm 去报一个看不懂的错。
  if (rec.install.method === 'github' && !/^github:/.test(rec.install.spec ?? '')) rec.install.method = 'manual';
  if (rec.install.method === 'npm' && !looksLikeNpmName(rec.install.spec)) rec.install.method = 'manual';
  if (rec.install.method === 'tarball' && !rec.install.url) rec.install.method = 'manual';

  const src = input.source ?? {};
  rec.source = {
    // public-index  由公开索引采集而来（默认层）
    // collection    由插件集合仓库的 manifest.json 而来（tier=verified）
    // self          市场插件自己（版本以本仓库 plugins-src 的 package.json 为准）
    // manual        人工写进 catalog/overrides/*.json 的条目
    kind: ['public-index', 'collection', 'self', 'manual'].includes(src.kind) ? src.kind : 'public-index',
    url: str(src.url),
    firstSeenAt: str(src.firstSeenAt),
    lastSyncedAt: str(src.lastSyncedAt),
  };

  rec.review = input.review && typeof input.review === 'object' ? input.review : null;

  return rec;
}

/**
 * 记录的**稳定序列化**。
 *
 * ★ 这是「每日定时更新」能不产生噪音 diff 的关键。
 *   配置文件的字段顺序必须固定，否则 JSON.stringify 会随对象字面量顺序变化，
 *   于是 7000 个文件每天全都显示为「已修改」——真正的变更被淹掉，review 也就无从谈起。
 */
export function serializeRecord(rec) {
  const ordered = {
    schemaVersion: SCHEMA_VERSION,
    id: rec.id,
    slug: rec.slug,
    tier: rec.tier,
    package: rec.package,
    name: rec.name,
    title: rec.title,
    summary: rec.summary,
    tags: rec.tags,
    version: rec.version,
    versionSource: rec.versionSource,
    versionCheckedAt: rec.versionCheckedAt,
    latestRelease: rec.latestRelease,
    author: rec.author,
    repo: rec.repo,
    homepage: rec.homepage,
    license: rec.license,
    stars: rec.stars,
    forks: rec.forks,
    pushedAt: rec.pushedAt,
    metricsCheckedAt: rec.metricsCheckedAt,
    origin: rec.origin,
    peerRuntimePin: rec.peerRuntimePin,
    peerVerdict: rec.peerVerdict,
    peerNote: rec.peerNote,
    coexistenceWarning: rec.coexistenceWarning,
    notes: rec.notes,
    sha256Note: rec.sha256Note,
    install: rec.install,
    source: rec.source,
    review: rec.review,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * 比较两条记录里**除了时间戳之外**的内容是否一致。
 *
 * 用来决定「这次同步到底有没有真的改变什么」：只有内容变了才更新
 * lastSyncedAt / versionCheckedAt / metricsCheckedAt，否则保持原样。
 * 不这么做的话，每天一次定时任务会让整仓 diff 充满「只有时间变了」的假变更。
 */
export function contentEquals(a, b) {
  const strip = (r) => {
    if (!r) return null;
    const { versionCheckedAt, metricsCheckedAt, source, ...rest } = r;
    void versionCheckedAt;
    void metricsCheckedAt;
    return { ...rest, source: { ...source, lastSyncedAt: null } };
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** 从记录里派生索引条目（列表页只需要这些字段）。 */
export function indexEntry(rec) {
  return {
    slug: rec.slug,
    id: rec.id,
    tier: rec.tier,
    package: rec.package,
    name: rec.name,
    title: rec.title,
    summary: rec.summary,
    tags: rec.tags.slice(0, 12),
    version: rec.version,
    versionSource: rec.versionSource,
    stars: rec.stars,
    repo: rec.repo,
    homepage: rec.homepage,
    license: rec.license,
    author: rec.author,
    pushedAt: rec.pushedAt,
    installMethod: rec.install.method,
    installSpec: rec.install.spec,
    needsConfig: rec.install.needsConfig,
    usageNeedsConfig: rec.install.usageNeedsConfig,
    risky: rec.install.risky,
    peerVerdict: rec.peerVerdict,
    origin: rec.origin,
    reviewed: rec.review !== null,
    collection: rec.source.kind === 'collection',
  };
}

/**
 * 由全部记录派生索引。
 *
 * ★ **一条记录一个索引条目，不做去重。**
 *
 *   这里曾经按「包名」去重（本意是「同一个包只出现一次」），结果是 7493 个配置
 *   文件派生出 7127 条索引 —— 366 个插件在界面上**根本不会出现**，而文件还在仓库里。
 *   那是很难发现的一类丢失：数量对不上，但没有任何一条报错。
 *
 *   包名相同不等于同一个插件：公开索引里一个仓库一条记录，两个仓库完全可能声明
 *   同一个包名（fork、模板、改名残留）。**跨层去重是市场运行时 mergeEntries 的职责**
 *   （它按层级保留最高的那条，并把被合并条目的 star 数补过来），不该在这里预先把
 *   记录吃掉。这样也保住了一条硬不变量：配置文件数 == 索引条目数，CI 可以直接断言。
 */
export function buildIndex(records, { generatedAt, sourceIndex = null } = {}) {
  const rank = { verified: 0, reviewed: 1, community: 2 };

  const plugins = records
    .map(indexEntry)
    .sort((a, b) => {
      const d = (rank[a.tier] ?? 3) - (rank[b.tier] ?? 3);
      if (d !== 0) return d;
      return (b.stars ?? 0) - (a.stars ?? 0);
    });

  const counts = { total: plugins.length, verified: 0, reviewed: 0, community: 0 };
  for (const p of plugins) counts[p.tier] = (counts[p.tier] ?? 0) + 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt ?? null,
    sourceIndex,
    counts,
    note: '由 scripts/sync-catalog.mjs 从 catalog/plugins/*.json 派生，请勿手工编辑。一条配置文件对应一条记录，不做去重。',
    plugins,
  };
}

/** 读一个 JSON 文件；不存在或坏了都返回 null（目录是运行时产物，不该让进程崩）。 */
export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写：先写同目录临时文件再 rename，读者要么看到旧版要么看到新版。 */
export function writeJsonAtomic(target, value, { raw = null } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw ?? `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

/** 列出 catalog/plugins 下所有配置文件（返回绝对路径）。 */
export function listRecordFiles(repo) {
  const dir = path.join(repo, PLUGINS_DIR_REL);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.includes('.tmp-'))
    .map((f) => path.join(dir, f))
    .sort();
}
