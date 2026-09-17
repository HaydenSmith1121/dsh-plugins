/**
 * dsh-plugins-market —— 服务器半：事务化安装器
 *
 * 一次安装就是一次事务：
 *
 *   [0] 复核闸门（必须 canInstall）
 *   [1] 拿到 tarball（本地仓库优先；没有就联网下载并校验 sha256）
 *   [2] 备份 profile 的 5 个状态文件
 *   [3] 事前把 allowBuilds 补好（读**当前**文件再合并，绝不重放旧快照）
 *   [4] 跑 `dsh plugin --profile <p> add <绝对路径>`
 *       ★ 成功判据是 **pnpm 退出码**，不是「node_modules 里有没有文件」
 *       ★ 撞 ERR_PNPM_IGNORED_BUILDS 时自动补 allowBuilds 并重试一次
 *   [5] 校验三层：依赖层 / 注册表层（bundles 有没有写进去）/ 装配层
 *   [6] 任何一步失败 → 用 [2] 的快照回滚，并重新链接 node_modules
 *
 * 为什么第 [5] 步的「注册表层」是重点：pnpm 非 0 退出时 dsh 会直接 return，
 * **不会**把包追加进 dsh.profile.bundles，而这一步是完全静默的 —— 于是表现为
 * 「装上了但 GUI 里没有」。这个判据是本插件存在的直接原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  resolveDataDir, ensureDir, readJsonSafe, writeJsonAtomic, readTextSafe,
  mergeAllowBuilds, readAllowBuilds, spawnCapture, timestampSlug, sleep,
} from './util.js';
import {
  readProfileState, scanInstalled, composedTree, backupProfile, restoreProfile, tail,
} from './profile.js';

/** 构建脚本放行名单：pnpm 10+ 不批准这些就会让 add 以非 0 退出 */
const KNOWN_ALLOW_BUILDS = { '@google/genai': false, protobufjs: false };

// ─────────────────────────────────────────────────────────────
// 调用 dsh
// ─────────────────────────────────────────────────────────────

/**
 * 直接以 `node <dshDir>/lib/bin.js` 调用 dsh，而不是走 dsh.cmd 薄壳。
 *
 * 理由：Windows 上 spawnSync 跑 .cmd 必须开 shell，而开 shell 之后含空格/
 * 特殊字符的绝对路径就必须手工加引号，非常容易出错。直接用 harness 自己
 * 正在用的那个 node 执行 bin.js，参数逐个传递，不经过 shell，彻底绕开这个问题。
 * 找不到 bin.js 时才退回启动器 + shell。
 */
export function dshRun(args, ctx, { timeout = 600_000, env: extraEnv } = {}) {
  const binJs = ctx.env.dsh.dir ? path.join(ctx.env.dsh.dir, 'lib', 'bin.js') : null;
  const env = { ...process.env, ...(extraEnv ?? {}) };
  if (binJs && fs.existsSync(binJs)) {
    return spawnCapture(process.execPath, [binJs, ...args], { env, timeout, shell: false, cwd: ctx.profileState?.dir });
  }
  const launcher = ctx.env.dsh.launcher ?? 'dsh';
  return spawnCapture(launcher, args, { env, timeout, shell: process.platform === 'win32' });
}

// ─────────────────────────────────────────────────────────────
// allowBuilds
// ─────────────────────────────────────────────────────────────

/**
 * 把 allowBuilds 合并进 profile 的 pnpm-workspace.yaml。
 *
 * ★ 每次都**重新读盘**再合并 —— 仓库原 install.mjs 在这里有个缺陷：
 *   它在 profile 初始化之前就把文件内容捕获进内存，初始化后又把那份（空）
 *   快照写回去，结果把 dsh 刚建好的 packages/nodeLinker/autoInstallPeers
 *   一起抹掉。那三个键丢了会让 pnpm 去 registry 装 peer，进而在 profile 里
 *   出现第二份 @deepseek-ai/*，正是「插件树加载失败」的经典成因。
 */
