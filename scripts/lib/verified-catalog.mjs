/**
 * 「已验证」目录的生成逻辑 —— **唯一实现**。
 *
 * 为什么必须抽成一份：这份目录有两个消费者，而它们各自写一份的话必然漂移。
 *
 *   1. **市场包的构建**（`plugins-src/dsh-plugins-market/build.mjs`）
 *      把它打进包内的 `catalog/verified.json`，作为**离线兜底** ——
 *      没有网络时市场仍然要能列出插件。
 *   2. **仓库本身**（`scripts/build-collection.mjs`）
 *      把它写到仓库根的 `catalog/verified.json`，作为**运行时联网拉取**的那一份。
 *
 * 过去只有第 1 个消费者，于是「目录」被焊死在包内：任何一个插件发新版，
 * 都必须重打市场包、并且**给市场换个版本号**（因为 `file:` 指向同一路径而内容变了时，
 * pnpm 会跳过解包 —— 不换版本号已装的人根本收不到），否则用户看不到新版本。
 * 一个插件的数据变更被迫搭上一次发版，这是我们要拆掉的东西。
 *
 * 拆掉之后：插件发新版只需改 `compatibility.json` + 重新生成目录 + 提交，
 * 市场版本号不动、市场 tarball 不重打。
 *
 * ★ 自引用条目（市场指向自己的那一条）在**两个调用方**里都必须是
 *   `sha256: null` / `bytes: null`，这一点不能各自发挥：
 *   `build.mjs` 生成目录时自己的 tarball 还没打出来（它是本次构建的产物），
 *   算不出自己的 hash；而 `build-collection.mjs` 跑的时候那个文件已经在了，算得出。
 *   两边若各按自己的能力来，仓库根那份与包内那份就会**永远不一致**，
 *   每次构建都产生无意义的差异。所以统一按「算不出」处理，
 *   市场自身的完整性由同目录的 `.tgz.sha256` 边车文件保证。
 *
 * @module scripts/lib/verified-catalog
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 仓库根那份目录的相对路径（运行时拉取用的就是它）。 */
export const REPO_CATALOG_REL = path.join('catalog', 'verified.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * 取当前**已实测支持**的那个 runtime。
 *
 * 优先 `recommended`，退回第一个 `supported` —— 与 build.mjs 的既有判定一致，
 * 两份调用方必须选到同一条，否则生成的目录会指向不同的插件集合。
 *
 * @param {object} compat - compatibility.json 的内容。
 * @returns {object|undefined} 选中的 runtime。
 */
export function supportedRuntime(compat) {
  const runtimes = compat.runtimes ?? [];
  return runtimes.find((r) => r.status === 'supported' && r.recommended)
    ?? runtimes.find((r) => r.status === 'supported');
}

/**
 * 生成「已验证」目录。
 *
 * 不写盘、不打印、不退出 —— 只返回结果与问题清单，由调用方决定怎么呈现与是否失败。
 * 这样同一个实现既能服务「构建市场」也能服务「提交前校验」。
 *
 * @param {object} options
 * @param {string} options.repo - 仓库根目录。
 * @param {string} options.selfPackage - 自引用条目的包名（市场自己），其 sha256 恒为 null。
 * @returns {{ catalog: object|null, problems: string[], warnings: string[] }}
 *   `problems` 非空时 `catalog` 为 null 或不可信，调用方应视为失败。
 */
export function generateVerifiedCatalog({ repo, selfPackage }) {
  const problems = [];
  const warnings = [];

  const compatPath = path.join(repo, 'compatibility.json');
  if (!fs.existsSync(compatPath)) {
    problems.push(`找不到 ${compatPath} —— 请在仓库根目录结构完整的情况下运行。`);
    return { catalog: null, problems, warnings };
  }
  const compat = readJson(compatPath);

  const runtime = supportedRuntime(compat);
  if (!runtime) {
    problems.push('compatibility.json 里没有任何 status=supported 的 runtime，无法生成目录。');
    return { catalog: null, problems, warnings };
  }

  const metaPath = path.join(repo, 'catalog', 'verified-meta.json');
  const meta = fs.existsSync(metaPath) ? readJson(metaPath) : { plugins: {} };

  const plugins = runtime.plugins.map((p) => {
    const tgz = path.join(repo, p.tarball);
    const isSelf = p.package === selfPackage;
    const present = fs.existsSync(tgz);

    // 自引用条目指向的正是本次构建的产物：存在性与 hash 都不能要求（见文件头）。
    if (!present && !isSelf) problems.push(`tarball 缺失：${p.tarball}`);
    const actualSha = present && !isSelf ? sha256(tgz) : null;
    const actualBytes = present && !isSelf ? fs.statSync(tgz).size : null;

    // 目录里原本就写了 sha256 的必须对得上 —— 对不上说明有人在改包而没更新目录。
    // 这条同时也是「已发布版本的字节不可改写」在生成侧的体现。
    if (present && !isSelf && p.sha256 && p.sha256 !== actualSha) {
      problems.push(
        `${p.package} 的 sha256 与 compatibility.json 记录不一致`
        + `（记录 ${p.sha256.slice(0, 12)}…，实际 ${actualSha.slice(0, 12)}…）`,
      );
    }

    const m = meta.plugins?.[p.package] ?? {};
    if (!m.title) {
      warnings.push(`  ! ${p.package} 在 verified-meta.json 里没有展示元数据，将退化为用包名当标题`);
    }

    return {
      id: p.package,
      package: p.package,
      version: p.version,
      title: m.title ?? p.package,
      summary: m.summary ?? m.title ?? p.peerNote ?? '',
      tags: m.tags ?? [],
      author: p.author ?? null,
      origin: p.origin ?? null,
      upstream: p.upstream ?? null,
      homepage: p.homepage ?? null,
      license: p.license ?? 'MIT',
      licenseFileInTarball: p.licenseFileInTarball ?? null,

      // 事实（来自 compatibility.json，不要在展示层改）
      peerRuntimePin: p.peerRuntimePin ?? null,
      peerVerdict: p.peerVerdict ?? null,
      peerNote: p.peerNote ?? null,
      coexistenceWarning: p.coexistenceWarning ?? null,
      notes: p.notes ?? null,
      replaces: p.replaces ?? null,
      supersedes: p.supersedes ?? null,
      derivedFrom: p.derivedFrom ?? null,

      // 安装用
      install: {
        kind: 'local-tarball',
        tarball: p.tarball,
        spec: null, // 运行时按仓库根/下载地址解析
        files: p.files ?? null,
        needsConfig: Boolean(m.needsConfig ?? /Key/.test(String(m.tags ?? ''))),
        risky: false,
      },
      sha256: actualSha,
      sha256Note: isSelf
        ? '本条目指向的 tarball 就是本次构建的产物，sha256 与大小都无法自包含（算完又要重写 tarball）；实际 sha256 见同目录的 .tgz.sha256 边车文件与 compatibility.json。'
        : null,
      bytes: actualBytes,
    };
  });

  return {
    catalog: {
      schemaVersion: 1,
      generatedFrom: 'compatibility.json',
      generatedAt: runtime.verifiedAt ?? null,
      dshVersion: runtime.dshVersion,
      note: '由 scripts/lib/verified-catalog.mjs 生成，请勿手工编辑。展示元数据改 catalog/verified-meta.json，事实改 compatibility.json。',
      plugins,
    },
    problems,
    warnings,
  };
}

/**
 * 原子的写 JSON：先写同目录临时文件再 rename。
 *
 * 目录是**运行时会被拉取**的产物，半截文件会让市场把目录判定为损坏；
 * 而 rename 在同一个文件系统内是原子的，读者要么看到旧版要么看到新版。
 *
 * @param {string} target - 目标文件路径。
 * @param {unknown} value - 要序列化的值。
 */
export function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}
