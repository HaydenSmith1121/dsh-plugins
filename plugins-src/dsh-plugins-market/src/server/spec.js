/**
 * dsh-plugins-market —— 服务器半：安装规格与安装提示
 *
 * ★ 这个文件以前叫 `gate.js` —— 它当时是「装前兼容性闸门」，会给每个插件算一个
 *   verdict（pass / warn / block-overridable / block），并据此**拦住**安装。
 *   0.6.0 把那套判定去掉了：**市场不拦任何插件**。
 *
 *   为什么去掉：判定回答的是「维护者敢不敢担保这个包装完不会出事」，
 *   而用户要的是「我要装它」。中间隔着一个必然出错的猜测 —— 静态探测看不到
 *   实际发布产物、看不到运行时行为、也看不到依赖闭包，而它给出的「不安全」结论
 *   会被用户当成「装不了」，于是本该能用的插件被一个标签挡在门外。
 *
 *   现在的分工是干净的：
 *     · **能不能装**不再由市场判断，所有插件都可装；
 *     · **怎么装**由用户选（自动 / 手动），两条路的命令都从这里解析；
 *     · 我们知道的**事实**（这个包没声明 dsh.bundle、与已装的某插件冲突、
 *       需要配置才能用……）原样列出来，供用户自己判断 —— 它们是提示，不是判决。
 *
 * 本文件保留三件事：
 *   1. `resolveInstallSpec()` —— 「怎么装」的唯一答案
 *   2. `installNotes()`       —— 我们知道的、值得在安装前说一句的事实（不拦截）
 *   3. tar 只读访问的几个helper（读 package.json / patch 行）+ 干净命令提取
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readTarGzEntries, listTarGzEntries, extractPatchRows, compareVersions } from './util.js';

/** 需要预先放行的构建脚本（pnpm 10+ 会因未批准而让 add 以非 0 退出） */
export const KNOWN_ALLOW_BUILDS = {
  '@google/genai': false,
  protobufjs: false,
};

/** 已知的共存冲突对：两个包不能进同一个 profile（来自本仓库实测结论） */
export const KNOWN_CONFLICTS = [
  {
    packages: ['dsh-opencode-go', 'dsh-opencode-go-plus'],
    reason:
      '两者共用设置命名空间 llm-opencode-go 与 provider 路由 opencode-go。实测四种组合：'
      + '共存且基线在前 → 本包记一条 warn 后主动退场；共存且本包在前 → 基线抛未捕获的 '
      + 'DUPLICATE_DISCOVERY，整棵插件树加载失败、dsh web 退出码 1，同 profile 其余插件一并挂掉。',
  },
];

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
 *
 * ★ 返回 `null` 的含义是「没有可自动执行的安装路径」，**不是**「不允许装」。
 *   调用方应当退回手动安装：把上游说明原样给用户，让他自己决定。
 */
