#!/usr/bin/env node
/**
 * dsh-plugins — 开发环境隔离（可移植）
 * ============================================================================
 * 为什么需要它
 * ----------------------------------------------------------------------------
 * 插件的开发与调试会频繁改动 profile 的插件树、settings、patch 层。
 * 如果直接在「日常在用的 harness」上做（默认 `~/.dsh`），就会：
 *   - 正在用的页面断连（第二个 `dsh web` 抢同一端口，旧的退出即断）
 *   - 插件树装坏 → `dsh web` 起不来
 *   - settings/凭据被写坏 → 连累日常使用
 *
 * 为什么用 DSH_HOME 而不是 --profile
 * ----------------------------------------------------------------------------
 * `dsh --profile dev` 只隔离**插件树**（各自的 node_modules）。
 * 而 `.credentials.yaml` / `settings.yaml` / `sessions/` 仍在同一个
 * `$DSH_HOME` 下**共享** —— 开发时改坏它们，日常环境一起遭殃。
 *
 * `DSH_HOME` 隔离的是整个主目录：profile、插件、凭据、设置、会话
 * 全部另起一套。这才是真隔离。
 *
 * 为什么这个脚本能跨设备复用
 * ----------------------------------------------------------------------------
 * 所有路径都从「本机实际环境」推导，没有任何硬编码盘符：
 *   - 隔离 home 默认 `~/.dsh-dev`（`~` 由 Node 的 os.homedir() 解析，
 *     Windows / macOS / Linux 通吃）
 *   - `dsh` 从 PATH 里找
 *   - 生产 home 用 `$DSH_HOME` 或 `~/.dsh`
 * 换一台设备 clone 本仓库后直接跑即可，不需要改任何一行。
 *
 * 用法
 * ----------------------------------------------------------------------------
 *   node scripts/dev-env.mjs init           创建隔离环境（幂等）
 *   node scripts/dev-env.mjs status         查看两个环境的状态对比
 *   node scripts/dev-env.mjs web            启动隔离环境
 *   node scripts/dev-env.mjs install <tgz>  往隔离环境装插件
 *   node scripts/dev-env.mjs list           隔离环境的插件列表
 *   node scripts/dev-env.mjs config         隔离环境的装配树
 *   node scripts/dev-env.mjs shell          打印可直接 eval 的环境变量
 *   node scripts/dev-env.mjs doctor         检查隔离是否真的成立
 *
 * 常用选项：
 *   --home <path>      隔离 home 位置（默认 ~/.dsh-dev）
 *   --profile <name>   隔离 profile 名（默认 dev）
 *   --port <n>         隔离环境的端口（默认 3090；生产默认 3080）
 *   --from <name>      从哪个出厂模板初始化（默认 web）
 *   --json             机器可读输出
 *
 * 退出码：
 *   0  成功
 *   1  用法错误
 *   2  环境不满足（缺 dsh / node 等）
 *   3  执行过程中出错
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

// ---------------------------------------------------------------- 默认值
const DEFAULT_DEV_HOME_NAME = '.dsh-dev';
const DEFAULT_DEV_PROFILE = 'dev';
const DEFAULT_DEV_PORT = 3090;
const DEFAULT_PROD_PORT = 3080;
const DEFAULT_TEMPLATE = 'web';
/** 必须与 compatibility.json 的 requirements 保持一致。 */
const MIN_NODE_MAJOR = 22;

/**
 * 会「吃掉」下一个参数的选项（flag 型选项如 `--json` 不会）。
 * 解析命令行时靠它区分「选项的值」和「位置参数」——
 * 否则 `--home /x/y` 里的 `/x/y` 会被误判成命令。
 */
const VALUE_TAKING_FLAGS = new Set(['--home', '--profile', '--port', '--from']);

// ---------------------------------------------------------------- 命令行
const argv = process.argv.slice(2);
const optValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const asJson = argv.includes('--json');

// 找第一个非选项参数作为命令。注意要跳过选项的「值」，
// 否则 `--home /some/path` 里的路径会被误当成命令。
const command = (() => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // 只有「取值型」选项才需要多跳一格；flag 型选项没有值。
      if (VALUE_TAKING_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return 'status';
})();

