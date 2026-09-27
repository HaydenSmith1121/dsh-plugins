/**
 * dsh-plugins-market —— 服务器半：跨版本适配层
 *
 * ── 这一层存在的理由 ──────────────────────────────────────────
 *
 * dsh 迭代很快（0.1.5-rc.x → 0.1.6-alpha.x → 0.1.7-rc.x，插件 API 一直在动）。
 * 本插件的态度是：**能跑就继续跑，不认识的版本降级而不是罢工**。
 *
 * 具体做法有三条，按重要性排序：
 *
 *   1. **不写 peerDependencies**（见 util.js 顶部说明）—— dsh 0.1.7 起会在导入前
 *      核对 peer 里 `@deepseek-ai/dsh*` 与运行时版本是否一致。写了 peer 就等于
 *      把自己钉在一个版本上；不写 peer，同一个包才能同时装在 0.1.5 / 0.1.6 / 0.1.7 上。
 *   2. **只用各版本都在的 API**：服务器半只用 `ctx.effect` 与
 *      `webServer.register({ kind, path, handler })`；客户端半只用
 *      `slots.inject` / `slots.register` 与 baseline 的 `react`。
 *   3. **能力探测而不是版本判断**：真正决定「能不能干活」的是 `webServer.register`
 *      在不在、`ctx.effect` 在不在，而不是版本号字符串。版本号只用来在界面上
 *      如实告诉用户「你跑在哪个 harness 上、这个版本有没有被实测过」。
 *
 * 所以本文件里的结论**永远不参与放行/拦截**：未被实测的版本照样全功能可用，
 * 只是界面上会标一句「未实测」。
 */

import path from 'node:path';
import { pluginDir, readJsonSafe } from './util.js';

// ─────────────────────────────────────────────────────────────
// 版本号比较（只需要「排序 + 相等」，不实现 range 语法）
// ─────────────────────────────────────────────────────────────

/** `1.2.3-rc.1` → { major, minor, patch, pre: [] }；不可解析返回 null */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;  // 正式版 > 预发布版
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字标识符 < 字母标识符
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1；任一侧不可解析返回 null */
export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) return null;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return comparePre(va.pre, vb.pre);
}

// ─────────────────────────────────────────────────────────────
// 兼容矩阵
// ─────────────────────────────────────────────────────────────

export function readCompatibility() {
  const doc = readJsonSafe(path.join(pluginDir(), 'compatibility.json'));
  return doc && typeof doc === 'object' ? doc : { runtimes: [] };
}

/**
 * 「谁离得更近」用的顺序值。
 *
 * ★ 不能拿 `Math.abs(compareVersions(a, b))` 当距离：那个函数返回的是**符号**
 *   （-1 / 0 / 1），取绝对值之后「差一个预发布号」和「差一个 minor」都变成 1，
 *   排序结果就退化成数组顺序。实测症状：在 0.1.6-alpha.2 上，面板会告诉你
 *   「最接近的实测版本是 0.1.7-rc.2」—— 一个比它还新的版本。
 *
 *   这里给同一 major.minor 线内一个可比较的顺序值：patch 为主，
 *   预发布号的最后一段数字为辅（rc.2 → 2，alpha.10 → 10），正式版排在预发布之后。
 */
function versionOrdinal(v) {
  const last = v.pre.length > 0 ? Number(v.pre[v.pre.length - 1]) : NaN;
  const pre = v.pre.length === 0 ? 1000 : (Number.isFinite(last) ? Math.min(last, 999) : 0);
  return v.patch * 10_000 + pre;
}

/**
 * 把当前 harness 版本对到矩阵里的结论。
 *
 * ★ 返回值里的 `verified` **只影响界面上的一句话**，不影响任何功能。
 *   没有实测过的版本（比如将来某天的 0.1.8）照样能用：本插件用的都是稳定 API，
 *   真正会出问题的场景是 API 被删掉 —— 那由能力探测当场发现，而不是靠版本号预判。
 */
export function matchRuntime(compat, version) {
  const runtimes = Array.isArray(compat?.runtimes) ? compat.runtimes : [];
  if (!version) {
    return { verified: false, reason: 'unknown-version', entry: null, nearest: null };
  }
  const exact = runtimes.find((r) => r.dshVersion === version);
  if (exact) return { verified: exact.status === 'supported', reason: 'listed', entry: exact, nearest: exact };

  const v = parseVersion(version);
  if (!v) return { verified: false, reason: 'unparsable', entry: null, nearest: null };

  // 同一 major.minor 线里最接近的一条 —— 用来给出「最接近的实测结论是哪个版本」
  const sameMinor = runtimes
    .map((r) => ({ runtime: r, parsed: parseVersion(r.dshVersion) }))
    .filter((x) => x.parsed && x.parsed.major === v.major && x.parsed.minor === v.minor)
    .sort((a, b) => Math.abs(versionOrdinal(a.parsed) - versionOrdinal(v))
      - Math.abs(versionOrdinal(b.parsed) - versionOrdinal(v)));

  if (sameMinor.length === 0) {
    return { verified: false, reason: 'unlisted', entry: null, nearest: null };
  }

  const nearest = sameMinor[0];
  // 同一条 patch 线（0.1.6-alpha.2 ↔ 0.1.6-alpha.1）比只是同一个 minor 更近
  const sameLine = nearest.parsed.patch === v.patch;
  return {
    verified: false,
    reason: sameLine ? 'same-line' : 'same-minor',
    entry: null,
    nearest: nearest.runtime,
  };
}

// ─────────────────────────────────────────────────────────────
// 能力探测
// ─────────────────────────────────────────────────────────────

/** 只探测，不改动任何东西；任何一项拿不到都不算错误 */
export function probeHost(ctx) {
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };

  const webServer = safe(() => (typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer)) ?? null;
  const names = ['webServer', 'pluginPackages', 'profileContext', 'storage', 'sessions', 'jobs', 'subagents'];

  return {
    effect: typeof ctx?.effect === 'function',
    get: typeof ctx?.get === 'function',
    on: typeof ctx?.on === 'function',
    webServer: {
      present: Boolean(webServer),
      register: typeof webServer?.register === 'function',
      registerUpgrade: typeof webServer?.registerUpgrade === 'function',
      registerFallback: typeof webServer?.registerFallback === 'function',
      match: typeof webServer?.match === 'function',
    },
    services: Object.fromEntries(
      names.map((n) => [n, Boolean(safe(() => (typeof ctx?.get === 'function' ? ctx.get(n) : undefined)))]),
    ),
  };
}

/**
 * 探测结果 → 一句人话。
 *
 * 这是「适配不同版本」在界面上的落点：用户一眼能看到自己这套 harness
 * 上哪些能力在、哪些不在，而不是遇到一个白屏去猜。
 */
export function describeCapabilities(caps) {
  const notes = [];
  if (!caps.webServer.present) notes.push('没有 webServer 服务：面板的数据接口无法注册。');
  else if (!caps.webServer.register) notes.push('webServer 上没有 register()：这个版本的 HTTP 路由接口形状不同。');
  if (!caps.effect) notes.push('ctx.effect 不可用：路由注册无法随插件卸载一起回收。');
  return notes;
}
