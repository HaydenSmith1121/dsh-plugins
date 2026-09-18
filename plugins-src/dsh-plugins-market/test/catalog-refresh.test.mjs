/**
 * 目录层：**一个插件一个配置文件** + 远程优先 + 条件请求。
 *
 * ★ 为什么这组测试值得存在：
 *
 *   1. **「安装 = 读那个插件自己的配置文件，再按它写的 install.method 去装」**
 *      是这一版全部改动的目的。这件事必须有断言钉住 —— 否则将来某次重构很容易
 *      悄悄把安装路径改回「按索引里的字段拼一条命令」，而那种回归在界面上
 *      完全看不出来：装是装上了，只是装的东西不再由配置说了算。
 *
 *   2. **读不到配置就不装**。索引里的字段只够展示：拿它猜一个安装方法是错的，
 *      而且错得很安静。所以「配置文件 404」必须是一条**明确的失败**，
 *      而不是静默退回索引。
 *
 *   3. **条件请求**（ETag / 304）是刷新成本的关键：目录是 7000+ 条的静态文件，
 *      没有 304 时每次刷新都要重下几百 KB。
 *
 *   4. **回退链**（远程 → 缓存 → 包内兜底）决定「没网时市场还能不能用」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { suite, test, assert, eq, importBuilt, BUILT } from './harness.mjs';

suite('catalog / 单条配置文件 + 远程优先 + 条件请求');

const catalog = await importBuilt('lib/catalog.js');
const bundledIndex = JSON.parse(fs.readFileSync(path.join(BUILT, 'catalog', 'index.json'), 'utf8'));
const bundledSelf = JSON.parse(
  fs.readFileSync(path.join(BUILT, 'catalog', 'plugins', 'dsh-plugins-market.json'), 'utf8'),
);

/** 深拷贝包内目录，供伪造远程内容用。 */
const cloneIndex = () => JSON.parse(JSON.stringify(bundledIndex));

/**
 * 在伪造的 fetch 下跑一段逻辑。
 *
 * @param {(url: string, init: object) => Response} responder - 伪造的响应。
 * @param {() => Promise<unknown>} fn - 被测逻辑。
 */
async function withFetch(responder, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => responder(String(url), init ?? {});
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const jsonOk = (payload, headers = {}) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
});

// ─────────────────────────────────────────────────────────────
// 索引
// ─────────────────────────────────────────────────────────────

test('preferRemote=false 时只用包内兜底目录，且不联网', async () => {
  let called = 0;
  const res = await withFetch(() => { called += 1; return jsonOk({}); },
    () => catalog.loadCatalogIndex({ preferRemote: false }));
  eq(called, 0, 'preferRemote:false 不该发任何网络请求');
  assert(res.available, `包内目录应当可用：${res.error}`);
  eq(res.source, 'bundled');
  assert(res.entries.length > 0, '包内兜底目录不能为空');
});

test('远程索引可用时采纳远程，并落盘缓存', async () => {
  const remote = cloneIndex();
  remote.counts = { total: 4242 };
  remote.plugins = [
    ...remote.plugins,
    { slug: 'acme__dsh-remote-only', id: 'acme/dsh-remote-only', package: 'dsh-remote-only', title: '远程新插件', summary: 'x', tags: [], version: '9.9.9', stars: 7, installMethod: 'github', installSpec: 'github:acme/dsh-remote-only' },
  ];

  const res = await withFetch(() => jsonOk(remote, { etag: 'W/"abc"' }),
    () => catalog.loadCatalogIndex({ force: true }));

  eq(res.source, 'remote');
  eq(res.counts.total, 4242);
  const added = res.entries.find((e) => e.slug === 'acme__dsh-remote-only');
  assert(added, '远程新增的插件应当出现 —— 这正是「插件发新版不必重打市场包」的直接体现');
  eq(added.version, '9.9.9');
});

test('服务端答 304 时沿用缓存，不重下正文', async () => {
  // 先建立一份缓存
  const remote = cloneIndex();
  await withFetch(() => jsonOk(remote, { etag: 'W/"etag-1"' }), () => catalog.loadCatalogIndex({ force: true }));

  let sawConditional = false;
  const res = await withFetch((url, init) => {
    if (init.headers?.['if-none-match'] === 'W/"etag-1"') {
      sawConditional = true;
      return new Response(null, { status: 304 });
    }
    return jsonOk(remote, { etag: 'W/"etag-1"' });
  }, () => catalog.loadCatalogIndex({ force: true }));

  assert(sawConditional, '第二次请求应当带上 If-None-Match（否则每次刷新都要重下整个目录）');
  eq(res.source, 'remote-304');
  assert(res.entries.length > 0, '304 之后应当仍然有可用的条目（来自缓存）');
});