const devHome = expandHome(optValue('--home', path.join(os.homedir(), DEFAULT_DEV_HOME_NAME)));
const devProfile = optValue('--profile', DEFAULT_DEV_PROFILE);
const devPort = Number(optValue('--port', String(DEFAULT_DEV_PORT)));
const templateName = optValue('--from', DEFAULT_TEMPLATE);

// 命令之后的位置参数（如 `install <tgz>` 的 tarball 路径），透传给 dsh。
const positionalArgs = (() => {
  const out = [];
  let seenCommand = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (VALUE_TAKING_FLAGS.has(a)) i++; // 跳过选项的值
      continue;
    }
    if (!seenCommand) {
      // `help` 已在前面拦下，这里只可能是真正的命令
      seenCommand = true;
      if (a === 'help') return out;
      continue;
    }
    out.push(a);
  }
  return out;
})();

// ---------------------------------------------------------------- 工具函数

/** 展开 `~` / `~/` / `~\`。与 dsh 自身 expandHomePath 的行为保持一致。 */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 生产 home：`$DSH_HOME`（非空）优先，否则 `~/.dsh`。 */
function resolveProdHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return path.resolve(expandHome(fromEnv.trim()));
  return path.join(os.homedir(), '.dsh');
}

/** 在 PATH 里找可执行文件；Windows 补 PATHEXT 后缀。 */
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

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 节点主版本是否达标。 */
function nodeOk() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR;
}

/** 跑一条命令，继承 stdio，返回退出码。 */
function run(cmd, args, env) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...(env || {}) },
    shell: process.platform === 'win32'
  });
  return r.status === null ? 1 : r.status;
}

