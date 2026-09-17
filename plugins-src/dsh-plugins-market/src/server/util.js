/**
 * dsh-plugins-market —— 服务器半：基础设施层
 *
 * 设计约束（重要）：
 *   本插件的服务器半**只依赖 Node 内置模块**，不引入任何第三方依赖。
 *   理由：profile 安装走 pnpm，每多一个依赖就多一分 ERR_PNPM_IGNORED_BUILDS /
 *   解析失败 / 离线不可用的风险，而本插件存在的意义正是「别把 harness 装坏」。
 *   因此 semver 判定、tar 读取、YAML 局部改写都在这里自己实现，并有单测覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────
// 版本语义（semver 子集，含 prerelease 规则）
// ─────────────────────────────────────────────────────────────

/** 解析 `1.2.3-rc.1+build` → {major,minor,patch,pre:[...],raw}；不可解析返回 null */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    raw: input.trim(),
  };
}

function comparePre(a, b) {
  // 无 prerelease 的版本 > 有 prerelease 的版本
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      // 数字标识符 < 字母标识符
      return xn ? -1 : 1;
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

/** 拆成 AND 组的 OR 列表：`a b || c` → [[a,b],[c]] */
function splitRange(range) {
  return String(range)
    .split('||')
    .map((part) => part.trim().split(/\s+/).filter(Boolean));
}

/** 把单个比较器展开成一组 {op, version}；无法识别返回 null */
function expandComparator(token) {
  const t = token.trim();
  if (t === '' || t === '*' || t === 'x' || t === 'X') return [];
  // hyphen range 由调用方处理
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/.exec(t);
  if (!m) return null;
  const op = m[1] ?? '=';
  const ver = m[2];
  const v = parseVersion(ver);
  if (!v) return null;

  if (op === '=' || op === '') return [{ op: '=', version: v }];
  if (op === '>=' || op === '>' || op === '<=' || op === '<') return [{ op, version: v }];
  if (op === '^') {
    // ^1.2.3 → >=1.2.3 <2.0.0 ; ^0.2.3 → >=0.2.3 <0.3.0 ; ^0.0.3 → >=0.0.3 <0.0.4
    let upper;
    if (v.major > 0) upper = { major: v.major + 1, minor: 0, patch: 0, pre: [], raw: '' };
    else if (v.minor > 0) upper = { major: 0, minor: v.minor + 1, patch: 0, pre: [], raw: '' };
    else upper = { major: 0, minor: 0, patch: v.patch + 1, pre: [], raw: '' };
    // ^X.Y.Z-pre 的上界不是裸版本，否则 0.1.6-alpha.1 会被 ^0.1.6-alpha.1 拒绝
    const out = [{ op: '>=', version: v }, { op: '<', version: upper }];
    if (v.pre.length > 0) out[1].prereleaseOk = v;
    return out;
  }
  if (op === '~') {
    const upper = { major: v.major, minor: v.minor + 1, patch: 0, pre: [], raw: '' };
    return [{ op: '>=', version: v }, { op: '<', version: upper }];
  }
  return null;
}

function satisfiesComparator(v, c) {
  const cmp = compareVersions(v, c.version);
  if (cmp === null) return false;
  switch (c.op) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    default: return false;
  }
}

