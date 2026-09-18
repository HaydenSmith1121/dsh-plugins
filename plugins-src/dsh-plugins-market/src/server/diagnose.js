/**
 * dsh-plugins-market —— 服务器半：环境与 profile 诊断
 *
 * ★ 这里回答的是「**这台机器 / 这个 profile** 健康吗」，不是「某个插件能不能装」。
 *   后者那套判定（verdict / 硬拦截 / 风险确认）已在 0.6.0 整体删除 ——
 *   市场不再拦任何插件，见 spec.js 顶部的说明。
 *
 * 留下来是因为它有用：「已装」页的 profile 体检读的就是这两组结论，
 * 而它们描述的问题（断链的 file: 依赖、dsh / pnpm 装错 Node、版本漂移）
 * 会让**任何**安装都失败或装到错地方 —— 与装哪个插件无关。
 *
 * 这两组结论是**只读诊断**：不参与任何放行判定。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions, readAllowBuilds, checkWorkspaceInvariants,
} from './util.js';
import { resolveLocalSpecPath } from './profile.js';
import { KNOWN_ALLOW_BUILDS } from './spec.js';

/** 严重度：只用于决定这一行长什么样，不参与任何放行判定 */
const SEV = { FATAL: 'fatal', WARN: 'warn', INFO: 'info' };

function mk(id, title, severity, status, detail, extra = {}) {
  return { id, title, severity, status, detail, ...extra };
}

// ─────────────────────────────────────────────────────────────
// 环境层
// ─────────────────────────────────────────────────────────────

