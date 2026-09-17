/**
 * dsh-plugins-market —— 服务器半：装前兼容性闸门（本插件的核心）
 *
 * 目标：在**动任何文件之前**，把「装完会让 dsh 起不来」的情况找出来。
 *
 * 严重度语义（刻意分成三种，避免一刀切导致要么拦不住、要么拦太多）：
 *
 *   fatal + overridable=false  已知确定有害。硬拦截，**不给覆盖入口**。
 *                              例：候选包精确 pin 到另一个 dsh 版本（缺具名导出 → 整棵树挂）、
 *                                  声明的 patch 文件不在包里（boot 期必然 fatal）、
 *                                  profile 里存在指向已删除 tarball 的 file: 依赖。
 *
 *   fatal + overridable=true   我们**无法确认**它安全（不是确认它不安全）。
 *                              默认拦截，但允许用户在明确知情后强制继续。
 *                              例：dsh 版本不在本仓库兼容矩阵里、候选包探测不到 package.json。
 *
 *   warn                       已知的软风险，可继续，但必须如实告诉用户。
 *                              例：peer 范围只是警告、候选带 install 生命周期脚本、
 *                                  未审核层级、installed 版本与声明漂移。
 *
 * 判定依据全部来自**静态读取**（tarball 内容、profile 清单、兼容矩阵、实测的
 * 运行时包版本），不执行候选包的任何代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  satisfies, compareVersions,
  readTarGzEntries, listTarGzEntries, extractPatchRows,
  readAllowBuilds, checkWorkspaceInvariants,
} from './util.js';
import { composedIds, resolveRuntimePackageVersion, resolveLocalSpecPath } from './profile.js';

/** 已知的共存冲突对：两个包不能进同一个 profile（来自本仓库实测结论） */
const KNOWN_CONFLICTS = [
  {
    packages: ['dsh-opencode-go', 'dsh-opencode-go-plus'],
    reason:
      '两者共用设置命名空间 llm-opencode-go 与 provider 路由 opencode-go。实测四种组合：'
      + '共存且基线在前 → 本包记一条 warn 后主动退场；共存且本包在前 → 基线抛未捕获的 '
      + 'DUPLICATE_DISCOVERY，整棵插件树加载失败、dsh web 退出码 1，同 profile 其余插件一并挂掉。',
  },
];

/** 需要预先放行的构建脚本（pnpm 10+ 会因未批准而让 add 以非 0 退出） */
const KNOWN_ALLOW_BUILDS = {
  '@google/genai': false,
  protobufjs: false,
};

const SEV = { FATAL: 'fatal', WARN: 'warn', INFO: 'info' };

function mk(id, title, severity, status, detail, extra = {}) {
  return { id, title, severity, status, detail, ...extra };
}

/**
 * 运行闸门。
 *
 * @param {object} entry   归一化后的目录条目（catalog.normalizeEntry 的产物）
 * @param {object} ctx     { env, compat, profileState, installed, tree, repoRoot, resolveTarball }
 * @param {object} options { acknowledgeRisk, targetProfile, probe }
 */