export function applyAllowBuilds(profileState, entries = KNOWN_ALLOW_BUILDS) {
  const file = path.join(profileState.dir, 'pnpm-workspace.yaml');
  const fresh = readTextSafe(file);
  if (fresh == null) {
    return { ok: false, changed: false, added: [], error: 'pnpm-workspace.yaml 不存在（profile 可能还没初始化）' };
  }
  const merged = mergeAllowBuilds(fresh, entries);
  if (!merged.changed) return { ok: true, changed: false, added: [], text: fresh, file };
  fs.writeFileSync(file, merged.text, 'utf8');
  return { ok: true, changed: true, added: merged.added, text: merged.text, file };
}

/** 从 pnpm 的输出里解析出它要求批准的构建脚本包名 */
export function parseBlockedBuilds(output) {
  const names = new Set();
  const text = String(output ?? '');
  // 形如：Ignored build scripts: @google/genai@1.52.0, protobufjs@7.6.6
  const line = /Ignored build scripts:\s*(.+)/i.exec(text);
  if (line) {
    for (const part of line[1].split(/[,\n]/)) {
      const name = part.trim().replace(/@[\d^~<>=.*-]+$/, '').trim();
      if (name && !name.includes(' ')) names.add(name);
    }
  }
  // pnpm 在 pnpm-workspace.yaml 里留下的占位符也是同一信号
  const ph = /^\s*['"]?([^'":\s]+)['"]?\s*:\s*set this to true or false/gim;
  for (const m of text.matchAll(ph)) names.add(m[1].trim());
  return [...names];
}

// ─────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────

/**
 * 安装后校验（前三层，全部很快、无副作用，不需要启动第二个进程）。
 *   ① 依赖层   node_modules 里有、且版本对得上
 *   ② 注册表层 ★ dsh.profile.bundles 里有它（这是 pnpm 非 0 退出时唯一会漏的一步）
 *   ③ 装配层   --dump-config 里有对应的 bundle 段
 */
export function verifyInstalled(pkgName, ctx) {
  const layers = [];
  const state = readProfileState(ctx.profileState.profile, process.env);
  const installed = scanInstalled(ctx.profileState.profile, process.env);
  const item = installed.find((i) => i.name === pkgName) ?? null;

  // ① 依赖层
  if (item?.installed) {
    layers.push({ id: 'deps', label: '依赖层', ok: true, detail: `node_modules 中为 ${pkgName}@${item.installedVersion ?? '?'}` });
  } else {
    layers.push({ id: 'deps', label: '依赖层', ok: false, detail: `node_modules 里没有 ${pkgName}（或缺少 package.json）` });
  }

  // ② 注册表层
  const inDeps = Boolean(state.dependencies[pkgName]);
  const inBundles = state.bundles.includes(pkgName);
  if (inDeps && inBundles) {
    layers.push({ id: 'registry', label: '注册表层', ok: true, detail: `已写入 dependencies，且 bundles 第 ${state.bundles.indexOf(pkgName) + 1} 位` });
  } else if (inDeps && !inBundles) {
    layers.push({
      id: 'registry', label: '注册表层', ok: false,
      detail: `${pkgName} 已在 dependencies 中，但**没有**写进 dsh.profile.bundles —— `
        + '这正是 pnpm 以非 0 退出时的典型残局：文件都在，GUI 里却看不到它。',
      repairable: true,
    });
  } else {
    layers.push({ id: 'registry', label: '注册表层', ok: false, detail: `${pkgName} 既不在 dependencies 也不在 bundles 中` });
  }

  // ③ 装配层
  const tree = composedTree(ctx.profileState.profile, process.env, { launcher: ctx.env.dsh.launcher });
  if (!tree.ok) {
    layers.push({ id: 'assembly', label: '装配层', ok: false, detail: `--dump-config 执行失败：${tree.error}` });
  } else {
    const head = tree.heads.find((h) => h.package === pkgName && !h.patchedBy);
    const idx = head ? head.index : -1;
    const prevIdx = Math.max(-1, ...tree.heads.filter((h) => !h.patchedBy && h.package !== pkgName && state.bundles.indexOf(h.package) >= 0 && state.bundles.indexOf(h.package) < state.bundles.indexOf(pkgName)).map((h) => h.index));
    if (!head) {
      layers.push({ id: 'assembly', label: '装配层', ok: false, detail: `--dump-config 里没有 ${pkgName} 这一段（说明它没有被当成 bundle 层装配）` });
    } else if (idx < prevIdx) {
      layers.push({ id: 'assembly', label: '装配层', ok: false, detail: `${pkgName} 的装配位置(${idx})早于它前面的 bundle(${prevIdx})，层序不对` });
    } else {
      const rowNames = tree.rows.filter((r) => r.section === pkgName).map((r) => `${r.id}(${r.name})`);
      layers.push({
        id: 'assembly', label: '装配层', ok: true,
        detail: `装配树第 ${idx + 1} 段，插入行：${rowNames.join('、') || '（无插入行）'}`,
      });
    }
    // patch 告警
    const patchWarn = /patch (?:insert: entry|: entry) .+ not (?:found|a group)/i.test(tree.stderr ?? '');
    if (patchWarn) {
      layers.push({ id: 'assembly-warn', label: '装配告警', ok: false, detail: `装配过程中有 patch 告警：\n${tail(tree.stderr, 1200)}` });
    }
  }

  return {
    ok: layers.every((l) => l.ok),
    layers,
    bundles: state.bundles,
    tree,
  };
}

