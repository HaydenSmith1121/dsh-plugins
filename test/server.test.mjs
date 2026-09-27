/**
 * 服务器半的端到端：用假的 ctx / webServer 把插件挂起来，然后真的发 HTTP 请求。
 *
 * ★ 为什么值得这么测：宿主与插件之间只有两个接触点 ——
 *   `webServer.register({ kind, path, handler })` 与 `ctx.effect(fn)`。
 *   它们跨版本变过形，而变形之后的症状是「面板上一片空白」，
 *   在开发机上永远复现不出来。这里用一个**最小的假宿主**把契约钉住。
 */

import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, ok, includes } from './harness.mjs';
import { apply, inject, name } from '../src/server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 最小假宿主：只实现本插件用到的那两个接触点 */
function fakeHost() {
  const routes = [];
  const cleanups = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => cleanups.push(route.path);
    },
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      cleanups.push(dispose);
    },
    get(service) {
      return service === 'webServer' ? webServer : undefined;
    },
  };
  return { ctx, routes, cleanups };
}

/** 假请求：手动喂 body（handler 内部用 req.on('data'/'end') 读） */
function fakeReq(body, { headers = {} } = {}) {
  const listeners = {};
  return {
    method: 'POST',
    headers,
    setEncoding() {},
    destroy() {},
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      return this;
    },
    emit(event, arg) {
      for (const fn of listeners[event] ?? []) fn(arg);
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** 假响应：收集状态码与 body */
function fakeRes() {
  return {
    code: null,
    headers: null,
    chunks: [],
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(buf) {
      if (buf !== undefined) this.chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
    },
    get text() {
      const raw = Buffer.concat(this.chunks);
      return this.headers?.['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    },
    get json() {
      return JSON.parse(this.text);
    },
  };
}

async function call(routes, payload, { headers = {} } = {}) {
  const req = fakeReq(payload, { headers });
  const res = fakeRes();
  const done = routes[0].handler(req, res);
  if (req.body !== undefined) req.emit('data', req.body);
  req.emit('end');
  await done;
  return res;
}

function mount() {
  const host = fakeHost();
  apply(host.ctx);
  return host;
}

test('插件导出三件套，name 与包名一致', () => {
  eq(name, 'dsh-plugins-market');
  eq(typeof apply, 'function');
  eq(inject.length, 1);
  eq(inject[0], 'webServer', '只声明一个服务，避免拖垮整棵插件树');
});

test('apply：通过 ctx.effect 注册一条 prefix 路由（可随卸载回收）', () => {
  const host = mount();
  eq(host.routes.length, 1, '只注册一条路由');
  eq(host.routes[0].kind, 'prefix');
  eq(host.routes[0].path, '/dsh-plugins-market/api');
  eq(typeof host.routes[0].handler, 'function');
  eq(host.cleanups.length, 1, '注册动作必须包在 ctx.effect 里');
});

test('apply：宿主没有 webServer.register 时降级而不是抛错', () => {
  // 这是「适配不同 harness 版本」的底线：某个版本上少了这个 API，
  // harness 本身必须照常启动，只是面板没有数据接口。
  let threw = false;
  try {
    apply({
      effect(fn) { fn(); },
      get() { return undefined; },
    });
  } catch {
    threw = true;
  }
  eq(threw, false, '缺 API 不能把插件的 apply 弄崩');
});

test('apply：register 抛错也不影响 harness 启动', () => {
  let threw = false;
  try {
    apply({
      effect(fn) { fn(); },
      get() { return { register() { throw new Error('route conflict'); } }; },
    });
  } catch {
    threw = true;
  }
  eq(threw, false);
});

test('RPC：非 POST 返回 405', async () => {
  const host = mount();
  const req = fakeReq(undefined);
  req.method = 'GET';
  const res = fakeRes();
  await host.routes[0].handler(req, res);
  eq(res.code, 405);
});

test('RPC：未知方法如实报错，不静默成功', async () => {
  const host = mount();
  const res = await call(host.routes, { method: 'install', args: { id: 'a/b' } });
  eq(res.code, 200);
  eq(res.json.ok, false);
  includes(res.json.error, '未知方法', '旧版的安装方法必须已经不存在了');
});

test('RPC：请求体不是 JSON 时给出可读错误', async () => {
  const host = mount();
  const req = fakeReq(undefined);
  req.body = '{oops';
  const res = fakeRes();
  const done = host.routes[0].handler(req, res);
  req.emit('data', req.body);
  req.emit('end');
  await done;
  eq(res.json.ok, false);
  includes(res.json.error, 'JSON');
});

test('RPC index：返回列式 payload（仓库检出时走本地文件，不发网络请求）', async () => {
  const host = mount();
  const res = await call(host.routes, { method: 'index' });
  eq(res.code, 200);
  const body = res.json;
  eq(body.ok, true);
  const result = body.result;
  ok(Array.isArray(result.rows) && result.rows.length > 1000, `索引里应当有上千条记录，实际 ${result.rows.length}`);
  ok(Array.isArray(result.cols) && result.cols[0] === 'id');
  eq(result.meta.source, 'checkout', `本仓库里有 catalog/index.json，应当走本地检出，实际 ${result.meta.source}`);
  eq(result.meta.error, null);
  eq(result.rows[0].length, result.cols.length, '每行的列数必须与列名表一致');
  ok(typeof result.meta.repoHomepage === 'string');
});

test('RPC index：声明接受 gzip 时真的压缩，且解出来是同一份数据', async () => {
  const host = mount();
  const gz = await call(host.routes, { method: 'index' }, { headers: { 'accept-encoding': 'gzip, deflate' } });
  eq(gz.headers['content-encoding'], 'gzip');
  const plain = await call(host.routes, { method: 'index' });
  eq(plain.headers['content-encoding'], undefined, '没声明 gzip 时不能压缩');
  const a = gz.json.result;
  const b = plain.json.result;
  eq(a.total, b.total);
  eq(JSON.stringify(a.rows), JSON.stringify(b.rows));
});

test('RPC status：不载入索引也能立刻返回，且带上适配信息', async () => {
  const host = mount();
  const res = await call(host.routes, { method: 'status' });
  const s = res.json.result;
  eq(s.panel.name, 'dsh-plugins-market');
  ok(typeof s.panel.version === 'string');
  ok(s.harness, '要有 harness 探测结果');
  ok(s.caps && typeof s.caps.webServer.register === 'boolean');
  ok(Array.isArray(s.harness.supportedRuntimes) && s.harness.supportedRuntimes.length >= 3);
  ok(typeof s.cache.file === 'string');
  // 面板自述里不该出现任何「安装 / 卸载 / 体检」的入口
  const text = JSON.stringify(s);
  ok(!/install/.test(text), 'status 的字段名里不该再有 install 相关的东西');
});

test('RPC dropCache：幂等，重复调用都返回 ok', async () => {
  const host = mount();
  const a = await call(host.routes, { method: 'dropCache' });
  const b = await call(host.routes, { method: 'dropCache' });
  eq(a.json.result.ok, true);
  eq(b.json.result.ok, true);
});

test('RPC refresh：本地检出下不发网络请求，如实回报来源', async () => {
  const host = mount();
  const res = await call(host.routes, { method: 'refresh', args: { force: true } });
  const r = res.json.result;
  eq(typeof r.changed, 'boolean');
  eq(r.meta.source, 'checkout');
});

test('仓库根就是插件根：pluginDir() 能定位到带 dsh.bundle 的 package.json', async () => {
  const { pluginDir } = await import('../src/server/util.js');
  eq(path.resolve(pluginDir()), ROOT);
});