test('拉取失败时退回缓存，并如实报出错误', async () => {
  const res = await withFetch(() => { throw new Error('boom'); },
    () => catalog.loadCatalogIndex({ force: true }));
  assert(res.available, '拉取失败也应当有一份可用的目录（缓存或包内）');
  assert(res.error, '必须如实报出「这次没拉到远程」——用户据此判断版本号新不新');
  assert(['cache', 'bundled'].includes(res.source), `来源应当是缓存或包内，实际 ${res.source}`);
});

// ─────────────────────────────────────────────────────────────
// 单条配置文件（安装路径的核心）
// ─────────────────────────────────────────────────────────────

const selfEntry = catalog.normalizeEntry(
  bundledIndex.plugins.find((p) => p.package === 'dsh-plugins-market'),
  'verified',
);

test('loadPluginConfig() 远程命中，并落盘缓存', async () => {
  const remoteConfig = { ...bundledSelf, summary: '来自远程的那一份' };
  const res = await withFetch(() => jsonOk(remoteConfig),
    () => catalog.loadPluginConfig(selfEntry));
  eq(res.source, 'remote');
  eq(res.config.summary, '来自远程的那一份', '应当用远程那一份，而不是包内快照');
});

test('loadPluginConfig() 网络失败时退回缓存', async () => {
  const res = await withFetch(() => { throw new Error('offline'); },
    () => catalog.loadPluginConfig(selfEntry));
  eq(res.source, 'cache', '刚才远程那份应当已经被缓存下来');
  assert(res.error, '回退时要如实说明原因');
});

test('★ 远程 404 且没有缓存时如实返回「读不到」，绝不编一份出来', async () => {
  const ghost = catalog.normalizeEntry(
    { slug: 'nobody__dsh-ghost', id: 'nobody/dsh-ghost', install: { method: 'github', spec: 'github:nobody/dsh-ghost' } },
    'community',
  );
  const res = await withFetch(() => new Response('not found', { status: 404 }),
    () => catalog.loadPluginConfig(ghost));
  eq(res.config, null, '读不到就是读不到 —— 调用方要靠 null 来决定「不装」');
  assert(res.error, '必须给出可读的原因');
});

test('★ entryFromConfig() 让配置文件压过索引（安装方法以配置为准）', () => {
  const indexEntry = catalog.normalizeEntry(
    { slug: 'acme__dsh-x', id: 'acme/dsh-x', title: '索引里的标题', install: { method: 'github', spec: 'github:acme/dsh-x' } },
    'community',
  );
  const config = {
    slug: 'acme__dsh-x',
    id: 'acme/dsh-x',
    
    package: 'dsh-x',
    title: '配置里的标题',
    summary: '配置里的简介',
    tags: ['a'],
    version: '1.2.3',
    install: { method: 'tarball', url: 'https://example.invalid/x.tgz', sha256: 'a'.repeat(64), tarball: 'plugins/dsh-x/0.1.6-alpha.1/dsh-x-1.2.3.tgz' },
  };
  const merged = catalog.entryFromConfig(config, indexEntry);
  eq(merged.title, '配置里的标题', '展示字段以配置为准');
  eq(merged.tier, undefined, '配置里也不再有 tier —— 信任分级已在 0.5.0 移除');
  eq(merged.install.method, 'tarball', '★ 安装方法必须来自配置文件');
  eq(merged.install.url, 'https://example.invalid/x.tgz');
  eq(merged.sha256, 'a'.repeat(64), 'tarball 的校验和要能传到闸门与安装器');
  eq(merged.slug, 'acme__dsh-x', 'slug 是定位配置文件的键，不能丢');
});

test('配置文件缺字段时，展示信息回退到索引（但不回退安装方法）', () => {
  const indexEntry = catalog.normalizeEntry(
    { slug: 'acme__dsh-y', id: 'acme/dsh-y', title: '索引标题', summary: '索引简介', tags: ['t'], install: { method: 'github', spec: 'github:acme/dsh-y' } },
    'community',
  );
  const merged = catalog.entryFromConfig({ slug: 'acme__dsh-y', id: 'acme/dsh-y', install: { method: 'manual' } }, indexEntry);
  eq(merged.title, '索引标题', '配置没给标题时退回索引的');
  eq(merged.install.method, 'manual', '★ 但安装方法必须是配置里那个 —— 哪怕是 manual');
});

