#!/usr/bin/env node
/**
 * dsh-plugins — 安装后校验（只读，除了一次短暂的试启动）
 * ============================================================================
 * 四步校验，缺一不可，因为不同的步骤能查出不同层次的问题：
 *
 *   ① dsh 版本       —— 最先查。版本错了后面全白搭。
 *   ② 依赖层         —— dsh plugin list，包有没有真的装进去。
 *   ③ 装配层         —— --dump-config，bundle 有没有按顺序挂上。
 *                        ★ 它只打配置树、不 import 任何模块。
 *   ④ 真实启动       —— 唯一能验证「模块能不能 import」的办法。
 *                        ★ 导出缺失（0.1.5 线缺 0.1.6 的 API）只有这步查得出。
 *
 * ③ 和 ④ 不能互相替代：③ 查不出 import 失败，④ 查不出 bundles 顺序错。
 *
 * 用法：
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --skip-boot          跳过第 ④ 步
 *   node scripts/verify.mjs --boot-timeout 60    延长试启动观察时间（秒）
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn, execSync } from 'node:child_process';

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
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const PROFILE = argVal('--profile') || 'web';
const SKIP_BOOT = argv.includes('--skip-boot');
const BOOT_TIMEOUT = parseInt(argVal('--boot-timeout') || '35', 10) * 1000;
const IS_WIN = process.platform === 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function quoteArg(a) {
  const s = String(a);
  if (IS_WIN) return '"' + s.replace(/"/g, '""') + '"';
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function sh(cmd, opts = {}) {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

// ---------------------------------------------------------------- 前置
const compat = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'compatibility.json'), 'utf8'));
const pf = sh(`"${process.execPath}" "${path.join(__dirname, 'preflight.mjs')}" --json --profile ${PROFILE}`);
let report;
try {
  report = JSON.parse(pf.out);
} catch {
  console.error(red('预检失败，请先运行：node scripts/preflight.mjs'));
  console.error(pf.out);
  process.exit(3);
}

const launcher = report.dsh.launcher;
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', PROFILE);
const runtime = compat.runtimes.find((r) => r.dshVersion === report.dsh.version) || null;
const userPlugins = runtime?.plugins?.map((p) => p.package) ?? [];

console.log();
console.log(bold('  dsh-plugins 安装后校验'));
console.log('  ' + dim('─'.repeat(74)));
console.log(`  profile   ${PROFILE}      dsh ${report.dsh.version ?? '?'}      ${profileDir}`);
console.log();

const results = [];
function record(no, title, pass, detail, hint) {
  results.push({ no, title, pass });
  const s = pass === true ? green('✓') : pass === false ? red('✗') : yellow('!');
  console.log(`  ${s} ${bold(`[${no}/4] ${title}`)}`);
  if (detail) console.log('      ' + detail);
  if (hint) console.log('      ' + dim('↳ ' + hint));
  console.log();
  return pass;
}

// ---------------------------------------------------------------- ① 版本
{
  const want = compat.runtimes.find((r) => r.recommended)?.dshVersion;
  const got = report.dsh.version;
  if (!got) {
    record(1, 'dsh 版本', false, red('找不到 dsh'), '先按 README-安装说明.md 安装 dsh');
  } else if (runtime?.status === 'supported') {
    record(1, 'dsh 版本', true, `${got}  ${dim('(受支持)')}`);
  } else {
    record(
      1,
      'dsh 版本',
      false,
      `${got}  ${red('不是本仓库适配的版本')}`,
      `应为 ${want}。注意：npm i -g @deepseek-ai/dsh 不带版本会装到 latest 通道，${compat.distTags?.latest} 不够用。`
    );
  }
}

// ---------------------------------------------------------------- ② 依赖层
{
  const r = sh(`${quoteArg(launcher)} plugin --profile ${PROFILE} list`);
  const listed = userPlugins.filter((p) => r.out.includes(p));
  const missing = userPlugins.filter((p) => !r.out.includes(p));
  if (r.status !== 0 && !r.out.trim()) {
    record(2, '依赖层', false, red('dsh plugin list 执行失败'), '多半是 pnpm 没找到，先跑 preflight 看看');
  } else if (missing.length === 0) {
    record(2, '依赖层', true, `期望 ${userPlugins.length} 个，实际全部在列 ✓`);
  } else {
    record(
      2,
      '依赖层',
      false,
      `缺少 ${missing.length} 个：${red(missing.join(', '))}`,
      '重跑安装脚本；若报 ERR_PNPM_IGNORED_BUILDS，说明包进 node_modules 了但没写进 bundles'
    );
  }
}

// ---------------------------------------------------------------- ③ 装配层
let bundleOk = false;
{
  const expected = compat.inBoxBundles.concat(userPlugins);
  const r = sh(`${quoteArg(launcher)} --profile ${PROFILE} --dump-config`);
  const heads = [...r.out.matchAll(/^# == (.+)$/gm)].map((m) => m[1].trim());
  const uniq = [...new Set(heads)];

  const missing = expected.filter((b) => !uniq.includes(b));
  // 顺序：取每个期望 bundle 首次出现的位置，检查单调递增
  const positions = expected.map((b) => heads.indexOf(b)).filter((i) => i >= 0);
  const ordered = positions.every((v, i) => i === 0 || v > positions[i - 1]);

  if (!r.out.trim()) {
    record(3, '装配层', false, red('--dump-config 没有输出'), 'dsh 可能没跑起来，先看 preflight');
  } else if (missing.length) {
    record(
      3,
      '装配层',
      false,
      `缺 ${missing.length} 个 bundle：${red(missing.join(', '))}`,
      'bundles 数组在 profile 的 package.json 里，顺序即层级顺序'
    );
  } else if (!ordered) {
    record(3, '装配层', false, yellow('bundle 顺序与预期不一致'), '按 ' + cyan('profile-config/profile-bundles.yaml') + ' 调整顺序');
  } else {
    bundleOk = true;
    record(
      3,
      '装配层',
      true,
      `${expected.length} 个 bundle 全部就位且顺序正确  ${dim(`（共 ${heads.length} 个分节头，dsh-base 重复出现属正常）`)}`
    );
  }
}

// ---------------------------------------------------------------- ④ 真实启动
if (SKIP_BOOT) {
  record(4, '真实启动', null, dim('已按 --skip-boot 跳过'), '注意：导出缺失这类问题只有这一步能查出来');
} else {
  console.log('  ' + dim(`[4/4] 真实启动…（观察 ${BOOT_TIMEOUT / 1000}s，期间会起一个临时 dsh web）`));
  console.log();

  const child = spawn(`${quoteArg(launcher)} web --no-open --port 0`, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));

  let exitedEarly = false;
  child.on('exit', () => (exitedEarly = true));

  await sleep(BOOT_TIMEOUT);

  // 清理：Windows 要连进程树一起杀
  if (!exitedEarly) {
    try {
      if (IS_WIN) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
      /* 已经退出了 */
    }
  }
  await sleep(500);

  const FATAL = [
    /plugin tree failed to load/i,
    /does not provide an export named/i,
    /SyntaxError/i,
    /ERR_MODULE_NOT_FOUND/,
    /Cannot find module/i,
    /ERR_PNPM_/i,
  ];
  const hit = FATAL.filter((re) => re.test(out));
  const hasUrl = /dsh web:\s*http/i.test(out);

  if (hasUrl && hit.length === 0) {
    const url = (out.match(/dsh web:\s*(\S+)/i) || [])[1] || '';
    record(4, '真实启动', true, `${green('启动成功')}  ${dim(url.replace(/\?token=.*/, '?token=***'))}`);
    console.log('      ' + dim('8 层 bundle 全部装配成功，所有插件模块 import 通过。'));
    console.log();
  } else {
    const detail = hit.length
      ? red(`检测到致命错误：${hit.map((r) => r.source).join(' , ')}`)
      : red('进程未输出服务地址就退出了');
    record(4, '真实启动', false, detail, '这是在 ③ 之后才暴露的那一层问题');

    // 给出最有价值的诊断：把关键行挑出来
    const lines = out.split('\n').filter((l) => FATAL.some((re) => re.test(l)) || /dsh-opencode-go|dsh-llm/.test(l));
    if (lines.length) {
      console.log('      ' + dim('关键输出：'));
      for (const l of lines.slice(0, 8)) console.log('      ' + dim('  ' + l.trim().slice(0, 160)));
      console.log();
    }
    if (/does not provide an export named/i.test(out) && runtime?.status === 'supported') {
      console.log(
        '      ' +
          yellow('↳ 这是典型的「插件要求的 dsh 版本 ≠ 内置运行时版本」。') +
          '\n      ' +
          dim(`  插件要求的运行时基线是 ${runtime.dshVersion}，请确认 dsh --version 与之一致，`) +
          '\n      ' +
          dim('  且不带版本的 npm 升级没有把它降回 latest 通道。')
      );
      console.log();
    }
  }
}

// ---------------------------------------------------------------- 汇总
console.log('  ' + dim('─'.repeat(74)));
const passed = results.filter((r) => r.pass === true).length;
const failed = results.filter((r) => r.pass === false);
const skipped = results.filter((r) => r.pass === null).length;

if (failed.length === 0) {
  console.log('  ' + green(bold('全部通过')) + `  （${passed} 项通过${skipped ? `，${skipped} 项跳过` : ''}）`);
  console.log();
  console.log('  ' + dim('接下来在 GUI 里确认插件面板可见：') + ' dsh web');
  console.log('  ' + dim('新增插件的规范见：') + ' CONTRIBUTING.md');
  console.log();
  process.exit(0);
} else {
  console.log('  ' + red(bold(`${failed.length} 项未通过`)) + `  （通过 ${passed} 项）`);
  console.log();
  console.log('  ' + dim('未通过项：'));
  for (const f of failed) console.log('    ' + red('✗') + ` [${f.no}/4] ${f.title}`);
  console.log();
  console.log('  ' + dim('排查顺序建议：① 版本 → ② 依赖 → ③ 装配 → ④ 启动。'));
  console.log('  ' + dim('每一步都能独立定位问题，不要跳着查。'));
  console.log();
  process.exit(1);
}
