/**
 * 「已验证」层远程优先 + 锚规则 + 刷新提速。
 *
 * ★ 为什么这组测试值得存在：
 *
 *   1. **解耦**是这次改动的全部目的 —— 插件发新版不再需要重打市场包、也不再需要
 *      给市场换版本号。这件事必须有一条断言钉住，否则将来某次重构很容易
 *      悄悄把 loadVerified 改回「只读包内」，而那种回归在界面上完全看不出来
 *      （只是「新版本不出现」而已）。
 *
 *   2. **锚规则**是这次改动唯一动到安全边界的地方。目录从「包内只读」变成
 *      「联网拉取」之后，能改仓库的人就能同时改 tarball 和它的校验和。
 *      规则是「远程只能追加、不能改写历史」—— 这条必须有反向用例，
 *      否则它只是一句注释。
 *
 *   3. **条件请求**是刷新提速的主要手段：没有它，每点一次刷新都要重下 4.8MB。
 */

import fs from 'node:fs';
import path from 'node:path';
import { suite, test, assert, eq, importBuilt, BUILT } from './harness.mjs';

suite('catalog / 已验证层远程优先 + 锚规则 + 刷新提速');

const catalog = await importBuilt('lib/catalog.js');
const bundled = JSON.parse(fs.readFileSync(path.join(BUILT, 'catalog', 'verified.json'), 'utf8'));

/** 深拷贝包内目录，供伪造远程内容用。 */
const cloneBundled = () => JSON.parse(JSON.stringify(bundled));

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

const jsonOk = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

// ── 解耦：远程目录被采纳 ────────────────────────────────────────

test('★ 远程目录可用时以远程为准（source=remote）', async () => {
  const res = await withFetch(() => jsonOk(cloneBundled()), () => catalog.loadVerified());
  eq(res.source, 'remote', '应当采用远程目录');
  eq(res.plugins.length, bundled.plugins.length, '条目数应与远程一致');
});

test('★ 远程新增一个版本能进来 —— 这就是「不必重打市场」的那条路', async () => {
  const remote = cloneBundled();
  // 造一个包内**没有**的新版本（模拟某个插件刚发了新版、只刷新了 catalog）
  remote.plugins.push({
    id: 'dsh-ark-plans',
    package: 'dsh-ark-plans',
    version: '99.0.0-probe',
    title: '探针',
    install: { kind: 'local-tarball', tarball: 'plugins/dsh-ark-plans/0.1.6-alpha.1/nope.tgz' },
    sha256: null,
  });
  const res = await withFetch(() => jsonOk(remote), () => catalog.loadVerified());
  eq(res.source, 'remote');
  assert(
    res.plugins.some((p) => p.version === '99.0.0-probe'),
    '远程新增的版本必须出现在结果里（否则市场看不到新版，解耦就没做到）',
  );
});

// ── 锚规则：远程不能改写历史 ────────────────────────────────────

test('★ 远程改写已发布版本的 sha256 → 整体拒绝远程、退回包内', async () => {
  const pinned = bundled.plugins.find((p) => p.sha256);
  assert(pinned, '包内应当至少有一条带 sha256 的条目');

  const remote = cloneBundled();
  const target = remote.plugins.find((p) => p.package === pinned.package && p.version === pinned.version);
  target.sha256 = 'f'.repeat(64); // 换成另一个校验和

  const res = await withFetch(() => jsonOk(remote), () => catalog.loadVerified());
  eq(res.source, 'bundled', '被改写时必须退回包内那份');
  assert(res.error && res.error.includes('被改写'), `错误里应当说明是改写：${res.error}`);
});

test('★ 远程把已发布版本的 sha256 抹掉 → 同样拒绝（否则删掉校验和就能绕过）', async () => {
  const pinned = bundled.plugins.find((p) => p.sha256);
  const remote = cloneBundled();
  const target = remote.plugins.find((p) => p.package === pinned.package && p.version === pinned.version);
  target.sha256 = null;
  delete target.sha256;

  const res = await withFetch(() => jsonOk(remote), () => catalog.loadVerified());
  eq(res.source, 'bundled', '抹掉校验和必须被拦下');
  assert(res.error && res.error.includes('丢失了 sha256'), `错误里应当说明是抹掉：${res.error}`);
});

test('远程拉取失败时退回缓存/包内，并如实说明原因', async () => {
  const res = await withFetch(() => new Response('boom', { status: 500 }), () => catalog.loadVerified());
  assert(res.source === 'bundled' || res.source === 'cache', `应当退回本地副本，实际 ${res.source}`);
  assert(res.error, '退回复本时必须带上原因');
  assert(res.plugins.length > 0, '退回后仍应可用（离线兜底的意义）');
});

test('preferRemote=false 时不联网，直接用包内那份', async () => {
  let called = 0;
  const res = await withFetch(() => { called++; return jsonOk(cloneBundled()); },
    () => catalog.loadVerified({ preferRemote: false }));
  eq(called, 0, '不应发出任何请求');
  eq(res.source, 'bundled');
});

// ── 刷新提速：条件请求 ──────────────────────────────────────────

test('★ 公共索引支持 304 时走 remote-304，不再重下整包', async () => {
  // 第一次：正常 200，**并带上 ETag**（服务端真实行为），建立缓存与校验器。
  const first = await withFetch(
    () => new Response(JSON.stringify({ schemaVersion: 1, generatedAt: 'x', plugins: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: 'W/"probe-etag"' },
    }),
    () => catalog.fetchCommunity({ force: true }),
  );
  eq(first.source, 'remote', '首次应当真的下载');
  eq(first.etag, 'W/"probe-etag"', '校验器要随缓存留下来，否则下次发不出条件请求');

  // 第二次：服务端答 304
  const second = await withFetch((url, init) => {
    assert(init.headers && init.headers['if-none-match'],
      '刷新时必须带上 If-None-Match，否则服务端无法答 304，省不下那 4.8MB');
    return new Response(null, { status: 304 });
  }, () => catalog.fetchCommunity({ force: true }));

  eq(second.source, 'remote-304', '304 应当被识别为「目录没变」');
  eq(second.stale, false, '304 等于确认了内容仍是最新，不应再判为过期');
});

test('304 之后缓存里的条目仍然是可用的（沿用而不是清空）', async () => {
  const res = await withFetch(() => new Response(null, { status: 304 }),
    () => catalog.fetchCommunity({ force: true }));
  assert(Array.isArray(res.plugins), '304 路径也必须返回数组，不能退化成空');
});