/** 跑一条命令并捕获输出（用于探测，不期望副作用）。 */
function runCapture(cmd, args, env) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    shell: process.platform === 'win32'
  });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 显示宽度：CJK / 全角字符占 2 列，其余占 1 列。
 * 终端对齐必须按这个算，不能用 String.length —— 「端口」是 2 个字符但占 4 列。
 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||   // 韩文字母
      (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK 部首 ~ 彝文
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // 韩文音节
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 兼容表意
      (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xff60) ||   // 全角形式
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右侧补空格。 */
function padDisplay(s, width) {
  const pad = width - displayWidth(s);
  return pad > 0 ? String(s) + ' '.repeat(pad) : String(s);
}

// ---------------------------------------------------------------- 环境快照

/** 采集某个 home + profile 的状态。 */
function snapshot(home, profile) {
  const profileDir = path.join(home, 'profiles', profile);
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  const userBundles = (pkg?.dsh?.profile?.bundles ?? []).filter(
    (b) => !String(b).startsWith('@deepseek-ai/dsh-base') && !String(b).startsWith('@deepseek-ai/dsh-web-app')
  );
  const deps = Object.keys(pkg?.dependencies ?? {});
  return {
    home,
    profile,
    profileDir,
    exists: exists(profileDir),
    initialized: pkg !== null,
    bundles: pkg?.dsh?.profile?.bundles ?? [],
    userBundles,
    dependencies: deps,
    nodeModulesInstalled: exists(path.join(profileDir, 'node_modules')),
    hasCredentials: exists(path.join(home, '.credentials.yaml')),
    hasSettings: exists(path.join(home, 'settings.yaml')),
    patchReload: pkg?.dsh?.profile?.patchReload ?? null
  };
}

/** 找 dev 类产物（探测目录、临时打包路径）混进生产 profile 的情况。 */
function findDevArtifacts(snap) {
  const suspicious = [];
  for (const [name, spec] of Object.entries(
    (readJson(path.join(snap.profileDir, 'package.json'))?.dependencies) ?? {}
  )) {
    if (typeof spec !== 'string') continue;
    if (/_probe|\/tmp\/|\\temp\\|pack-|\.local|dev-only/i.test(spec)) {
      suspicious.push({ name, spec });
    }
  }
  return suspicious;
}

// ---------------------------------------------------------------- 子命令

function cmdInit() {
  const prod = resolveProdHome();
  const dshCmd = findInPath(['dsh']);

  if (!nodeOk()) {
    console.error(`${symBad()} Node ${process.versions.node} 过低，需要 >= ${MIN_NODE_MAJOR}.x`);
    return 2;
  }
  if (!dshCmd) {
    console.error(`${symBad()} PATH 里找不到 dsh。先全局安装：`);
    console.error(`    npm i -g @deepseek-ai/dsh@0.1.6-alpha.1   ${dim('（必须带版本，否则会静默降级）')}`);
    return 2;
  }

  const s = snapshot(devHome, devProfile);
  const steps = [];

  // ★ 顺序很关键：必须**先让 dsh 自己初始化 profile**，再补别的。
  //   dsh 的 initializeProfileFromDefault 见到 profile 目录已存在就直接抛错
  //   （"profile directory ... already exists; choose an unused profile name"），
  //   所以这里绝不能预先 mkdir 那个目录 —— 反了就会初始化失败。
  if (!s.initialized) {
    // `--dump-config` 只用来触发初始化；它会把整棵装配树打到 stdout，
    // 那属于噪音，这里吞掉，只保留失败时的错误输出。
    const r = spawnSync(dshCmd, [
      '--profile', devProfile,
      '--from-default-profile', templateName,
      '--dump-config'
    ], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: devHome },
      shell: process.platform === 'win32'
    });
    if (r.status !== 0) {
      console.error(`${symBad()} 初始化 profile 失败（退出码 ${r.status}）`);
      const err = (r.stderr || r.stdout || '').trim();
      if (err) console.error(dim(err.split('\n').slice(0, 6).join('\n')));
      console.error(`${dim('  常见原因：该 profile 名已被占用 → 换一个 --profile <name>，')}`);
      console.error(`${dim('            或先删掉残留的 profile 目录。')}`);
      return 3;
    }
    steps.push(['从出厂模板初始化 profile', `${templateName} → ${devProfile}`]);
  } else {
    steps.push(['profile 已存在', '保留原样（幂等）']);
  }

  // 2) 凭据 / 设置：复制成独立副本（★ 不是软链，避免开发改坏生产）
  for (const f of ['.credentials.yaml', 'settings.yaml']) {
    const src = path.join(prod, f);
    const dst = path.join(devHome, f);
    if (!exists(src)) {
      steps.push([`跳过 ${f}`, '生产环境里没有，稍后可在 GUI 里手填']);
      continue;
    }
    if (exists(dst)) {
      steps.push([`保留已有 ${f}`, '不覆盖（如需同步，见 README 的 sync 说明）']);
      continue;
    }
    fs.copyFileSync(src, dst);
    steps.push([`复制 ${f}`, '独立副本']);
  }

  if (!asJson) {
    console.log('');
    console.log(`  ${bold('dsh 开发环境隔离 — 初始化')}`);
    console.log(`  ${'-'.repeat(72)}`);
    for (const [what, detail] of steps) {
      console.log(`  ${symOk()} ${padDisplay(what, 28)} ${dim(detail)}`);
    }
    console.log('');
    console.log(`  隔离 home   ${cyan(devHome)}`);
    console.log(`  隔离 profile ${cyan(devProfile)}`);
    console.log(`  端口         ${cyan(String(devPort))}   ${dim(`(生产用 ${DEFAULT_PROD_PORT})`)}`);
    console.log('');
    console.log(`  ${bold('下一步')}`);
    console.log(`    ${dim('1.')} 装依赖（只需一次）：`);
    console.log(`         ${cyan(`cd ${s.profileDir}`)}`);
    console.log(`         ${cyan('pnpm install')}`);
    console.log(`    ${dim('2.')} 启动隔离环境：`);
    console.log(`         ${cyan('node scripts/dev-env.mjs web')}`);
    console.log('');
  } else {
    console.log(JSON.stringify({ ok: true, devHome, devProfile, devPort, steps }, null, 2));
  }

  return 0;
}

