/**
 * dsh-plugins-market —— 服务器半：事务化安装器
 *
 * 一次安装就是一次事务：
 *
 *   [0] 复核闸门（必须 canInstall）
 *   [0.5] profile 装前体检（断链 file: 依赖、profile 损坏）—— 见 preflight()
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
 *
 * ★ 关于「为什么全部改成异步 / 可中止」
 *   本文件里所有真正跑外部命令的地方都走 spawnCaptureAsync（不阻塞事件循环），
 *   并且接受一个 job 上下文：job.phase(...) 上报阶段、job.signal 支持中止。
 *   原因见 util.js 里 spawnCaptureAsync 的注释 —— spawnSync 会把进度上报
 *   和中止请求一起堵死，那正是「点了安装之后长时间没反应」的机械原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveDataDir, ensureDir, readJsonSafe, writeJsonAtomic, readTextSafe,
  mergeAllowBuilds, readAllowBuilds, spawnCaptureAsync, killProcessTree, dshCommand,
  timestampSlug, sleep,
} from './util.js';
import {
  readProfileState, scanInstalled, composedTree, backupProfile, restoreProfile, tail,
  resolveLocalSpecPath,
} from './profile.js';

/** 构建脚本放行名单：pnpm 10+ 不批准这些就会让 add 以非 0 退出 */
const KNOWN_ALLOW_BUILDS = { '@google/genai': false, protobufjs: false };

/**
 * 各阶段的硬上限。
 *
 * ★ 早先这里对每一步都用了 900 秒（15 分钟）。那是一个「不会误杀，但用户
 *   要干等 15 分钟才知道失败」的值 —— 实际体验等同于没有超时。
 *   现在按阶段拆开：绝大多数步骤是秒级的，给它们 1–3 分钟已经极其宽松；
 *   只有真正跑 pnpm 的 install 阶段保留长超时（它可能真的要下几百 MB）。
 */
const TIMEOUTS = {
  remove: 180_000,
  install: 900_000,
  relink: 300_000,
};

// ─────────────────────────────────────────────────────────────
// 中止信号（一层薄封装，让所有阶段用同一套语义）
// ─────────────────────────────────────────────────────────────

function aborted(job) {
  return Boolean(job?.signal?.aborted);
}

