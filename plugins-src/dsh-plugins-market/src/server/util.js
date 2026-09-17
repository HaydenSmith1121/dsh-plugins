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
import { execFileSync, spawnSync } from 'node:child_process';
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
      const out = execFileSync(chosen, ['--version'], {
        encoding: 'utf8',
        timeout: 20000,
        shell: process.platform === 'win32',
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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
