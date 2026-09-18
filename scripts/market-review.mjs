/**
 * market-review.mjs —— 第三方条目（catalog/overrides/curated.json）的核对助手
 *
 *   node scripts/market-review.mjs <owner/repo | npm 包名 | 目录里的插件 id>
 *   node scripts/market-review.mjs owner/repo --write      # 直接把草稿追加进 overrides/curated.json
 *
 * 它做的事：把「该查什么」自动化成一次可复现的探测，产出一份**草稿条目**，
 * 你只需要复核结论并决定收不收 —— 而不是凭印象手写 JSON。
 *
 * ★ 它**不会**替你做判断。核对的实质是「在真机上装一次并启动成功」，
 *   脚本只能把静态事实摆出来（peer 约束、是否声明 dsh.bundle、有没有安装脚本、
 *   与本仓库基线是否兼容），最后那一步必须你自己跑、自己记。
 *
 * ★ 0.5.0 起这个文件不再对应任何「信任层级」—— 往里面加一条**不会**让插件升级成
 *   「已审核」。它补的是**公开索引里查不到的事实**：安装规格、peer 结论、当时怎么验的。
 *   写进去的内容会拍平进条目的 `notes`（详情页可见），不参与筛选，也不影响能不能装。
 *
 * ★ --write 之后必须再跑一次 `node scripts/sync-catalog.mjs`：
 *   本文件只写「人的结论」，catalog/plugins/*.json 是由采集脚本从它派生出来的。
 *   不重跑的话，界面上的详情还是旧的，CI 的 --check 也会红。
 *
 * 核对一条的最低要求见 catalog/overrides/curated.json 顶部的 _comment，
 * 以及 CONTRIBUTING.md 的「插件市场收录」一节。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = path.join(REPO, 'plugins-src', 'dsh-plugins-market', 'src', 'server');

// 直接复用插件自己的服务器半模块（它们只用 Node 内置模块，可以独立跑）
const { probeEntry } = await import(pathToFileURL(path.join(SRC, 'probe.js')).href);
const { satisfies, compareVersions, detectEnvironment, readJsonSafe } = await import(pathToFileURL(path.join(SRC, 'util.js')).href);
const { resolveRuntimePackageVersion } = await import(pathToFileURL(path.join(SRC, 'profile.js')).href);

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
const JSON_OUT = args.includes('--json');

if (!target) {
  console.error('');
  console.error('  用法：node scripts/market-review.mjs <owner/repo | npm 包名 | 插件 id> [--write] [--json]');
  console.error('');
  console.error('  例：  node scripts/market-review.mjs someone/cool-plugin');
  console.error('        node scripts/market-review.mjs dsh-workbuddy-quota --write');
  console.error('');
  process.exit(1);
}

const compat = readJsonSafe(path.join(REPO, 'compatibility.json'));
const runtime = compat?.runtimes?.find((r) => r.status === 'supported' && r.recommended);
const env = detectEnvironment(process.env);

// ── 认输入形态 ────────────────────────────────────────────────
const looksLikeSlug = /^[\w.-]+\/[\w.-]+$/.test(target) && !target.startsWith('@');
const entry = looksLikeSlug
  ? {
    id: target,
    package: target.split('/')[1],
    name: target.split('/')[1],
    upstream: `https://github.com/${target}`,
    install: { kind: 'github', spec: `github:${target}` },
  }
  : {
    id: target,
    package: target,
    name: target,
    install: { kind: 'npm', spec: target },
  };

console.log('');
console.log('  dsh-plugins 市场收录助手');
console.log(`  ${'-'.repeat(74)}`);
console.log(`  候选          ${target}`);
console.log(`  形态          ${looksLikeSlug ? 'GitHub 仓库' : 'npm 包名'}`);
console.log(`  本机 dsh       ${env.dsh.version ?? '(未找到)'}   node ${env.node.version}   pnpm ${env.pnpm.version ?? '?'}`);
console.log(`  仓库基线       ${runtime?.dshVersion ?? '?'}`);
console.log('');

// ── 探测 ──────────────────────────────────────────────────────
process.stdout.write('  正在读取候选包的 package.json… ');
const probe = await probeEntry(entry, { force: true });
console.log(probe.available ? '成功' : '失败');
console.log('');

const findings = [];
const add = (level, title, detail) => findings.push({ level, title, detail });

if (!probe.available) {
  add('bad', '探测失败', probe.error ?? '未知原因');
} else {
  const m = probe.manifest;
  console.log(`  来源          ${probe.source}`);
  console.log(`  包名 / 版本    ${m.name ?? '?'} @ ${m.version ?? '?'}`);
  console.log(`  许可          ${m.license ?? '(未声明)'}`);
  console.log(`  仓库          ${m.repository?.url ?? '(未声明)'}`);
  console.log('');

  // 1) 是不是一个能加载的 dsh 插件
  if (m.dsh?.bundle?.patch) {
    add('ok', 'dsh.bundle 已声明', `patch: ${m.dsh.bundle.patch}`);
  } else if (m.workspaces) {
    add('bad', '根包不是插件（monorepo）', '根 package.json 没有 dsh.bundle，但声明了 workspaces —— 插件在子目录里，需要指定具体包');
  } else {
    add('bad', '没有声明 dsh.bundle', '装了也不会被写进 profile bundles，永远不会加载');
  }

  if (m.dsh?.client) {
    add('info', '带客户端半', `platform=${m.dsh.client.platform} external=${JSON.stringify(m.dsh.client.external ?? [])}`);
  }

  // 2) peer 约束 vs 本机运行时 —— 这一条最值钱
  const peers = m.peerDependencies ?? {};
  const dsPeers = Object.entries(peers).filter(([k]) => k.startsWith('@deepseek-ai/'));
  if (dsPeers.length === 0) {
    add('ok', '不对 @deepseek-ai/* 设 peer 约束', Object.keys(peers).length ? `其它 peer：${Object.keys(peers).join('、')}` : '无 peerDependencies');
  }
  const rangeMismatch = [];
  const unresolved = [];
  for (const [key, range] of dsPeers) {
    const resolved = resolveRuntimePackageVersion(key, { dshDir: env.dsh.dir, env: process.env });
    const exactPin = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(range).trim());
    const ok = satisfies(resolved.version, range);
    if (ok === true) {
      add('ok', `peer 满足：${key}`, `要求 ${range}，本机 ${resolved.version}`);
    } else if (ok === false && exactPin) {
      const cmp = compareVersions(resolved.version, range);
      if (cmp !== null && cmp < 0) {
        add('bad', `peer 精确 pin 高于本机：${key}`,
          `要求 ${range}，本机 ${resolved.version} —— 本机缺少它要的接口。这类不匹配的后果是整棵插件树加载失败、dsh web 起不来，属于不可覆盖的致命项。不要收录，除非同时给出适配该 dsh 版本的构建产物。`);
      } else {
        add('warn', `peer 精确 pin 低于本机：${key}`,
          `要求 ${range}，本机 ${resolved.version} —— 通常向后兼容（dsh-receipt 就是这种形态且实测可用），但必须在真机上启动确认。`);
      }
    } else if (ok === false) {
      rangeMismatch.push(`${key}（要求 ${range}，本机 ${resolved.version}）`);
    } else {
      unresolved.push(`${key}（要求 ${range}）`);
    }
  }
  // 同一个包里这类 warning 往往成片出现，合并成一条，别把真正致命的那条淹掉
  if (rangeMismatch.length > 0) {
    add('warn', `${rangeMismatch.length} 个 peer 范围按 npm 语义不匹配`,
      `${rangeMismatch.join('；')}\n      预发布版本的匹配规则较严；profile 设了 autoInstallPeers: false，peer 不参与安装，实测多为 pnpm 警告（dsh-connect-trae 即如此）。真机启动确认即可。`);
  }
  if (unresolved.length > 0) {
    add('warn', `${unresolved.length} 个 peer 无法判定（本机未解析到该包）`, unresolved.join('；'));
  }

  // 3) 安装期脚本（供应链信号）
  const lifecycle = Object.keys(m.scripts ?? {}).filter((k) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(k));
  if (lifecycle.length > 0) {
    add('warn', '带安装期脚本', `${lifecycle.join('、')} —— 安装时会执行代码，注意来源可信度`);
  } else {
    add('ok', '无安装期脚本', 'preinstall / install / postinstall / prepare 都没有');
  }

  // 4) engines
  if (m.engines?.node) {
    const ok = satisfies(env.node.version, m.engines.node);
    add(ok === true ? 'ok' : 'warn', 'engines.node', `${m.engines.node}（本机 ${env.node.version}）`);
  }

  // 5) 自身依赖
  const deps = Object.keys(m.dependencies ?? {});
  add('info', '运行时依赖', deps.length ? `${deps.length} 个：${deps.slice(0, 8).join('、')}${deps.length > 8 ? '…' : ''}` : '无');
}

// ── 输出 ──────────────────────────────────────────────────────
const ICON = { ok: '✓', warn: '!', bad: '✗', info: '·' };
console.log('  静态核对结果');
console.log(`  ${'-'.repeat(74)}`);
for (const f of findings) {
  console.log(`  ${ICON[f.level]} ${f.title}`);
  if (f.detail) console.log(`      ${f.detail}`);
}
console.log('');

const blockers = findings.filter((f) => f.level === 'bad');
const warns = findings.filter((f) => f.level === 'warn');

const draft = {
  id: entry.id,
  package: probe.manifest?.name ?? entry.package,
  version: probe.manifest?.version ?? null,
  title: probe.manifest?.name ?? entry.package,
  summary: '(待填写：一句话中文简介)',
  tags: [],
  author: null,
  upstream: entry.upstream ?? (probe.manifest?.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') ?? null),
  homepage: probe.manifest?.homepage ?? null,
  license: probe.manifest?.license ?? null,
  install: {
    kind: entry.install.kind,
    spec: entry.install.spec,
    needsConfig: false,
    usageNeedsConfig: false,
    risky: lifecyclePresent(probe.manifest),
  },
  peerRuntimePin: Object.entries(probe.manifest?.peerDependencies ?? {})
    .filter(([k]) => k.startsWith('@deepseek-ai/'))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || null,
  peerVerdict: blockers.length ? 'bad' : warns.length ? 'warn' : 'ok',
  peerNote: '(待填写：peer 结论与依据)',
  review: {
    reviewedAt: null,          // ★ 必须填：实际审核日期
    dshVersion: env.dsh.version,
    node: env.node.version,
    pnpm: env.pnpm.version,
    reviewer: null,            // ★ 必须填
    verdict: null,             // ★ 必须填：ok | ok-with-notes | broken
    sha256: null,              // 有 tarball 就填
    evidence: '(待填写：真机启动输出里的关键行 / 安装命令 / 观察到的副作用)',
    notes: '(待填写：有无副作用 —— 写全局配置、起后台进程、需要联网/登录/API Key)',
  },
};

function lifecyclePresent(m) {
  return Boolean(Object.keys(m?.scripts ?? {}).some((k) => ['preinstall', 'install', 'postinstall'].includes(k)));
}

if (JSON_OUT) {
  console.log(JSON.stringify(draft, null, 2));
} else {
  console.log('  草稿条目（填完 ★ 字段再收）');
  console.log(`  ${'-'.repeat(74)}`);
  console.log(JSON.stringify(draft, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('');
}

console.log('  接下来必须由你完成（脚本代替不了）');
console.log(`  ${'-'.repeat(74)}`);
console.log('  1. 在隔离环境里真装一次并启动：');
console.log('       node scripts/dev-env.mjs install <tarball 或先 dsh plugin --profile web add <spec>>');
console.log('       node scripts/dev-env.mjs web        # 确认 3090 起得来、面板里能看到它');
console.log('  2. 把启动输出里的关键行、以及观察到的副作用，填进 evidence / notes');
console.log('     （「装上了」不算证据：要写退出码、装配树里出现的那一行）');
console.log('  3. 填 curatedAt 与结论（可用 / 可用但有注意事项 / 不可用），写进 catalog/overrides/curated.json');
console.log('  4. 重新生成目录：node scripts/sync-catalog.mjs（必须）');
console.log('');

if (blockers.length > 0) {
  console.log(`  ✗ 有 ${blockers.length} 项静态检查未通过 —— 按上面的说明处理；不要直接收录。`);
  console.log('');
  process.exit(2);
}

if (WRITE) {
  const curatedPath = path.join(REPO, 'catalog', 'overrides', 'curated.json');
  const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf8'));
  if (curated.plugins.some((p) => p.id === draft.id || p.package === draft.package)) {
    console.log(`  ! catalog/overrides/curated.json 里已经有 ${draft.id} 了，未改动。`);
    console.log('');
    process.exit(1);
  }
  curated.plugins.push(draft);
  curated.curatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(curatedPath, `${JSON.stringify(curated, null, 2)}\n`, 'utf8');
  console.log('  ✓ 草稿已追加到 catalog/overrides/curated.json（还有 ★ 字段是 null，填完再核对）');
  console.log('    别忘了重跑：node scripts/sync-catalog.mjs');
  console.log('');
} else {
  console.log('  提示：加 --write 可以把上面这份草稿直接追加进 catalog/overrides/curated.json。');
  console.log('');
}
