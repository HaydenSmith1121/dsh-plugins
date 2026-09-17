#!/usr/bin/env node
/**
 * dsh-plugins — 环境预检（只读）
 * ============================================================================
 * 这个脚本「只看不动」：它检测机器上有什么、和 compatibility.json 比对、
 * 然后告诉你接下来该做什么。它绝不安装、不写文件、不改配置。
 *
 * 之所以把逻辑放在 Node 里，而不是分别写在 .ps1 和 .sh 里：
 *   install.ps1 / install.sh 只负责「找到 node 并把控制权交给这里」。
 *   判定逻辑只有一份实现，两个平台就不会行为漂移。
 *
 * 用法：
 *   node scripts/preflight.mjs              人类可读报告
 *   node scripts/preflight.mjs --json       机器可读（供 install 脚本消费）
 *   node scripts/preflight.mjs --profile web
 *
 * 退出码：
 *   0  环境就绪，可以直接安装
 *   1  缺 pnpm —— 可以由安装脚本自动补上
 *   2  缺 dsh 或 dsh 版本不受支持 —— 需要先处理（脚本会打印具体命令）
 *   3  预检本身出错（找不到兼容清单等）
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 输出着色
const hasColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (hasColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const cyan = (s) => paint('36', s);
const symOk = () => green('✓');
const symWarn = () => yellow('!');
const symBad = () => red('✗');

// ---------------------------------------------------------------- 命令行
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const profileArg = (() => {
  const i = argv.indexOf('--profile');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------- 工具函数

/** 在 PATH 里按顺序找一个可执行文件；Windows 会补 PATHEXT 后缀。 */
function findInPath(basenames) {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [];
  const dirs = (process.env.PATH || '')
    .split(path.delimiter)
    .map((d) => d.replace(/^"|"$/g, '').trim())
    .filter(Boolean);

  for (const dir of dirs) {
    for (const name of basenames) {
      const candidates = isWin ? exts.map((e) => name + e) : [name];
      for (const cand of candidates) {
        const full = path.join(dir, cand);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          /* 不存在就继续 */
        }
      }
    }
  }
  return null;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 比较 semver（只处理 x.y.z 和 -prerelease，够用）。返回 -1 / 0 / 1 */
function cmpVersion(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < 3; i++) {
    if ((A.nums[i] || 0) !== (B.nums[i] || 0)) return (A.nums[i] || 0) > (B.nums[i] || 0) ? 1 : -1;
  }
  // 有预发布号 < 无预发布号
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre === B.pre) return 0;
  return A.pre > B.pre ? 1 : -1;
}

// ---------------------------------------------------------------- 检测项

const checks = [];
const actions = [];
const notes = [];
const add = (level, label, detail, hint) => checks.push({ level, label, detail, hint });

// ---- 0. 兼容清单 ----
const compatPath = path.join(REPO_ROOT, 'compatibility.json');
const compat = readJsonSafe(compatPath);
if (!compat) {
  console.error(red(`找不到或无法解析 ${compatPath}`));
  console.error('请在仓库根目录下运行本脚本。');
  process.exit(3);
}
const profile = profileArg || compat.profile || 'web';

// ---- 1. Node ----
const nodeVersion = process.versions.node;
const nodeMin = compat.requirements?.node?.min ?? '0.0.0';
if (cmpVersion(nodeVersion, nodeMin) >= 0) {
  add('ok', 'Node', `${nodeVersion}  (要求 >= ${nodeMin})`);
} else {
  add('bad', 'Node', `${nodeVersion}  低于要求的 ${nodeMin}`, `升级 Node 到 ${nodeMin} 或更高`);
}

// ---- 2. dsh ----
// 先沿 PATH 找 dsh 启动器，再据此定位它所属的 npm prefix，
// 最后直接读包的 package.json 拿版本 —— 比跑 `dsh --version` 快且不启进程。
const dshLauncher = findInPath(['dsh']);
let dsh = { installed: false, launcher: null, prefix: null, version: null, pkgPath: null };