/**
 * 判定 version 是否满足 range。
 *
 * prerelease 规则（与 npm 一致，且是本仓库兼容性结论的关键）：
 *   预发布版本只有在「同一 [major,minor,patch] 元组」的比较器里也带预发布时才算匹配。
 *   例：`0.1.6-alpha.1` 满足 `>=0.1.5-0 <0.2.0-0`（两端都带 -0，落在上界同一元组… 见实现），
 *       但不满足 `^0.1.5-rc.1`（上界裸 0.2.0，且 0.1.5-rc.1 与 0.1.6-alpha.1 不同元组）。
 * 无法解析的 range 返回 null（调用方必须当作「无法判定」，而不是「不满足」）。
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return null;
  if (typeof range !== 'string' || range.trim() === '') return null;

  const groups = splitRange(range);
  let parsedAny = false;

  for (const group of groups) {
    // hyphen range: `1.2.3 - 2.3.4`
    const hyphen = group.join(' ').match(/^(\S+)\s+-\s+(\S+)$/);
    let comparators;
    if (hyphen) {
      const lo = parseVersion(hyphen[1]);
      const hi = parseVersion(hyphen[2]);
      if (!lo || !hi) return null;
      comparators = [{ op: '>=', version: lo }, { op: '<=', version: hi }];
    } else {
      comparators = [];
      let ok = true;
      for (const token of group) {
        const expanded = expandComparator(token);
        if (expanded === null) { ok = false; break; }
        comparators.push(...expanded);
      }
      if (!ok) return null;
    }
    parsedAny = true;

    const prereleaseOk = comparators.some(
      (c) =>
        c.version.pre.length > 0 &&
        c.version.major === v.major &&
        c.version.minor === v.minor &&
        c.version.patch === v.patch,
    );
    if (v.pre.length > 0 && !prereleaseOk) continue; // 本组不接受预发布
    if (comparators.every((c) => satisfiesComparator(v, c))) return true;
  }
  return parsedAny ? false : null;
}

// ─────────────────────────────────────────────────────────────
// 路径与环境
// ─────────────────────────────────────────────────────────────

/** dsh 自己的 DSH_HOME 规则：非空 $DSH_HOME > ~/.dsh */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.dsh');
}

export function resolveProfilesDir(env = process.env) {
  return path.join(resolveDshHome(env), 'profiles');
}

export function resolveProfileDir(profile, env = process.env) {
  return path.join(resolveProfilesDir(env), String(profile));
}

