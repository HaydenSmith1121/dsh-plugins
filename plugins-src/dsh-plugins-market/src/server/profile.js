/**
 * dsh-plugins-market —— 服务器半：profile 读写 / 快照 / 恢复
 *
 * 这个模块是「别把 harness 装坏」的物理基础：
 *   - 所有对 profile 的修改前，必须先 backupProfile() 拿到一个可恢复的快照；
 *   - restoreProfile() 负责把快照写回并重新链接 node_modules。
 *
 * 涉及的文件（一个都不能少）：
 *   package.json        dependencies + dsh.profile.bundles —— 装配顺序的唯一来源
 *   pnpm-lock.yaml      依赖闭包
 *   pnpm-workspace.yaml allowBuilds + nodeLinker/autoInstallPeers 三个不变量
 *   cordis.patch.yml    profile 用户补丁层
 *   cordis.yml          profile 根 include（每次 boot/dump 都会被重写成常量内容）
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveProfileDir,
  resolveDshHome,
  readJsonSafe,
  readTextSafe,
  writeJsonAtomic,
  ensureDir,
  spawnCapture,
  spawnCaptureAsync,
  dshCommand,
  timestampSlug,
  resolveDataDir,
} from './util.js';

/** 备份/恢复必须覆盖的文件集合 */
export const PROFILE_STATE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'cordis.yml',
];

export function readProfileState(profile, env = process.env) {
  const dir = resolveProfileDir(profile, env);
  const manifestPath = path.join(dir, 'package.json');
  const manifest = readJsonSafe(manifestPath);
  const workspaceText = readTextSafe(path.join(dir, 'pnpm-workspace.yaml'));
  const patchText = readTextSafe(path.join(dir, 'cordis.patch.yml'));

  return {
    profile,
    dir,
    exists: fs.existsSync(dir),
    initialized: Boolean(manifest),
    manifest,
    bundles: manifest?.dsh?.profile?.bundles ?? [],
    dependencies: manifest?.dependencies ?? {},
    patchReload: manifest?.dsh?.profile?.patchReload ?? null,
    workspaceText,
    patchText,
    hasLockfile: fs.existsSync(path.join(dir, 'pnpm-lock.yaml')),
    hasNodeModules: fs.existsSync(path.join(dir, 'node_modules')),
  };
}

/**
 * 扫描 profile 里每个依赖的**实际安装**情况。
 * 这一步能查出一类 CLI 完全看不见的漂移：声明的是 0.1.1，装上去的是 0.1.2（本机真实存在）。
 */
export function scanInstalled(profile, env = process.env) {
  const state = readProfileState(profile, env);
  const out = [];
  for (const [name, spec] of Object.entries(state.dependencies)) {
    const pkgDir = path.join(state.dir, 'node_modules', name);
    const manifest = readJsonSafe(path.join(pkgDir, 'package.json'));
    const isBundle = Boolean(manifest?.dsh?.bundle?.patch);
    const specVersion = extractVersionFromSpec(spec);
    out.push({
      name,
      spec,
      specVersion,
      installed: Boolean(manifest),
      installedVersion: manifest?.version ?? null,
      isBundle,
      inBundles: state.bundles.includes(name),
      dir: fs.existsSync(pkgDir) ? pkgDir : null,
      hasClient: Boolean(manifest?.dsh?.client),
      patchPath: isBundle ? path.join(pkgDir, manifest.dsh.bundle.patch) : null,
      peerDependencies: manifest?.peerDependencies ?? {},
      engines: manifest?.engines ?? null,
      scripts: manifest?.scripts ?? null,
      mismatch: Boolean(specVersion && manifest?.version && specVersion !== manifest.version),
    });
  }
  return out;
}

