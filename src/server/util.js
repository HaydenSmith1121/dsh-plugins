/**
 * dsh-plugins-market —— 服务器半：基础设施层
 *
 * 设计约束（重要，也是本插件能跨 dsh 版本活下来的原因）：
 *   服务器半**只依赖 Node 内置模块**，不引入任何第三方依赖，也不声明
 *   `dependencies` / `peerDependencies`。
 *
 *   两个理由：
 *   1. 装插件走 pnpm。每多一个依赖就多一分解析失败 / ERR_PNPM_IGNORED_BUILDS /
 *      离线不可用的风险，而这个插件本身只是一个只读的搜集面板，没有理由冒这个险。
 *   2. dsh 0.1.7 起会在导入插件前核对 `peerDependencies` 里 `@deepseek-ai/dsh*`
 *      与运行时版本是否一致。写了 peer 就把自己钉死在某一个 dsh 版本上；
 *      一个 peer 都不写，才能同时活在 0.1.5 / 0.1.6 / 0.1.7 上。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────
// 路径
// ─────────────────────────────────────────────────────────────

/** dsh 自己的 DSH_HOME 规则：非空 $DSH_HOME > ~/.dsh */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.dsh');
}

/**
 * 本插件的可写数据目录（索引缓存），不污染 profile 目录。
 * 只放缓存 —— 删掉它不会有任何损失，下次打开面板会重新拉。
 */
export function resolveDataDir(env = process.env) {
  return path.join(resolveDshHome(env), 'storages', 'dsh-plugins-market');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 本插件的包根目录。
 *
 * ★ 不能写成「相对本文件往上 N 层」的固定层数：源码树里服务器半在 `src/server/`，
 *   而历史上打包后的布局是平铺的 `lib/`。改为**往上找带 dsh.bundle 声明的
 *   package.json**，两种布局都对。
 */
export function pluginDir() {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const manifest = readJsonSafe(path.join(dir, 'package.json'));
    if (manifest && (manifest.dsh?.bundle?.patch || manifest.name === 'dsh-plugins-market')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..');
}

// ─────────────────────────────────────────────────────────────
// 读写
// ─────────────────────────────────────────────────────────────

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON 被下一次启动读到 */
export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 运行时探测：这是哪个 dsh、哪个通道
// ─────────────────────────────────────────────────────────────

const DSH_PACKAGE_RE = /^@deepseek-ai\/dsh(?:-|$)/;

/**
 * 从某个目录往上找第一个「属于 dsh 自己的」package.json。
 *
 * ★ 为什么要往上找而不是写死路径：dsh 有三种装法，路径完全不同 ——
 *   · npm 全局：`<prefix>/node_modules/@deepseek-ai/dsh/`
 *   · 官方桌面版：`<install>/resources/app.asar/dsh/`（Electron 的 fs 补丁让
 *     asar 内的路径可以像普通文件一样读）
 *   · 开发检出：仓库根直接跑
 *   从**入口脚本**往上走，三种都能落到同一个地方。
 */
function manifestUpFrom(startDir, { maxDepth = 8 } = {}) {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i += 1) {
    const manifest = readJsonSafe(path.join(dir, 'package.json'));
    if (manifest && typeof manifest.name === 'string' && DSH_PACKAGE_RE.test(manifest.name)) {
      return { manifest, dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 探测当前运行时的 dsh 版本与通道。
 *
 * ★ 探测失败**不是错误**。本插件的功能不依赖 dsh 版本（它只读一份 GitHub 采集结果），
 *   版本信息只用于在界面上如实告知「你跑在哪个 harness 上」。所以这里宁可返回
 *   `version: null`，也绝不抛错、绝不因为版本不认识就禁用功能。
 *
 * @returns {{version:string|null,name:string|null,dir:string|null,channel:'desktop'|'cli'|'unknown',
 *            node:string,platform:string,arch:string,electron:string|null,evidence:string}}
 */
export function detectHarness(env = process.env) {
  const candidates = [];

  // ① 入口脚本往上找 —— 三种装法里最可靠的一条
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry !== '') {
    candidates.push({ from: path.dirname(entry), evidence: 'entry' });
  }

  // ② 桌面版：可执行文件旁边的 resources/app.asar/dsh
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    candidates.push({
      from: path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh'),
      evidence: 'desktop-resources',
    });
  }

  // ③ npm 全局（Windows 与 POSIX 的常见位置）
  const globalRoots = [
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules') : null,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
  for (const root of globalRoots) {
    candidates.push({ from: path.join(root, '@deepseek-ai', 'dsh'), evidence: 'npm-global' });
  }

  for (const c of candidates) {
    const hit = manifestUpFrom(c.from);
    if (hit) {
      return {
        version: typeof hit.manifest.version === 'string' ? hit.manifest.version : null,
        name: typeof hit.manifest.name === 'string' ? hit.manifest.name : null,
        dir: hit.dir,
        channel: /app\.asar/i.test(hit.dir) || Boolean(process.versions.electron) ? 'desktop' : 'cli',
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? null,
        evidence: c.evidence,
      };
    }
  }

  return {
    version: null,
    name: null,
    dir: null,
    channel: process.versions.electron ? 'desktop' : 'unknown',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? null,
    evidence: 'none',
  };
}

// ─────────────────────────────────────────────────────────────
// 杂项
// ─────────────────────────────────────────────────────────────

export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 截断长文本（列表页不需要把整段描述传过去） */
export function short(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
