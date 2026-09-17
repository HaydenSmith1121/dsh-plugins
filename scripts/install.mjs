#!/usr/bin/env node
/**
 * dsh-plugins — 安装执行器
 * ============================================================================
 * 先跑 preflight 拿判定，再「按判定」执行。不会盲目照抄一套固定步骤。
 *
 *   缺 pnpm      → 在 dsh 所在的那个 Node 上补装
 *   dsh 版本不符 → 打印该装哪个版本，停下来（除非 --force）
 *   allowBuilds  → 事前补好，规避 ERR_PNPM_IGNORED_BUILDS
 *   环境就绪     → 按 bundle 顺序逐个 add
 *
 * 用法：
 *   node scripts/install.mjs                 # 正常安装
 *   node scripts/install.mjs --dry-run       # 只打印将要执行的命令
 *   node scripts/install.mjs --force         # dsh 版本不符时也继续（危险）
 *   node scripts/install.mjs --skip-verify   # 装完不做启动校验
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const hasColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (hasColor ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const cyan = (s) => paint('36', s);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const SKIP_VERIFY = argv.includes('--skip-verify');
const profileArgIdx = argv.indexOf('--profile');
const PROFILE = profileArgIdx >= 0 && argv[profileArgIdx + 1] ? argv[profileArgIdx + 1] : null;

const IS_WIN = process.platform === 'win32';

function die(msg, code = 1) {
  console.error('\n' + red('✗ ') + msg + '\n');
  process.exit(code);
}

function quoteArg(a) {
  const s = String(a);
  if (IS_WIN) return '"' + s.replace(/"/g, '""') + '"';
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** 拼一条命令并执行；shell 是必需的（Windows 上要跑 .cmd，POSIX 上 dsh 是脚本） */
function run(cmd, { quiet = false, allowFail = false } = {}) {
  if (DRY_RUN) {
    console.log('    ' + dim('$ ') + cmd);
    return { ok: true, output: '', dryRun: true };
  }
  const res = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = (res.stdout || '') + (res.stderr || '');
  if (!quiet && output.trim()) console.log(output.trimEnd());
  const ok = res.status === 0;
  if (!ok && !allowFail) {
    console.error('\n' + red('✗ ') + '命令失败：' + cmd);
    console.error(output.trimEnd());
    process.exit(1);
  }
  return { ok, output, status: res.status };
}

// ---------------------------------------------------------------- 1. 预检
console.log();
console.log(bold('  dsh-plugins 安装') + (DRY_RUN ? yellow('   [演练模式，不会真正执行]') : ''));
console.log('  ' + dim('─'.repeat(74)));
console.log('  ' + dim('[1/5] 环境预检…'));

const preflightJs = path.join(__dirname, 'preflight.mjs');
const pf = spawnSync(
  process.execPath,
  [preflightJs, '--json', ...(PROFILE ? ['--profile', PROFILE] : [])],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
);

let report;
try {
  report = JSON.parse(pf.stdout);
} catch {
  console.error(red('预检输出无法解析：'));
  console.error(pf.stdout || '(空)');
  console.error(pf.stderr || '');
  process.exit(3);
}

const profile = report.profile;
const compat = JSON.parse(fs.readFileSync(report.compatPath, 'utf8'));

for (const ck of report.checks) {
  const s = ck.level === 'ok' ? green('✓') : ck.level === 'warn' ? yellow('!') : red('✗');
  console.log(`  ${s} ${ck.label.padEnd(11)} ${dim(ck.detail)}`);
}

// ---------------------------------------------------------------- 2. 判定
console.log();
console.log('  ' + dim('[2/5] 判定…'));

if (report.verdict === 'need-dsh' || report.verdict === 'dsh-version-unsupported') {
  console.log('  ' + red('✗ ') + 'dsh 不满足要求，无法继续。');
  console.log();
  if (report.notes.length) for (const n of report.notes) console.log('  ' + yellow('! ') + n + '\n');
  console.log('  ' + bold('请先执行：'));
  for (const a of report.actions) console.log('    ' + cyan(a));
  console.log();
  if (!FORCE) {
    console.log('  ' + dim('（确认要在当前 dsh 版本上强装，可加 --force，但启动很可能失败）'));
    console.log();
    process.exit(2);
  }
  console.log('  ' + yellow('! ') + '--force 已指定，继续安装 —— 启动失败请自行承担\n');
}