if (dshLauncher) {
  dsh.launcher = dshLauncher;
  const shimDir = path.dirname(dshLauncher);
  const pkgCandidates = [
    path.join(shimDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), // Windows npm global
    path.join(shimDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), // POSIX npm global
    path.join(shimDir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), // 同層 fallback
  ];
  for (const c of pkgCandidates) {
    const pkg = readJsonSafe(c);
    if (pkg?.version) {
      dsh.pkgPath = c;
      dsh.version = pkg.version;
      // Windows: <prefix>\dsh.cmd  → prefix 就是 shimDir
      // POSIX:   <prefix>/bin/dsh  → prefix 是 shimDir 的上一级
      dsh.prefix = process.platform === 'win32' ? shimDir : path.dirname(shimDir);
      break;
    }
  }
  // 兜底：直接问 dsh 自己
  if (!dsh.version) {
    try {
      const out = execFileSync(dshLauncher, ['--version'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
      if (m) dsh.version = m[0];
    } catch {
      /* 保持 null */
    }
  }
  if (dsh.version) dsh.installed = true;
}

if (!dsh.installed) {
  add('bad', 'dsh', '未安装，或不在当前 PATH 里', '按下方「接下来做什么」安装');
}

// ---- 3. 匹配运行时（compatibility.json 的 runtime） ----
const runtimes = compat.runtimes || [];
const runtime = dsh.version ? runtimes.find((r) => r.dshVersion === dsh.version) : null;

if (dsh.installed) {
  if (runtime?.status === 'supported') {
    add('ok', 'dsh', `${dsh.version}  @ ${dsh.prefix ?? '?'}  →  受支持`);
  } else if (runtime) {
    add(
      'bad',
      'dsh',
      `${dsh.version}  →  ${runtime.status === 'unsupported' ? '不受支持' : runtime.status}`,
      runtime.reason
    );
  } else {
    add('warn', 'dsh', `${dsh.version}  →  本仓库尚未适配这个版本`, '可参考 CONTRIBUTING.md 补一份适配包，或降/升到已适配的版本');
  }
}

// ---- 4. pnpm（关键：必须在「dsh 所在的那个 Node」上） ----
let pnpm = { installed: false, path: null, version: null, sameNodeAsDsh: false, strayCopies: [] };

if (process.platform === 'win32') {
  for (const n of ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat']) {
    const p = path.join(dsh.prefix || process.env.APPDATA || '', n);
    if (exists(p)) { pnpm.path = p; break; }
  }
} else if (dsh.prefix) {
  const p = path.join(dsh.prefix, 'bin', 'pnpm');
  if (exists(p)) pnpm.path = p;
}

// 没有 dsh prefix 信息时退回 PATH 查找
if (!pnpm.path) {
  const fromPath = findInPath(['pnpm']);
  if (fromPath) pnpm.path = fromPath;
}
if (pnpm.path) {
  pnpm.installed = true;
  pnpm.sameNodeAsDsh = !dsh.prefix || pnpm.path.startsWith(dsh.prefix);
  try {
    pnpm.version = execFileSync(pnpm.path, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* 拿不到版本不算致命 */
  }
}
// 找出「装到了别的 Node」上的 pnpm（多 Node 环境最常见的坑）
if (dsh.prefix && pnpm.path && !pnpm.sameNodeAsDsh) {
  pnpm.strayCopies.push(pnpm.path);
}

if (!pnpm.installed) {
  add('bad', 'pnpm', '未安装 —— dsh plugin 底层就是转发给 pnpm，没有它一切安装命令都会失败', dsh.prefix ? `应装在：${dsh.prefix}` : null);
} else if (!pnpm.sameNodeAsDsh) {
  add(
    'bad',
    'pnpm',
    `${pnpm.version ?? '?'}  但位于 ${pnpm.path} —— 与 dsh 不在同一个 Node`,
    `dsh 在 ${dsh.prefix}。多 Node 环境必须用「dsh 那个 Node 的 npm」装 pnpm，否则 dsh 找不到它`
  );
} else {
  add('ok', 'pnpm', `${pnpm.version ?? '?'}  @ ${pnpm.path}  （与 dsh 同一个 Node）`);
}

// ---- 5. profile 目录 ----
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', profile);
const profilePkgPath = path.join(profileDir, 'package.json');
const profilePkg = readJsonSafe(profilePkgPath);

if (profilePkg) {
  const bundles = profilePkg.dsh?.profile?.bundles ?? [];
  const userBundles = bundles.filter((b) => !b.startsWith('@deepseek-ai/'));
  add('ok', 'profile', `${profileDir}  （bundles ${bundles.length} 项，其中用户插件 ${userBundles.length} 个）`);
} else {
  add('warn', 'profile', `${profileDir} 尚未初始化`, '先跑一次 dsh --profile web --version 让它生成目录');
}

// ---- 6. allowBuilds（pnpm 10+ 构建脚本白名单） ----
const wsYamlPath = path.join(profileDir, 'pnpm-workspace.yaml');
const allowBuildsWanted = compat.allowBuilds?.packages ?? {};
let allowBuildsState = 'n/a';
if (profilePkg) {
  if (!exists(wsYamlPath)) {
    allowBuildsState = 'missing';
    add('warn', 'allowBuilds', 'pnpm-workspace.yaml 不存在', '安装脚本会补上，用于规避 ERR_PNPM_IGNORED_BUILDS');
  } else {
    const yaml = fs.readFileSync(wsYamlPath, 'utf8');
    const hasKey = /^\s*allowBuilds\s*:/m.test(yaml);
    const hasPlaceholder = /set this to true or false/i.test(yaml);
    const covered = Object.keys(allowBuildsWanted).every((k) => {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`['"]?${esc}['"]?\\s*:\\s*(false|true)`, 'm').test(yaml);
    });
    if (hasKey && covered && !hasPlaceholder) {
      allowBuildsState = 'ok';
      add('ok', 'allowBuilds', `已配置 ${Object.keys(allowBuildsWanted).join(', ')}`);
    } else {
      allowBuildsState = hasPlaceholder ? 'placeholder' : 'incomplete';
      add('warn', 'allowBuilds', `需要补全（${allowBuildsState}）`, '安装脚本会写；症状是装完 GUI 里看不到插件');
    }
  }
}

// ---- 7. tarball 存在性 ----
let tarballState = { total: 0, missing: [], plugins: [] };
if (runtime?.status === 'supported') {
  for (const p of runtime.plugins || []) {
    tarballState.total++;
    const abs = path.join(REPO_ROOT, p.tarball);
    if (!exists(abs)) tarballState.missing.push(p.tarball);
    tarballState.plugins.push({ ...p, absPath: abs, present: exists(abs) });
  }
  if (tarballState.missing.length === 0) {
    add('ok', '插件包', `${tarballState.total}/${tarballState.total} 个 tarball 都在位`);
  } else {
    add('bad', '插件包', `${tarballState.missing.length} 个 tarball 缺失：${tarballState.missing.join(', ')}`, 'git clone 不完整？重跑 git checkout -- .');
  }
}

// ---------------------------------------------------------------- 结论
let verdict;
let exitCode;

if (!dsh.installed) {
  verdict = 'need-dsh';
  exitCode = 2;
  actions.push(`npm i -g @deepseek-ai/dsh@${compat.runtimes.find((r) => r.recommended)?.dshVersion ?? '0.1.6-alpha.1'}`);
} else if (!runtime || runtime.status !== 'supported') {
  verdict = 'dsh-version-unsupported';
  exitCode = 2;
  const target = runtime?.upgradeTo ?? compat.runtimes.find((r) => r.recommended)?.dshVersion;
  if (target) {
    actions.push(`npm i -g @deepseek-ai/dsh@${target}`);
    notes.push(
      `⚠ npm i -g @deepseek-ai/dsh（不带版本）装的是 latest 通道 = ${compat.distTags?.latest}，` +
        `对这个仓库来说不够用，而且以后升级会静默降级回去。必须显式带版本号。`
    );
  }
} else if (!pnpm.installed || !pnpm.sameNodeAsDsh) {
  verdict = 'need-pnpm';
  exitCode = 1;
  const npmp = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  actions.push(
    dsh.prefix
      ? `"${path.join(dsh.prefix, npmp)}" install -g pnpm`
      : 'npm install -g pnpm'
  );
  if (dsh.prefix) {
    notes.push(
      `pnpm 必须装在 dsh 所在的那个 Node 上：${dsh.prefix}。` +
        `在多 Node 的机器上直接跑 npm i -g pnpm 很容易装到另一个 Node，` +
        `结果是 dsh plugin 报「'pnpm' 不是内部或外部命令」。`
    );
  }
} else {
  verdict = 'ready';
  exitCode = 0;
}

// ---------------------------------------------------------------- 输出
const report = {
  repoRoot: REPO_ROOT,
  profile,
  profileDir,
  compatPath,
  node: { version: nodeVersion, min: nodeMin, ok: cmpVersion(nodeVersion, nodeMin) >= 0 },
  dsh,
  pnpm,
  runtime: runtime
    ? { dshVersion: runtime.dshVersion, distTag: runtime.distTag, status: runtime.status, plugins: runtime.plugins?.length ?? 0 }
    : null,
  allowBuilds: { state: allowBuildsState, wanted: allowBuildsWanted },
  tarballs: tarballState,
  verdict,
  exitCode,
  actions,
  notes,
  checks,
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(exitCode);
}

const line = '─'.repeat(74);
console.log();
console.log(bold('  dsh-plugins 环境预检') + dim('   （只读，不会改动任何东西）'));
console.log('  ' + dim(line));
console.log(`  仓库      ${REPO_ROOT}`);
console.log(`  profile   ${profile}`);
console.log('  ' + dim(line));
console.log();

for (const ck of checks) {
  const s = ck.level === 'ok' ? symOk() : ck.level === 'warn' ? symWarn() : symBad();
  console.log(`  ${s} ${bold(ck.label.padEnd(11))} ${ck.detail}`);
  if (ck.hint) console.log(`      ${dim('↳ ' + ck.hint)}`);
}

if (runtime?.status === 'supported' && tarballState.plugins.length) {
  console.log();
  console.log('  ' + dim('本机 dsh 版本对应的插件集：'));
  for (const p of tarballState.plugins) {
    const origin = p.origin === 'self' ? '自研' : '第三方';
    const flag = p.peerVerdict === 'critical' ? red('●') : p.peerVerdict === 'warn' ? yellow('●') : dim('●');
    console.log(`    ${flag} ${p.package.padEnd(24)} ${p.version.padEnd(9)} ${dim(origin + (p.localModifications ? ' / 含本地改造' : ''))}`);
  }
  const critical = tarballState.plugins.filter((p) => p.peerVerdict === 'critical');
  if (critical.length) {
    console.log();
    console.log(
      '  ' +
        dim('  ● 红点 = 决定 dsh 版本基线的那一个：') +
        critical.map((p) => p.package).join(', ')
    );
  }
}

console.log();
console.log('  ' + dim(line));
const verdictText = {
  ready: green('环境就绪，可以安装'),
  'need-pnpm': yellow('缺 pnpm —— 安装脚本可以自动补上'),
  'need-dsh': red('还没装 dsh'),
  'dsh-version-unsupported': red('dsh 版本不受支持，需要先换版本'),
}[verdict];
console.log(`  结论：${bold(verdictText ?? verdict)}`);
console.log();

if (notes.length) {
  for (const n of notes) console.log('  ' + yellow('! ') + n);
  console.log();
}

if (actions.length) {
  console.log('  ' + dim('接下来做什么：'));
  for (const a of actions) console.log('    ' + cyan(a));
  console.log();
}

if (verdict === 'ready') {
  const ps = process.platform === 'win32';
  console.log('  ' + dim('直接安装：'));
  console.log('    ' + cyan(ps ? '.\\scripts\\install.ps1' : './scripts/install.sh'));
  console.log();
  console.log('  ' + dim('或者手动按 README-安装说明.md 逐条执行。'));
  console.log();
}

process.exit(exitCode);