export function resolveInstallSpec(entry, ctx, probe) {
  const inst = entry.install ?? {};
  const method = inst.method ?? (inst.kind === 'local-tarball' ? 'tarball' : inst.kind) ?? 'manual';
  const pkg = entry.package ?? entry.id;

  // ── ① tarball：配置文件给了下载地址 + 校验和 ──────────────
  if (method === 'tarball' || inst.kind === 'local-tarball') {
    // ①a 规格本身就是本机一个真实存在的 .tgz 绝对路径。
    //     这一条不能少：它既是「用户手动指定了一个本地包」的路径，
    //     也是测试唯一能造出一个可控候选包的方式（不需要联网、不需要仓库副本）。
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

  // skills / manual：没有可执行的 dsh 安装路径，如实返回 null
  return null;
}

/** 「没有自动安装路径」时，该怎么向用户解释 */
export function explainNoAutoInstall(entry) {
  const method = entry.install?.method ?? 'manual';
  if (method === 'skills') {
    return '这个条目走的是上游的 skills 机制，不是 dsh 插件 —— 市场没有可执行的安装路径，'
      + '下面是上游给的说明。';
  }
  return '目录里没有为它记录可自动执行的安装方式（没有干净的 npm / GitHub 规格，也没有托管 tarball），'
    + '所以只能按上游说明手动装。';
}

/**
 * 安装前值得说一句的**事实**。
 *
 * ★ 这些是提示，不是判决：它们不改变「能不能装」，也不改变用哪条路装。
 *   列出来的理由只有一个 —— 用户看完之后可能改主意（比如知道装上去 GUI 里
 *   也不会出现、或者会和已装的插件打架），而那应该由他决定。
 *
 * @param {object} entry
 * @param {object} o
 * @param {object} [o.probe]            probeEntry() 的结果（含 manifest）
 * @param {object[]} [o.installed]      scanInstalled() 的结果
 * @param {object} [o.runtimeVersions]  本机运行时的包版本表（peer pin 比对用）
 * @returns {{id:string, text:string}[]}
 */
export function installNotes(entry, { probe = null, installed = [], runtimeVersions = null } = {}) {
  const out = [];
  const manifest = probe?.manifest ?? null;

  // ① 包里没有声明 dsh.bundle：装进 node_modules 了，但不会出现在 GUI 里
  if (probe && probe.available && manifest && !manifest.dsh?.bundle?.patch) {
    out.push({
      id: 'no-bundle',
      text: '这个包的 package.json 没有声明 dsh.bundle.patch，dsh 会把它当普通依赖装进 node_modules，'
        + '但**不会**写进 dsh.profile.bundles —— 结果是「装上了，但 GUI 里什么也没有」，且没有任何报错。'
        + (probe.monorepoHint ? '看起来是个 monorepo：插件可能在某个子目录里，根包不是插件。' : ''),
    });
  }

  // ② 声明了 patch 文件却不在包里 —— 启动时会 fatal
  if (manifest?.dsh?.bundle?.patch && probe?.patchFilesMissing?.length) {
    out.push({
      id: 'patch-missing',
      text: `它声明了 cordis.patch.yml（${manifest.dsh.bundle.patch}），但探测时没有在包里找到这个文件。`
        + 'dsh 启动时会因为读不到它而失败。',
    });
  }

  /**
   * ③ peer 依赖精确 pin 到了**比本机更新**的版本。
   *
   * ★ 这一条以前是「不可覆盖的硬拦截」，现在是**一句提示** —— 事实没变
   *   （本机缺这个接口，装上大概率起不来），但要不要冒这个险由用户决定。
   *   实测过的事故形态：@deepseek-ai/dsh-llm 被精确 pin 到 0.1.6-alpha.1，
   *   在 0.1.5 线上装 → 内置 dsh-llm 缺那个导出 → 整棵树加载失败、dsh web 退出码 1。
   *
   *   pin 到**更低**版本不算提示：那是向后兼容的常见写法（dsh-receipt 就是），
   *   实测能正常工作 —— 把它也列出来只会让提示变成噪音。
   */
  for (const [name, want] of peerPins(manifest)) {
    const have = runtimeVersions?.[name] ?? null;
    if (!have) continue;
    const cmp = compareVersions(have, want);
    if (cmp !== null && cmp < 0) {
      out.push({
        id: 'peer-newer',
        text: `它的 peerDependency 把 ${name} 精确 pin 在 ${want}，而本机是 ${have}：`
          + '本机缺这个包里用到的接口时，dsh 会在启动阶段加载失败（整棵插件树一起挂掉，'
          + '同 profile 的其它插件也会跟着起不来）。',
      });
    }
  }

  // ④ 需要配置才能用
  if (entry.install?.needsConfig) {
    out.push({ id: 'needs-config', text: '装完需要配置（例如 API Key / Token）才能用，具体见它的说明。' });
  }

  // ⑤ 已知共存冲突
  if (entry.package || entry.id) {
    const me = entry.package ?? entry.id;
    for (const conflict of KNOWN_CONFLICTS) {
      if (!conflict.packages.includes(me)) continue;
      const present = conflict.packages
        .filter((p) => p !== me)
        .filter((p) => installed.some((i) => i.name === p && i.installed));
      if (present.length > 0) {
        out.push({
          id: 'coexistence',
          text: `本机已经装了 ${present.join('、')}，它与这个包**不能共存**于同一个 profile。${conflict.reason}`,
        });
      }
    }
  }

  // ⑥ 配置里自己声明的共存警告
  if (entry.coexistenceWarning) {
    out.push({ id: 'coexistence-config', text: String(entry.coexistenceWarning) });
  }

  // ⑦ 上游带安装脚本（供应链信号，不是判决）
  if (entry.install?.risky) {
    out.push({
      id: 'install-scripts',
      text: '上游带了安装期脚本（preinstall / install / postinstall）。'
        + 'pnpm 10+ 默认拦截它们，需要显式放行才会执行 —— 本市场不会替你放行。',
    });
  }

  return out;
}

/**
 * 挑出 peerDependencies 里**精确 pin**（不带 ^ ~ 范围符）的 @deepseek-ai/* 与 cordis。
 *
 * 只挑精确 pin，因为只有它才是「我知道你会缺这个接口」的确定信号；
 * 范围声明在 semver 上本来就允许漂移，拿它当提示会误伤。
 */
function peerPins(manifest) {
  const peers = manifest?.peerDependencies;
  if (!peers || typeof peers !== 'object') return [];
  const out = [];
  for (const [name, range] of Object.entries(peers)) {
    if (!/^(@deepseek-ai\/|cordis$)/.test(name)) continue;
    const v = String(range ?? '').trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) continue;
    out.push([name, v]);
  }
  return out;
}

