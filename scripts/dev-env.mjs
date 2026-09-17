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
 *   --profile <name>   隔离 profile 名（必须为 web —— `dsh web` 是它的硬编码别名）
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
/**
 * 隔离环境里 profile **必须叫 `web`**。
 *
 * 原因：`dsh web` 是 `--profile web` 的**硬编码别名**
 * （`lib/bin.js`: `program.command("web")` → `resolveBoot(web, "web", …)`），
 * 而且 `rejectParentOptions()` 会**主动拒绝**父级的 `--profile`：
 *
 *     $ dsh --profile dev web
 *     error: web takes none of parent --profile, ...
 *
 * 也就是说走 `dsh web` 这条路时 profile 名不可改。隔离靠的是 `DSH_HOME`
 * 指向另一个主目录（那边 `profiles/web` 就是我们的开发环境），
 * 而**不是**在同一个主目录里换 profile 名。
 */
const DEFAULT_DEV_PROFILE = 'web';
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

/**
 * 本脚本自己的 flag 型选项 —— 不消耗值、也不透传给 dsh。
 * 除此之外的 `--xxx` 一律视为「给 dsh 的」，原样透传
 * （如 `web --no-open` / `web --host 0.0.0.0`）。
 */
const OWN_FLAGS = new Set(['--json', '--help', '-h']);

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
    if (OWN_FLAGS.has(a)) continue; // `-h` 这类短选项不能被当成命令
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
      if (VALUE_TAKING_FLAGS.has(a)) {
        i++; // 跳过本脚本自己的、吃值的选项
        continue;
      }
      if (OWN_FLAGS.has(a)) continue; // 本脚本自己的 flag，不透传
      // ★ 其余 `--xxx` 是本脚本不认识的 —— 那是**给 dsh 的**，必须透传。
      //   典型例子：`web --no-open`、`web --host 0.0.0.0`。
      //   以前这里一律 continue，导致 `--no-open` 被静默吞掉（浏览器照开）。
      out.push(a);
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

  // ★ 出厂模板名（web / 其它 shipped profile）不能被 --from-default-profile 复制，
  //   dsh 会直接抛：
  //     profile "web" is shipped and cannot be a custom profile target;
  //     omit --from-default-profile to use it
  //   好在也不用复制 —— 它是**出厂自带**的，`dsh web` 首次跑会自动建出来
  //   （实测：DSH_HOME=新目录跑 `dsh web` 会自动建 profiles/web）。
  //   所以这里跳过初始化，交给 dsh 自己按需创建。
  const isShippedName = devProfile === templateName;

  // ★ 顺序很关键：必须**先让 dsh 自己初始化 profile**，再补别的。
  //   dsh 的 initializeProfileFromDefault 见到 profile 目录已存在就直接抛错
  //   （"profile directory ... already exists; choose an unused profile name"），
  //   所以这里绝不能预先 mkdir 那个目录 —— 反了就会初始化失败。
  if (s.initialized) {
    steps.push(['profile 已存在', '保留原样（幂等）']);
  } else if (isShippedName) {
    steps.push([
      `profile 用出厂名 ${devProfile}`,
      '无需初始化 —— dsh 首次启动会自动建（隔离靠 DSH_HOME，不靠换 profile 名）'
    ]);
  } else {
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
  }

  // ★ 隔离 home 本身必须先存在。
  //   profile 名是出厂名（web）时，上面那一步只 push 了一条日志、**什么都没建**
  //   —— 这是对的，dsh 首次启动会自己建 profiles/web。但 home 这个父目录没人建，
  //   于是下面的 copyFileSync 会以 ENOENT 失败。而那个报错会把源路径和目标路径
  //   一起打出来，读起来像「生产的凭据文件不存在」，实际缺的是目标目录。
  //   凡是「生产有凭据 + 目标 home 不存在」都会中招，也就是换设备后跑 init 的场景；
  //   本机一直没暴露，只是因为 ~/.dsh-dev 早就存在了。
  //   注意这里建的是 home，不是 profile 目录：上面那条「绝不能预先 mkdir」的约束
  //   针对的是 `<home>/profiles/<name>`（dsh 的 initializeProfileFromDefault 见到
  //   已存在就抛错），建它的父目录不影响 dsh 自己初始化 profile。
  fs.mkdirSync(devHome, { recursive: true });

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
    // ★ 这里**不要**再提示「手动 pnpm install」。
    //   `dsh web` 首次跑会自己建出 profile 四件套 + node_modules 并装好依赖
    //   （实测：全新 DSH_HOME 上一条 `dsh web` 就完成全部初始化）——
    //   见 cmdWeb() 里的同类注释。以前让用户手动补，是因为 profile 名
    //   用了 dev，dsh 自动建的是 web，对不上；现在名字对齐了就不需要了。
    console.log(`    启动隔离环境（依赖由 dsh 首次启动自动安装，无需手动 pnpm install）：`);
    console.log(`      ${cyan('node scripts/dev-env.mjs web')}`);
    console.log(
      `      ${dim(`首次启动会自己建出 profiles/${devProfile} 并装依赖，稍等片刻即可。`)}`
    );
    console.log('');
    console.log(`  ${dim(`提示：生产环境照旧用 ${cyan('dsh web')}（${DEFAULT_PROD_PORT}），互不影响。`)}`);
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
    // 不提示手动 pnpm install —— `dsh web` 首次启动会自己装（见 cmdWeb 注释）。
    console.log(`  ${symWarn()} 隔离环境还没装依赖，启动一次即可（会自己装）：`);
    console.log(`    ${cyan('node scripts/dev-env.mjs web')}`);
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

  // ★ 不用检查「profile 是否已初始化」「node_modules 是否已装」——
  //   `dsh web` 首次跑会**自己建 profile 并装依赖**（实测：全新 DSH_HOME 上
  //   一条 `dsh web` 就建出 profiles/web 四件套 + node_modules 并成功监听）。
  //   以前拦这两项是因为 profile 名用了 dev，dsh 自动建的是 web，
  //   结果拦下来要用户手动补 —— 现在 profile 名对齐了，就不需要这一步了。

  console.log('');
  console.log(`  ${bold('启动隔离环境')}`);
  console.log(`  ${'-'.repeat(72)}`);
  console.log(`  DSH_HOME  ${cyan(devHome)}`);
  console.log(`  profile   ${cyan(devProfile)}`);
  console.log(`  端口       ${cyan(String(devPort))}   ${dim(`(生产是 ${DEFAULT_PROD_PORT}，两者可并行)`)}`);
  if (!s.initialized) {
    console.log(`  ${dim('首次启动：dsh 会自己建出该 profile 并装依赖，稍等片刻。')}`);
  }
  console.log('');

  // ★ 不能给 `dsh web` 传 --profile：它是 `--profile web` 的硬编码别名，
  //   而且会主动拒绝父级 --profile（见 DEFAULT_DEV_PROFILE 处的注释）。
  //   隔离完全靠 DSH_HOME 切主目录，profile 名保持 `web`。
  if (devProfile !== DEFAULT_TEMPLATE) {
    console.error(`${symBad()} 隔离环境的 profile 必须叫 ${cyan(DEFAULT_TEMPLATE)} —— 当前是 ${cyan(devProfile)}。`);
    console.error(`    ${dim('`dsh web` 是 --profile web 的硬编码别名，无法指向别的 profile 名。')}`);
    console.error(`    ${dim(`要改回默认：去掉 --profile 参数（或显式写 --profile ${DEFAULT_TEMPLATE}）。`)}`);
    console.error(`    ${dim('换 profile 名请改用走 --profile 的命令，如 config / list / install。')}`);
    console.error('');
    return 1;
  }

  return run(dshCmd, ['web', '--port', String(devPort), ...positionalArgs], {
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
    // `dsh plugin` 的 help 写着 profile 会「initialized on first use」，
    // 所以这里不硬拦，只提醒一声。
    console.log(`${symWarn()} 隔离环境的 ${devProfile} profile 还没建，dsh 会自动初始化一个。`);
    console.log(`${dim(`  想先用出厂模板铺好： node scripts/dev-env.mjs web  （跑一次再停掉）`)}`);
    console.log('');
  }
  return run(dshCmd, ['plugin', '--profile', devProfile, ...extraArgs], { DSH_HOME: devHome });
}

