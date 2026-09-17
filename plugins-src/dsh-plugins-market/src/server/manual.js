/**
 * dsh-plugins-market —— 服务器半：手动安装指引
 *
 * ★ 为什么这个文件必须存在
 *
 * 自动安装是「一条命令 + 一堆环境假设」：pnpm 在、Node 版本对、网络通、
 * profile 里没有断链的 file: 依赖、构建脚本已放行……任何一条不成立，
 * 界面上能做的都只是**报错**，而用户手里没有可执行的下一步。
 *
 * 更糟的是那些「不报错但很慢」的情形（慢镜像解析整棵依赖树、pnpm 反复重试）。
 * 此时唯一正确的产品行为是：**让用户看到「其实你可以自己敲命令装」**，
 * 并且把命令原样给全 —— 包括装哪个文件、校验和是多少、装完怎么确认。
 *
 * 本仓库的情况让这件事格外可行：目录里每一条插件在本仓库都有**快照 tarball**
 * （`plugins/<包名>/<dsh 版本>/<包名>-<版本>.tgz`），
 * 所以「手动安装」不是一句空话 —— 用户拿到的是一个确定存在的文件 + 一条确定的命令。
 *
 * 设计约束：
 *   - 命令必须是**可以直接复制粘贴执行**的完整命令，不带占位符、不带省略号。
 *   - Windows 与 POSIX 分开给（用户的机器是哪种，界面上要能自己选）。
 *   - 每一步都要有一句「这一步在干什么、失败了说明什么」，否则命令清单等于没给。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256File, tarballCacheDir } from './installer.js';
import { REPO_RAW_BASE, REPO_HOMEPAGE } from './catalog.js';

const win = process.platform === 'win32';

/** 路径统一成正斜杠：两种 shell 都能用，且不会在 JSON/界面里出现转义地狱 */
function slash(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/** 需要引号时（含空格）套双引号 —— 两种 shell 都认 */
function q(p) {
  const s = slash(p);
  return /\s/.test(s) ? `"${s}"` : s;
}

function sh(p) {
  return `"${slash(p)}"`;
}

/**
 * 生成本次安装的「手动兜底」方案。
 *
 * @param {object} entry  目录条目（含 package / version / sha256 / install.tarball）
 * @param {object} ctx    gctx() 的结果
 * @param {object} [spec] gate.installSpec（有就用它，能拿到已解析的绝对路径）
 */
export function manualInstallPlan(entry, ctx, spec = null) {
  const pkg = entry?.package ?? entry?.id ?? '（未知包）';
  const profile = ctx?.profileState?.profile ?? 'web';
  const dshHome = ctx?.profileState?.dir ? path.dirname(path.dirname(ctx.profileState.dir)) : null;
  const relTarball = entry?.install?.tarball ?? null;

  /**
   * ★ 安装包的地址与规格，**一律以配置文件为准**（自 0.4.0 起）。
   *
   * 上一版是从 `entry.install.tarball` 拼 `${REPO_RAW_BASE}/<相对路径>` —— 那个
   * 相对路径只在市场仓库内成立。现在自研插件的 tarball 托管在**另一个仓库**
   * （dsh-plugin-collection），所以地址必须来自插件自己的配置文件；
   * 只有它没给地址时，才退回市场仓库的拼接规则。
   */
  const directSpec = spec && spec.kind !== 'local-tarball' ? spec.spec : null;

  // ── 安装包从哪来 ────────────────────────────────────────
  const localRepoPath = ctx?.repoRoot && relTarball ? path.join(ctx.repoRoot, relTarball) : null;
  const localRepoOk = Boolean(localRepoPath && fs.existsSync(localRepoPath));
  const resolved = spec?.resolvedPath && fs.existsSync(spec.resolvedPath) ? spec.resolvedPath : null;

  const downloadUrl = spec?.downloadUrl
    ?? entry?.install?.url
    ?? (relTarball ? `${REPO_RAW_BASE}/${slash(relTarball)}` : null);
  const cacheFile = downloadUrl ? path.join(tarballCacheDir(), path.basename(new URL(downloadUrl).pathname)) : null;

  const tgz = resolved ?? (localRepoOk ? localRepoPath : cacheFile ?? null);
  const needDownload = !resolved && !localRepoOk && Boolean(downloadUrl);

  const sourceKind = resolved ? 'cache'
    : localRepoOk ? 'repo'
      : needDownload ? 'download'
        : 'none';

  // ── 校验和 ──────────────────────────────────────────────
  let sha = spec?.sha256 ?? entry?.sha256 ?? null;
  let shaSource = sha ? 'catalog' : null;
  if (!sha && tgz && fs.existsSync(tgz)) {
    try {
      sha = sha256File(tgz);
      shaSource = 'computed';
    } catch { /* 读不到就算了，不阻塞给出命令 */ }
  }
  const shaNote = entry?.sha256Note ?? null;

  const notes = [];
  const steps = [];

  if (directSpec) {
    // npm / github 规格：一条命令就够，不需要下载任何东西
    notes.push(`这条插件配置的安装方法是 **${spec.kind}**：直接把规格交给 dsh（底层是 pnpm），不需要先下载 tarball。`);
    steps.push({
      id: 'add',
      title: '1) 直接安装',
      why: `${spec.kind} 规格由 pnpm 自己解析并拉取，目标明确（不会装进来一个同名但无关的包）。`,
      commands: [{ shell: 'any', text: `dsh plugin --profile ${profile} add ${directSpec}` }],
    });
  } else if (sourceKind === 'none') {
    // 既没有仓内快照，也没有可下载地址，也没有直接规格 —— 如实说明，并给出通用路径
    notes.push('这条插件**没有**仓内 tarball 快照、没有可推导的下载地址，也没有可用的 npm / GitHub 规格，所以下面给的是通用命令模板。');
    if (entry?.install?.commands?.length) {
      notes.push(`它的配置文件里记着上游给的命令，可以照抄：\n${entry.install.commands.map((c) => `    ${c}`).join('\n')}`);
    }
    steps.push({
      id: 'resolve',
      title: '先拿到这个包的安装规格',
      why: '本插件只能从目录条目里推出「装什么」，但推不出「从哪下」——需要你按上游说明拿到规格（npm 包名或 GitHub 仓库）。',
      commands: [
        { shell: 'any', text: `dsh plugin --profile ${profile} add ${pkg}` },
      ],
    });
  } else {
    if (needDownload) {
      steps.push({
        id: 'download',
        title: '1) 下载快照 tarball 并校验 sha256',
        why: '本仓库为目录里每一条插件都存了 tarball 快照。下载后必须校验 —— 校验不过说明文件被替换或下载坏了，此时**不要**继续装。',
        commands: win
          ? [
            { shell: 'powershell', text: `New-Item -ItemType Directory -Force -Path ${sh(path.dirname(cacheFile))} | Out-Null` },
            { shell: 'powershell', text: `Invoke-WebRequest -Uri ${downloadUrl} -OutFile ${sh(cacheFile)}` },
            ...(sha ? [{ shell: 'powershell', text: `(Get-FileHash ${sh(cacheFile)} -Algorithm SHA256).Hash.ToLower()` }, { shell: 'powershell', text: `# 期望值：${sha}` }] : []),
          ]
          : [
            { shell: 'bash', text: `mkdir -p ${sh(path.dirname(cacheFile))}` },
            { shell: 'bash', text: `curl -fL ${downloadUrl} -o ${sh(cacheFile)}` },
            ...(sha ? [{ shell: 'bash', text: `sha256sum ${sh(cacheFile)}` }, { shell: 'bash', text: `# 期望值：${sha}` }] : []),
          ],
      });
    } else {
      steps.push({
        id: 'locate',
        title: '1) 确认安装包在本地（无需下载）',
        why: '这个 tarball 已经在本机了（要么是仓库里的快照，要么是上次下载的缓存），直接用它即可。',
        commands: win
          ? [{ shell: 'powershell', text: `Test-Path ${sh(tgz)}` }]
          : [{ shell: 'bash', text: `ls -l ${sh(tgz)}` }],
      });
      if (sha) {
        steps.push({
          id: 'verify',
          title: '2) 校验 sha256',
          why: '确认文件没被替换或损坏。不一致就不要继续装。',
          commands: win
            ? [{ shell: 'powershell', text: `(Get-FileHash ${sh(tgz)} -Algorithm SHA256).Hash.ToLower()` }, { shell: 'powershell', text: `# 期望值：${sha}` }]
            : [{ shell: 'bash', text: `sha256sum ${sh(tgz)}` }, { shell: 'bash', text: `# 期望值：${sha}` }],
        });
      }
    }

    const addIdx = steps.length + 1;

    // 更新场景：必须先 remove
    if (ctx?.installed?.some((i) => i.name === pkg)) {
      steps.push({
        id: 'remove',
        title: `${addIdx}) 先移除旧版本（这是更新，不是全新安装）`,
        why: 'profile 里已有一条指向旧 tarball 的 file: 依赖。只 add 不 remove 的话，pnpm 会认为依赖已满足 —— 结果装完还是旧版本，而且**界面会显示成功**。这是最难查的一类「假成功」。',
        commands: [
          { shell: 'any', text: `dsh plugin --profile ${profile} remove ${pkg}` },
        ],
      });
    }

    steps.push({
      id: 'add',
      title: `${steps.length + 1}) 安装`,
      why: '这就是自动化安装内部真正执行的那条命令。手动跑它的好处是：输出直接打在你眼前，卡在哪一步一目了然，`Ctrl+C` 也由你控制。',
      commands: [
        { shell: 'any', text: `dsh plugin --profile ${profile} add ${q(tgz)}` },
      ],
      tips: [
        '★ 成功判据是**退出码 0**，不是「node_modules 里有没有文件」。',
        'pnpm 非 0 退出时，dsh 不会把这个包追加进 dsh.profile.bundles —— 表现就是「装上了但 GUI 里没有」。',
        '卡住不动时，先按 Ctrl+C 中止；那不会破坏 profile（这一步只动 node_modules 与 lockfile）。',
      ],
    });

    steps.push({
      id: 'confirm',
      title: `${steps.length + 1}) 确认装上了（三层校验）`,
      why: '三层都过才算真的装好；只看其中一层正是「装上了但界面里没有」这类问题的来源。',
      commands: [
        { shell: 'any', text: `dsh plugin --profile ${profile} list` },
        ...(win
          ? [
            { shell: 'powershell', text: `(Get-Content ${sh(path.join(ctx?.profileState?.dir ?? '', 'package.json'))} -Raw | ConvertFrom-Json).dsh.profile.bundles` },
            { shell: 'powershell', text: `dsh --profile ${profile} --dump-config | Select-String '^# == '` },
          ]
          : [
            { shell: 'bash', text: `grep -A20 '"dsh"' ${sh(path.join(ctx?.profileState?.dir ?? '', 'package.json'))}` },
            { shell: 'bash', text: `dsh --profile ${profile} --dump-config | grep '^# == '` },
          ]),
      ],
      tips: [
        '第 2 条要能看到包名在 bundles 数组里。',
        '第 3 条要能看到一行 `# == ' + pkg + '`（注意：--dump-config 输出里**没有** "bundles" 这个字面词，别用 grep bundles 判断）。',
      ],
    });

    steps.push({
      id: 'restart',
      title: `${steps.length + 1}) 重启 dsh web`,
      why: '新增的 bundle 是在**启动时**合成的，热重载不会把它加进去 —— 不重启就看不到。',
      commands: [
        { shell: 'any', text: dshHome ? `# DSH_HOME=${slash(dshHome)}` : '# 直接重启你平时用的 dsh web', kind: 'comment' },
        { shell: 'any', text: 'dsh web' },
      ],
    });
  }

  // ── 出问题时的收尾命令（永远都给） ──────────────────────
  const backupsDir = ctx?.profileState?.dir ? path.join(path.dirname(path.dirname(ctx.profileState.dir)), 'storages', 'dsh-plugins-market', 'backups') : null;

  const recovery = [
    {
      id: 'allowbuilds',
      title: '撞上 ERR_PNPM_IGNORED_BUILDS',
      why: 'pnpm 10+ 默认不批准依赖的构建脚本，并让 add 以非 0 退出。这两个包（protobufjs / @google/genai）的脚本都不需要真的执行 —— 前者只打印一句提示，后者的 prepare 对 tarball 安装本来就不跑。',
      commands: win
        ? [{ shell: 'powershell', text: `notepad ${sh(path.join(ctx?.profileState?.dir ?? '', 'pnpm-workspace.yaml'))}` }, { shell: 'powershell', text: '# 把 allowBuilds 下的占位符 "set this to true or false" 改成 false，存盘后重跑安装命令' }]
        : [{ shell: 'bash', text: `${process.env.EDITOR ?? 'vi'} ${sh(path.join(ctx?.profileState?.dir ?? '', 'pnpm-workspace.yaml'))}` }, { shell: 'bash', text: '# 把 allowBuilds 下的占位符 "set this to true or false" 改成 false，存盘后重跑安装命令' }],
    },
    {
      id: 'dangling',
      title: 'profile 里有指向「已经不存在的 tarball」的 file: 依赖',
      why: '这类断链会让**每一次** pnpm 操作都变慢甚至卡死（pnpm 要解析整棵树）。本插件现在会在装前检查里直接拦下来，并把断链的包名列给你。修法是二选一：把该依赖指向现有 tarball，或直接移除它。',
      commands: [
        { shell: 'any', text: `dsh plugin --profile ${profile} list` },
        { shell: 'any', text: `# 对每个断链的包：dsh plugin --profile ${profile} remove <包名>` },
      ],
    },
    {
      id: 'rollback',
      title: '想回到安装前的状态',
      why: '本插件每次安装前都会把 profile 的状态文件拍一份快照。手动安装不受它管理，所以这里给的是「用快照还原」的办法。',
      commands: [
        { shell: 'any', text: backupsDir ? `# 快照目录：${slash(backupsDir)}` : '# 快照在 $DSH_HOME/storages/dsh-plugins-market/backups/', kind: 'comment' },
        { shell: 'any', text: `# 把快照里的 package.json / pnpm-workspace.yaml / cordis.patch.yml 复制回 ${slash(ctx?.profileState?.dir ?? '<profile 目录>')}，然后：` },
        { shell: 'any', text: `dsh plugin --profile ${profile} install` },
      ],
    },
  ];

  return {
    available: sourceKind !== 'none',
    package: pkg,
    version: entry?.version ?? null,
    profile,
    dshHome: dshHome ? slash(dshHome) : null,
    profileDir: ctx?.profileState?.dir ? slash(ctx.profileState.dir) : null,
    tarball: tgz ? slash(tgz) : null,
    tarballUrl: downloadUrl,
    tarballSource: sourceKind,
    tarballSourceText: {
      repo: '仓库里的快照 tarball（离线可用）',
      cache: '本插件下载缓存里的 tarball（已校验）',
      download: '需要从本仓库下载快照 tarball',
      none: '没有可用的快照 tarball',
    }[sourceKind],
    sha256: sha,
    sha256Source: shaSource,
    sha256Note: shaNote,
    repoHomepage: REPO_HOMEPAGE,
    steps,
    recovery,
    notes,
    // 一行版：给「复制全部」用的纯文本
    text: toPlainText({ pkg, profile, tgz, needDownload, downloadUrl, sha, steps, recovery }),
  };
}

function toPlainText({ pkg, profile, tgz, needDownload, downloadUrl, sha, steps, recovery }) {
  const out = [];
  out.push(`# ${pkg} —— 手动安装（profile: ${profile}）`);
  out.push('');
  if (needDownload) out.push(`# 1) 下载快照： ${downloadUrl}`);
  else if (tgz) out.push(`# 1) 安装包：   ${slash(tgz)}`);
  if (sha) out.push(`#    sha256：   ${sha}`);
  out.push('');
  out.push(`# 2) 安装`);
  out.push(`dsh plugin --profile ${profile} add ${tgz ? q(tgz) : pkg}`);
  out.push('');
  out.push(`# 3) 确认（三层：依赖 / bundles / 装配树）`);
  out.push(`dsh plugin --profile ${profile} list`);
  out.push(`dsh --profile ${profile} --dump-config | grep '^# == '`);
  out.push('');
  out.push(`# 4) 重启 dsh web 才生效`);
  out.push('');
  out.push(`# 出问题时：`);
  for (const r of recovery ?? []) {
    out.push(`#  - ${r.title}`);
  }
  void steps;
  return out.join('\n');
}

/** 写一份到磁盘，方便用户直接拿走（UI 上有「另存为 .txt / .ps1 / .sh」） */
export function writeManualScript(plan, { dir, format = 'txt' } = {}) {
  const target = path.join(dir, `${plan.package}-manual-install.${format === 'ps1' ? 'ps1' : format === 'sh' ? 'sh' : 'txt'}`);
  const lines = plan.text.split('\n');
  if (format === 'ps1') lines.unshift('$ErrorActionPreference = "Stop"');
  if (format === 'sh') lines.unshift('#!/usr/bin/env bash', 'set -euo pipefail');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return { ok: true, file: target };
}
