/**
 * dsh-plugins-market —— 服务器半入口
 *
 * cordis 插件三件套：`{ name, inject, apply }`。只 inject `webServer` 一个服务 ——
 * 声明的服务没到位会让整棵插件树出问题，所以这里刻意保持最小。
 *
 * RPC 走一条同源 HTTP 路由 `POST /dsh-plugins-market/api`：
 *   请求  { method: string, args: object }
 *   响应  { ok: true, result, tookMs } | { ok: false, error, detail? }
 *
 * ★ 只有三个方法。
 *
 *   旧版（插件市场）在这条路由后面挂了几十个方法：安装、卸载、修 profile、
 *   装前体检、回滚、进度轮询、中止、日志…… 这一版全部删掉了 —— 装插件已经是
 *   官方桌面版自带的能力（设置 → 插件 → 添加插件），本面板只做**搜集与展示**，
 *   所以服务器半只剩下「给你一份索引」「告诉你我跑在哪儿」「去确认一次有没有更新」。
 *
 *   · index    列表数据（列式压缩 + gzip）
 *   · status   面板版本 / harness 版本与能力 / 缓存状态
 *   · refresh  忽略 TTL 去确认一次（条件请求，通常只拿到 304）
 *
 * ★ 不写盘、不执行命令、不改 profile。这条约束让「面板打不开某个功能」这类
 *   故障不可能波及 harness 本身。
 */

import path from 'node:path';
import zlib from 'node:zlib';
import { buildPayload, cacheInfo, clearCache, loadIndex, REPO_HOMEPAGE, REPO_INDEX_URL } from './catalog.js';
import { describeCapabilities, matchRuntime, probeHost, readCompatibility } from './compat.js';
import { detectHarness, pluginDir, readJsonSafe, resolveDataDir, short } from './util.js';

export const name = 'dsh-plugins-market';
export const inject = ['webServer'];

const ROUTE = '/dsh-plugins-market/api';
const MAX_BODY = 64 * 1024; // 本插件的请求体只有几十字节
const GZIP_MIN_BYTES = 1024;

function panelManifest() {
  return readJsonSafe(path.join(pluginDir(), 'package.json')) ?? {};
}

function createContext() {
  const harness = detectHarness(process.env);
  const compat = readCompatibility();
  return {
    harness,
    compat,
    match: matchRuntime(compat, harness.version),
    /** 上一次交给前端的索引指纹，用于判断「刷新之后到底变没变」 */
    lastFingerprint: null,
  };
}

function fingerprint(index) {
  if (!index) return null;
  return `${index.generatedAt ?? ''}|${index.plugins?.length ?? 0}`;
}