function cmdInstall() {
  if (positionalArgs.length === 0) {
    console.error(`${symBad()} 需要给出 tarball 路径`);
    console.error(`    用法： node scripts/dev-env.mjs install <path/to/plugin.tgz>`);
    return 1;
  }
  // ★ 必须转成绝对路径再交给 dsh。dsh 是在「隔离 profile 目录」里执行 pnpm 的，
  //   相对路径会被锚到 `~/.dsh-dev/profiles/web/` 下 → ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND。
  //   实测：`install plugins/xxx.tgz` 从仓库根跑也会失败，因为生效的 cwd 不是仓库根。
  const abs = positionalArgs.map((p) => {
    if (/^(https?:|git\+|file:)/.test(p)) return p; // 远端/协议地址保持原样
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      console.error(`${symBad()} 找不到 tarball： ${resolved}`);
      console.error(`${dim('    提示：路径按「你敲命令时的 cwd」解析。从仓库根跑时用 plugins/... 即可，')}`);
      console.error(`${dim('          其它位置请给绝对路径。')}`);
      return null;
    }
    return resolved;
  });
  if (abs.some((p) => p === null)) return 1;
  return cmdPlugin(['add', ...abs]);
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
  const isWin = process.platform === 'win32';
  if (asJson) {
    console.log(JSON.stringify({ DSH_HOME: devHome }, null, 2));
    return 0;
  }
  console.log('');
  console.log(`  ${bold('隔离环境变量')}`);
  console.log(`  ${'-'.repeat(72)}`);
  console.log(`  ${dim('只需要设 DSH_HOME —— 它决定整个主目录在哪。')}`);
  console.log('');
  console.log(`  ${dim('PowerShell（当前会话生效）：')}`);
  console.log(`    ${cyan(`$env:DSH_HOME = "${devHome}"`)}`);
  console.log('');
  console.log(`  ${dim('bash / zsh（当前会话生效）：')}`);
  const posixHome = isWin ? devHome.replace(/\\/g, '/') : devHome;
  console.log(`    ${cyan(`export DSH_HOME="${posixHome}"`)}`);
  console.log('');
  console.log(`  ${dim('然后在仓库根目录敲：')}`);
  console.log(`    ${cyan(`dsh web --port ${devPort}`)}`);
  console.log('');
  console.log(`  ${dim('★ 别加 --profile —— dsh web 会拒绝父级 --profile（profile 名固定是 web）。')}`);
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

  // ★ 三态：'ok' | 'warn' | 'fail'
  //   warn 用于「按流程走到这一步时属预期」的情况 —— 只提示，不拉低退出码。
  //   典型：`init` 之后、`web` 之前，profile 还没被 dsh 建出来（它要等首次
  //   `dsh web` 才自动创建），此时报 fail 会让新人以为搞砸了。

  checks.push([
    '隔离 home 与生产 home 不是同一个目录',
    path.resolve(devHome) !== path.resolve(prod),
    devHome
  ]);
  checks.push([
    '隔离 profile 已初始化',
    // profile 名固定为 web（出厂名）时，建 profile 这一步本来就交给 dsh
    // 首次 `dsh web` 完成 —— 所以「尚未初始化」是**预期中间态**，不是失败。
    devSnap.initialized ? true : devProfile === DEFAULT_TEMPLATE ? 'warn' : false,
    devSnap.initialized
      ? devSnap.profileDir
      : devProfile === DEFAULT_TEMPLATE
        ? '尚未创建（正常：首次 `node scripts/dev-env.mjs web` 会由 dsh 自动建出并装依赖）'
        : '未建'
  ]);
  checks.push([
    '隔离 profile 的插件树独立（不是生产的软链）',
    devSnap.initialized
      ? !exists(devSnap.profileDir) ||
        !prodSnap.profileDir ||
        !sameRealPath(devSnap.profileDir, prodSnap.profileDir)
      : 'warn', // profile 还没建 → 无从比对，同上属预期中间态
    devSnap.initialized ? '独立' : '待首次启动后再比对'
  ]);
  checks.push([
    '凭据是独立副本（非硬链）',
    !devSnap.hasCredentials
      ? 'warn'
      : prodSnap.hasCredentials
        ? !sameInode(path.join(devHome, '.credentials.yaml'), path.join(prod, '.credentials.yaml'))
        : true,
    devSnap.hasCredentials
      ? '副本'
      : '尚未登录（新设备属正常，首次启动隔离环境时在 GUI 里登一次即可）'
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
    console.log(
      JSON.stringify(
        {
          checks: checks.map(([n, st, d]) => ({
            name: n,
            ok: st === true || st === 'ok',
            status: st === true || st === 'ok' ? 'ok' : st === 'warn' ? 'warn' : 'fail',
            detail: d
          }))
        },
        null,
        2
      )
    );
    return checks.some(([, st]) => st !== true && st !== 'ok' && st !== 'warn') ? 1 : 0;
  }

  console.log('');
  console.log(`  ${bold('隔离自检')}`);
  console.log(`  ${'-'.repeat(72)}`);
  for (const [name, st, detail] of checks) {
    const mark = st === true || st === 'ok' ? symOk() : st === 'warn' ? yellow('!') : symBad();
    console.log(`  ${mark} ${name}`);
    console.log(`      ${dim(detail)}`);
  }
  const failed = checks.filter(([, st]) => st !== true && st !== 'ok' && st !== 'warn').length;
  const warned = checks.filter(([, st]) => st === 'warn').length;
  console.log('');
  if (failed === 0 && warned === 0) {
    console.log(`  ${green('隔离成立。')} ${dim('两套环境互不影响。')}`);
  } else if (failed === 0) {
    console.log(`  ${green('隔离成立。')} ${dim(`另有 ${warned} 项提示，不影响隔离。`)}`);
  } else {
    console.log(`  ${yellow(`${failed} 项未通过`)} — 见上面逐条说明。`);
  }
  // profile 还没建时，明确告诉下一步该干什么 —— 这正是新设备上 init→web 之间
  // 最常出现的状态，光说「隔离成立」新人不知道还要做什么。
  if (!devSnap.initialized && failed === 0) {
    console.log(`  ${dim('下一步：')} ${cyan('node scripts/dev-env.mjs web')} ${dim('（首次启动会建出 profile 并装依赖）')}`);
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
    --profile <name>    隔离 profile 名（默认 ${DEFAULT_DEV_PROFILE}；
                        必须与 --from 同为 ${DEFAULT_TEMPLATE}，见下）
    --port <n>          隔离端口（默认 ${DEFAULT_DEV_PORT}）
    --from <name>       出厂模板（默认 ${DEFAULT_TEMPLATE}）
    --json              机器可读输出
    其它 --xxx          原样透传给 dsh（如 web --no-open）

  ${bold('典型流程')}
    cd <你 clone 的 dsh-plugins 仓库根目录>   # 命令都要在仓库根跑
    node scripts/dev-env.mjs init           # 建隔离 home（幂等）
    node scripts/dev-env.mjs web            # 启动，默认 ${DEFAULT_DEV_PORT}
                                            # 依赖由 dsh 首次启动自动装

  ${bold('说明')}
    生产环境照旧用 ${cyan('dsh web')}（端口 ${DEFAULT_PROD_PORT}）。
    本脚本只在子进程里设 DSH_HOME，不写全局环境变量，
    所以你平时的命令永远落在生产环境。

    ★ profile 名必须是 ${DEFAULT_TEMPLATE}：${cyan('dsh web')} 是 ${cyan(`--profile ${DEFAULT_TEMPLATE}`)}
      的硬编码别名，并会拒绝父级 ${cyan('--profile')}。隔离靠的是 DSH_HOME
      指向另一个主目录，而不是换 profile 名。
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
