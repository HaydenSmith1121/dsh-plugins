/**
 * collection/ 收录快照的**生成器**（可重复运行，确定性输出）。
 *
 *   node scripts/build-collection.mjs            # 生成 / 刷新 collection/
 *   node scripts/build-collection.mjs --check    # 只校验，不写盘（CI 用）
 *
 * ── 它解决什么问题 ─────────────────────────────────────────────
 *
 * 插件市场装的是「收录当时那一版」的 tarball。上游一旦发新版，
 * 旧版可能被撤回、可能被重新发布成不同内容、也可能改了 peer 约束
 * 导致与新 dsh 不兼容 —— 这些都会让"当时明明能装"的组合突然装不上。
 *
 * 所以这里把**收录当时那个字节**固定下来，并记录它是谁写的、从哪来的、
 * 以及它对应哪个 dsh 运行时版本。装的时候只认这份快照 + sha256，
 * 不再依赖上游此刻发布了什么。
 *
 * ── 数据从哪来（不手写，全部反推）─────────────────────────────
 *
 *   compatibility.json                     版本 / origin / author / upstream / peer 结论
 *   catalog/verified-meta.json             标题 / 简介 / 标签（展示层）
 *   各 tarball 的 package.json              name / version / author / repository / license
 *   各 tarball 的 sha256                    字节级指纹
 *
 * 手写清单容易和事实脱节；这里所有字段都是算出来或读出来的，
 * 唯一的人工输入是 collection/collection-notes.json（收录说明与"是否最新"的核实记录）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COLLECTION = path.join(REPO, 'collection');
const CHECK_ONLY = process.argv.includes('--check');

const problems = [];
const fail = (m) => { problems.push(m); console.error(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────────
// 最小 tar 读取器：只取 package/package.json，不落盘、不依赖外部命令
// ─────────────────────────────────────────────────────────────

/** 从 .tgz 里读出 package/package.json 的文本 */
function readPackageJsonFromTarball(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const dataStart = offset + 512;

    if (rawName === 'package/package.json') {
      return buf.subarray(dataStart, dataStart + size).toString('utf8');
    }
    // 数据区按 512 对齐
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** 从 .tgz 里读整个条目列表（用于核对结构） */
function listTarballEntries(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const out = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = header.subarray(156, 157).toString('utf8');
    if (rawName && typeFlag !== '5') out.push(rawName);
    offset = offset + 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 读输入
// ─────────────────────────────────────────────────────────────

const compat = readJson(path.join(REPO, 'compatibility.json'));
const metaPath = path.join(REPO, 'catalog', 'verified-meta.json');
const meta = fs.existsSync(metaPath) ? readJson(metaPath) : { plugins: {} };
const notesPath = path.join(COLLECTION, 'collection-notes.json');
const notes = fs.existsSync(notesPath) ? readJson(notesPath) : { plugins: {}, defaults: {} };

const runtime = (compat.runtimes ?? []).find((r) => r.status === 'supported' && r.recommended)
  ?? (compat.runtimes ?? []).find((r) => r.status === 'supported');
if (!runtime) {
  console.error('compatibility.json 里没有 status=supported 的 runtime，无法生成收录快照。');
  process.exit(3);
}

// ─────────────────────────────────────────────────────────────
// 逐个收录
// ─────────────────────────────────────────────────────────────

const entries = [];
for (const p of runtime.plugins ?? []) {
  const tarballPath = path.join(REPO, p.tarball);
  if (!fs.existsSync(tarballPath)) {
    fail(`compatibility.json 指向的 tarball 不存在：${p.tarball}`);
    continue;
  }

  const bytes = fs.readFileSync(tarballPath);
  const digest = sha256(bytes);

  if (p.sha256 && p.sha256 !== digest) {
    fail(`${p.package} 的 sha256 与 compatibility.json 不一致（清单 ${p.sha256.slice(0, 12)}… / 实测 ${digest.slice(0, 12)}…）`);
  }

  const inner = readPackageJsonFromTarball(tarballPath);
  if (!inner) {
    fail(`${p.tarball} 内没有 package/package.json`);
    continue;
  }
  const pkg = JSON.parse(inner);
  const files = listTarballEntries(tarballPath);

  // 包内自述优先于清单：清单是给判定用的，包内才是事实
  if (pkg.name !== p.package) fail(`${p.tarball} 内包名 ${pkg.name} 与清单 ${p.package} 不一致`);
  if (pkg.version !== p.version) fail(`${p.tarball} 内版本 ${pkg.version} 与清单 ${p.version} 不一致`);

  const repoUrl = typeof pkg.repository === 'string'
    ? pkg.repository
    : (pkg.repository?.url ?? null);
  const author = typeof pkg.author === 'string'
    ? pkg.author
    : (pkg.author?.name ?? null);

  const m = meta.plugins?.[p.package] ?? {};
  const n = notes.plugins?.[p.package] ?? {};

  // 人工复核说明的字段要在 docs 里说清楚：authorSource 是**出处标签**，
  // 不是「一段解释」；解释请写进 note。这里挡一下常见误填。
  const rawAuthorSource = n.authorSource ?? null;
  if (rawAuthorSource && rawAuthorSource.length > 120) {
    fail(`${p.package} 的 collection-notes.json → authorSource 过长（${rawAuthorSource.length} 字）`
      + '，它应当是一个短出处标签；解释请写进 note。');
  }

  entries.push({
    id: p.dir ?? p.package,
    package: p.package,
    version: p.version,
    title: m.title ?? p.package,
    summary: m.summary ?? null,
    tags: m.tags ?? [],
    origin: p.origin ?? 'third-party',
    author: p.author ?? author ?? null,
    // 作者信息来自哪一级：清单 → 包内 package.json → 人工核实说明（存疑来源的审计线索）
    authorSource: p.author ? 'compatibility.json'
      : author ? 'package.json'
        : (rawAuthorSource ?? 'unstated'),
    upstream: p.upstream ?? repoUrl ?? null,
    homepage: p.homepage ?? null,
    license: p.license ?? pkg.license ?? null,
    licenseFileInTarball: p.licenseFileInTarball ?? files.some((f) => /^package\/LICENSE/i.test(f)),

    collectedFile: `snapshots/${p.dir ?? p.package}/${p.version}/${path.basename(p.tarball)}`,
    sourcePath: p.tarball,
    sha256: digest,
    bytes: bytes.length,
    fileCount: files.length,

    runtimeVersion: runtime.dshVersion,
    runtimeDistTag: runtime.distTag ?? null,
    peerRuntimePin: p.peerRuntimePin ?? null,
    peerVerdict: p.peerVerdict ?? null,
    peerNote: p.peerNote ?? null,

    isLatest: n.isLatest ?? null,
    latestKnown: n.latestKnown ?? null,
    latestCheckedAt: n.latestCheckedAt ?? null,
    collectNote: n.note ?? null,
  });
}

// ─────────────────────────────────────────────────────────────
// 校验 sha256
// ─────────────────────────────────────────────────────────────
//
// 两种模式的判据不同，不能混用：
//
//   --check    把「磁盘上的快照」与「已提交的 manifest」比对 —— 这才是完整性契约：
//              快照被改过、或清单与快照脱节，都必须报错。
//   生成模式   快照是**本次要写出去的产物**，此刻磁盘上还是旧字节，比对必然失败。
//              所以这里只核对「源 tarball 是否存在且可读」，字节一致性交给写盘后的复查。

const manifestFile = path.join(COLLECTION, 'manifest.json');

if (CHECK_ONLY) {
  const existing = fs.existsSync(manifestFile) ? readJson(manifestFile) : null;
  if (!existing) {
    fail('collection/manifest.json 不存在');
  } else {
    // ① 清单本身是否与当前仓库事实一致
    if (JSON.stringify(existing.plugins) !== JSON.stringify(entries)) {
      fail('collection/manifest.json 已过期，请运行 node scripts/build-collection.mjs');
    } else {
      ok('manifest.json 与当前仓库事实一致');
    }

    // ② 磁盘上的快照是否与**已提交的清单**逐字节一致
    for (const rec of existing.plugins ?? []) {
      const f = path.join(COLLECTION, rec.collectedFile);
      if (!fs.existsSync(f)) {
        fail(`缺少快照文件：${rec.collectedFile}`);
        continue;
      }
      const actual = sha256(fs.readFileSync(f));
      if (rec.sha256 && actual !== rec.sha256) {
        fail(`快照 sha256 与清单不符：${rec.collectedFile}`);
      }
    }
  }
} else {
  // 生成模式：只确认源 tarball 可读（字节一致性在写盘后由 loadSnapshots 核对）
  for (const e of entries) {
    const src = path.join(REPO, e.sourcePath);
    if (!fs.existsSync(src)) fail(`源 tarball 不存在：${e.sourcePath}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 写盘
// ─────────────────────────────────────────────────────────────

const manifest = {
  _comment: [
    '收录快照清单 —— 由 scripts/build-collection.mjs 从 compatibility.json + 各 tarball 反推生成，请勿手写。',
    '',
    '每条记录固定了收录当时那个 tarball 的字节（sha256）与来源信息。',
    '★ isLatest 为 false 是正常状态：收录的是「当时验证过的那一版」，不是最新版。',
    '  上游发新版后本文件不会自动更新 —— 这是刻意的，快照的意义就在于不被上游改动影响。',
    '',
    '重新生成：node scripts/build-collection.mjs',
  ],
  schemaVersion: 1,
  generatedFrom: 'compatibility.json',
  runtime: {
    dshVersion: runtime.dshVersion,
    distTag: runtime.distTag ?? null,
    profile: compat.profile ?? null,
  },
  counts: {
    total: entries.length,
    self: entries.filter((e) => e.origin === 'self').length,
    thirdParty: entries.filter((e) => e.origin !== 'self').length,
  },
  plugins: entries,
};

if (CHECK_ONLY) {
  if (problems.length) {
    console.error(`\n收录快照校验失败：${problems.length} 项`);
    process.exit(1);
  }
  console.log('\n收录快照校验通过。');
  process.exit(0);
}

if (problems.length) {
  console.error(`\n生成收录快照失败：${problems.length} 项`);
  process.exit(1);
}

// 拷快照（逐字节复制，保证 sha256 可复现）
for (const e of entries) {
  const dest = path.join(COLLECTION, e.collectedFile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(REPO, e.sourcePath), dest);
}

// 写盘后复查：确认落盘的字节确实等于登记进清单的 sha256。
// 复制本身极少出错，但「清单写了 A、磁盘是 B」正是这套机制要防的事，
// 所以宁可在生成时就撞出来，也不要等 CI 或用户装错版本时才发现。
for (const e of entries) {
  const dest = path.join(COLLECTION, e.collectedFile);
  const actual = sha256(fs.readFileSync(dest));
  if (actual !== e.sha256) {
    fail(`写盘后校验失败：${e.collectedFile}（期望 ${e.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
  }
}

if (problems.length) {
  console.error(`\n生成收录快照失败：${problems.length} 项`);
  process.exit(1);
}

fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

console.log(`收录快照已生成：${entries.length} 个包（自研 ${manifest.counts.self} / 第三方 ${manifest.counts.thirdParty}）`);
console.log(`运行时基线：dsh ${runtime.dshVersion}`);
for (const e of entries) {
  console.log(`  · ${e.package}@${e.version}  ${e.origin === 'self' ? '[自研]' : '[第三方]'}  sha256=${e.sha256.slice(0, 12)}…`);
}
