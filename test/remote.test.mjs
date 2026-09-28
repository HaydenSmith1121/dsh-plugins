/**
 * 索引的**远程路径**。
 *
 * ★ 这一条路径在开发机上永远走不到 —— 仓库检出里就有 catalog/index.json，
 *   所以 `loadIndex()` 直接读本地文件（source: checkout）。而**装到别人机器上时
 *   走的恰恰是远程那条**：包内没有完整索引，只能从 raw.githubusercontent 拉，
 *   拉不到就用包内快照。真实用户碰到的是这条，开发机上测的是那条。
 *
 *   所以这里起一个本地 HTTP 服务器扮演远程，把四种情况都跑一遍：
 *   正常下载、条件请求拿到 304、服务器 5xx、返回的形状不对。
 *   全部只读，不联网。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, eq, ok } from './harness.mjs';

/** 一个可控的假「远程索引」服务 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const sampleIndex = {
  schemaVersion: 2,
  generatedAt: '2026-09-27T00:00:00.000Z',
  counts: { total: 2 },
  sources: [],
  plugins: [
    { id: 'a/one', description: 'one', stars: 10, sources: ['remote-test'] },
    { id: 'b/two', description: 'two', stars: 5, sources: ['remote-test'] },
  ],
};

const body = JSON.stringify(sampleIndex);
const ETAG = '"v1"';

/** 每个用例用一个独立的 DSH_HOME，避免互相看到对方的缓存 */
function isolateHome(name) {
  const home = path.join(os.tmpdir(), `dsh-remote-test-${name}-${process.pid}`);
  fs.rmSync(home, { recursive: true, force: true });
  process.env.DSH_HOME = home;
  return home;
}

/**
 * ★ 环境变量必须在**每个用例结束时**清掉，不能只在文件末尾清一次。
 *
 *   测试文件里的顶层语句在 `import` 时就执行了，而用例体是之后才跑的 ——
 *   所以写在文件末尾的 `delete process.env...` 会在所有用例**开始之前**执行，
 *   等于没清。实测症状：它把后面的 server.test.mjs 一起带偏，
 *   那两个断言「本地检出」的用例变成了去连一个已经关掉的端口。
 */
async function withRemote(port, fn) {
  process.env.DSH_PLUGINS_MARKET_INDEX_URL = `http://127.0.0.1:${port}/index.json`;
  try {
    return await fn();
  } finally {
    delete process.env.DSH_PLUGINS_MARKET_INDEX_URL;
  }
}

// ★ 必须在导入被测模块**之前**设好：catalog.js 在模块作用域就会读它
isolateHome('boot');

const { loadIndex, cacheInfo, clearCache } = await import('../src/server/catalog.js');

test('远程路径：包内没有完整索引时才走远程（这里用环境变量强制走远程）', async () => {
  isolateHome('happy');
  let hits = 0;
  const { server, port } = await startServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json', etag: ETAG });
    res.end(body);
  });
  try {
    await withRemote(port, async () => {
      const loaded = await loadIndex();
      eq(loaded.source, 'remote', '正常情况下应当从远程拿到');
      eq(loaded.error, null);
      eq(loaded.index.plugins.length, 2);
      eq(loaded.etag, ETAG, 'ETag 要记下来，下次才能走条件请求');
      eq(hits, 1);
      ok(cacheInfo().present, '拉到的内容必须落盘缓存 —— 否则每次开面板都要重下 3.8MB');
    });
  } finally {
    server.close();
  }
});

test('远程路径：第二次走条件请求，304 时不再读 body', async () => {
  const seen = [];
  const { server, port } = await startServer((req, res) => {
    seen.push(req.headers['if-none-match'] ?? null);
    if (req.headers['if-none-match'] === ETAG) {
      res.writeHead(304, { etag: ETAG });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: ETAG });
    res.end(body);
  });
  try {
    await withRemote(port, async () => {
      const loaded = await loadIndex({ force: true });
      eq(seen[0], ETAG, '必须把上次的 ETag 带上');
      eq(loaded.source, 'remote-304', '304 是「确认没更新」，不是「没拿到」');
      eq(loaded.error, null, '304 不是错误');
      eq(loaded.index.plugins.length, 2, '内容沿用缓存');
      ok(cacheInfo().present);
    });
  } finally {
    server.close();
  }
});

test('远程路径：服务器 5xx 时退回缓存，并如实报错', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  try {
    await withRemote(port, async () => {
      const loaded = await loadIndex({ force: true });
      eq(loaded.source, 'cache', '有缓存就必须用缓存，而不是让面板空着');
      ok(loaded.error && loaded.error.includes('500'), `错误要如实回报，实际：${loaded.error}`);
      eq(loaded.index.plugins.length, 2, '缓存里的数据照样能用');
    });
  } finally {
    server.close();
  }
});

test('远程路径：连不上时也退回缓存（面板不许白屏）', async () => {
  // 一个已经关掉的端口
  const { server, port } = await startServer((req, res) => res.end(''));
  await new Promise((r) => server.close(r));
  await withRemote(port, async () => {
    const loaded = await loadIndex({ force: true });
    eq(loaded.source, 'cache');
    ok(loaded.error && loaded.error.length > 0, '要说明为什么用了缓存');
    eq(loaded.index.plugins.length, 2);
  });
});

test('远程路径：返回的形状不对时，退回上一份可用数据而不是渲染半个文档', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', etag: '"v2"' });
    res.end(JSON.stringify({ schemaVersion: 2, plugins: 'not-an-array' }));
  });
  try {
    await withRemote(port, async () => {
      const loaded = await loadIndex({ force: true });
      eq(loaded.source, 'cache');
      ok(loaded.error && loaded.error.includes('形状'), `错误要指出是形状问题，实际：${loaded.error}`);
      eq(loaded.index.plugins.length, 2, '仍然是上一份完好的数据');
    });
  } finally {
    server.close();
  }
});

test('远程路径：缓存被清掉且远程不可达时，用包内快照兜底', async () => {
  isolateHome('cold');
  clearCache();
  eq(cacheInfo().present, false, '缓存确实被清掉了');
  const { server, port } = await startServer((req, res) => res.end(''));
  await new Promise((r) => server.close(r));
  await withRemote(port, async () => {
    const loaded = await loadIndex({ force: true });
    eq(loaded.source, 'bundled', '冷启动 + 没网 = 用打进包里的快照');
    ok(loaded.index && loaded.index.plugins.length > 0, '包内快照必须真的有内容');
    const full = JSON.parse(fs.readFileSync(new URL('../catalog/index.json', import.meta.url), 'utf8'));
    eq(loaded.index.plugins.length, full.plugins.length, '新设备离线安装也应包含完整目录，不得只剩 400 条');
    ok(loaded.error, '要如实说明这是兜底');
  });
});