/** 本插件的可写数据目录（缓存 / 备份 / 日志），不污染 profile 目录 */
export function resolveDataDir(env = process.env) {
  return path.join(resolveDshHome(env), 'storages', 'dsh-plugins-market');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 定位 dsh 的安装目录（用于取「安装锚点」里 @deepseek-ai/* 的真实版本）。
 * 顺序与仓库 preflight.mjs 一致：Windows 全局 npm 目录优先。
 */
export function findDshInstall(env = process.env) {
  const candidates = [];
  const npmGlobalWin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh');
  candidates.push(npmGlobalWin);
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  // 从 PATH 上的 dsh 启动器反推
  const launcher = findInPath(['dsh.cmd', 'dsh.ps1', 'dsh.bat', 'dsh'], env);
  if (launcher) {
    const shimDir = path.dirname(launcher);
    candidates.push(path.join(shimDir, 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(path.join(path.dirname(shimDir), 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh');

  for (const dir of candidates) {
    const manifest = readJsonSafe(path.join(dir, 'package.json'));
    if (manifest?.name === '@deepseek-ai/dsh') {
      return { dir, manifest, launcher: launcher ?? null, prefix: shimPrefix(dir) };
    }
  }
  return { dir: null, manifest: null, launcher: launcher ?? null, prefix: launcher ? path.dirname(launcher) : null };
}

function shimPrefix(installDir) {
  // <prefix>/node_modules/@deepseek-ai/dsh → <prefix>
  const parts = installDir.split(path.sep);
  const idx = parts.lastIndexOf('node_modules');
  if (idx <= 0) return null;
  return parts.slice(0, idx).join(path.sep) || path.sep;
}

/**
 * 「怎么调 dsh」的唯一答案。
 *
 * ★ 优先直接跑 `node <dshDir>/lib/bin.js`，而不是 PATH 上的 dsh 薄壳。
 *
 *   两个理由，都是踩过的坑：
 *   1. Windows 上跑 `.cmd` / `.ps1` 薄壳必须开 shell，而开了 shell 之后
 *      含空格或特殊字符的路径就得自己加引号 —— 一旦漏了，命令会**静默跑成
 *      另一个东西**，报错还很难看懂。
 *   2. 薄壳依赖 PATH 被正确继承。harness 从 GUI / 快捷方式启动时，PATH 常常
 *      和终端里不一样（少一个 npm 全局目录就找不到 dsh）。直接用 harness
 *      自己正在用的那个 node 执行 bin.js，这一整类问题都不存在。
 *
 * 找不到安装目录时才退回启动器（此时只能开 shell）。
 */
export function dshCommand(env = process.env) {
  const install = findDshInstall(env);
  const binJs = install.dir ? path.join(install.dir, 'lib', 'bin.js') : null;
  if (binJs && fs.existsSync(binJs)) {
    return { command: process.execPath, prefixArgs: [binJs], shell: false, resolved: 'bin.js', dir: install.dir, launcher: install.launcher };
  }
  const launcher = install.launcher ?? 'dsh';
  return { command: launcher, prefixArgs: [], shell: process.platform === 'win32', resolved: 'launcher', dir: install.dir, launcher };
}

export function findInPath(names, env = process.env) {
  const list = Array.isArray(names) ? names : [names];
  const pathValue = env.PATH ?? env.Path ?? '';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of list) {
      const tries = process.platform === 'win32' && !path.extname(name)
        ? exts.map((e) => path.join(dir, name + e))
        : [path.join(dir, name)];
      for (const candidate of tries) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* 继续 */ }
      }
    }
  }
  return null;
}

/** 探测运行环境：node / dsh / pnpm。只读，不修改任何东西。 */
export function detectEnvironment(env = process.env) {
  const dsh = findDshInstall(env);
  const pnpm = detectPnpm(dsh.prefix, env);

  return {
    node: {
      version: process.versions.node,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch,
    },
    dsh: {
      version: dsh.manifest?.version ?? null,
      dir: dsh.dir,
      launcher: dsh.launcher,
      prefix: dsh.prefix,
      installed: Boolean(dsh.manifest),
    },
    pnpm: pnpm,
    home: resolveDshHome(env),
  };
}

function detectPnpm(dshPrefix, env) {
  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat', 'pnpm'] : ['pnpm'];
  const nearDsh = dshPrefix ? names.map((n) => path.join(dshPrefix, n)).find((p) => fs.existsSync(p)) ?? null : null;
  const onPath = findInPath(names, env);
  const chosen = nearDsh ?? onPath;
  let version = null;
  if (chosen) {
    try {
      // ★ 不开 shell（Windows 上开 shell 会触发 DEP0190，且参数会被拼进命令行，
      //   路径里有空格就有风险）。execFileSync 在 Windows 上本来就能直接跑 .cmd。
      const out = execFileSync(chosen, ['--version'], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      });
      version = /(\d+\.\d+\.\d+[^\s]*)/.exec(out)?.[1] ?? null;
    } catch { /* 保留 null */ }
  }
  return {
    path: chosen,
    version,
    installed: Boolean(chosen),
    nearDsh,
    onPath,
    samePrefixAsDsh: Boolean(chosen && dshPrefix && path.resolve(chosen).startsWith(path.resolve(dshPrefix))),
  };
}

// ─────────────────────────────────────────────────────────────
// tar.gz 只读访问（不依赖 tar 命令，不落盘解包）
// ─────────────────────────────────────────────────────────────

/**
 * 从 .tgz 里按条目名读取内容（只解 gzip + 顺序扫 tar 头）。
 * 用途：安装前**静态**检查候选包，不去执行它的任何代码。
 * @returns {Map<string, Buffer>|null} 匹配到的条目（键为 tar 内路径）
 */
export function readTarGzEntries(tgzPath, wanted) {
  let raw;
  try {
    raw = zlib.gunzipSync(fs.readFileSync(tgzPath));
  } catch {
    return null;
  }
  const want = new Set(wanted);
  const found = new Map();
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const sizeOctal = readCString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeflag = String.fromCharCode(header[156] || 48);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;

    if (Number.isFinite(size) && size >= 0) {
      if ((typeflag === '0' || typeflag === '\0') && want.has(fullName)) {
        found.set(fullName, raw.subarray(dataStart, dataStart + size));
        if (found.size === want.size) break;
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
    } else {
      break;
    }
  }
  return found;
}

function readCString(buf, start, len) {
  let end = start;
  const limit = Math.min(start + len, buf.length);
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('utf8', start, end);
}

/** 列出 tgz 内所有文件条目（用于「包完整性」判定） */
export function listTarGzEntries(tgzPath) {
  let raw;
  try {
    raw = zlib.gunzipSync(fs.readFileSync(tgzPath));
  } catch {
    return null;
  }
  const out = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const sizeOctal = readCString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeflag = String.fromCharCode(header[156] || 48);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (!Number.isFinite(size) || size < 0) break;
    if (typeflag === '0' || typeflag === '\0') out.push({ name: fullName, size });
    offset = offset + 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// YAML 局部处理（只覆盖本插件真正需要的两种形状）
// ─────────────────────────────────────────────────────────────

/**
 * 从 cordis.patch.yml 里抽出 **insert 行**的 id / name（用于安装前的 id 冲突检测）。
 *
 * 这里刻意**不**实现完整 YAML —— 我们只需要 insert 子项里的两个标量，而且
 * 解析不出来时调用方会降级为「无法判定」，不会误伤。
 *
 * ★ 但「只抽 insert 子项」这一条必须做对。踩过的坑：dsh-ark-plans 的 patch 长这样 ——
 *
 *     - insert:
 *         - id: ark-plans
 *           name: dsh-ark-plans
 *     - id: llm-pi-ai            ← 这是 patch 的**定位目标**，不是插入行
 *       config:
 *         providers:
 *           - id: ark-agent-plan
 *             models:
 *               - id: ark-code-latest   ← 这是模型数据里的 id
 *
 *   只按「缩进不小于 insert」来判定，会把 `llm-pi-ai` 以及几十个模型 id 全当成插入行，
 *   于是闸门对一个仓库自带的已验证插件报出假的「装配行 id 冲突」。
 *
 * 正确做法：记住 insert 的**直接子项缩进**，只收该缩进上的 `- id:`；
 * 一旦缩进回落到 insert 自身所在层（或更浅），整个 insert 块就结束了。
 */
export function extractPatchRows(text) {
  if (typeof text !== 'string') return null;
  const rows = [];
  const lines = text.split(/\r?\n/);
  let inInsert = false;
  let insertIndent = -1;
  let childIndent = -1; // insert 直接子项的缩进；-1 表示还没见到第一个子项
  let current = null;

  const flush = () => {
    if (current) rows.push(current);
    current = null;
  };

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (/^-?\s*insert\s*:/.test(body)) {
      flush();
      inInsert = true;
      insertIndent = indent;
      childIndent = -1;
      continue;
    }
    if (!inInsert) continue;

    // insert 块结束：缩进回落到 insert 自身所在层或更浅
    if (indent <= insertIndent) {
      flush();
      inInsert = false;
      continue;
    }
    // 已经定位到子项层之后，出现更浅的项 → 该 insert 的列表也结束了
    if (childIndent !== -1 && indent < childIndent) {
      flush();
      inInsert = false;
      continue;
    }

    const idMatch = /^-\s*id\s*:\s*(.+)$/.exec(body);
    if (idMatch) {
      if (childIndent === -1) childIndent = indent;
      if (indent !== childIndent) continue; // 更深层的 id 属于嵌套数据，忽略
      flush();
      current = { id: stripYamlScalar(idMatch[1]) };
      continue;
    }
    // 子项的字段比 `- id:` 再缩进一层；只取该子项自己的第一个 name/disabled，
    // 避免把子项内部嵌套结构里的同名字段读成它的。
    if (!current || indent <= childIndent) continue;
    const nameMatch = /^name\s*:\s*(.+)$/.exec(body);
    if (nameMatch) {
      if (current.name === undefined) current.name = stripYamlScalar(nameMatch[1]);
      continue;
    }
    const disabledMatch = /^disabled\s*:\s*(.+)$/.exec(body);
    if (disabledMatch && current.disabled === undefined) {
      current.disabled = /^true$/i.test(stripYamlScalar(disabledMatch[1]));
    }
  }
  flush();
  return rows.length > 0 ? rows : null;
}

function stripYamlScalar(value) {
  return String(value).trim().replace(/^['"]|['"]$/g, '');
}

/** 读取 pnpm-workspace.yaml 里 allowBuilds 的键 → 布尔值 */
export function readAllowBuilds(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let blockIndent = -1;
  const out = {};
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (/^allowBuilds\s*:/.test(body)) {
      inBlock = true;
      blockIndent = indent;
      continue;
    }
    if (!inBlock) continue;
    if (indent <= blockIndent) { inBlock = false; continue; }
    const m = /^(['"]?)([^'":]+)\1\s*:\s*(.*)$/.exec(body);
    if (!m) continue;
    const key = m[2].trim();
    const value = m[3].trim();
    // pnpm 留下的占位符原文是 "set this to true or false"（带 "or false"）。
    // 只匹配 "set this to (true|false)" 是抓不到的 —— 那会让「还有未决定的构建脚本」
    // 这个信号静默丢失，而它正是 ERR_PNPM_IGNORED_BUILDS 的前兆。
    if (/^set this to true or false$/i.test(value)) out[key] = 'placeholder';
    else if (/^true$/i.test(value)) out[key] = true;
    else if (/^false$/i.test(value)) out[key] = false;
    else out[key] = value;
  }
  return inBlock || Object.keys(out).length > 0 ? out : null;
}

/**
 * YAML 里的键要不要加引号。
 *
 * YAML 规定 `@` 与 `` ` `` 是**保留指示符**，不能作为普通标量的首字符 ——
 * 所以 `@google/genai: false` 是非法 YAML，必须写成 `'@google/genai': false`。
 * 而 `@google/genai` 恰恰是 allowBuilds 里最常见的键之一，漏了引号会让整个
 * pnpm-workspace.yaml 解析失败，进而让所有安装操作报出与真实原因无关的错。
 */
function yamlKey(key) {
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(key) ? key : `'${key}'`;
}

/**
 * 把 allowBuilds 的条目合并进 pnpm-workspace.yaml 文本。
 * 只做「补键 / 替换占位符」，不动文件的其它任何一行 —— 尤其是
 * packages / nodeLinker / autoInstallPeers，这三个键丢了会改变整个安装语义。
 * @returns {{text:string, changed:boolean, added:string[]}}
 */
export function mergeAllowBuilds(text, entries) {
  const original = typeof text === 'string' ? text : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === '' ? [] : original.split(/\r?\n/);
  const added = [];
  let changed = false;

  const wanted = Object.entries(entries ?? {});
  if (wanted.length === 0) return { text: original, changed: false, added };

  // 找到 allowBuilds 块的范围
  let blockStart = -1;
  let blockIndent = 0;
  let blockEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i]) || lines[i].trim() === '') continue;
    if (/^\s*allowBuilds\s*:/.test(lines[i])) {
      blockStart = i;
      blockIndent = lines[i].length - lines[i].trimStart().length;
      for (let j = i + 1; j < lines.length; j++) {
        const li = lines[j];
        if (li.trim() === '' || /^\s*#/.test(li)) continue;
        const ind = li.length - li.trimStart().length;
        if (ind <= blockIndent) { blockEnd = j; break; }
      }
      break;
    }
  }

  for (const [key, value] of wanted) {
    const literal = `${value}`;
    const quoted = yamlKey(key);

    if (blockStart === -1) {
      added.push(key);
      continue; // 交给下面的整体追加处理
    }

    let hit = -1;
    for (let j = blockStart + 1; j < blockEnd; j++) {
      const m = /^(\s*)(['"]?)([^'":]+)\2\s*:/.exec(lines[j]);
      if (m && m[3].trim() === key) { hit = j; break; }
    }
    if (hit === -1) {
      const indent = ' '.repeat(blockIndent + 2);
      lines.splice(blockEnd, 0, `${indent}${quoted}: ${literal}`);
      blockEnd++;
      added.push(key);
      changed = true;
    } else if (/set this to true or false/i.test(lines[hit])) {
      lines[hit] = `${/^(\s*)/.exec(lines[hit])[1]}${quoted}: ${literal}`;
      added.push(key);
      changed = true;
    }
  }

  if (blockStart === -1 && added.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('allowBuilds:');
    for (const key of added) {
      lines.push(`  ${yamlKey(key)}: ${entries[key]}`);
    }
    changed = true;
  }

  return { text: lines.join(eol), changed, added };
}

/** 校验 pnpm-workspace.yaml 的三个关键不变量是否还在 */
export function checkWorkspaceInvariants(text) {
  const t = typeof text === 'string' ? text : '';
  return {
    packages: /^\s*packages\s*:/m.test(t),
    nodeLinkerHoisted: /^\s*nodeLinker\s*:\s*hoisted\s*$/m.test(t),
    autoInstallPeersFalse: /^\s*autoInstallPeers\s*:\s*false\s*$/m.test(t),
  };
}

// ─────────────────────────────────────────────────────────────
// 杂项
// ─────────────────────────────────────────────────────────────

/**
 * 本插件的包根目录。
 *
 * ★ 不能写成「相对本文件往上两层」：源码树里服务器半在 `src/server/*.js`（往上两层
 *   正好是包根），但打包后它们被平铺到 `lib/*.js`（往上两层会跑到**包的父目录**）。
 *   这个差异很隐蔽 —— 代码能跑，只是所有包内资源（catalog/*.json、package.json）
 *   全部读不到，表现为「目录是空的、版本号是 ?」。
 *
 * 所以改成往上找那个带 dsh.bundle 声明的 package.json，两种布局都对。
 */
export function pluginDir() {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 5; i++) {
    const manifest = readJsonSafe(path.join(dir, 'package.json'));
    if (manifest && (manifest.dsh?.bundle?.patch || manifest.name === 'dsh-plugins-market')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：按打包后的 lib/ 布局推一层
  return path.resolve(start, '..');
}

export function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function spawnCapture(command, args, options = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? String(res.error.message ?? res.error) : null,
    get failed() { return res.status !== 0 || Boolean(res.error); },
  };
}

// ─────────────────────────────────────────────────────────────
// 异步进程（安装任务专用）
// ─────────────────────────────────────────────────────────────
//
// ★ 为什么安装**不能**用上面的 spawnCapture（spawnSync）
//
//   spawnSync 会阻塞 Node 的事件循环 —— 也就是说，在 pnpm 跑完之前，
//   这个进程既不能处理下一个 HTTP 请求，也**不能把自己的进度报出去**。
//   用户看到的就是「点了安装，整个页面卡住，没有进度、没有耗时、连中止按钮
//   都按不动」，因为处理中止请求的那条路径同样被堵死了。
//
//   所以安装路径一律走下面这套 spawn 实现：事件循环保持可响应，
//   输出以流的方式回到任务对象里，中止才真正有意义（能去 kill 子进程）。
//
//   上半部分（目录、闸门、profile 只读探测）继续用 spawnSync 是可以接受的：
//   那里要么很快（ms 级），要么本来就该在返回结果前跑完。

function toResult(res, { stdout = '', stderr = '', error = null, timedOut = false, canceled = false } = {}) {
  return {
    status: res?.code ?? null,
    signal: res?.signal ?? null,
    stdout,
    stderr,
    error,
    timedOut,
    canceled,
    get failed() { return timedOut || canceled || res?.code !== 0 || Boolean(error); },
  };
}

/** 只在需要「旧式结果对象」时用（同步路径的兼容层） */
export function asResult(proc) {
  return toResult({ code: proc.status, signal: proc.signal }, {
    stdout: proc.stdout, stderr: proc.stderr, error: proc.error, timedOut: proc.timedOut, canceled: proc.canceled,
  });
}

/**
 * 跑一个子进程，**不阻塞事件循环**。
 *
 * 返回值是「thenable 的进程句柄」：既能 `await` 拿结果（把整件事等完），
 * 也能在等待过程中 `proc.kill()` / `proc.settled()` / 读 `proc.stdout`。
 * 进度上报与「中止安装」依赖的就是后一半能力。
 *
 * ★ 输出为什么走**临时文件**而不是 pipe
 *
 *   直觉上应该用 `stdio: ['ignore','pipe','pipe']`，但那条路在受限环境
 *   （文件沙箱 / 受限令牌 / 部分 CI 容器）里会直接失败：子进程的 pipe 需要
 *   命名管道权限，拿不到就 `spawn EPERM`；更糟的是**父进程只看到子进程挂着不动**
 *   （close 事件永远不来）—— 表现正好就是「点了安装，一直没反应」。
 *
 *   重定向到文件没有这个限制（`stdio: ['ignore', fd, fd]` 只是打开一个文件），
 *   而且顺手满足另一个需求：**边跑边读**。安装进度里的「pnpm 实时输出」
 *   就是靠周期性读这个文件里新增的字节实现的。
 *
 * ★ 为什么 resolve 的是 `proc.result` 而不是 `proc`
 *
 *   `proc` 自己是 thenable（带 then 方法），如果 `resolve(proc)`，Promise 规范
 *   会去「解开」这个 thenable —— 也就是调用它自己的 `.then()`，而那个 `.then()`
 *   等的又是同一个 promise：**自己等自己，永远不落定**。
 *   症状极具迷惑性：子进程明明跑完、输出也拿到了，await 却永远不返回。
 *   所以对外暴露一个**不带 then** 的纯结果对象。
 *
 * @param {object} o
 * @param {number} [o.timeout]      到点强制结束（连同子进程树一起杀）
 * @param {AbortSignal} [o.signal]  外部中止信号
 * @param {(chunk:string, stream:'out'|'err')=>void} [o.onOutput]  有新输出时回调
 * @param {boolean} [o.shell]       默认 Windows 上 true（要跑 .cmd 薄壳时必需）
 * @param {boolean} [o.capture]     是否捕获输出（默认 true）
 * @param {number} [o.maxBuffer]    单次保留的上限（防止输出把内存吃光）
 */
export function spawnCaptureAsync(command, args, options = {}) {
  const {
    timeout = 0,
    signal: abortSignal = null,
    onOutput = null,
    shell = process.platform === 'win32',
    cwd,
    env,
    capture = true,
    maxBuffer = 8 * 1024 * 1024,
    windowsHide = true,
  } = options;

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  let outFile = null;
  let outFd = null;
  let readOffset = 0;
  let reader = null;

  if (capture) {
    try {
      outFile = path.join(
        os.tmpdir(),
        `dsh-market-out-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`,
      );
      outFd = fs.openSync(outFile, 'w+');
    } catch {
      outFile = null;
      outFd = null;
    }
  }

  const proc = {
    command,
    args,
    child: null,
    pid: null,
    stdout: '',
    stderr: '',
    outputFile: outFile,
    status: null,
    signal: null,
    error: null,
    timedOut: false,
    canceled: false,
    settled: () => proc._settled,
    _settled: false,
    kill: (reason = 'kill') => killProcessTree(proc.child, reason),
    get failed() { return proc.timedOut || proc.canceled || proc.status !== 0 || Boolean(proc.error); },
    then: (onOk, onErr) => done.then(onOk, onErr),
    catch: (onErr) => done.catch(onErr),
    finally: (fn) => done.finally(fn),
  };

  /** 把文件里新增的部分读出来（「边跑边看输出」的关键） */
  const drain = () => {
    if (!outFile || !onOutput) return;
    let stat;
    try {
      stat = fs.statSync(outFile);
    } catch {
      return;
    }
    if (stat.size <= readOffset) return;
    let text = '';
    try {
      const fd = fs.openSync(outFile, 'r');
      const len = Math.min(stat.size - readOffset, maxBuffer);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, readOffset);
      fs.closeSync(fd);
      readOffset += len;
      text = buf.toString('utf8');
    } catch {
      return;
    }
    if (text) {
      try { onOutput(text, 'out'); } catch { /* 回调出错不能影响子进程 */ }
    }
  };

  const cleanup = () => {
    if (reader) { clearInterval(reader); reader = null; }
    // 最后一次读盘：把收尾阶段写的输出也带上（否则会丢掉最后几行错误信息）
    drain();
    try {
      if (outFd !== null) fs.closeSync(outFd);
    } catch { /* 忽略 */ }
  };

  const finish = (code, sig) => {
    if (proc._settled) return;
    proc._settled = true;
    proc.status = code;
    proc.signal = sig;
    if (timer) clearTimeout(timer);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    cleanup();
    // 完整输出：文件内容就是 stdout+stderr 的合并（按子进程实际写出的顺序）
    try {
      if (outFile) proc.stdout = fs.readFileSync(outFile, 'utf8').slice(-maxBuffer);
    } catch { /* 忽略 */ }
    try {
      if (outFile) fs.rmSync(outFile, { force: true });
    } catch { /* 忽略 */ }

    // ★ 对外只暴露这个纯数据对象（不带 then），绝不 resolve 上面那个 thenable 句柄
    proc.result = {
      command,
      args,
      pid: proc.pid,
      status: proc.status,
      signal: proc.signal,
      stdout: proc.stdout,
      stderr: proc.stderr,
      error: proc.error,
      timedOut: proc.timedOut,
      canceled: proc.canceled,
      exitCode: proc.status,
      get failed() { return proc.timedOut || proc.canceled || proc.status !== 0 || Boolean(proc.error); },
    };
    resolveDone(proc.result);
  };

  let timer = null;
  if (timeout > 0) {
    timer = setTimeout(() => {
      proc.timedOut = true;
      // ★ Windows 上必须杀**整棵树**：pnpm 自己会再拉起 node 子进程，
      //   只 kill 直接子进程会留下孤儿继续占着 profile 目录。
      proc.kill('timeout');
    }, timeout);
    if (typeof timer.unref === 'function') timer.unref();
  }

  let abortHandler = null;
  if (abortSignal) {
    if (abortSignal.aborted) {
      proc.canceled = true;
      // 还没启动就算已结束 —— 让调用方拿到的语义一致
      queueMicrotask(() => finish(null, null));
      return proc;
    }
    abortHandler = () => {
      proc.canceled = true;
      proc.kill('abort');
    };
    abortSignal.addEventListener('abort', abortHandler, { once: true });
  }

  const stdio = outFd !== null ? ['ignore', outFd, outFd] : 'ignore';

  try {
    proc.child = spawn(command, args, {
      cwd,
      env,
      shell,
      windowsHide,
      stdio,
    });
    proc.pid = proc.child.pid ?? null;
  } catch (err) {
    proc.error = String(err?.message ?? err);
    queueMicrotask(() => finish(null, null));
    return proc;
  }

  proc.child.on('error', (err) => {
    proc.error = String(err?.message ?? err);
  });
  proc.child.on('close', (code, sig) => finish(code, sig));

  // 250ms 一次：比进度轮询（600ms）密，保证界面上的「实时输出」看起来是实时的
  if (outFile && onOutput) {
    reader = setInterval(drain, 250);
    if (typeof reader.unref === 'function') reader.unref();
  }

  return proc;
}

/**
 * 杀掉一个子进程及其全部后代。
 *
 * Windows 上没有进程组信号可用，唯一可靠的是 `taskkill /T /F`。
 * 这里刻意**不**等待 taskkill 完成：调用方真正在意的是「子进程开始死」，
 * 而 close 事件才是收尾的信号。
 */
export function killProcessTree(child, reason = 'kill') {
  if (!child || child.killed) return { ok: false, reason: 'no-child' };
  const pid = child.pid;
  if (!pid) return { ok: false, reason: 'no-pid' };
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
      // 给 1.5 秒优雅退出，仍不死就上 SIGKILL
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch { /* 忽略 */ }
      }, 1500).unref?.();
    }
    return { ok: true, reason, pid };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