/**
 * 第四层：真实启动一次（唯一能验证「模块到底能不能 import」的办法）。
 *
 * 默认**不**自动跑 —— 它会在同一个 profile 上再起一个 dsh 进程（用 --port 0
 * 避开端口冲突），耗时约 30–40 秒。只有在用户显式要求时才执行。
 */
export async function bootVerify(ctx, { timeoutMs = 45_000 } = {}) {
  const binJs = ctx.env.dsh.dir ? path.join(ctx.env.dsh.dir, 'lib', 'bin.js') : null;
  if (!binJs || !fs.existsSync(binJs)) {
    return { ok: false, error: '找不到 dsh 的 lib/bin.js，无法做真实启动校验' };
  }
  const port = 0;
  const child = spawnCaptureAsync(
    process.execPath,
    [binJs, 'web', '--no-open', '--port', String(port)],
    { env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' }, cwd: ctx.profileState?.dir },
  );

  const FATAL = [
    /plugin tree failed to load/i,
    /does not provide an export named/i,
    /SyntaxError/i,
    /ERR_MODULE_NOT_FOUND/,
    /Cannot find module/i,
    /ERR_PNPM_/i,
    /did not activate/i,
    /pending \(waiting for/i,
    /client bundle not found/i,
    /loaded without registering/i,
    /missed the module table/i,
  ];

  const deadline = Date.now() + timeoutMs;
  let sawUrl = false;
  while (Date.now() < deadline) {
    await sleep(700);
    const text = child.output();
    if (/dsh web:\s*http/i.test(text)) { sawUrl = true; break; }
    if (child.exited()) break;
  }
  await sleep(1200);
  child.kill();
  await sleep(300);

  const text = child.output();
  const fatalHits = FATAL.filter((re) => re.test(text)).map((re) => re.source);
  const warnings = [...text.matchAll(/^.*(?:warning|did not activate|pending \(waiting).*$/gim)].map((m) => m[0].trim()).slice(0, 10);

  return {
    ok: sawUrl && fatalHits.length === 0,
    sawUrl,
    fatalHits,
    warnings,
    exitCode: child.status(),
    output: tail(text, 6000),
  };
}

function spawnCaptureAsync(command, args, { env, cwd } = {}) {
  // 用 child_process.spawn 而非 spawnSync：boot 校验需要边跑边看输出
  const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let status = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  child.on('exit', (code) => { status = code; });
  child.on('error', (err) => { buf += `\n[spawn error] ${err.message}`; status = -1; });
  return {
    output: () => buf,
    exited: () => status !== null,
    status: () => status,
    kill: () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnCapture('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 15000 });
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* 忽略 */ }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// tarball 获取
// ─────────────────────────────────────────────────────────────

export function tarballCacheDir() {
  return ensureDir(path.join(resolveDataDir(), 'tarballs'));
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function downloadTarball(url, destFile, { expectedSha256 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'user-agent': 'dsh-plugins-market' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(buf).digest('hex');
  if (expectedSha256 && actual !== expectedSha256) {
    throw new Error(`下载的 tarball sha256 不匹配：期望 ${expectedSha256.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…`);
  }
  ensureDir(path.dirname(destFile));
  fs.writeFileSync(destFile, buf);
  return { file: destFile, sha256: actual, bytes: buf.length };
}

/** 把安装规格变成磁盘上一个真实存在的 .tgz 绝对路径 */
export async function materializeSpec(installSpec, entry) {
  if (installSpec.kind !== 'local-tarball') {
    return { ok: true, spec: installSpec.spec, file: null, kind: installSpec.kind };
  }
  if (installSpec.resolvedPath && fs.existsSync(installSpec.resolvedPath)) {
    return { ok: true, spec: installSpec.resolvedPath, file: installSpec.resolvedPath, kind: 'local-tarball', source: 'local' };
  }
  if (!installSpec.downloadUrl) {
    return { ok: false, error: `tarball 不存在且没有可下载地址：${installSpec.spec}` };
  }
  const base = path.basename(new URL(installSpec.downloadUrl).pathname);
  const dest = path.join(tarballCacheDir(), base);
  if (fs.existsSync(dest) && entry.sha256 && sha256File(dest) === entry.sha256) {
    return { ok: true, spec: dest, file: dest, kind: 'local-tarball', source: 'cache' };
  }
  try {
    const r = await downloadTarball(installSpec.downloadUrl, dest, { expectedSha256: entry.sha256 ?? undefined });
    return { ok: true, spec: r.file, file: r.file, kind: 'local-tarball', source: 'download', sha256: r.sha256, bytes: r.bytes };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ─────────────────────────────────────────────────────────────
// 安装事务
// ─────────────────────────────────────────────────────────────

/**
 * 执行一次安装。**调用方必须已经跑过 runGate 并确认 gate.canInstall === true。**
 *
 * @returns {object} 结构化结果：steps[] 记录了每一步，failure 时含 rollback 结果
 */
export async function installPlugin({ entry, ctx, gate, options = {} }) {
  const profile = ctx.profileState.profile;
  const pkgName = entry.package ?? entry.id;
  const steps = [];
  const log = (id, label, status, detail, extra = {}) => {
    const step = { id, label, status, detail, at: new Date().toISOString(), ...extra };
    steps.push(step);
    return step;
  };

  if (!gate?.canInstall) {
    log('gate', '装前检查', 'fail', '闸门未放行，安装中止。');
    return { ok: false, steps, failure: 'gate-blocked', gate };
  }

  // [1] 取 tarball
  const mat = await materializeSpec(gate.installSpec, entry);
  if (!mat.ok) {
    log('fetch', '获取安装包', 'fail', mat.error);
    return { ok: false, steps, failure: 'fetch' };
  }
  log('fetch', '获取安装包', 'ok',
    mat.kind === 'local-tarball'
      ? `${mat.source === 'download' ? '已从 GitHub 下载' : '使用本地 tarball'}：${mat.spec}${mat.bytes ? `（${(mat.bytes / 1024).toFixed(1)} KB）` : ''}`
      : `安装规格：${mat.spec}（${mat.kind}）`);

  // [2] 备份
  const backup = backupProfile(profile, { label: `install-${pkgName}`.replace(/[^A-Za-z0-9._@-]/g, '_') });
  if (!backup.ok) {
    log('backup', '备份 profile', 'fail', backup.error);
    return { ok: false, steps, failure: 'backup' };
  }
  log('backup', '备份 profile', 'ok', `快照：${backup.dir}（${backup.meta.copied.join('、')}）`);

  const rollback = async (reason) => {
    log('rollback', '回滚', 'running', `正在用快照还原 profile…（原因：${reason}）`);
    const r = restoreProfile(backup.dir);
    const step = steps[steps.length - 1];
    step.status = r.ok ? 'ok' : 'fail';
    step.detail = r.ok
      ? `已还原 ${r.results.restored.join('、')}${r.results.deleted.length ? `，并删除 ${r.results.deleted.join('、')}` : ''}`
        + `；重新链接 node_modules：${r.results.relink?.ok ? '成功' : '失败（' + (r.results.relink?.output ?? '') + '）'}`
      : r.error;
    return r;
  };

  // [3] allowBuilds 预置
  const ab = applyAllowBuilds(ctx.profileState);
  if (!ab.ok) {
    log('allowbuilds', '预置 allowBuilds', 'warn', ab.error);
  } else {
    log('allowbuilds', '预置 allowBuilds', 'ok',
      ab.changed ? `已补上：${ab.added.join('、')}` : '已知的构建脚本放行项都已就位，无需改动');
  }

  // [4] 调 dsh 安装
  let attempt = await dshRun(['plugin', '--profile', profile, 'add', mat.spec], ctx, { timeout: 900_000 });
  let combined = `${attempt.stdout}\n${attempt.stderr}`;
  let retried = false;

  if (attempt.failed && /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(combined)) {
    const blocked = parseBlockedBuilds(combined);
    log('install-attempt', `安装（第 1 次）`, 'warn',
      `pnpm 因未批准的构建脚本以非 0 退出（${blocked.join('、') || '未知包'}）。已按 pnpm 的提示补进 allowBuilds 并重试一次 —— `
      + '注意这一步不能跳：pnpm 非 0 时 dsh 不会把包写进 bundles。');
    // 重新读盘再合并（必须用最新内容，不能重放旧快照）
    const entries = Object.fromEntries([...Object.keys(KNOWN_ALLOW_BUILDS), ...blocked].map((k) => [k, false]));
    const ab2 = applyAllowBuilds(readProfileState(profile, process.env), entries);
    log('allowbuilds-retry', '补 allowBuilds', ab2.ok ? 'ok' : 'warn',
      ab2.changed ? `已补上：${ab2.added.join('、')}` : (ab2.error ?? '无需改动'));
    attempt = await dshRun(['plugin', '--profile', profile, 'add', mat.spec], ctx, { timeout: 900_000 });
    combined = `${attempt.stdout}\n${attempt.stderr}`;
    retried = true;
  }

  // ★ 成功判据：pnpm 退出码为 0
  if (attempt.failed) {
    log('install', '执行安装', 'fail',
      `dsh plugin add 以退出码 ${attempt.status} 结束${retried ? '（重试后仍然失败）' : ''}。`
      + '按 dsh 的语义，只要 pnpm 非 0，它就不会把包写进 dsh.profile.bundles —— '
      + '所以即使 node_modules 里已经能看到文件，这次安装也算没完成。',
      { output: tail(combined, 5000) });
    const r = await rollback('安装命令失败');
    return { ok: false, steps, failure: 'install-command', rollback: r, output: tail(combined, 5000) };
  }
  log('install', '执行安装', 'ok', `dsh plugin add 退出码 0${retried ? '（重试后成功）' : ''}`, { output: tail(combined, 3000) });

  // [5] 校验
  const verify = verifyInstalled(pkgName, ctx);
  for (const layer of verify.layers) {
    log(`verify-${layer.id}`, `校验 · ${layer.label}`, layer.ok ? 'ok' : 'fail', layer.detail);
  }

  if (!verify.ok) {
    const r = await rollback('安装后校验未通过');
    return { ok: false, steps, failure: 'verify', verify, rollback: r };
  }

  // 成功也要把「已装但不在 bundles」这类可修复残留标出来
  log('done', '完成', 'ok', `${pkgName} 已安装并通过三层校验。重启 dsh web 后生效。`);

  return {
    ok: true,
    steps,
    verify,
    backupDir: backup.dir,
    needsRestart: true,
    restartHint: '新增的 bundle 是在启动时合成的，必须重启 dsh web 才会出现。',
  };
}

// ─────────────────────────────────────────────────────────────
// 卸载 / 修复 / 手动回滚
// ─────────────────────────────────────────────────────────────

export async function uninstallPlugin({ entry, ctx }) {
  const profile = ctx.profileState.profile;
  const pkgName = entry.package ?? entry.id;
  const steps = [];
  const backup = backupProfile(profile, { label: `uninstall-${pkgName}`.replace(/[^A-Za-z0-9._@-]/g, '_') });
  if (!backup.ok) return { ok: false, steps, failure: 'backup', error: backup.error };
  steps.push({ id: 'backup', label: '备份 profile', status: 'ok', detail: backup.dir });

  const attempt = dshRun(['plugin', '--profile', profile, 'remove', pkgName], ctx, { timeout: 900_000 });
  const combined = `${attempt.stdout}\n${attempt.stderr}`;
  if (attempt.failed) {
    steps.push({ id: 'uninstall', label: '执行卸载', status: 'fail', detail: `退出码 ${attempt.status}`, output: tail(combined, 4000) });
    const r = restoreProfile(backup.dir);
    steps.push({ id: 'rollback', label: '回滚', status: r.ok ? 'ok' : 'fail', detail: r.ok ? '已还原快照' : r.error });
    return { ok: false, steps, failure: 'uninstall-command', output: tail(combined, 4000) };
  }
  steps.push({ id: 'uninstall', label: '执行卸载', status: 'ok', detail: `已从 profile 移除 ${pkgName}` });

  const state = readProfileState(profile, process.env);
  const stillThere = state.dependencies[pkgName] || state.bundles.includes(pkgName);
  steps.push({
    id: 'verify', label: '校验', status: stillThere ? 'fail' : 'ok',
    detail: stillThere ? '卸载后 dependencies/bundles 里仍有残留' : 'dependencies 与 bundles 均已清理干净',
  });
  return { ok: !stillThere, steps, needsRestart: true };
}

/** 修复：重跑 `dsh plugin --profile <p> install`，让 dsh 重新对齐 bundles */
export async function repairProfile({ ctx }) {
  const profile = ctx.profileState.profile;
  const backup = backupProfile(profile, { label: 'repair' });
  const res = dshRun(['plugin', '--profile', profile, 'install'], ctx, { timeout: 900_000 });
  const combined = `${res.stdout}\n${res.stderr}`;

  const state = readProfileState(profile, process.env);
  const depNames = new Set(Object.keys(state.dependencies));
  const inBox = new Set(ctx.compat?.inBoxBundles ?? []);
  const orphan = state.bundles.filter((b) => !depNames.has(b) && !inBox.has(b));

  return {
    ok: !res.failed && orphan.length === 0,
    exitCode: res.status,
    output: tail(combined, 6000),
    backupDir: backup.ok ? backup.dir : null,
    orphansBefore: (ctx.profileState?.bundles ?? []).filter((b) => !new Set(Object.keys(ctx.profileState?.dependencies ?? {})).has(b) && !inBox.has(b)),
    orphansAfter: orphan,
    bundles: state.bundles,
  };
}

/** 用户主动回滚到某次快照 */
export async function rollbackTo({ backupDir, ctx }) {
  const r = restoreProfile(backupDir);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, results: r.results, needsRestart: true };
}