function createDispatcher(ctx) {
  return async function dispatch(method, args = {}) {
    switch (method) {
      /**
       * 列表数据。
       *
       * 一次性把整份索引交给前端（列式 + gzip），前端才能做到「输入即搜」——
       * 每次按键都回服务器问一趟虽然也能实现，但那把「零延迟」这件事交给了网络，
       * 而这里的数据量（几千到一两万条）完全放得进浏览器内存。
       */
      case 'index': {
        const loaded = await loadIndex({ force: Boolean(args.refresh) });
        ctx.lastFingerprint = fingerprint(loaded.index);
        return buildPayload(loaded.index, {
          loaded,
          extraMeta: {
            harnessVersion: ctx.harness.version,
            harnessChannel: ctx.harness.channel,
          },
        });
      }

      /**
       * 面板自述：版本、跑在哪、缓存怎么样、这个 harness 版本有没有被实测过。
       *
       * ★ 刻意**不**在这里载入索引：状态查询必须永远是瞬时的，
       *   哪怕此刻网络不可达。数据的新鲜度在 `index.meta` 里。
       */
      case 'status': {
        const manifest = panelManifest();
        const notes = describeCapabilities(ctx.caps ?? {});
        return {
          panel: {
            name: manifest.name ?? name,
            version: manifest.version ?? null,
            dir: pluginDir(),
            dataDir: resolveDataDir(process.env),
            repoHomepage: REPO_HOMEPAGE,
            indexUrl: REPO_INDEX_URL,
          },
          harness: {
            version: ctx.harness.version,
            channel: ctx.harness.channel,
            name: ctx.harness.name,
            dir: ctx.harness.dir,
            evidence: ctx.harness.evidence,
            node: ctx.harness.node,
            platform: ctx.harness.platform,
            arch: ctx.harness.arch,
            electron: ctx.harness.electron,
            // 兼容矩阵里的结论：只影响界面上的一句话，不影响任何功能
            verified: ctx.match.verified,
            matchReason: ctx.match.reason,
            nearestVerified: ctx.match.nearest?.dshVersion ?? null,
            verifiedOn: ctx.match.entry?.verifiedAt ?? ctx.match.nearest?.verifiedAt ?? null,
            supportedRuntimes: (ctx.compat.runtimes ?? []).map((r) => ({
              dshVersion: r.dshVersion,
              channel: r.channel ?? null,
              status: r.status,
              verifiedAt: r.verifiedAt ?? null,
            })),
          },
          caps: ctx.caps ?? null,
          capsNotes: notes,
          cache: cacheInfo(),
        };
      }

      /**
       * 去确认一次有没有更新。
       *
       * TTL 内的缓存不会被刷新流程绕过（那正是 TTL 的意义）；`force` 才忽略 TTL。
       * 无论哪条路，走的都是条件请求 —— 没更新时远端只回一个 304，不传 body。
       */
      case 'refresh': {
        const before = ctx.lastFingerprint;
        const loaded = await loadIndex({ force: args.force !== false });
        const after = fingerprint(loaded.index);
        ctx.lastFingerprint = after;
        return {
          changed: before !== null && before !== after,
          firstLoad: before === null,
          meta: buildPayload(loaded.index, { loaded }).meta,
        };
      }

      /** 丢掉磁盘缓存（排查「为什么我看到的是旧数据」时用） */
      case 'dropCache':
        return { ok: clearCache(), cache: cacheInfo() };

      default:
        throw new Error(`未知方法：${method}`);
    }
  };
}

export function apply(ctx) {
  let appCtx;
  try {
    appCtx = createContext();
  } catch (err) {
    // 上下文构建失败也不能把整棵树带下去：降级成一个只报错的实例
    appCtx = null;
    process.stderr.write(`dsh-plugins-market: 上下文初始化失败：${err?.message ?? err}\n`);
  }
  if (appCtx) appCtx.caps = probeHost(ctx);

  const dispatch = appCtx
    ? createDispatcher(appCtx)
    : async () => {
      throw new Error('dsh-plugins-market 上下文初始化失败，面板数据不可用。请看 harness 启动日志。');
    };

  const register = () => {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      // 不抛错：这个版本上少一条 HTTP 路由，harness 本身照常运行
      process.stderr.write(
        'dsh-plugins-market: 当前 harness 上没有可用的 webServer.register()，面板数据接口未注册。\n',
      );
      return () => {};
    }
    try {
      return webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: makeHandler(dispatch),
      });
    } catch (err) {
      process.stderr.write(`dsh-plugins-market: 注册 ${ROUTE} 失败：${err?.message ?? err}\n`);
      return () => {};
    }
  };

  // ctx.effect 在所有目标版本里都在；万一不在，也要把接口挂上（只是无法随卸载回收）
  if (typeof ctx.effect === 'function') ctx.effect(register, `dsh-plugins-market: ${ROUTE}`);
  else register();
}

function makeHandler(dispatch) {
  return async (req, res) => {
    const send = (code, body) => {
      const text = JSON.stringify(body);
      const accept = String(req.headers?.['accept-encoding'] ?? '');
      const wantGzip = /\bgzip\b/.test(accept) && Buffer.byteLength(text) > GZIP_MIN_BYTES;
      if (wantGzip) {
        const buf = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 6 });
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'gzip',
          'content-length': buf.length,
          'cache-control': 'no-store',
        });
        res.end(buf);
        return;
      }
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      });
      res.end(text);
    };

    if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
    try {
      const payload = await readJsonBody(req);
      const started = Date.now();
      const result = await dispatch(String(payload.method ?? ''), payload.args ?? {});
      return send(200, { ok: true, result, tookMs: Date.now() - started });
    } catch (err) {
      return send(200, {
        ok: false,
        error: short(err?.message ?? err, 800),
        detail: err?.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : null,
      });
    }
  };
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