// ---------------------------------------------------------------- 3. 补齐环境
console.log('  ' + dim('[3/5] 补齐缺失的环境…'));

// 3a. pnpm
if (report.verdict === 'need-pnpm' || !report.pnpm.installed || !report.pnpm.sameNodeAsDsh) {
  const npmp = IS_WIN ? 'npm.cmd' : 'npm';
  if (!report.dsh.prefix) {
    die('无法确定 dsh 的安装位置，请手动安装 pnpm 后重试。');
  }
  const npmCmd = path.join(report.dsh.prefix, npmp);
  if (!fs.existsSync(npmCmd) && !DRY_RUN) {
    die(`找不到 ${npmCmd}\n请确认 dsh 是用 npm 全局安装的，或手动安装 pnpm。`);
  }
  console.log(`  ${yellow('!')} pnpm 缺失或装错了 Node，正在用 dsh 所在 Node 的 npm 安装…`);
  console.log(`    ${dim('目标位置：')}${report.dsh.prefix}`);
  run(`${quoteArg(npmCmd)} install -g pnpm --no-fund --no-audit`);
  console.log('  ' + green('✓ ') + 'pnpm 已安装\n');
} else {
  console.log('  ' + green('✓ ') + `pnpm ${report.pnpm.version ?? ''} 已就位（与 dsh 同一个 Node）\n`);
}

// 3b. allowBuilds —— 事前补好，避免撞 ERR_PNPM_IGNORED_BUILDS
const wanted = compat.allowBuilds?.packages ?? {};
const wsYaml = path.join(report.profileDir, 'pnpm-workspace.yaml');

function ensureAllowBuilds() {
  const changes = [];
  let text = fs.existsSync(wsYaml) ? fs.readFileSync(wsYaml, 'utf8') : '';

  // ① pnpm 失败时自己会写占位符，把它填成 false
  for (const pkg of Object.keys(wanted)) {
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(\\s*)['"]?${esc}['"]?\\s*:\\s*set this to true or false\\s*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, `$1'${pkg}': false`);
      changes.push(`${pkg}（占位符 → false）`);
    }
  }

  // ② 还没出现的包，补进 allowBuilds 块
  const missing = Object.keys(wanted).filter((pkg) => {
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^\\s*['"]?${esc}['"]?\\s*:\\s*(false|true)\\s*$`, 'm').test(text);
  });

  if (missing.length) {
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => /^allowBuilds\s*:/.test(l));
    if (idx >= 0) {
      let end = idx + 1;
      while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
      lines.splice(end, 0, ...missing.map((p) => `  '${p}': false`));
      text = lines.join('\n');
    } else {
      text = text.replace(/\s*$/, '') + '\n\nallowBuilds:\n' + missing.map((p) => `  '${p}': false`).join('\n') + '\n';
    }
    changes.push(...missing.map((p) => `${p}（新增）`));
  }

  return { changes, text };
}

const ab = ensureAllowBuilds();
if (!fs.existsSync(report.profileDir) && !DRY_RUN) {
  console.log('  ' + dim('profile 目录尚不存在，先初始化…'));
  run(`${quoteArg(report.dsh.launcher)} --profile ${profile} --version`, { quiet: true });
}

if (ab.changes.length === 0) {
  console.log('  ' + green('✓ ') + 'allowBuilds 已就绪，无需改动\n');
} else {
  if (fs.existsSync(report.profileDir)) {
    fs.mkdirSync(path.dirname(wsYaml), { recursive: true });
    if (!DRY_RUN) fs.writeFileSync(wsYaml, ab.text, 'utf8');
    console.log(`  ${green('✓')} allowBuilds 已写入：${ab.changes.join('、')}`);
    console.log('    ' + dim('作用：pnpm 10+ 默认拦截依赖的构建脚本，不处理会在安装时报'));
    console.log('    ' + dim('ERR_PNPM_IGNORED_BUILDS —— 而且是「包装好了但 GUI 里看不到」的假象。') + '\n');
  } else {
    console.log('  ' + dim('（profile 目录未初始化，稍后会自动处理 allowBuilds）') + '\n');
  }
}