// ─────────────────────────────────────────────────────────────
// 归一化
// ─────────────────────────────────────────────────────────────

test('normalizeEntry() 同时认新字段（repo / method / url）与旧字段（upstream / kind / tarball）', () => {
  const modern = catalog.normalizeEntry({ id: 'a/b', repo: 'https://github.com/a/b', install: { method: 'github', spec: 'github:a/b' } }, 'community');
  eq(modern.upstream, 'https://github.com/a/b');
  eq(modern.install.method, 'github');

  const legacy = catalog.normalizeEntry({ id: 'c/d', upstream: 'https://github.com/c/d', install: { kind: 'local-tarball', tarball: 'plugins/c/0.1.6-alpha.1/c-1.0.0.tgz' } }, 'verified');
  eq(legacy.install.method, 'tarball', '旧 kind 应当映射成新 method');
  eq(legacy.install.kind, 'local-tarball', 'kind 仍需保留，供还没换过来的调用方用');
  eq(legacy.install.tarball, 'plugins/c/0.1.6-alpha.1/c-1.0.0.tgz');
});

test('mergeEntries() 已被删除：目录不再跨层合并（0.5.0）', () => {
  // 这条钉住的是**删除本身**。以前同一个插件会同时出现在 verified 层与公共索引里，
  // 运行时必须按层级保留最高的一条并补上 star 数 —— 那套逻辑（mergeEntries /
  // mergedCounts / dedupeKey）随信任分级一起删掉了。
  //
  // 留着这条断言是有价值的：如果哪天有人把 mergeEntries 加回来，
  // 说明「一个插件可能出现在多处」这个前提又回来了，而它与
  // 「一条配置 = 一条记录」的硬不变量是冲突的 —— 那时应该先想清楚。
  eq(typeof catalog.mergeEntries, 'undefined', 'mergeEntries 不该再存在');
  eq(typeof catalog.mergedCounts, 'undefined', 'mergedCounts 不该再存在');
  eq(typeof catalog.reviewStatusOf, 'undefined', 'reviewStatusOf 不该再存在');
});

test('★ 只有**真包名**才算「同一个插件」—— 仓库名不能冒充包名', () => {
  // 公开索引按**仓库**一条记录，`name` 是仓库名，跟 npm 包名毫无关系：
  // 几十个互不相干的仓库都叫 dsh-plugins / dsh-plugin。
  // 早先 normalizeEntry 写的是 `package: p.package ?? p.name`，于是这些不同的插件
  // 被算成了同一个 —— 目录 7496 条只剩 6542 条，954 条在界面上永远不出现，
  // 而列表看起来完全正常，只是数量对不上。
  //
  // ★ 0.5.0 去掉了跨层合并之后，这条不变量**更硬**了：现在一条配置就是一条记录，
  //   连「合并」这个动作都不存在，所以数量的唯一来源是配置文件数 —— CI 直接断言。
  //   但这条判据仍然要钉住：`package: null` 才是「没有真包名」的如实写法。
  const a = catalog.normalizeEntry({ slug: 'alice__dsh-plugins', id: 'alice/dsh-plugins', name: 'dsh-plugins', title: 'A', summary: 's', tags: [] });
  const b = catalog.normalizeEntry({ slug: 'bob__dsh-plugins', id: 'bob/dsh-plugins', name: 'dsh-plugins', title: 'B', summary: 's', tags: [] });

  eq(a.package, null, '没有真包名时 package 必须是 null，而不是拿仓库名顶上');
  eq(b.package, null);
  eq(a.name, 'dsh-plugins', '仓库名仍要留着（展示与检索用）');
  eq(a.title, 'A');
});

test('★ 索引条数 == 配置文件数（不等同于「去重后」）', async () => {
  const idx = await catalog.loadCatalogIndex({ preferRemote: false });
  const { readdirSync } = await import('node:fs');
  const path = await import('node:path');
  const { BUILT } = await import('./harness.mjs');
  const files = readdirSync(path.join(BUILT, 'catalog', 'plugins')).filter((f) => f.endsWith('.json'));
  eq(
    idx.entries.length,
    files.length,
    `包内兜底目录 ${files.length} 个配置文件，索引却列了 ${idx.entries.length} 条 —— `
    + '两者必须一一对应（0.5.0 起目录不再做任何跨层去重）。',
  );
});