/**
 * 从 `file:.../foo-1.2.3.tgz` / `1.2.3` / `^1.2.3` / `dsh-memory@0.1.0` 里取出版本号。
 *
 * ★ 最后那种带包名前缀的写法（`<pkg>@<version>`）必须单独认。
 *   它是**更新判定**的关键输入：目录里给的是 `npm` 规格时，版本号只存在于
 *   这个后缀里；漏了它，「装了 0.1.0、目录里是 0.2.0」会被判成「无法比较」，
 *   于是永远不显示「可升级」，用户也就永远升不上去。
 *   注意不能简单地取最后一个 `@` —— scoped 包名是 `@scope/name@1.2.3`，
 *   末尾的 `@` 后面才是版本，用 /@([^@/]+)$/ 正好只吃掉最后一段。
 */
export function extractVersionFromSpec(spec) {
  if (typeof spec !== 'string') return null;
  const s = spec.trim();
  const tgz = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(s);
  if (tgz) return tgz[1];
  if (/^file:|^link:|^\.{1,2}[\\/]|^[A-Za-z]:[\\/]/.test(s)) return null;
  const scoped = /@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(s);
  if (scoped) return scoped[1];
  const bare = /^[~^>=<\s]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(s);
  if (bare) return bare[1];
  return null;
}