// 保存一份，供安装失败后重试时使用
const allowBuildsSnapshot = ab.text;

// ---------------------------------------------------------------- 4. 安装
console.log('  ' + dim('[4/5] 安装插件…'));

const runtime = compat.runtimes.find((r) => r.dshVersion === report.dsh.version);
const plugins = runtime?.plugins ?? [];
if (!plugins.length) {
  die(`没有找到适配 dsh ${report.dsh.version} 的插件集。请查看 CONTRIBUTING.md 了解如何补充适配。`, 3);
}

const expectedBundles = compat.inBoxBundles.concat(plugins.map((p) => p.package));
console.log('  ' + dim(`  顺序即 bundle 层级顺序，共 ${plugins.length} 个：`));

let failed = [];
for (let i = 0; i < plugins.length; i++) {
  const p = plugins[i];
  const abs = path.join(REPO_ROOT, p.tarball);
  const tag = `  ${dim(`[${i + 1}/${plugins.length}]`)} ${p.package}`;

  if (!fs.existsSync(abs) && !DRY_RUN) {
    console.log(`${tag}  ${red('✗')} tarball 不存在：${abs}`);
    failed.push(p.package);
    continue;
  }

  console.log(`${tag}  ${p.origin === 'self' ? dim('自研') : dim('第三方')}`);
  const cmd = `${quoteArg(report.dsh.launcher)} plugin --profile ${profile} add ${quoteArg(abs)}`;
  let r = run(cmd, { quiet: true, allowFail: true });

  // ★ 命中 pnpm 构建脚本拦截：补 allowBuilds 后重试一次
  if (!r.ok && /ERR_PNPM_IGNORED_BUILDS/i.test(r.output)) {
    console.log(`    ${yellow('!')} 撞到 ERR_PNPM_IGNORED_BUILDS，补 allowBuilds 后重试…`);
    if (!DRY_RUN) {
      let text = fs.existsSync(wsYaml) ? fs.readFileSync(wsYaml, 'utf8') : allowBuildsSnapshot;
      for (const pkg of Object.keys(wanted)) {
        const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(
          new RegExp(`^(\\s*)['"]?${esc}['"]?\\s*:\\s*set this to true or false\\s*$`, 'm'),
          `$1'${pkg}': false`
        );
      }
      fs.writeFileSync(wsYaml, text, 'utf8');
    }
    r = run(cmd, { quiet: true, allowFail: true });
  }

  if (r.ok) {
    console.log(`    ${green('✓')} 已加入 bundles`);
  } else {
    console.log(`    ${red('✗')} 安装失败`);
    const tail = r.output.trim().split('\n').slice(-6).join('\n');
    if (tail) console.log(dim(tail.split('\n').map((l) => '      ' + l).join('\n')));
    failed.push(p.package);
  }
}

console.log();
if (failed.length) {
  console.log('  ' + yellow('! ') + `${failed.length} 个插件没装成功：${failed.join(', ')}`);
  console.log('    ' + dim('提示：只要 pnpm 退出码非 0，dsh 就不会把该包写进 bundles ——'));
  console.log('    ' + dim('即使 node_modules 里已经能看到文件，也当作「没装完」。') + '\n');
} else {
  console.log('  ' + green('✓ ') + `${plugins.length}/${plugins.length} 个插件全部安装成功\n`);
}

// ---------------------------------------------------------------- 5. 校验
if (SKIP_VERIFY || DRY_RUN) {
  console.log('  ' + dim('[5/5] 已跳过校验' + (DRY_RUN ? '（演练模式）' : '（--skip-verify）')) + '\n');
  if (DRY_RUN) {
    console.log('  ' + bold('演练结束，没有做任何改动。') + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

console.log('  ' + dim('[5/5] 校验…'));
console.log('  ' + dim('─'.repeat(74)));
const verify = spawnSync(process.execPath, [path.join(__dirname, 'verify.mjs'), '--profile', profile], {
  stdio: 'inherit',
});
process.exit(verify.status ?? 1);