export function checkEnvironment(ctx) {
  const { env, compat } = ctx;
  const out = [];

  // node
  const nodeMin = compat?.requirements?.node?.min ?? null;
  if (nodeMin) {
    const cmp = compareVersions(env.node.version, nodeMin);
    out.push(
      cmp === null
        ? mk('env.node', 'Node 版本', SEV.WARN, 'skip', `无法比较 Node 版本（当前 ${env.node.version}，要求 ≥ ${nodeMin}）`)
        : cmp >= 0
          ? mk('env.node', 'Node 版本', SEV.INFO, 'pass', `${env.node.version}（要求 ≥ ${nodeMin}）`)
          : mk('env.node', 'Node 版本', SEV.FATAL, 'fail', `当前 ${env.node.version}，低于本仓库验证下限 ${nodeMin}。`, { overridable: true, hint: `升级 Node 到 ≥ ${nodeMin} 后重试。` }),
    );
  }

  // dsh 是否装了
  if (!env.dsh.installed) {
    out.push(mk('env.dsh', 'dsh 安装', SEV.FATAL, 'fail', '没有找到 @deepseek-ai/dsh 的安装目录，无法安装任何插件。', {
      overridable: false,
      hint: '先安装 dsh，例如：npm i -g @deepseek-ai/dsh@' + (compat?.runtimes?.find((r) => r.recommended)?.dshVersion ?? '0.1.6-alpha.1'),
    }));
    return out;
  }
  out.push(mk('env.dsh', 'dsh 安装', SEV.INFO, 'pass', `dsh ${env.dsh.version}（${env.dsh.dir}）`));

  // dsh 版本是否在兼容矩阵里
  const runtime = compat?.runtimes?.find((r) => r.dshVersion === env.dsh.version) ?? null;
  const latest = compat?.distTags?.latest ?? null;
  if (!runtime) {
    out.push(mk('env.dsh-runtime', 'dsh 版本适配', SEV.FATAL, 'fail',
      `本仓库的兼容矩阵里没有 dsh ${env.dsh.version}，无法判断任何插件能否在该版本上加载。`, {
        overridable: true,
        hint: '换到矩阵里 status: supported 的版本，或自行承担风险继续。',
      }));
  } else if (runtime.status !== 'supported') {
    out.push(mk('env.dsh-runtime', 'dsh 版本适配', SEV.FATAL, 'fail',
      `dsh ${env.dsh.version} 在本仓库中被标记为 **不支持**：${runtime.reason ?? '（未说明原因）'}`, {
        overridable: false,
        hint: runtime.upgradeTo ? `升级到 ${runtime.upgradeTo}：npm i -g @deepseek-ai/dsh@${runtime.upgradeTo}` : null,
      }));
  } else {
    out.push(mk('env.dsh-runtime', 'dsh 版本适配', SEV.INFO, 'pass', `dsh ${env.dsh.version} 已实测支持（${runtime.verifiedAt ?? '—'}）`));
  }
  if (latest && env.dsh.version === latest) {
    out.push(mk('env.dsh-downgrade', '静默降级风险', SEV.WARN, 'warn',
      `当前 dsh 版本等于 npm latest 通道（${latest}），而不带版本号的 npm i -g @deepseek-ai/dsh 装的正是它。`, {
        hint: '升级请始终显式带版本号，例如 npm i -g @deepseek-ai/dsh@' + (compat?.runtimes?.find((r) => r.recommended)?.dshVersion ?? '0.1.6-alpha.1'),
      }));
  }

  // pnpm
  const pnpmMin = compat?.requirements?.pnpm?.min ?? null;
  if (!env.pnpm.installed) {
    out.push(mk('env.pnpm', 'pnpm 可用', SEV.FATAL, 'fail',
      'PATH 上找不到 pnpm。dsh plugin 本质是 pnpm 的薄封装，没有它一切安装都会失败。', {
        overridable: false,
        hint: env.dsh.prefix ? `"${path.join(env.dsh.prefix, process.platform === 'win32' ? 'npm.cmd' : 'bin/npm')}" install -g pnpm` : '先安装 pnpm',
      }));
  } else if (!env.pnpm.samePrefixAsDsh) {
    out.push(mk('env.pnpm', 'pnpm 可用', SEV.WARN, 'warn',
      `pnpm（${env.pnpm.path}）与 dsh（${env.dsh.prefix}）不在同一个 Node 前缀下。多 Node 环境下这很容易导致装错位置。`, {
        hint: '把 pnpm 装在 dsh 所在的那个 Node 上。',
      }));
    out.push(mk('env.pnpm-version', 'pnpm 版本', SEV.INFO, 'skip', `pnpm ${env.pnpm.version ?? '?'}`));
  } else {
    out.push(mk('env.pnpm', 'pnpm 可用', SEV.INFO, 'pass', `pnpm ${env.pnpm.version ?? '?'}（与 dsh 同前缀）`));
    if (pnpmMin && env.pnpm.version) {
      const cmp = compareVersions(env.pnpm.version, pnpmMin);
      out.push(cmp !== null && cmp < 0
        ? mk('env.pnpm-version', 'pnpm 版本', SEV.WARN, 'warn',
          `pnpm ${env.pnpm.version} 低于本仓库验证的 ${pnpmMin}；pnpm 10+ 才默认拦截依赖构建脚本（allowBuilds 那套机制依赖它）。`)
        : mk('env.pnpm-version', 'pnpm 版本', SEV.INFO, 'pass', `pnpm ${env.pnpm.version}（要求 ≥ ${pnpmMin}）`));
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// profile 层
// ─────────────────────────────────────────────────────────────

export function checkProfile(ctx) {
  const { profileState, installed, tree } = ctx;
  const out = [];

  if (!profileState?.exists) {
    out.push(mk('profile.exists', 'profile 目录', SEV.WARN, 'warn', `profile 目录还不存在：${profileState?.dir ?? '?'}，首次安装时会被 dsh 自动初始化。`));
    return out;
  }
  if (!profileState.initialized) {
    out.push(mk('profile.manifest', 'profile 清单', SEV.FATAL, 'fail',
      `${profileState.dir}/package.json 不存在或不是合法 JSON。`, {
        overridable: false,
        hint: '先跑一次 `dsh --profile ' + profileState.profile + ' --version` 让 dsh 初始化 profile。',
      }));
    return out;
  }
  out.push(mk('profile.manifest', 'profile 清单', SEV.INFO, 'pass',
    `${profileState.bundles.length} 个 bundle、${Object.keys(profileState.dependencies).length} 个依赖`));

  // ★ file: 依赖指向的 tarball 必须还在 —— 本机真实存在的隐患
  const dangling = [];
  for (const [name, spec] of Object.entries(profileState.dependencies)) {
    const local = resolveLocalSpecPath(spec, profileState.dir);
    if (local && !fs.existsSync(local)) dangling.push({ name, spec, local });
  }
  if (dangling.length > 0) {
    out.push(mk('profile.file-specs', 'file: 依赖完整性', SEV.FATAL, 'fail',
      `profile 里有 ${dangling.length} 个依赖指向的本地 tarball 已不存在：`
      + dangling.map((d) => `${d.name} → ${d.local}`).join('；')
      + '。只要这些引用还在，之后**任何** pnpm install / dsh plugin 操作都会失败，装什么都会连带失败。', {
        overridable: false,
        hint: '先修好 profile：把过期的依赖升级到仓库里现有的 tarball（或移除），再回来装插件。',
        detail_data: dangling,
      }));
  } else {
    out.push(mk('profile.file-specs', 'file: 依赖完整性', SEV.INFO, 'pass', '所有 file: 依赖指向的本地 tarball 都存在'));
  }

  // bundles 与 dependencies 的一致性
  const depNames = new Set(Object.keys(profileState.dependencies));
  const inBox = new Set(ctx.compat?.inBoxBundles ?? []);
  const orphan = profileState.bundles.filter((b) => !depNames.has(b) && !inBox.has(b));
  if (orphan.length > 0) {
    out.push(mk('profile.bundles-consistent', 'bundles 一致性', SEV.WARN, 'warn',
      `bundles 里有 ${orphan.length} 项既不是依赖也不是内置 bundle：${orphan.join('、')}。这通常意味着 pnpm 曾以非 0 退出、bundles 没写成，或依赖被手删过。`, {
        hint: `跑一次 \`dsh plugin --profile ${profileState.profile} install\` 让 dsh 重新对齐。`,
      }));
  } else {
    out.push(mk('profile.bundles-consistent', 'bundles 一致性', SEV.INFO, 'pass', 'bundles 每一项都能对应到依赖或内置 bundle'));
  }

  // 已安装版本 vs 声明版本（漂移）
  const drift = (installed ?? []).filter((i) => i.mismatch);
  if (drift.length > 0) {
    out.push(mk('profile.installed-drift', '已装版本漂移', SEV.WARN, 'warn',
      drift.map((d) => `${d.name}：声明 ${d.specVersion}，实际装的是 ${d.installedVersion}`).join('；'), {
        hint: '重新安装该插件即可对齐；本市场的「更新」会顺带修掉。',
      }));
  }

  // pnpm-workspace.yaml 三个不变量
  const inv = checkWorkspaceInvariants(profileState.workspaceText);
  const lost = Object.entries(inv).filter(([, ok]) => !ok).map(([k]) => k);
  if (profileState.workspaceText == null) {
    out.push(mk('profile.workspace', 'pnpm-workspace.yaml', SEV.WARN, 'warn', 'pnpm-workspace.yaml 不存在，首次安装时 dsh 会创建它。'));
  } else if (lost.length > 0) {
    out.push(mk('profile.workspace', 'pnpm-workspace.yaml 不变量', SEV.FATAL, 'fail',
      `pnpm-workspace.yaml 缺少关键配置：${lost.join('、')}。`
      + (inv.autoInstallPeersFalse ? '' : ' 少了 autoInstallPeers: false，pnpm 会去 registry 装 peer，'
        + '从而在 profile 里出现第二份 @deepseek-ai/* —— 那正是「插件树加载失败」的经典成因。'), {
        overridable: true,
        repairable: true,
        hint: '用「修复 profile 配置」把缺失的键补回去（只补键，不改动其它内容）。',
      }));
  } else {
    out.push(mk('profile.workspace', 'pnpm-workspace.yaml 不变量', SEV.INFO, 'pass', 'packages / nodeLinker / autoInstallPeers 均在'));
  }

  // allowBuilds
  const ab = readAllowBuilds(profileState.workspaceText);
  const missingKeys = Object.keys(KNOWN_ALLOW_BUILDS).filter((k) => ab == null || !(k in ab));
  const placeholders = ab ? Object.entries(ab).filter(([, v]) => v === 'placeholder').map(([k]) => k) : [];
  if (placeholders.length > 0) {
    out.push(mk('profile.allowbuilds', 'allowBuilds', SEV.WARN, 'warn',
      `allowBuilds 里还有 ${placeholders.length} 个未决定的占位符：${placeholders.join('、')}。pnpm 会因此以非 0 退出，`
      + '而 dsh 在 pnpm 非 0 时**不会**把包写进 bundles —— 表现就是「装上了但 GUI 里没有」。', {
        hint: '安装前会自动补好这几项。',
      }));
  } else if (missingKeys.length > 0) {
    out.push(mk('profile.allowbuilds', 'allowBuilds', SEV.WARN, 'warn',
      `allowBuilds 里缺少本仓库已知需要放行的键：${missingKeys.join('、')}（安装前会自动补上）。`));
  } else {
    out.push(mk('profile.allowbuilds', 'allowBuilds', SEV.INFO, 'pass', '已知需要放行的构建脚本都已标记'));
  }

  // 装配树（如果有）
  if (tree?.ok) {
    const bad = [
      [/patch insert: entry (.+) not found/g, 'insert 目标不存在'],
      [/patch insert: entry (.+) is not a group/g, 'insert 目标不是 group'],
      [/patch: entry (.+) not found/g, 'patch 目标不存在'],
      [/patch: name mismatch/g, 'patch name 不匹配'],
    ];
    const hits = [];
    for (const [re, label] of bad) {
      for (const m of String(tree.stderr ?? '').matchAll(re)) hits.push(`${label}：${m[1] ?? ''}`.trim());
    }
    if (hits.length > 0) {
      out.push(mk('profile.patch-warnings', '现有装配告警', SEV.WARN, 'warn',
        `当前装配树已存在 ${hits.length} 条 patch 告警：` + hits.slice(0, 5).join('；')));
    }
  }

  return out;
}