/** `file:` / `link:` 规格解析成绝对路径（用于「tarball 还在不在」检查） */
export function resolveLocalSpecPath(spec, profileDir) {
  if (typeof spec !== 'string') return null;
  const m = /^(file|link):(.+)$/.exec(spec.trim());
  if (m) return path.resolve(m[2]);
  if (/^\.{1,2}[\\/]/.test(spec.trim()) || /^[A-Za-z]:[\\/]/.test(spec.trim())) {
    return path.resolve(profileDir, spec.trim());
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 装配层：--dump-config
// ─────────────────────────────────────────────────────────────

/**
 * 跑 `dsh --profile <p> --dump-config` 并解析装配树。
 *
 * 关键点（来自对 dsh 源码的核对）：这个命令**只解析配置、不 import 任何模块**，
 * 所以它不需要网络/凭据，也非常快；但它查不出「模块能不能 import」。
 * 它同时也**不修改** profile 的实质内容（只把 cordis.yml 重写成同一份常量）。
 *
 * 输出里 section 头是 `# == <bundle 包名>`，被别的 bundle 打过补丁时会写成
 * `# == <包名>, patched by <另一个包>`。
 *
 * ★ async：这一步要起一个 dsh 进程（约 1–5 秒）。用同步实现会把事件循环堵住，
 *   安装进度面板上的计时器会突然停住 —— 那看起来和卡死没区别。
 */
export async function composedTree(profile, env = process.env, { launcher, signal, timeout = 120_000 } = {}) {
  const state = readProfileState(profile, env);
  // ★ 用 dshCommand() 解析出「怎么调 dsh」，而不是让 shell 去 PATH 里找 ——
  //   harness 从 GUI / 快捷方式启动时 PATH 常和终端不同，那时 shell 找不到 dsh，
  //   表现就是这一类「配置树读不出来 / 安装很久没反应」。
  //
  //   launcher 参数只在**显式传了绝对路径**时才用（那是调用方已经解析好的结果）；
  //   传进来的是 `dsh.cmd` 这种相对名字时忽略它 —— 走 shell 跑薄壳既会触发
  //   DEP0190，又引入引号/继承 PATH 的一整类问题，正是要避免的东西。
  const explicit = launcher && (path.isAbsolute(launcher) || launcher.includes(path.sep) || launcher.includes('/'));
  const dc = explicit
    ? { command: launcher, prefixArgs: [], shell: process.platform === 'win32' }
    : dshCommand(env);
  const res = await spawnCaptureAsync(dc.command, [...dc.prefixArgs, '--profile', profile, '--dump-config'], {
    cwd: state.dir,
    env: { ...process.env, ...env },
    timeout,
    signal,
    shell: dc.shell,
  });
  if (res.failed && !res.stdout) {
    return { ok: false, error: res.error ?? res.stderr ?? 'dump-config 失败', heads: [], bundles: [], rows: [], stderr: res.stderr, stdout: res.stdout };
  }

  const lines = res.stdout.split(/\r?\n/);
  const heads = [];
  const rows = [];
  let current = null;
  let row = null;

  const flush = () => {
    if (row) rows.push(row);
    row = null;
  };

  for (const line of lines) {
    const head = /^# == (.+?)\s*$/.exec(line);
    if (head) {
      flush();
      const raw = head[1];
      const patched = /^(.*?),\s*patched by\s+(.+)$/.exec(raw);
      current = { raw, package: (patched ? patched[1] : raw).trim(), patchedBy: patched ? patched[2].trim() : null, index: heads.length };
      heads.push(current);
      continue;
    }
    if (!current) continue;
    const idMatch = /^- id:\s*(.+?)\s*$/.exec(line);
    if (idMatch) {
      flush();
      row = { id: stripScalar(idMatch[1]), name: null, disabled: false, section: current.package, configKeys: [] };
      continue;
    }
    if (!row) continue;
    const nameMatch = /^\s+name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch && row.name === null) {
      row.name = stripScalar(nameMatch[1]);
      continue;
    }
    if (/^\s+disabled:\s*true\s*$/.test(line)) {
      row.disabled = true;
      continue;
    }
    const cfg = /^\s{4}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (cfg) row.configKeys.push(cfg[1]);
  }
  flush();

  return {
    ok: true,
    error: null,
    stdout: res.stdout,
    stderr: res.stderr,
    heads,
    bundles: [...new Set(heads.filter((h) => !h.patchedBy).map((h) => h.package))],
    rows,
    exitCode: res.status,
  };
}

function stripScalar(v) {
  return String(v).trim().replace(/^['"]|['"]$/g, '');
}

/** 从装配树里取「当前所有已挂载的 id」和「每个 id 由哪个 bundle 提供」 */
export function composedIds(tree) {
  const byId = new Map();
  for (const row of tree.rows ?? []) {
    if (!row.id) continue;
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  return byId;
}

// ─────────────────────────────────────────────────────────────
// 运行时包版本解析（peerDependencies 判定要用「真实存在的那个版本」）
// ─────────────────────────────────────────────────────────────

/**
 * 解析 `@deepseek-ai/dsh-llm` 这类运行时依赖在**本机实际**的版本。
 * 顺序与 dsh 的模块解析一致：dsh 安装锚点优先（profile 里不会有第二份，
 * 因为 autoInstallPeers: false）。
 */
export function resolveRuntimePackageVersion(name, { dshDir, profileDir, env = process.env } = {}) {
  const candidates = [];
  if (dshDir) candidates.push(path.join(dshDir, 'node_modules', name));
  if (profileDir) {
    candidates.push(path.join(profileDir, 'node_modules', name));
    // dsh 的 healProfilesModuleFallback 会把安装侧的依赖闭包镜像到这里。
    // 像 @deepseek-ai/dsh-llm 这种只出现在 devDependencies 里的包，只有这条路径找得到 ——
    // 少了它，peer 判定就会退化成「无法判定」，让本该拦下来的 pin 不匹配溜过去。
    candidates.push(path.join(profileDir, '.dsh-module-fallback', 'node_modules', name));
  }
  candidates.push(path.join(resolveDshHome(env), 'profiles', 'node_modules', name));

  for (const dir of candidates) {
    const manifest = readJsonSafe(path.join(dir, 'package.json'));
    if (manifest?.version) return { version: manifest.version, dir };
  }
  return { version: null, dir: null };
}

/** 收集一件 tarball 或目录里的全部问题所需的东西：只读，不执行代码 */
export function readInstalledManifest(pkgDir) {
  return readJsonSafe(path.join(pkgDir, 'package.json'));
}

// ─────────────────────────────────────────────────────────────
// 备份 / 恢复
// ─────────────────────────────────────────────────────────────

export function backupsRoot(env = process.env) {
  return path.join(resolveDataDir(env), 'backups');
}

/**
 * 给 profile 拍一份快照。返回的 dir 可以直接交给 restoreProfile()。
 * 只复制「状态文件」——node_modules 不复制（几百 MB），恢复时用 pnpm install 重新链接。
 */
export function backupProfile(profile, { label = 'manual', env = process.env, extra = {} } = {}) {
  const state = readProfileState(profile, env);
  if (!state.exists) return { ok: false, error: `profile 目录不存在：${state.dir}` };

  const dir = ensureDir(path.join(backupsRoot(env), `profile-${profile}-${timestampSlug()}-${label}`));
  const copied = [];
  const missing = [];
  for (const file of PROFILE_STATE_FILES) {
    const src = path.join(state.dir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, file));
      copied.push(file);
    } else {
      missing.push(file);
    }
  }
  const meta = {
    profile,
    label,
    createdAt: new Date().toISOString(),
    profileDir: state.dir,
    copied,
    missing,
    bundles: state.bundles,
    dependencies: state.dependencies,
    ...extra,
  };
  writeJsonAtomic(path.join(dir, 'backup-meta.json'), meta);
  return { ok: true, dir, meta };
}

/**
 * 把快照写回 profile，并重新链接 node_modules。
 *
 * 注意：恢复 manifest 之后**必须**再跑一次 `dsh plugin --profile <p> install`，
 * 否则 node_modules 与 package.json 会不一致 —— 那本身就是一种「装坏」。
 *
 * ★ 两个关键修正：
 *   1) relink 改用 spawnCaptureAsync，并且**优先用 lib/bin.js**（与 installer 一致）。
 *      早先这里写死 `spawnCapture('dsh', …)`，依赖 PATH 上有 dsh 且能跑 .cmd 薄壳；
 *      而安装路径本来刻意绕开了那个薄壳 —— 回滚是最不能失败的一步，却用了最脆的方式。
 *   2) 超时从 10 分钟压到 5 分钟：回滚卡 10 分钟没有任何意义，用户需要的是
 *      「尽快知道回滚成没成」，失败时还能照着手动命令自己修。
 */
export async function restoreProfile(backupDir, {
  env = process.env, relink = true, dshDir = null, signal = null, timeout = 300_000,
} = {}) {
  const meta = readJsonSafe(path.join(backupDir, 'backup-meta.json'));
  if (!meta?.profileDir) return { ok: false, error: `快照缺少 backup-meta.json：${backupDir}` };

  const results = { restored: [], deleted: [], relink: null };
  for (const file of PROFILE_STATE_FILES) {
    const src = path.join(backupDir, file);
    const dst = path.join(meta.profileDir, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      results.restored.push(file);
    } else if (fs.existsSync(dst)) {
      // 快照里没有 = 当时不存在 → 删掉，避免留下半截状态
      try {
        fs.rmSync(dst, { force: true });
        results.deleted.push(file);
      } catch { /* 忽略 */ }
    }
  }

  if (relink) {
    const dc = dshCommand(env);
    // dshDir 显式给了就优先用它（安装路径下调用方已经解析过一次，避免重复找）
    const binJs = dshDir ? path.join(dshDir, 'lib', 'bin.js') : null;
    const useBin = binJs && fs.existsSync(binJs);
    const res = await spawnCaptureAsync(
      useBin ? process.execPath : dc.command,
      [...(useBin ? [binJs] : dc.prefixArgs), 'plugin', '--profile', meta.profile, 'install'],
      {
        cwd: meta.profileDir,
        env: { ...process.env, ...env },
        timeout,
        signal,
        shell: useBin ? false : dc.shell,
      },
    );
    results.relink = {
      ok: !res.failed,
      status: res.status,
      timedOut: res.timedOut,
      output: tail(`${res.stdout}${res.stderr}`, 4000),
    };
  }

  return { ok: true, meta, results };
}

export function listProfileBackups(env = process.env) {
  const root = backupsRoot(env);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => {
      const dir = path.join(root, name);
      const meta = readJsonSafe(path.join(dir, 'backup-meta.json'));
      return meta ? { name, dir, meta } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
}

export function tail(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : `…\n${s.slice(-n)}`;
}