export function runGate(entry, ctx, options = {}) {
  const started = Date.now();
  const checks = [];

  const envChecks = checkEnvironment(ctx);
  const profileChecks = checkProfile(ctx);
  const candidate = checkCandidate(entry, ctx, options);

  checks.push(...envChecks, ...profileChecks, ...candidate.checks);

  // ── 汇总 ────────────────────────────────────────────────
  const fails = checks.filter((c) => c.status === 'fail');
  const fatalBlocking = fails.filter((c) => c.severity === SEV.FATAL && !c.overridable);
  const fatalOverridable = fails.filter((c) => c.severity === SEV.FATAL && c.overridable);
  const warns = checks.filter((c) => c.status === 'warn' || (c.status === 'fail' && c.severity === SEV.WARN));

  let verdict;
  if (fatalBlocking.length > 0) verdict = 'block';
  else if (fatalOverridable.length > 0) verdict = 'block-overridable';
  else if (warns.length > 0) verdict = 'warn';
  else verdict = 'pass';

  const isCommunity = entry.tier === 'community';
  const requiresRiskAck = isCommunity || verdict === 'block-overridable';
  const acknowledged = options.acknowledgeRisk === true;

  const installable = candidate.installSpec != null;
  let canInstall;
  if (!installable) canInstall = false;
  else if (verdict === 'block') canInstall = false;
  else if (requiresRiskAck) canInstall = acknowledged;
  else canInstall = true;

  return {
    pluginId: entry.id,
    tier: entry.tier,
    tierLabel: entry.tierLabel,
    targetProfile: options.targetProfile ?? ctx.profileState?.profile ?? null,
    verdict,
    canInstall,
    installable,
    requiresRiskAck,
    acknowledged,
    blockedBy: fatalBlocking.map((c) => c.id),
    overridableBy: fatalOverridable.map((c) => c.id),
    counts: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: warns.length,
      fatalBlocking: fatalBlocking.length,
      fatalOverridable: fatalOverridable.length,
      skipped: checks.filter((c) => c.status === 'skip').length,
    },
    checks,
    installSpec: candidate.installSpec,
    manifest: candidate.manifest ?? null,
    probe: candidate.probe ?? null,
    alreadyInstalled: candidate.alreadyInstalled ?? null,
    durationMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// 环境层
// ─────────────────────────────────────────────────────────────

function checkEnvironment(ctx) {
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

function checkProfile(ctx) {
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

// ─────────────────────────────────────────────────────────────
// 候选包层
// ─────────────────────────────────────────────────────────────

function checkCandidate(entry, ctx, options) {
  const out = [];
  const { env, compat, repoRoot } = ctx;

  // 1) 安装规格
  const installSpec = resolveInstallSpec(entry, ctx, options.probe);
  if (!installSpec) {
    out.push(mk('cand.install-spec', '可安装性', SEV.FATAL, 'fail',
      '这个条目没有可用的安装方式（公共索引里既没有可靠的安装命令，也没能推导出 npm / GitHub 规格）。', {
        overridable: false,
        hint: '到它的仓库 README 里按手动步骤安装；本市场只负责展示。',
      }));
  }

  // 2) 已安装情况
  const installedList = ctx.installed ?? [];
  const already = installedList.find((i) => i.name === (entry.package ?? entry.id)) ?? null;
  if (already) {
    out.push(mk('cand.already-installed', '已安装', SEV.INFO, 'pass',
      `已安装 ${already.name}${already.installedVersion ? ` ${already.installedVersion}` : ''}`
      + (entry.version && already.installedVersion && entry.installedVersion !== entry.version ? `，目录里是 ${entry.version}` : '')
      + (already.inBundles ? '，且在 bundles 中' : '，但**不在** bundles 中（装了却不会加载）')));
    if (already.installed && !already.inBundles) {
      out.push(mk('cand.orphan-install', '装了但没挂载', SEV.WARN, 'warn',
        `${already.name} 已经在 node_modules 里，却没有出现在 dsh.profile.bundles 中 —— 这正是 ERR_PNPM_IGNORED_BUILDS 的典型残局，GUI 里看不到它。`, {
          repairable: true,
          hint: `跑一次 \`dsh plugin --profile ${ctx.profileState?.profile} install\` 即可让 dsh 补上 bundles 条目。`,
        }));
    }
  }

  // 3) 静态读包（本地 tarball）
  let manifest = null;
  let patchRows = null;
  let tarEntries = null;
  let tarReadError = null;

  if (installSpec?.kind === 'local-tarball') {
    const tgz = installSpec.resolvedPath;
    if (installSpec.needsDownload && (!tgz || !fs.existsSync(tgz))) {
      // ★ 需要联网下载的 tarball（插件集合仓库托管的那批）**不能**当成失败。
      //   本机没有那份字节，所以装前读不到包内的 package.json —— 这是能力边界，
      //   不是风险。真正的完整性由下载后的 sha256 强校验负责（见 installer.js）。
      out.push(mk('cand.tarball', '安装包来源', SEV.INFO, 'pass',
        `需联网下载：${installSpec.downloadUrl}`
        + (installSpec.sha256 ? `（下载后校验 sha256 ${String(installSpec.sha256).slice(0, 12)}…）` : '')));
      if (!installSpec.sha256) {
        out.push(mk('cand.sha256-missing', '安装包校验和', SEV.WARN, 'warn',
          '配置文件里没有 sha256，下载下来的字节无法校验是否被替换或损坏。', {
            hint: '这是配置文件的问题：请让维护者补上 sha256（插件集合仓库跑 build-manifest.mjs 会自动算出来）。',
          }));
      }
    } else if (!tgz || !fs.existsSync(tgz)) {
      out.push(mk('cand.tarball', 'tarball 存在性', SEV.FATAL, 'fail',
        `找不到 tarball：${tgz ?? installSpec.spec}`, {
          overridable: true,
          hint: '如果本机没有仓库副本，需要联网从 GitHub 下载；也可以手动 clone 仓库后重试。',
        }));
    } else {
      const parsed = readPackageFromTarball(tgz);
      manifest = parsed.manifest;
      patchRows = parsed.patchRows;
      tarEntries = parsed.entries;
      tarReadError = parsed.error;
      if (!manifest) {
        out.push(mk('cand.manifest', '包清单', SEV.FATAL, 'fail',
          `无法从 tarball 里读出 package.json：${tarReadError ?? '未知原因'}`, { overridable: true }));
      } else {
        out.push(mk('cand.manifest', '包清单', SEV.INFO, 'pass',
          `${manifest.name}@${manifest.version}${tarEntries ? `（${tarEntries.length} 个文件）` : ''}`));
      }
    }
  } else if (installSpec?.kind === 'probe' || options.probe) {
    // 远程探测拿到的清单（公共索引条目）
    manifest = options.probe?.manifest ?? null;
    if (manifest) {
      out.push(mk('cand.manifest', '包清单（远程探测）', SEV.INFO, 'pass',
        `读到 ${manifest.name}@${manifest.version ?? '?'}（来自 ${options.probe.source}）。注意：这是仓库源码里的清单，实际发布产物可能不同。`));
    } else {
      out.push(mk('cand.manifest', '包清单（远程探测）', SEV.WARN, 'warn',
        `没能读到候选包的 package.json${options.probe?.error ? `：${options.probe.error}` : ''}，只能做有限判断。`, {
          hint: '这本身就是一个风险信号：无法确认它是不是合法的 dsh 插件。',
        }));
    }
  }

  // 4) dsh.bundle 声明 —— 没有它装了也不会加载
  if (manifest) {
    const patchRel = manifest.dsh?.bundle?.patch;
    if (!patchRel) {
      out.push(mk('cand.bundle-declared', 'dsh.bundle 声明', SEV.FATAL, 'fail',
        '这个包没有声明 dsh.bundle.patch。dsh 会把它当普通依赖装进 node_modules，但**永远不会**写进 '
        + 'dsh.profile.bundles —— 结果就是「装上了，但 GUI 里什么都没有」，且没有任何报错。', {
          overridable: true,
          hint: '确认这确实是一个 dsh 插件包（有些仓库的插件在子目录里，根包不是插件）。',
        }));
    } else {
      out.push(mk('cand.bundle-declared', 'dsh.bundle 声明', SEV.INFO, 'pass', `声明了 ${patchRel}`));

      // 声明的 patch 文件必须在包里 —— 否则 boot 期必然 fatal
      if (tarEntries) {
        const wanted = `package/${patchRel.replace(/^\.\//, '')}`;
        const present = tarEntries.some((e) => e.name === wanted);
        out.push(present
          ? mk('cand.patch-present', 'patch 文件在包内', SEV.INFO, 'pass', wanted)
          : mk('cand.patch-present', 'patch 文件在包内', SEV.FATAL, 'fail',
            `package.json 声明了 ${patchRel}，但 tarball 里没有 ${wanted}。dsh 在 boot 期会直接 throw `
            + '`failed to read overlay …`，整棵插件树起不来。', { overridable: false }));
      }
    }

    // 5) 生命周期脚本（供应链信号，也是 ERR_PNPM_IGNORED_BUILDS 的诱因）
    const lifecycle = Object.keys(manifest.scripts ?? {}).filter((k) =>
      ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'].includes(k));
    if (lifecycle.length > 0) {
      const dangerous = lifecycle.filter((k) => ['preinstall', 'install', 'postinstall'].includes(k));
      out.push(mk('cand.lifecycle', '安装期脚本', dangerous.length > 0 ? SEV.WARN : SEV.INFO, dangerous.length > 0 ? 'warn' : 'pass',
        `包自带 ${lifecycle.join('、')} 脚本。`
        + (dangerous.length > 0 ? '这类脚本会在安装时执行，属于需要留意的供应链面。' : '（prepare 对 tarball/registry 安装本来就不执行。）')));
    }

    // 6) engines.node
    const eng = manifest.engines?.node;
    if (eng) {
      const ok = satisfies(env.node.version, eng);
      out.push(ok === true
        ? mk('cand.engines', 'engines.node', SEV.INFO, 'pass', `${eng}（当前 ${env.node.version}）`)
        : mk('cand.engines', 'engines.node', ok === null ? SEV.WARN : SEV.FATAL, ok === null ? 'skip' : 'fail',
          `包声明 engines.node = ${eng}，当前 Node ${env.node.version} `
          + (ok === false ? '不满足该范围。注意本仓库几个包写的是 `^22.19.0 || >=24.0.0`，它**排除 23.x**。' : '无法判定。'), {
            overridable: true,
            hint: '换到满足范围的 Node（22.19+ 或 24+）。',
          }));
    }
  }

  // 7) ★ peer 运行时判定 —— 最致命的一类
  const peer = checkPeerRuntime(manifest, entry, ctx);
  out.push(...peer);

  // 8) sha256（目录里给了就必须对得上）
  if (installSpec?.kind === 'local-tarball' && installSpec.resolvedPath && fs.existsSync(installSpec.resolvedPath)) {
    if (entry.sha256) {
      const actual = sha256File(installSpec.resolvedPath);
      out.push(actual === entry.sha256
        ? mk('cand.sha256', 'tarball 校验和', SEV.INFO, 'pass', `sha256 与目录一致（${entry.sha256.slice(0, 12)}…）`)
        : mk('cand.sha256', 'tarball 校验和', SEV.FATAL, 'fail',
          `sha256 不一致：目录记录 ${entry.sha256.slice(0, 16)}…，实际 ${String(actual).slice(0, 16)}…。`
          + 'tarball 可能被替换或损坏。', { overridable: false }));
    } else {
      // 自引用条目（本插件指向自己的 tarball）天然无法自包含 hash —— 如实说明，
      // 而不是假装校验过了。
      out.push(mk('cand.sha256', 'tarball 校验和', SEV.INFO, 'skip',
        entry.sha256Note ?? '目录里没有这个包的校验和，无法验证 tarball 是否被替换或损坏。'));
    }
  }

  // 9) 危险文件
  if (tarEntries) {
    const risky = tarEntries.filter((e) => /(^|\/)\.env($|\.)|\.pem$|\.key$|id_rsa|credentials\.ya?ml$|\.npmrc$/i.test(e.name));
    if (risky.length > 0) {
      out.push(mk('cand.risky-files', '包内敏感文件', SEV.WARN, 'warn',
        `tarball 内含疑似凭据文件：${risky.map((r) => r.name).join('、')}`));
    }
  }

  // 10) insert id 冲突
  if (patchRows && ctx.tree?.ok) {
    const existing = composedIds(ctx.tree);
    const collisions = patchRows.filter((r) => r.id && existing.has(r.id) && !isSelfRow(r, entry));
    if (collisions.length > 0) {
      out.push(mk('cand.row-collision', '装配行 id 冲突', SEV.WARN, 'warn',
        collisions.map((c) => `insert id "${c.id}" 在现有装配树里已存在（由 ${existing.get(c.id).map((x) => x.section).join('/')} 提供）`).join('；')
        + '。重复的顶层 id 可能让其中一个被覆盖或忽略。', { overridable: true }));
    }
  }

  // 11) 已知共存冲突
  if (manifest?.name) {
    for (const conflict of KNOWN_CONFLICTS) {
      const others = conflict.packages.filter((p) => p !== manifest.name);
      const present = others.filter((p) => (ctx.installed ?? []).some((i) => i.name === p && i.installed));
      if (conflict.packages.includes(manifest.name) && present.length > 0) {
        out.push(mk('cand.coexistence', '已知共存冲突', SEV.FATAL, 'fail',
          `本包与已安装的 ${present.join('、')} 不能共存于同一个 profile。${conflict.reason}`, {
            overridable: false,
            hint: `先卸载 ${present.join('、')} 再装这个。`,
          }));
      }
    }
  }

  // 12) 层级固有风险
  if (entry.tier === 'community') {
    out.push(mk('cand.tier', '来源可信度', SEV.WARN, 'warn',
      '这条来自公共索引，本仓库**没有**对它做过任何适配验证。上面的判定只基于对仓库源码的静态探测，'
      + '无法覆盖实际发布产物、运行时行为与依赖闭包。', { overridable: true }));
  } else if (entry.tier === 'reviewed') {
    out.push(mk('cand.tier', '来源可信度', SEV.INFO, 'pass',
      `维护者人工审核收录${entry.review?.reviewedAt ? `（${entry.review.reviewedAt}）` : ''}`
      + (entry.review?.dshVersion ? `，审核时 dsh ${entry.review.dshVersion}` : '')));
    out.push(mk('cand.tier-stale', '审核时效', entry.review?.dshVersion && entry.review.dshVersion !== env.dsh.version ? SEV.WARN : SEV.INFO,
      entry.review?.dshVersion && entry.review.dshVersion !== env.dsh.version ? 'warn' : 'pass',
      entry.review?.dshVersion && entry.review.dshVersion !== env.dsh.version
        ? `审核是在 dsh ${entry.review.dshVersion} 上做的，当前是 ${env.dsh.version}，结论可能已经过期。`
        : '审核结论与当前 dsh 版本一致。'));
  }

  return { checks: out, installSpec, manifest, probe: options.probe ?? null, alreadyInstalled: already };
}

function isSelfRow(row, entry) {
  return row.name === (entry.package ?? entry.id) || row.id === entry.id;
}

/**
 * peer 判定。
 *
 * 这一段的档位是**用仓库里两个真实数据点校准出来的**，不是拍脑袋定的：
 *
 *   · dsh-opencode-go-plus 把 @deepseek-ai/dsh-llm 精确 pin 在 0.1.6-alpha.1。
 *     在 0.1.5 线上装它 → 内置的 dsh-llm 缺 0.1.6 新增的导出 → ESM 具名导入确定性失败
 *     → **整棵插件树加载失败，dsh web 完全起不来**。这是真实事故。
 *     特征：**插件要求的版本比本机新**（本机缺少它要的东西）。
 *
 *   · dsh-receipt 精确 pin 了 @deepseek-ai/cordis@4.0.1 / dsh-session@0.1.0-rc.6 /
 *     dsh-tools@0.1.0-rc.6，而本机是 4.0.2 / 0.1.6-alpha.1 —— 全都不一致，
 *     但 compatibility.json 明确记录「这两个包在运行时仍存在，实测可正常加载」，
 *     而且它现在是 profile 里正常工作的 8 个插件之一。
 *     特征：**插件要求的版本比本机旧**（新版本保留了它要的接口，向后兼容）。
 *
 * 所以判据不是「pin 是否相等」，而是**方向**：
 *
 *   本机 < 插件要求   → pin-too-old   → 致命、不可覆盖（缺导出，整棵树挂）
 *   本机 > 插件要求   → pin-newer-ok  → 只告警（向后兼容，实测可用）
 *
 * 范围不匹配同理只告警：profile 设了 autoInstallPeers: false，peer 根本不参与安装；
 * dsh-connect-trae 就是范围不匹配却实测正常的例子。
 */
function checkPeerRuntime(manifest, entry, ctx) {
  const out = [];

  // ★ 没有包内清单时（tarball 需要联网下载、远程探测失败、npm/github 规格），
  //   退回到**本仓库实测记录下来的结论** —— 那是配置文件里的事实，比「无法判定」有用得多。
  //   注意措辞：这是「收录时测出来的」，不是「此刻现场测的」，所以要标出来源。
  if (!manifest) {
    if (entry.peerRuntimePin || entry.peerVerdict || entry.peerNote) {
      const level = entry.peerVerdict === 'critical' ? SEV.WARN
        : entry.peerVerdict === 'warn' ? SEV.WARN
          : SEV.INFO;
      out.push(mk('cand.peer-runtime', '运行时 peer 约束（收录结论）', level,
        level === SEV.WARN ? 'warn' : 'pass',
        `本仓库收录时的实测结论：${entry.peerVerdict ?? '未标注'}。`
        + (entry.peerRuntimePin ? `记录的 peer：${entry.peerRuntimePin}。` : '')
        + (entry.peerNote ? `\n${entry.peerNote}` : ''), {
          hint: level === SEV.WARN ? '可以继续；若启动后日志出现「does not provide an export named」再回退。' : null,
          fromConfig: true,
        }));
    }
    return out;
  }

  const peers = manifest?.peerDependencies ?? {};
  const keys = Object.keys(peers).filter((k) => k.startsWith('@deepseek-ai/'));
  if (keys.length === 0) {
    if (Object.keys(peers).length > 0) {
      out.push(mk('cand.peer-runtime', '运行时 peer 约束', SEV.INFO, 'pass',
        `只约束 ${Object.keys(peers).join('、')}，不对 @deepseek-ai/* 运行时设 pin。`));
    }
    return out;
  }

  const rows = [];
  const rank = { pass: 0, warn: 1, fail: 2 };
  let worst = 'pass';
  const bump = (level) => { if (rank[level] > rank[worst]) worst = level; };

  for (const key of keys) {
    const range = peers[key];
    const resolved = resolveRuntimePackageVersion(key, {
      dshDir: ctx.env.dsh.dir,
      profileDir: ctx.profileState?.dir,
      env: process.env,
    });
    if (!resolved.version) {
      rows.push({ key, range, actual: null, result: 'unknown' });
      bump('warn');
      continue;
    }
    const exactPin = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(range).trim());
    const ok = satisfies(resolved.version, range);
    let result;
    if (ok === true) {
      result = 'ok';
    } else if (ok === false && exactPin) {
      // ★ 关键：精确 pin 的失配要分方向，不能一律当致命
      const cmp = compareVersions(resolved.version, range);
      result = cmp !== null && cmp < 0 ? 'pin-too-old' : 'pin-newer-ok';
    } else if (ok === false) {
      result = 'range-mismatch';
    } else {
      result = 'unknown';
    }
    rows.push({ key, range, actual: resolved.version, result, exactPin });
    if (result === 'pin-too-old') bump('fail');
    else if (result !== 'ok') bump('warn');
  }

  const describe = (r) =>
    `${r.key}: 要求 ${r.range}，本机 ${r.actual ?? '未找到'}`
    + (r.result === 'pin-too-old' ? '（精确 pin，且本机版本**低于**要求）'
      : r.result === 'pin-newer-ok' ? '（精确 pin，本机版本更高，向后兼容）'
        : r.result === 'range-mismatch' ? '（按 npm 语义不在范围内）'
          : r.result === 'unknown' ? '（无法判定）' : '');

  const tooOld = rows.filter((r) => r.result === 'pin-too-old');
  const soft = rows.filter((r) => r.result !== 'ok' && r.result !== 'pin-too-old');

  if (tooOld.length > 0) {
    out.push({
      ...mk('cand.peer-runtime', '运行时 peer 约束', SEV.FATAL, 'fail',
        '候选包**精确 pin** 的 @deepseek-ai/* 运行时版本比本机**更高**，也就是本机缺少它要的接口。'
        + '这正是本仓库记录过的事故形态（dsh-opencode-go-plus 在 0.1.5 上）：'
        + '后果不是「功能少一点」，而是 ESM 具名导出缺失 → 整棵插件树加载失败 → dsh web 完全起不来。'
        + rows.map(describe).join('；'), {
          overridable: false,
          hint: '换用与本机 dsh 版本配套的插件版本，或把 dsh 升级到插件要求的版本。',
        }),
      rows,
    });
  } else if (soft.length > 0) {
    const onlyNewer = soft.every((r) => r.result === 'pin-newer-ok');
    out.push({
      ...mk('cand.peer-runtime', '运行时 peer 约束', SEV.WARN, 'warn',
        (onlyNewer
          ? '候选包精确 pin 的 @deepseek-ai/* 版本比本机**旧**。新版本保留了它需要的接口，'
          + '这类失配通常只是 pnpm 的 peer 警告 —— 本仓库自带的 dsh-receipt 就是这种情况（pin 在 0.1.0-rc.6，'
          + '本机 0.1.6-alpha.1），实测加载正常。'
          : '候选包要求的 @deepseek-ai/* 运行时范围按 npm 语义不包含本机版本（预发布版本的匹配规则比较严）。'
          + '因为 profile 设了 autoInstallPeers: false，peer 不参与安装，这类不匹配通常只是警告 —— '
          + '本仓库自带的 dsh-connect-trae 就是这种情况，实测加载正常。')
        + rows.map(describe).join('；'), {
          hint: '可以继续；若启动后日志出现「does not provide an export named」再回退。',
        }),
      rows,
    });
  } else {
    out.push({ ...mk('cand.peer-runtime', '运行时 peer 约束', SEV.INFO, 'pass', rows.map(describe).join('；')), rows });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 安装规格解析
// ─────────────────────────────────────────────────────────────

/**
 * 解析「怎么装」。
 *
 * ★ 自 0.4.0 起，这个函数的输入不再是「公共索引里的命令」，而是**那个插件自己的
 *   配置文件**（catalog/plugins/<slug>.json）里写的 `install`。也就是说：
 *   装什么、怎么装，由配置文件说了算 —— 市场只负责执行。
 *
 * 配置里可能出现的 method（枚举见仓库根的 scripts/lib/catalog-format.mjs）：
 *
 *   tarball  仓库托管的离线 .tgz，带 url + sha256。唯一的「直装」路径。
 *   npm      npm 包名，直接交给 pnpm。
 *   github   github:owner/repo，由 pnpm 直接解析仓库，目标明确、不会张冠李戴。
 *   skills   上游走的是 skills 机制，不是 dsh 插件 —— 市场没有可执行的安装路径。
 *   manual   没有可靠的安装方式，只有说明。
 *
 * 仍然保留的两条兜底：
 *   ① 配置文件给了 tarball 相对路径且本机有仓库副本 → 用本地字节（离线、快）
 *   ② 配置里没有规格，但条目的 upstream 是干净的 GitHub 仓库地址 → 推导 github:
 *      （这一条是安全的：pnpm 直接解析那个仓库，不会装进来一个同名无关的包）
 *
 * 刻意**不做**的事：拿条目的显示名去当 npm 包名。公共索引里的 name 与真实 npm
 * 包名没有任何保证关系，直接拿来装，极可能装进来一个同名但完全无关的包 ——
 * 那是最难排查的一类事故。
 */
export function resolveInstallSpec(entry, ctx, probe) {
  const inst = entry.install ?? {};
  const method = inst.method ?? (inst.kind === 'local-tarball' ? 'tarball' : inst.kind) ?? 'manual';
  const pkg = entry.package ?? entry.id;

  // ── ① tarball：配置文件给了下载地址 + 校验和 ──────────────
  if (method === 'tarball' || inst.kind === 'local-tarball') {
    // ①a 规格本身就是本机一个真实存在的 .tgz 绝对路径。
    //     这一条不能少：它既是「用户手动指定了一个本地包」的路径，
    //     也是闸门测试唯一能造出一个可控候选包的方式（不需要联网、不需要仓库副本）。
    if (inst.spec && fs.existsSync(inst.spec)) {
      return { kind: 'local-tarball', spec: inst.spec, resolvedPath: inst.spec, package: pkg, source: 'local' };
    }
    // ①b 本机有市场仓库副本时优先用仓库里的字节（离线、快、且与开发机一致）
    if (inst.tarball && ctx.repoRoot) {
      const local = path.join(ctx.repoRoot, inst.tarball);
      if (fs.existsSync(local)) {
        return { kind: 'local-tarball', spec: local, resolvedPath: local, source: 'repo', package: pkg };
      }
    }
    // ①c 集合仓库托管的 tarball 不在市场仓库里，只能联网下 —— sha256 在下载后校验
    if (inst.url) {
      return {
        kind: 'local-tarball',
        spec: inst.url,
        resolvedPath: null,
        needsDownload: true,
        downloadUrl: inst.url,
        sha256: inst.sha256 ?? entry.sha256 ?? null,
        dshVersion: inst.dshVersion ?? null,
        package: pkg,
        source: 'remote',
      };
    }
    // ①d 只有相对路径、没有 url：退回市场仓库的 raw 地址
    if (inst.tarball && ctx.repoRawBase) {
      const url = `${ctx.repoRawBase}/${slash(inst.tarball)}`;
      return {
        kind: 'local-tarball',
        spec: url,
        resolvedPath: null,
        needsDownload: true,
        downloadUrl: url,
        sha256: inst.sha256 ?? entry.sha256 ?? null,
        package: pkg,
        source: 'remote',
      };
    }
    return null;
  }

  // ── ② 配置文件直接给了规格 ────────────────────────────────
  if (method === 'github' && /^github:[^\s]+$/.test(String(inst.spec ?? ''))) {
    return { kind: 'github', spec: inst.spec, resolvedPath: null, package: pkg, source: 'config' };
  }
  if (method === 'npm' && looksLikeNpmSpec(inst.spec)) {
    return { kind: 'npm', spec: inst.spec, resolvedPath: null, package: pkg, source: 'config' };
  }

  // ── ③ 索引命令里干净的规格（兼容上一版的采集结果）──────────
  const extracted = extractCleanSpec(inst.commands ?? []);
  if (extracted) {
    return { kind: extracted.kind, spec: extracted.spec, resolvedPath: null, package: pkg, source: 'config-command' };
  }

  // ── ④ 从 owner/repo 推导（pnpm 直接解析仓库，不会张冠李戴）──
  if (entry.upstream && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(entry.upstream)) {
    const slug = entry.upstream.replace('https://github.com/', '');
    if (!slug.includes(' ')) {
      return { kind: 'github', spec: `github:${slug}`, resolvedPath: null, package: pkg, source: 'derived-github' };
    }
  }

  // ── ⑤ 退到裸 npm 包名：必须有探测证据（包在 npm 上真实存在）──
  const probed = probe?.available && /npm registry/.test(String(probe.source ?? ''));
  const name = probed ? (probe.manifest?.name ?? entry.package ?? entry.name) : null;
  if (name && looksLikeNpmSpec(name)) {
    return { kind: 'npm', spec: name, resolvedPath: null, package: name, source: 'probed-npm' };
  }

  // skills / manual：没有可执行的 dsh 安装路径，如实返回 null，由闸门告诉用户为什么
  return null;
}

const slash = (p) => String(p).split(path.sep).join('/');

/** npm 包名（可带 @scope）与 `name@version` 都算 */
function looksLikeNpmSpec(s) {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^\s]+)?$/i.test(String(s ?? '').trim());
}

/** 只接受 `dsh plugin … add <干净的 npm/github 规格>`；其它形式（curl|sh、pip、brew、npm -g）一律拒绝 */
export function extractCleanSpec(commands) {
  if (!Array.isArray(commands)) return null;
  for (const raw of commands) {
    const cmd = String(raw ?? '').trim();
    if (cmd === '' || /<[^>]*>/.test(cmd)) continue; // 含占位符的一律不信
    const m = /\bdsh\s+plugin\b[^\n]*?\badd\s+(.+?)\s*$/.exec(cmd);
    if (!m) continue;
    if (/\s&&|\s\|\s|\s;\s/.test(cmd)) continue; // 复合命令不认
    const spec = m[1].replace(/^['"]|['"]$/g, '').trim();
    if (/^github:[^\s]+$/.test(spec)) return { kind: 'github', spec };
    if (/^npm:[^\s]+$/.test(spec)) return { kind: 'npm', spec: spec.slice(4) };
    if (looksLikeNpmSpec(spec)) return { kind: 'npm', spec };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// tarball 静态读取
// ─────────────────────────────────────────────────────────────

export function readPackageFromTarball(tgz) {
  const wanted = ['package/package.json', 'package/cordis.patch.yml'];
  const entries = listTarGzEntries(tgz);
  const files = readTarGzEntries(tgz, wanted);
  if (!files) return { manifest: null, patchRows: null, entries, error: 'gzip 解压失败（文件损坏或不是 .tgz）' };

  const pkgBuf = files.get('package/package.json');
  if (!pkgBuf) return { manifest: null, patchRows: null, entries, error: 'tarball 里没有 package/package.json' };

  let manifest;
  try {
    manifest = JSON.parse(pkgBuf.toString('utf8'));
  } catch (err) {
    return { manifest: null, patchRows: null, entries, error: `package.json 不是合法 JSON：${err.message}` };
  }

  let patchRows = null;
  const declared = manifest.dsh?.bundle?.patch;
  const patchName = declared ? `package/${String(declared).replace(/^\.\//, '')}` : 'package/cordis.patch.yml';
  const patchBuf = files.get(patchName) ?? files.get('package/cordis.patch.yml');
  if (patchBuf) patchRows = extractPatchRows(patchBuf.toString('utf8'));

  return { manifest, patchRows, entries, error: null };
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