function slash(p) {
  return String(p).split(path.sep).join('/');
}

function looksLikeNpmSpec(s) {
  const t = String(s ?? '').trim();
  return t.length > 0 && t.length < 214 && !t.includes(' ') && !/^[./\\]/.test(t) && !t.includes('://');
}

/**
 * 从上游给的安装命令里提取**干净可执行**的规格。
 *
 * ★ 公共索引里混着大量根本不是 dsh 插件安装的命令（实测 7487 条里有
 *   `curl … | sh`、`pip install`、`brew install`、`npm install -g`）。
 *   它们不能被执行：有的是装别的东西，有的是把远程脚本直接管道的任意代码执行。
 *   所以只认一种形态 —— `dsh plugin … add <spec>`，且 spec 必须是干净的
 *   npm 包名或 `github:owner/repo`。
 */
export function extractCleanSpec(commands) {
  if (!Array.isArray(commands)) return null;
  for (const raw of commands) {
    const cmd = String(raw ?? '').trim();
    if (!/^dsh\s+plugin\b/.test(cmd)) continue;
    const m = cmd.match(/\badd\s+(\S+)\s*$/);
    if (!m) continue;
    const spec = m[1].replace(/^["']|["']$/g, '');
    if (/^github:[^\s]+$/.test(spec)) return { kind: 'github', spec };
    if (looksLikeNpmSpec(spec) && !spec.includes('<') && !spec.includes('>')) return { kind: 'npm', spec };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// tar 只读访问
// ─────────────────────────────────────────────────────────────

/** 从一个 .tgz 里读出 package.json 与 cordis.patch.yml 的插入行；读不出来不抛异常 */
export function readPackageFromTarball(tgz) {
  const wanted = ['package/package.json', 'package/cordis.patch.yml'];
  try {
    const entries = listTarGzEntries(tgz);
    const files = readTarGzEntries(tgz, wanted);
    const pkgBuf = files.get('package/package.json');
    if (!pkgBuf) return { manifest: null, patchRows: [], fileCount: entries.length, error: '包内没有 package/package.json' };
    let manifest = null;
    try {
      manifest = JSON.parse(pkgBuf.toString('utf8'));
    } catch {
      return { manifest: null, patchRows: [], fileCount: entries.length, error: '包内 package.json 不是合法 JSON' };
    }
    const patchBuf = files.get('package/cordis.patch.yml');
    const patchRows = patchBuf ? extractPatchRows(patchBuf.toString('utf8')) : [];
    return { manifest, patchRows, fileCount: entries.length, error: null };
  } catch (err) {
    return { manifest: null, patchRows: [], fileCount: 0, error: String(err?.message ?? err) };
  }
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