function cmdStatus() {
  const prod = resolveProdHome();
  const prodSnap = snapshot(prod, 'web');
  const devSnap = snapshot(devHome, devProfile);
  const artifacts = findDevArtifacts(prodSnap);

  if (asJson) {
    console.log(JSON.stringify({ prod: prodSnap, dev: devSnap, devArtifactsInProd: artifacts }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`  ${bold('dsh 环境对比')}`);
  console.log(`  ${'-'.repeat(72)}`);

  const rows = [
    ['DSH_HOME', displayHome(prodSnap.home), displayHome(devSnap.home)],
    ['profile', 'web', devProfile],
    ['端口', String(DEFAULT_PROD_PORT), String(devPort)],
    ['profile 已建', prodSnap.initialized ? '是' : '否', devSnap.initialized ? '是' : '否'],
    ['node_modules', prodSnap.nodeModulesInstalled ? '已装' : '未装', devSnap.nodeModulesInstalled ? '已装' : '未装'],
    ['业务插件数', String(prodSnap.userBundles.length), String(devSnap.userBundles.length)],
    ['凭据副本', prodSnap.hasCredentials ? '有' : '无', devSnap.hasCredentials ? '有' : '无'],
    ['settings', prodSnap.hasSettings ? '有' : '无', devSnap.hasSettings ? '有' : '无']
  ];

  const w0 = Math.max(14, ...rows.map((r) => displayWidth(r[0])));
  const w1 = Math.max(10, ...rows.map((r) => displayWidth(r[1])));
  const w2 = Math.max(10, ...rows.map((r) => displayWidth(r[2])));
  console.log(`  ${' '.repeat(w0)}  ${bold(padDisplay('生产', w1))}  ${bold(padDisplay('隔离/开发', w2))}`);
  for (const [a, b, c] of rows) {
    console.log(`  ${padDisplay(a, w0)}  ${padDisplay(b, w1)}  ${padDisplay(c, w2)}`);
  }
  console.log('');

  console.log(`  ${bold('生产环境的业务插件')}`);
  if (prodSnap.userBundles.length === 0) console.log(`    ${dim('（无）')}`);
  for (const b of prodSnap.userBundles) console.log(`    · ${b}`);
  console.log('');

  if (artifacts.length > 0) {
    console.log(`  ${symWarn()} ${yellow('生产 profile 里发现开发类产物')} ${dim('（建议挪到隔离环境）')}`);
    for (const a of artifacts) console.log(`    ${a.name}  ${dim(a.spec)}`);
    console.log('');
  }

  if (!devSnap.initialized) {
    console.log(`  ${symWarn()} 隔离环境还没建，先跑： ${cyan('node scripts/dev-env.mjs init')}`);
    console.log('');
  } else if (!devSnap.nodeModulesInstalled) {
    console.log(`  ${symWarn()} 隔离环境还没装依赖，先跑：`);
    console.log(`    ${cyan(`cd ${devSnap.profileDir}`)}`);
    console.log(`    ${cyan('pnpm install')}`);
    console.log('');
  }

  return 0;
}

function cmdWeb() {
  const dshCmd = findInPath(['dsh']);
  if (!dshCmd) {
    console.error(`${symBad()} PATH 里找不到 dsh`);
    return 2;
  }
  const s = snapshot(devHome, devProfile);
  if (!s.initialized) {
    console.error(`${symBad()} 隔离环境还没初始化，先跑： node scripts/dev-env.mjs init`);
    return 2;
  }
  if (!s.nodeModulesInstalled) {
    console.error(`${symWarn()} 隔离环境的依赖还没装，先执行：`);
    console.error(`    cd ${s.profileDir}`);
    console.error(`    pnpm install`);
    console.error('');
    console.error(`${dim('（首次使用必须做这一步，否则插件树无法加载）')}`);
    return 2;
  }

  console.log('');
  console.log(`  ${bold('启动隔离环境')}`);
  console.log(`  ${'-'.repeat(72)}`);
  console.log(`  DSH_HOME  ${cyan(devHome)}`);
  console.log(`  profile   ${cyan(devProfile)}`);
  console.log(`  端口       ${cyan(String(devPort))}   ${dim(`(生产是 ${DEFAULT_PROD_PORT}，两者可并行)`)}`);
  console.log('');

  return run(dshCmd, ['--profile', devProfile, 'web', '--port', String(devPort), ...positionalArgs], {
    DSH_HOME: devHome
  });
}

function cmdPlugin(extraArgs) {
  const dshCmd = findInPath(['dsh']);
  if (!dshCmd) {
    console.error(`${symBad()} PATH 里找不到 dsh`);
    return 2;
  }
  const s = snapshot(devHome, devProfile);
  if (!s.initialized) {
    console.error(`${symBad()} 隔离环境还没初始化，先跑： node scripts/dev-env.mjs init`);
    return 2;
  }
  return run(dshCmd, ['plugin', '--profile', devProfile, ...extraArgs], { DSH_HOME: devHome });
}

function cmdInstall() {
  if (positionalArgs.length === 0) {
    console.error(`${symBad()} 需要给出 tarball 路径`);
    console.error(`    用法： node scripts/dev-env.mjs install <path/to/plugin.tgz>`);
    return 1;
  }
  return cmdPlugin(['add', ...positionalArgs]);
}

function cmdConfig() {
  const dshCmd = findInPath(['dsh']);
  if (!dshCmd) {
    console.error(`${symBad()} PATH 里找不到 dsh`);
    return 2;
  }
  return run(dshCmd, ['--profile', devProfile, '--dump-config', ...positionalArgs], { DSH_HOME: devHome });
}

/** 打印可直接 eval / dot-source 的环境变量。 */
function cmdShell() {
  const s = snapshot(devHome, devProfile);
  if (asJson) {
    console.log(JSON.stringify({ DSH_HOME: devHome, DSH_PROFILE: devProfile, DSH_PORT: String(devPort) }, null, 2));
    return 0;
  }
  const isWin = process.platform === 'win32';
  console.log('');
  console.log(`  ${bold('隔离环境变量')}`);
  console.log(`  ${'-'.repeat(72)}`);
  console.log(`  ${dim('PowerShell（当前会话生效）：')}`);
  console.log(`    ${cyan(`$env:DSH_HOME = "${devHome}"`)}`);
  console.log(`    ${cyan(`$env:DSH_PROFILE = "${devProfile}"`)}`);
  console.log(`    ${cyan(`$env:DSH_PORT = "${devPort}"`)}`);
  console.log('');
  console.log(`  ${dim('bash / zsh（当前会话生效）：')}`);
  const posixHome = isWin ? devHome.replace(/\\/g, '/') : devHome;
  console.log(`    ${cyan(`export DSH_HOME="${posixHome}"`)}`);
  console.log(`    ${cyan(`export DSH_PROFILE="${devProfile}"`)}`);
  console.log(`    ${cyan(`export DSH_PORT="${devPort}"`)}`);
  console.log('');
  console.log(`  ${dim('设完之后，直接用普通 dsh 命令就落在隔离环境里：')}`);
  console.log(`    ${cyan(`dsh --profile ${devProfile} web --port ${devPort}`)}`);
  console.log('');
  console.log(`  ${dim('★ 只设当前会话，不写全局 —— 平时的 dsh web 仍走生产。')}`);
  console.log('');
  return 0;
}

/** 验证隔离是否真的成立。 */
function cmdDoctor() {
  const prod = resolveProdHome();
  const prodSnap = snapshot(prod, 'web');
  const devSnap = snapshot(devHome, devProfile);
  const checks = [];

  checks.push([
    '隔离 home 与生产 home 不是同一个目录',
    path.resolve(devHome) !== path.resolve(prod),
    devHome
  ]);
  checks.push([
    '隔离 profile 已初始化',
    devSnap.initialized,
    devSnap.initialized ? devSnap.profileDir : '未建'
  ]);
  checks.push([
    '隔离 profile 的插件树独立（不是生产的软链）',
    devSnap.initialized &&
      (!exists(devSnap.profileDir) || !prodSnap.profileDir ||
        !sameRealPath(devSnap.profileDir, prodSnap.profileDir)),
    '独立'
  ]);
  checks.push([
    '凭据是独立副本（非硬链）',
    devSnap.hasCredentials && prodSnap.hasCredentials
      ? !sameInode(path.join(devHome, '.credentials.yaml'), path.join(prod, '.credentials.yaml'))
      : devSnap.hasCredentials,
    devSnap.hasCredentials ? '副本' : '缺失（可在 GUI 手填）'
  ]);
  checks.push([
    `隔离端口 ${devPort} 与生产 ${DEFAULT_PROD_PORT} 不同`,
    devPort !== DEFAULT_PROD_PORT,
    `dev=${devPort} prod=${DEFAULT_PROD_PORT}`
  ]);
  checks.push([
    '隔离环境的 DSH_HOME 解析正确',
    path.resolve(expandHome(devHome)) === path.resolve(devHome),
    '~ 已展开'
  ]);

  const artifacts = findDevArtifacts(prodSnap);
  checks.push([
    '生产 profile 无开发类产物',
    artifacts.length === 0,
    artifacts.length === 0 ? '干净' : `发现 ${artifacts.length} 项：${artifacts.map((a) => a.name).join(', ')}`
  ]);

  if (asJson) {
    console.log(JSON.stringify({ checks: checks.map(([n, ok, d]) => ({ name: n, ok, detail: d })) }, null, 2));
    return checks.every(([, ok]) => ok) ? 0 : 1;
  }

  console.log('');
  console.log(`  ${bold('隔离自检')}`);
  console.log(`  ${'-'.repeat(72)}`);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? symOk() : symBad()} ${name}`);
    console.log(`      ${dim(detail)}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log('');
  if (failed === 0) {
    console.log(`  ${green('隔离成立。')} ${dim('两套环境互不影响。')}`);
  } else {
    console.log(`  ${yellow(`${failed} 项未通过`)} — 见上面逐条说明。`);
  }
  console.log(`  ${dim(`（提示：Node 的子进程一律用 ${cyan(devHome)} 作为 DSH_HOME）`)}`);
  console.log('');
  return failed === 0 ? 0 : 1;
}

function sameRealPath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function sameInode(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    // 同一 inode + 同一设备 = 硬链；内容副本则 dev/ino 不同。
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

function usage() {
  // 显示用的 home：能缩成 ~ 就缩，保证帮助文本换设备后依然准确。
  const homeDisplay = displayHome(devHome);
  console.log(`
  ${bold('dsh 开发环境隔离')} ${dim('— 把「日常 harness」与「开发插件的 harness」分开')}

  ${bold('用法')}
    node scripts/dev-env.mjs <命令> [选项]

  ${bold('命令')}
    init                创建隔离环境（幂等，可反复跑）
    status              两个环境的对比（默认命令）
    doctor              自检隔离是否真的成立
    web                 启动隔离环境
    install <tgz...>    往隔离环境装插件
    list                隔离环境的插件列表
    config              隔离环境的装配树
    shell               打印隔离环境变量（供手动 eval）

  ${bold('选项')}
    --home <path>       隔离 home（默认 ~/${DEFAULT_DEV_HOME_NAME}）
    --profile <name>    隔离 profile 名（默认 ${DEFAULT_DEV_PROFILE}）
    --port <n>          隔离端口（默认 ${DEFAULT_DEV_PORT}）
    --from <name>       出厂模板（默认 ${DEFAULT_TEMPLATE}）
    --json              机器可读输出

  ${bold('典型流程')}
    node scripts/dev-env.mjs init           # 建隔离环境
    cd ${homeDisplay}/profiles/${devProfile}
    pnpm install                            # 装依赖（只需一次）
    node scripts/dev-env.mjs web            # 启动，默认 ${DEFAULT_DEV_PORT}

  ${bold('说明')}
    生产环境照旧用 ${cyan('dsh web')}（端口 ${DEFAULT_PROD_PORT}）。
    本脚本只在子进程里设 DSH_HOME，不写全局环境变量，
    所以你平时的命令永远落在生产环境。
`);
}

/** 把绝对路径缩成 `~` 开头（能缩才缩），用于展示。后者换设备依然准确。 */
function displayHome(p) {
  const home = os.homedir();
  const abs = path.resolve(p);
  if (abs === home) return '~';
  for (const sep of ['/', '\\']) {
    if (abs.startsWith(home + sep)) return '~' + sep + abs.slice(home.length + 1);
  }
  return abs;
}

// ---------------------------------------------------------------- 入口

// `--help` / `-h` / `help` 都在这里处理。★ 必须放在所有常量定义之后 ——
// usage() 会读 devHome 等 const，函数声明虽会提升，const 不会（TDZ）。
if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
  usage();
  process.exit(0);
}

const COMMANDS = {
  init: cmdInit,
  status: cmdStatus,
  doctor: cmdDoctor,
  web: cmdWeb,
  install: cmdInstall,
  list: () => cmdPlugin(['list', ...positionalArgs]),
  config: cmdConfig,
  shell: cmdShell,
  help: () => {
    usage();
    return 0;
  }
};

const handler = COMMANDS[command];
if (!handler) {
  console.error(`${symBad()} 未知命令 "${command}"`);
  usage();
  process.exit(1);
}

process.exit(handler());