function controlFor(job, onOutput) {
  return {
    signal: job?.signal ?? null,
    onOutput: (text, stream) => {
      onOutput?.(text, stream);
      job?.noteOutput?.(text);
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 调用 dsh
// ─────────────────────────────────────────────────────────────

/**
 * 直接以 `node <dshDir>/lib/bin.js` 调用 dsh，而不是走 dsh.cmd 薄壳。
 *
 * 理由：Windows 上 spawn 跑 .cmd 必须开 shell，而开 shell 之后含空格/
 * 特殊字符的绝对路径就必须手工加引号，非常容易出错。直接用 harness 自己
 * 正在用的那个 node 执行 bin.js，参数逐个传递，不经过 shell，彻底绕开这个问题。
 * 找不到 bin.js 时才退回启动器 + shell。
 *
 * ★ 返回 Promise（不阻塞事件循环），并支持 timeout / signal / 输出流回调。
 *   这样进度上报与「中止安装」才有意义。
 */
export function dshRun(args, ctx, {
  timeout = TIMEOUTS.install,
  env: extraEnv,
  signal = null,
  onOutput = null,
} = {}) {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  const cwd = ctx.profileState?.dir;

  // ★ 「怎么调 dsh」只有一个答案：优先 `node <dshDir>/lib/bin.js`，找不到才退回
  //   启动器 + shell。理由见 util.dshCommand() 的注释（PATH 继承 / 引号地狱）。
  //   ctx.env.dsh.dir 已知时直接用，省掉一次全盘查找。
  const knownDir = ctx.env?.dsh?.dir ?? null;
  const binJs = knownDir ? path.join(knownDir, 'lib', 'bin.js') : null;
  const dc = binJs && fs.existsSync(binJs)
    ? { command: process.execPath, prefixArgs: [binJs], shell: false }
    : dshCommand(env);

  // dsh 自己会把 pnpm 的原始输出打出来；这里原样转给任务对象，供「实时输出」面板用
  return spawnCaptureAsync(dc.command, [...dc.prefixArgs, ...args], {
    env, timeout, signal, cwd, shell: dc.shell, onOutput,
  });
}

// ─────────────────────────────────────────────────────────────
// 装前体检：profile 层面会让安装「慢到像卡死」的问题
// ─────────────────────────────────────────────────────────────

/**
 * profile 装前体检。
 *
 * ★ 这一节是「长时间装不上」这个问题的第二个根因，而且比 UI 缺进度更隐蔽。
 *
 *   profile 的 package.json 里如果留着一条断链的 `file:` 依赖
 *   （指向已经被删掉的 tarball —— 开发件装在临时目录、仓库改名、临时目录被清，
 *   都会造成这种残局），那么**每一次** pnpm 操作都要解析整棵依赖树：
 *   装插件 A 也会因为包 B 的断链而失败或反复重试。用户看到的现象正是
 *   「点安装，等很久，最后什么也没发生」。
 *
 *   所以这里在动手之前先把这类问题**明确指出来**（哪个包、指向哪、怎么修），
 *   而不是丢给 pnpm 去超时。
 */
export function preflight(ctx) {
  const problems = [];
  const notices = [];
  const state = ctx.profileState;

  if (!state?.exists) {
    problems.push({
      id: 'profile-missing',
      severity: 'fatal',
      title: 'profile 目录不存在',
      detail: `找不到 ${state?.dir ?? '(未知)'}。`,
      fixes: [],
    });
    return { ok: false, problems, notices };
  }

  // ① file: / link: 依赖指向的本地 tar 包是否还在
  const dangling = [];
  for (const [name, spec] of Object.entries(state.dependencies ?? {})) {
    const s = String(spec ?? '').trim();
    if (!/^(file|link):/i.test(s)) continue;
    const resolved = resolveLocalSpecPath(s, state.dir);
    if (resolved && fs.existsSync(resolved)) continue;
    dangling.push({ name, spec: s, lookedFor: resolved ?? s.replace(/^(file|link):/i, '') });
  }
  if (dangling.length > 0) {
    problems.push({
      id: 'profile.dangling-file-specs',
      severity: 'fatal',
      title: `有 ${dangling.length} 条依赖指向已经不存在的本地包`,
      detail: 'pnpm 每次操作都要解析整棵依赖树，所以这些断链会让**任何**插件的安装都变慢甚至直接失败 —— '
        + '包括你现在想装的这一个。修好它们（或移除）之后再装。',
      items: dangling.map((d) => `${d.name} → ${d.spec}`),
      fixes: dangling.map((d) => ({
        kind: 'remove-dependency',
        package: d.name,
        label: `移除断链依赖 ${d.name}`,
        command: `dsh plugin --profile ${state.profile} remove ${d.name}`,
        reason: d.spec,
      })),
    });
  } else {
    notices.push({ id: 'file-specs', level: 'ok', text: '所有 file:/link: 依赖指向的本地包都存在' });
  }

  // ② pnpm-workspace.yaml 的关键键（丢了会让 pnpm 去 registry 装 peer，
  //    在 profile 里产生第二份 @deepseek-ai/*，是「插件树加载失败」的经典成因）
  const wsFile = path.join(state.dir, 'pnpm-workspace.yaml');
  const ws = readTextSafe(wsFile);
  if (ws == null) {
    problems.push({
      id: 'profile.workspace-missing',
      severity: 'fatal',
      title: 'pnpm-workspace.yaml 不存在',
      detail: `profile 还没有被 dsh 初始化过（或文件被删了）。先跑一次 "dsh plugin --profile ${state.profile} install" 让它重建。`,
      fixes: [{ kind: 'repair', label: '在 profile 里跑一次 install（重建）', command: `dsh plugin --profile ${state.profile} install` }],
    });
  } else {
    const missingKeys = ['packages', 'nodeLinker', 'autoInstallPeers'].filter((k) => !new RegExp(`^\\s*${k}\\s*:`, 'm').test(ws));
    if (missingKeys.length > 0) {
      notices.push({
        id: 'workspace-keys',
        level: 'warn',
        text: `pnpm-workspace.yaml 缺少 ${missingKeys.join('、')} —— 装完之后建议点一次「修复 profile」。`,
      });
    }
    // 未决定的 allowBuilds 占位符：不致命，[3] 会自动补好，但值得说一句
    const placeholders = [...ws.matchAll(/^\s*['"]?([^'":\s]+)['"]?\s*:\s*set this to true or false/gim)].map((m) => m[1]);
    if (placeholders.length > 0) {
      notices.push({
        id: 'allowbuilds-placeholder',
        level: 'warn',
        text: `allowBuilds 里还有 ${placeholders.length} 个未决定的占位符（${placeholders.join('、')}）—— 安装时会自动补成 false。`,
      });
    }
  }

  return { ok: problems.length === 0, problems, notices };
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
 *
 * ★ async：装配层要跑一次 `dsh --profile <p> --dump-config`。改成 async 是为了
 *   在它跑的时候事件循环仍然能响应进度轮询 —— 否则界面上的计时会突然冻住几秒，
 *   那看起来和「卡死」没有区别，恰好毁掉这个功能存在的意义。
 */
export async function verifyInstalled(pkgName, ctx, { signal = null } = {}) {
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
  const tree = await composedTree(ctx.profileState.profile, process.env, { signal });
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
export async function bootVerify(ctx, { timeoutMs = 45_000, signal = null } = {}) {
  const binJs = ctx.env.dsh.dir ? path.join(ctx.env.dsh.dir, 'lib', 'bin.js') : null;
  if (!binJs || !fs.existsSync(binJs)) {
    return { ok: false, error: '找不到 dsh 的 lib/bin.js，无法做真实启动校验' };
  }

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

  // ★ 边跑边看输出：用 spawnCaptureAsync 的输出回调记录「有没有出现监听地址」，
  //   再用一个并行的 Promise.race 收尾，而不是轮询一个字符串缓冲区。
  let sawUrl = false;
  let text = '';
  const onOutput = (chunk) => {
    text += chunk;
    if (/dsh web:\s*http/i.test(chunk)) sawUrl = true;
  };

  const proc = spawnCaptureAsync(
    process.execPath,
    [binJs, 'web', '--no-open', '--port', '0'],
    { env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' }, cwd: ctx.profileState?.dir, timeout: timeoutMs, signal, onOutput },
  );

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(700);
    if (sawUrl) break;
    // 进程已结束时没必要再等满超时
    if (proc.settled()) break;
  }
  await sleep(1200);

  // 结束它（端口 0 起的临时实例不能留着）
  proc.kill('boot-verify-done');
  const res = await proc;

  const fatalHits = FATAL.filter((re) => re.test(text)).map((re) => re.source);
  const warnings = [...text.matchAll(/^.*(?:warning|did not activate|pending \(waiting).*$/gim)].map((m) => m[0].trim()).slice(0, 10);

  return {
    ok: sawUrl && fatalHits.length === 0,
    sawUrl,
    fatalHits,
    warnings,
    exitCode: res.status,
    timedOut: res.timedOut,
    output: tail(text, 6000),
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

  // ★ 校验和以**安装规格**为准（它直接来自那个插件的配置文件），
  //   条目的 sha256 只作兜底。两处不一致时宁可什么都不装 ——
  //   这种不一致本身就是「有人在改配置文件而没重新生成」的信号。
  const expected = installSpec.sha256 ?? entry?.sha256 ?? null;
  if (installSpec.sha256 && entry?.sha256 && installSpec.sha256 !== entry.sha256) {
    return {
      ok: false,
      error: `配置文件里的 sha256（${String(installSpec.sha256).slice(0, 12)}…）与目录索引里的`
        + `（${String(entry.sha256).slice(0, 12)}…）不一致 —— 拒绝安装。`
        + '这通常意味着目录没重新生成，请刷新目录后重试。',
    };
  }

  const base = path.basename(new URL(installSpec.downloadUrl).pathname);
  const dest = path.join(tarballCacheDir(), base);
  if (fs.existsSync(dest) && expected && sha256File(dest) === expected) {
    return { ok: true, spec: dest, file: dest, kind: 'local-tarball', source: 'cache' };
  }
  try {
    const r = await downloadTarball(installSpec.downloadUrl, dest, { expectedSha256: expected ?? undefined });
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
 * @param {object}   o
 * @param {object}   o.entry    目录条目
 * @param {object}   o.ctx      gctx()
 * @param {object}   o.gate     runGate() 的结果
 * @param {object}   [o.job]    进度上下文：{ phase(id), note(text), signal, noteOutput(chunk) }
 *                              —— 给了就上报阶段，没给就当纯函数用（测试里很需要）
 * @returns {object} 结构化结果：steps[] 记录了每一步，failure 时含 rollback 结果
 */
export async function installPlugin({ entry, ctx, gate, options = {}, job = null }) {
  const profile = ctx.profileState.profile;
  const pkgName = entry.package ?? entry.id;
  const steps = [];
  const timings = {};

  const phase = (id) => {
    if (!job) return;
    job.phase(id);
  };

  const log = (id, label, status, detail, extra = {}) => {
    const step = { id, label, status, detail, at: new Date().toISOString(), ...extra };
    steps.push(step);
    if (job) {
      job.steps = steps;
      job.step = step;
    }
    return step;
  };

  /** 记录一个阶段的耗时（用于本机 ETA 学习） */
  const timePhase = async (id, fn) => {
    const t0 = Date.now();
    phase(id);
    try {
      return await fn();
    } finally {
      timings[id] = Date.now() - t0;
    }
  };

  if (!gate?.canInstall) {
    log('gate', '装前检查', 'fail', '闸门未放行，安装中止。');
    return { ok: false, steps, failure: 'gate-blocked', gate, timings };
  }

  const cancelled = () => aborted(job);

  // ── [0.5] profile 装前体检 ───────────────────────────────
  //
  // ★ 断链的 file: 依赖会让 pnpm 解析整棵依赖树时反复失败/重试，
  //   表现为「装很久装不上」。这里直接拦下来并给出可点的修复项。
  const pf = await timePhase('preflight', async () => preflight(gctxOf(ctx)));
  for (const n of pf.notices) log(`preflight-${n.id}`, '装前体检', n.level === 'ok' ? 'ok' : 'warn', n.text);
  if (!pf.ok) {
    for (const p of pf.problems) {
      log(`preflight-${p.id}`, `装前体检 · ${p.title}`, 'fail', `${p.detail}${p.items?.length ? `\n${p.items.map((i) => `· ${i}`).join('\n')}` : ''}`);
    }
    return { ok: false, steps, failure: 'preflight', preflight: pf, timings };
  }

  // ── [1] 取 tarball ──────────────────────────────────────
  if (cancelled()) return { ok: false, steps, failure: 'aborted-by-user', timings };
  const mat = await timePhase('fetch', async () => materializeSpec(gate.installSpec, entry, { signal: job?.signal ?? null }));
  if (!mat.ok) {
    log('fetch', '获取安装包', mat.canceled || /abort/i.test(String(mat.error)) ? 'warn' : 'fail', mat.error);
    return { ok: false, steps, failure: mat.canceled ? 'aborted-by-user' : 'fetch', timings };
  }
  log('fetch', '获取安装包', 'ok',
    mat.kind === 'local-tarball'
      ? `${mat.source === 'download' ? '已从 GitHub 下载' : '使用本地 tarball'}：${mat.spec}${mat.bytes ? `（${(mat.bytes / 1024).toFixed(1)} KB）` : ''}`
      : `安装规格：${mat.spec}（${mat.kind}）`);

  // ── [2] 备份 ────────────────────────────────────────────
  if (cancelled()) return { ok: false, steps, failure: 'aborted-by-user', timings };
  const backup = await timePhase('backup', async () => backupProfile(profile, { label: `install-${pkgName}`.replace(/[^A-Za-z0-9._@-]/g, '_') }));
  if (!backup.ok) {
    log('backup', '备份 profile', 'fail', backup.error);
    return { ok: false, steps, failure: 'backup', timings };
  }
  log('backup', '备份 profile', 'ok', `快照：${backup.dir}（${backup.meta.copied.join('、')}）`);

  const rollback = async (reason) => {
    phase('rollback');
    log('rollback', '回滚', 'running', `正在用快照还原 profile…（原因：${reason}）`);
    const t0 = Date.now();
    const r = await restoreProfile(backup.dir, {
      dshDir: ctx.env?.dsh?.dir ?? null,
      signal: null, // ★ 回滚本身不接受中止信号：半途停下会留下更坏的状态
      timeout: TIMEOUTS.relink,
    });
    timings.rollback = Date.now() - t0;
    const step = steps[steps.length - 1];
    step.status = r.ok ? 'ok' : 'fail';
    step.detail = r.ok
      ? `已还原 ${r.results.restored.join('、')}${r.results.deleted.length ? `，并删除 ${r.results.deleted.join('、')}` : ''}`
        + `；重新链接 node_modules：${r.results.relink?.ok ? '成功' : '失败（' + (r.results.relink?.output ?? '') + '）'}`
      : r.error;
    return r;
  };

  // ── [3] allowBuilds 预置 ────────────────────────────────
  await timePhase('allowbuilds', async () => {
    const ab = applyAllowBuilds(ctx.profileState);
    if (!ab.ok) {
      log('allowbuilds', '预置 allowBuilds', 'warn', ab.error);
    } else {
      log('allowbuilds', '预置 allowBuilds', 'ok',
        ab.changed ? `已补上：${ab.added.join('、')}` : '已知的构建脚本放行项都已就位，无需改动');
    }
    return ab;
  });

  // ── [4] 调 dsh 安装 ─────────────────────────────────────
  //
  // ★ 「更新」场景（profile 里已经有一条指向**旧版本 tarball** 的 file: 依赖）
  //   必须先 `remove` 再 `add`。只 add 的话 pnpm 会认为这个依赖已经满足，
  //   dependencies 里那条指向旧 `.tgz` 的规格原封不动 —— 用户点了「更新到 0.3.0」，
  //   结果装的还是 0.2.1，而且**界面会显示成功**。这是最难查的一类「假成功」。
  const previous = (ctx.installed ?? []).find((i) => i.name === pkgName) ?? null;
  const needsRemoveFirst = Boolean(previous?.installed || previous?.spec);

  if (needsRemoveFirst) {
    if (cancelled()) return { ok: false, steps, failure: 'aborted-by-user', timings, backupDir: backup.dir };
    await timePhase('remove', async () => {
      const rm = await dshRun(['plugin', '--profile', profile, 'remove', pkgName], ctx, {
        timeout: TIMEOUTS.remove,
        signal: job?.signal ?? null,
        onOutput: (t) => job?.noteOutput?.(t),
      });
      const rmOut = `${rm.stdout}\n${rm.stderr}`;
      log('install-replace', '移除旧版本', rm.failed ? 'warn' : 'ok',
        rm.failed
          ? `移除 ${pkgName}（旧规格 ${previous?.spec ?? '?'}）时退出码 ${rm.status} —— 继续尝试安装新版本，装完以三层校验为准。`
          : `已移除旧版本（原规格 ${previous?.spec ?? '?'}）`,
        rm.failed ? { output: tail(rmOut, 2000) } : {});
      return rm;
    });
  }

  let attempt;
  let combined;
  let retried = false;

  const runAdd = async (label) => {
    const r = await timePhase('install', async () => dshRun(['plugin', '--profile', profile, 'add', mat.spec], ctx, {
      timeout: TIMEOUTS.install,
      signal: job?.signal ?? null,
      onOutput: (t) => job?.noteOutput?.(t),
    }));
    void label;
    return r;
  };

  attempt = await runAdd('第 1 次');
  combined = `${attempt.stdout}\n${attempt.stderr}`;

  // ★ 用户主动中止：不要报「失败」，也不要假装修好了 —— 先回滚，
  //   然后如实说明「已中止」，并把手动安装命令给全。中止后 profile 必须是干净的。
  if (attempt.canceled || cancelled()) {
    log('install', '执行安装', 'warn', '安装已按你的要求中止（子进程连同它的子进程一起结束了）。正在把 profile 还原到安装前。');
    const r = await rollback('用户中止安装');
    log('done', '已中止', 'warn', '这次安装没有完成。profile 已回到安装前的状态；下面的手动命令可以让你自己控制节奏。');
    return { ok: false, steps, failure: 'aborted-by-user', aborted: true, rollback: r, backupDir: backup.dir, output: tail(combined, 4000), timings };
  }

  if (attempt.failed && /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(combined)) {
    const blocked = parseBlockedBuilds(combined);
    log('install-attempt', '安装（第 1 次）', 'warn',
      `pnpm 因未批准的构建脚本以非 0 退出（${blocked.join('、') || '未知包'}）。已按 pnpm 的提示补进 allowBuilds 并重试一次 —— `
      + '注意这一步不能跳：pnpm 非 0 时 dsh 不会把包写进 bundles。');
    // 重新读盘再合并（必须用最新内容，不能重放旧快照）
    const entries = Object.fromEntries([...Object.keys(KNOWN_ALLOW_BUILDS), ...blocked].map((k) => [k, false]));
    const ab2 = applyAllowBuilds(readProfileState(profile, process.env), entries);
    log('allowbuilds-retry', '补 allowBuilds', ab2.ok ? 'ok' : 'warn',
      ab2.changed ? `已补上：${ab2.added.join('、')}` : (ab2.error ?? '无需改动'));
    if (cancelled()) {
      const r = await rollback('用户中止安装');
      return { ok: false, steps, failure: 'aborted-by-user', aborted: true, rollback: r, timings };
    }
    attempt = await runAdd('第 2 次');
    combined = `${attempt.stdout}\n${attempt.stderr}`;
    retried = true;

    if (attempt.canceled || cancelled()) {
      const r = await rollback('用户中止安装');
      return { ok: false, steps, failure: 'aborted-by-user', aborted: true, rollback: r, timings };
    }
  }

  // ★ 成功判据：pnpm 退出码为 0
  if (attempt.failed) {
    const why = attempt.timedOut
      ? `超过本阶段的硬上限（${Math.round(TIMEOUTS.install / 1000)} 秒）仍未结束，已强制中止并回滚。`
      : `dsh plugin add 以退出码 ${attempt.status} 结束${retried ? '（重试后仍然失败）' : ''}。`;
    log('install', '执行安装', 'fail',
      `${why}按 dsh 的语义，只要 pnpm 非 0，它就不会把包写进 dsh.profile.bundles —— `
      + '所以即使 node_modules 里已经能看到文件，这次安装也算没完成。',
      { output: tail(combined, 5000) });
    const r = await rollback(attempt.timedOut ? '安装超时' : '安装命令失败');
    return {
      ok: false, steps, failure: attempt.timedOut ? 'timeout' : 'install-command',
      timedOut: attempt.timedOut, rollback: r, output: tail(combined, 5000), timings,
    };
  }
  log('install', '执行安装', 'ok', `dsh plugin add 退出码 0${retried ? '（重试后成功）' : ''}`, { output: tail(combined, 3000) });

  // ── [5] 校验 ────────────────────────────────────────────
  phase('verify');
  const verify = await verifyInstalled(pkgName, ctx, { signal: job?.signal ?? null });
  for (const layer of verify.layers) {
    log(`verify-${layer.id}`, `校验 · ${layer.label}`, layer.ok ? 'ok' : 'fail', layer.detail);
  }

  if (!verify.ok) {
    const r = await rollback('安装后校验未通过');
    return { ok: false, steps, failure: 'verify', verify, rollback: r, timings };
  }

  // 成功也要把「已装但不在 bundles」这类可修复残留标出来
  log('done', '完成', 'ok', `${pkgName} 已安装并通过三层校验。重启 dsh web 后生效。`);

  return {
    ok: true,
    steps,
    verify,
    backupDir: backup.dir,
    tarball: mat.spec,
    needsRestart: true,
    restartHint: '新增的 bundle 是在启动时合成的，必须重启 dsh web 才会出现。',
    timings,
  };
}

/** installPlugin 内部只需要 profileState / env / installed，这里做个小适配 */
function gctxOf(ctx) {
  return { profileState: ctx.profileState, env: ctx.env, installed: ctx.installed };
}

// ─────────────────────────────────────────────────────────────
// 卸载 / 修复 / 手动回滚
// ─────────────────────────────────────────────────────────────

export async function uninstallPlugin({ entry, ctx, job = null }) {
  const profile = ctx.profileState.profile;
  const pkgName = entry.package ?? entry.id;
  const steps = [];
  const backup = backupProfile(profile, { label: `uninstall-${pkgName}`.replace(/[^A-Za-z0-9._@-]/g, '_') });
  if (!backup.ok) return { ok: false, steps, failure: 'backup', error: backup.error };
  steps.push({ id: 'backup', label: '备份 profile', status: 'ok', detail: backup.dir });

  job?.phase?.('remove');
  const attempt = await dshRun(['plugin', '--profile', profile, 'remove', pkgName], ctx, {
    timeout: TIMEOUTS.remove,
    signal: job?.signal ?? null,
    onOutput: (t) => job?.noteOutput?.(t),
  });
  const combined = `${attempt.stdout}\n${attempt.stderr}`;
  if (attempt.failed) {
    steps.push({ id: 'uninstall', label: '执行卸载', status: 'fail', detail: `退出码 ${attempt.status}`, output: tail(combined, 4000) });
    const r = await restoreProfile(backup.dir, { dshDir: ctx.env?.dsh?.dir ?? null, signal: null, timeout: TIMEOUTS.relink });
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
export async function repairProfile({ ctx, job = null }) {
  const profile = ctx.profileState.profile;
  const backup = backupProfile(profile, { label: 'repair' });
  job?.phase?.('install');
  const res = await dshRun(['plugin', '--profile', profile, 'install'], ctx, {
    timeout: TIMEOUTS.install,
    signal: job?.signal ?? null,
    onOutput: (t) => job?.noteOutput?.(t),
  });
  const combined = `${res.stdout}\n${res.stderr}`;

  const state = readProfileState(profile, process.env);
  const depNames = new Set(Object.keys(state.dependencies));
  const inBox = new Set(ctx.compat?.inBoxBundles ?? []);
  const orphan = state.bundles.filter((b) => !depNames.has(b) && !inBox.has(b));

  return {
    ok: !res.failed && orphan.length === 0,
    exitCode: res.status,
    timedOut: res.timedOut,
    output: tail(combined, 6000),
    backupDir: backup.ok ? backup.dir : null,
    orphansBefore: (ctx.profileState?.bundles ?? []).filter((b) => !new Set(Object.keys(ctx.profileState?.dependencies ?? {})).has(b) && !inBox.has(b)),
    orphansAfter: orphan,
    bundles: state.bundles,
  };
}

/** 用户主动回滚到某次快照 */
export async function rollbackTo({ backupDir, ctx }) {
  const r = await restoreProfile(backupDir, { dshDir: ctx?.env?.dsh?.dir ?? null, signal: null, timeout: TIMEOUTS.relink });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, results: r.results, needsRestart: true };
}

/**
 * 从 profile 里摘掉一条依赖（「移除断链依赖」的一键修复）。
 *
 * ★ 这是一个**只增不减风险**的操作，所以刻意做成两步：
 *   先备份，再 remove；remove 失败就用快照还原。绝不允许它留下半截状态。
 */
export async function removeDependency({ ctx, pkgName, job = null }) {
  const profile = ctx.profileState.profile;
  const steps = [];
  const backup = backupProfile(profile, { label: `remove-dep-${pkgName}`.replace(/[^A-Za-z0-9._@-]/g, '_') });
  if (!backup.ok) return { ok: false, steps, failure: 'backup', error: backup.error };
  steps.push({ id: 'backup', label: '备份 profile', status: 'ok', detail: backup.dir });

  job?.phase?.('remove');
  const res = await dshRun(['plugin', '--profile', profile, 'remove', pkgName], ctx, {
    timeout: TIMEOUTS.remove,
    signal: job?.signal ?? null,
    onOutput: (t) => job?.noteOutput?.(t),
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  if (res.failed) {
    steps.push({ id: 'remove', label: '移除依赖', status: 'fail', detail: `退出码 ${res.status}`, output: tail(combined, 3000) });
    const r = await restoreProfile(backup.dir, { dshDir: ctx.env?.dsh?.dir ?? null, signal: null, timeout: TIMEOUTS.relink });
    steps.push({ id: 'rollback', label: '回滚', status: r.ok ? 'ok' : 'fail', detail: r.ok ? '已还原快照' : r.error });
    return { ok: false, steps, failure: 'remove-command', output: tail(combined, 3000) };
  }
  steps.push({ id: 'remove', label: '移除依赖', status: 'ok', detail: `已移除 ${pkgName}` });

  const after = preflight({ profileState: readProfileState(profile, process.env), env: ctx.env });
  steps.push({
    id: 'recheck', label: '复检', status: after.ok ? 'ok' : 'warn',
    detail: after.ok ? 'profile 里已没有断链依赖' : `仍有 ${after.problems.length} 类问题，见上。`,
  });
  return { ok: after.ok, steps, preflight: after, needsRestart: false };
}
