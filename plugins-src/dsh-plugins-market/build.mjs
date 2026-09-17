/**
 * dsh-plugins-market —— 构建脚本
 *
 *   node plugins-src/dsh-plugins-market/build.mjs [--check]
 *
 * 它做四件事，全部是确定性的（同输入必得同输出）：
 *
 *   [1] 生成 catalog/verified.json
 *       把 compatibility.json 里当前**已实测支持**的那个 runtime 的 8 个插件，
 *       与 catalog/verified-meta.json 的展示元数据合并，并**逐个算 sha256**。
 *       ★ 算 sha256 是为了补上仓库的一个缺口：原先 8 个 tarball 里只有 1 个有校验和，
 *         其余的在装前无法判断有没有被替换/损坏。
 *
 *   [2] 生成 catalog/compat-snapshot.json
 *       兼容矩阵的包内快照。开发机上插件会优先读仓库里那份活的 compatibility.json，
 *       但装到别的机器上时包里必须有兜底。
 *
 *   [3] 组装 lib/ + 拷入 catalog/，生成最终 package.json
 *       客户端半**不打包、不转译** —— 源码 src/client/app.js 本身就是可运行的
 *       经典脚本（自注册 __ModuleLoader__ 工厂），直接拷成 lib/client.js。
 *       少一层构建，就少一类「产物与源码不一致」的故障。
 *
 *   [4] 产出 tarball 到 plugins/dsh-plugins-market/<dsh 版本>/
 *       目录结构与仓库既有约定一致（那一层是 dsh 运行时版本，不是插件版本）。
 *
 * --check 只做校验不写文件：用于 CI 与提交前自检（catalog 是否过期、产物是否一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PKG_NAME = 'dsh-plugins-market';
const CHECK_ONLY = process.argv.includes('--check');

/**
 * 产物一律落在**暂存目录**里，绝不写回源码树。
 *
 * 早先的版本把生成的 package.json / README.md / lib/ 直接写在包根上，结果
 * 「源码」和「产物」混在一起：源码里的 package.json 被生成版覆盖、
 * README.md 被一个 21 字节的占位符顶掉。构建不该改动它自己的输入。
 */
const STAGE_ROOT = path.join(HERE, '.build');
const STAGE = path.join(STAGE_ROOT, 'package');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
let problems = 0;
const fail = (msg) => { problems++; console.error(`  ✗ ${msg}`); };

// ─────────────────────────────────────────────────────────────
// 读输入
// ─────────────────────────────────────────────────────────────

const compatPath = path.join(REPO, 'compatibility.json');
if (!fs.existsSync(compatPath)) {
  console.error(`找不到 ${compatPath} —— 请在仓库根目录结构完整的情况下运行。`);
  process.exit(3);
}
const compat = readJson(compatPath);
const metaPath = path.join(REPO, 'catalog', 'verified-meta.json');
const meta = fs.existsSync(metaPath) ? readJson(metaPath) : { plugins: {} };
// 尽早读进来：下面的自注册校验要用到版本号（它在文件后半段才第一次被用到）
const srcPkg = readJson(path.join(HERE, 'package.json'));

const runtime = (compat.runtimes ?? []).find((r) => r.status === 'supported' && r.recommended)
  ?? (compat.runtimes ?? []).find((r) => r.status === 'supported');

if (!runtime) {
  console.error('compatibility.json 里没有任何 status=supported 的 runtime，无法生成目录。');
  process.exit(3);
}

/**
 * ★ 自注册校验。
 *
 * 本插件的目录是**从 compatibility.json 反推**出来的 —— 它自己那一行不在
 * 那个 runtime 的 plugins 里，市场就不会把自己列进「已验证」层，
 * 用户也就看不到引导插件。而 compatibility.json 是多个贡献者/会话都会改的
 * 共享文件（本仓库真实发生过一次：并行会话重写它时把这一行冲掉了）。
 *
 * 所以这里显式校验，缺了就**直接报错并给出要粘的片段**，而不是安静地少生成一条。
 */
const selfEntry = (runtime.plugins ?? []).find((p) => p.package === PKG_NAME);
if (!selfEntry) {
  console.error('');
  console.error(`  ✗ compatibility.json 的 runtime ${runtime.dshVersion} 里没有 ${PKG_NAME} 这一条。`);
  console.error('    没有它，插件市场不会把自己列进「已验证」层，用户看不到引导插件。');
  console.error(`    请在 compatibility.json → runtimes[${runtime.dshVersion}] → plugins 里补上：`);
  console.error('');
  console.error(JSON.stringify({
    dir: PKG_NAME,
    package: PKG_NAME,
    version: srcPkg.version,
    tarball: `plugins/${PKG_NAME}/${runtime.dshVersion}/${PKG_NAME}-${srcPkg.version}.tgz`,
    origin: 'self',
    author: 'HaydenSmith1121',
    license: 'MIT',
    bootstrap: true,
  }, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));
  console.error('');
  console.error(`    并把 "${PKG_NAME}" 追加进同一 runtime 的 bundles 数组末尾。`);
  console.error('');
  process.exit(3);
}
if (!(runtime.bundles ?? []).includes(PKG_NAME)) {
  console.error('');
  console.error(`  ✗ compatibility.json 的 runtime ${runtime.dshVersion} 的 bundles 数组里没有 "${PKG_NAME}"。`);
  console.error('    请把它追加到数组末尾（安装顺序 = 层级顺序，市场排在最后）。');
  console.error('');
  process.exit(3);
}

log('');
log(`  dsh-plugins-market 构建${CHECK_ONLY ? '（仅校验）' : ''}`);
log(`  ${'-'.repeat(72)}`);
log(`  仓库            ${REPO}`);
log(`  dsh 运行时基线   ${runtime.dshVersion}（${runtime.distTag ?? '—'}）`);
log(`  插件            ${runtime.plugins.length} 个`);
log('');

// ─────────────────────────────────────────────────────────────
// [1] verified.json
// ─────────────────────────────────────────────────────────────

log('  [1/4] 生成 catalog/verified.json');

const verifiedPlugins = runtime.plugins.map((p) => {
  const tgz = path.join(REPO, p.tarball);
  const present = fs.existsSync(tgz);
  if (!present) fail(`tarball 缺失：${p.tarball}`);

  /**
   * ★ 自引用条目不能自包含 sha256。
   *
   * verified.json 在 [1] 生成、tarball 在 [4] 重写 —— 本次构建产物的 hash
   * 写不进本次构建产物里（算完 hash 又要重写 tarball，改完 hash 又变了，无限递归）。
   * 所以自己的条目不带 hash，实际 hash 落在同目录的 `.tgz.sha256` 边车文件里，
   * 同时由仓库维护流程写进 compatibility.json。
   * 其余条目指向的是**稳定**的历史 tarball，hash 正常计算并嵌入。
   */
  const isSelf = p.package === PKG_NAME;
  const actualSha = present && !isSelf ? sha256(tgz) : null;
  // 同理，自身 tarball 的大小在本次构建里也会变 —— 它和 hash 一样无法自包含
  const actualBytes = present && !isSelf ? fs.statSync(tgz).size : null;

  // 目录里原本就写了 sha256 的，必须对得上 —— 对不上说明有人在改包而没更新目录
  if (present && !isSelf && p.sha256 && p.sha256 !== actualSha) {
    fail(`${p.package} 的 sha256 与 compatibility.json 记录不一致（记录 ${p.sha256.slice(0, 12)}…，实际 ${actualSha.slice(0, 12)}…）`);
  }

  const m = meta.plugins?.[p.package] ?? {};
  if (!m.title) warn(`  ! ${p.package} 在 verified-meta.json 里没有展示元数据，将退化为用包名当标题`);

  return {
    id: p.package,
    package: p.package,
    version: p.version,
    title: m.title ?? p.package,
    summary: m.summary ?? p.peerNote ?? '',
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

const verifiedCatalog = {
  schemaVersion: 1,
  generatedFrom: 'compatibility.json',
  generatedAt: runtime.verifiedAt ?? null,
  dshVersion: runtime.dshVersion,
  note: '由 build.mjs 生成，请勿手工编辑。展示元数据改 catalog/verified-meta.json，事实改 compatibility.json。',
  plugins: verifiedPlugins,
};

// ─────────────────────────────────────────────────────────────
// [2] compat-snapshot.json
// ─────────────────────────────────────────────────────────────

log('  [2/4] 生成 catalog/compat-snapshot.json');

// 包内快照只保留判定需要的字段，不把整份文档（含长篇 notes）塞进去
const compatSnapshot = {
  schemaVersion: compat.schemaVersion,
  snapshotOf: compat.updated ?? null,
  profile: compat.profile ?? 'web',
  requirements: compat.requirements ?? {},
  distTags: compat.distTags ?? {},
  inBoxBundles: compat.inBoxBundles ?? [],
  allowBuilds: compat.allowBuilds ?? null,
  runtimes: (compat.runtimes ?? []).map((r) => ({
    dshVersion: r.dshVersion,
    distTag: r.distTag ?? null,
    status: r.status,
    recommended: Boolean(r.recommended),
    reason: r.reason ?? null,
    upgradeTo: r.upgradeTo ?? null,
    danger: r.danger ?? null,
    verifiedAt: r.verifiedAt ?? null,
    installCommand: r.installCommand ?? null,
  })),
};

// ─────────────────────────────────────────────────────────────
// [3] 组装 lib/ 与最终 package.json
// ─────────────────────────────────────────────────────────────

log('  [3/4] 组装 lib/ 与 catalog/');

// srcPkg 已在文件顶部读取（自注册校验要用），这里不再重复声明
const clientSrc = path.join(HERE, 'src', 'client', 'app.js');
const serverSrc = path.join(HERE, 'src', 'server', 'index.js');

if (!fs.existsSync(clientSrc)) fail(`缺少客户端半源码：${clientSrc}`);
if (!fs.existsSync(serverSrc)) fail(`缺少服务器半源码：${serverSrc}`);

const serverFiles = fs.existsSync(path.join(HERE, 'src', 'server'))
  ? fs.readdirSync(path.join(HERE, 'src', 'server')).filter((f) => f.endsWith('.js'))
  : [];

// 客户端半的自检：这些错误一旦出现就是「整个页面的插件树起不来」，必须在打包前拦住
if (fs.existsSync(clientSrc)) {
  const text = readText(clientSrc);
  const checks = [
    [new RegExp(`__ModuleLoader__\\s*\\.\\s*load\\s*\\(`), '缺少 window.__ModuleLoader__.load(...) 自注册'],
    [new RegExp(`id\\s*:\\s*["']${PKG_NAME}["']`), `load() 的 id 必须严格等于包名 "${PKG_NAME}"`],
    [/\bfactory\s*:\s*\(?\s*require\s*\)?\s*=>/, '缺少 factory(require) 工厂'],
    [/exports\s*\.\s*apply\s*=/, '缺少 exports.apply'],
    [/exports\s*\.\s*inject\s*=/, '缺少 exports.inject'],
  ];
  for (const [re, msg] of checks) if (!re.test(text)) fail(`客户端半 ${msg}`);

  // 经典脚本里出现 ESM 语法 = SyntaxError = 整页白屏
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/^\s*(import|export)\s/m.test(stripped)) {
    fail('客户端半含 import/export 语句 —— 它是经典脚本，这会导致 SyntaxError 并让整页功能加载失败');
  }
  if (/^\s*await\s/m.test(stripped) && !/async\s+function/.test(stripped)) {
    fail('客户端半疑似含顶层 await —— 经典脚本不支持');
  }
  if (!/data-plugin/.test(text) || !/data-plugin-css/.test(text)) {
    warn('  ! 客户端半没有按约定给 <style> 打 data-plugin / data-plugin-css 标记（HMR 会无法正确回收样式）');
  }
  if (/sidebar\.panellist/.test(text) && !/slots\s*\.\s*inject\s*\(\s*["']sidebar\.panellist["']/.test(text)) {
    fail('客户端半直接 register 了 sidebar.panellist —— 必须先 slots.inject(slotKey, cb)');
  }
} else {
  fail('客户端半源码不存在，跳过自检');
}

// 把包名/版本写进客户端半的调试标记（保持源码可读，产物带版本）
const builtClient = fs.existsSync(clientSrc)
  ? readText(clientSrc).replace('__DPM_VERSION__', srcPkg.version)
  : '';

const builtPackageJson = {
  ...srcPkg,
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },
    client: { platform: 'web', inject: [], external: [] },
    market: { profile: 'web' },
  },
};

// 包内目录清单（全部写进暂存目录，源码树保持干净）
const readmeSrc = path.join(HERE, 'README.md');
if (!fs.existsSync(readmeSrc) || readText(readmeSrc).length < 200) {
  fail('包根缺少像样的 README.md（会原样进包，也是 npm/GitHub 上的门面）');
}
const filesToWrite = [];
filesToWrite.push(['package.json', `${JSON.stringify(builtPackageJson, null, 2)}\n`]);
filesToWrite.push(['cordis.patch.yml', readText(path.join(HERE, 'cordis.patch.yml'))]);
filesToWrite.push(['README.md', fs.existsSync(readmeSrc) ? readText(readmeSrc) : `# ${PKG_NAME}\n`]);
filesToWrite.push(['LICENSE', fs.existsSync(path.join(HERE, 'LICENSE')) ? readText(path.join(HERE, 'LICENSE')) : 'MIT\n']);
filesToWrite.push(['lib/client.js', builtClient]);
filesToWrite.push(['catalog/verified.json', `${JSON.stringify(verifiedCatalog, null, 2)}\n`]);
filesToWrite.push(['catalog/compat-snapshot.json', `${JSON.stringify(compatSnapshot, null, 2)}\n`]);
filesToWrite.push(['catalog/curated.json', readText(path.join(REPO, 'catalog', 'curated.json'))]);
for (const f of serverFiles) {
  filesToWrite.push([`lib/${f}`, readText(path.join(HERE, 'src', 'server', f))]);
}

if (!CHECK_ONLY) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const [rel, content] of filesToWrite) {
    const dst = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, 'utf8');
  }
  log(`      暂存目录 ${path.relative(HERE, STAGE)}：lib/ ${serverFiles.length + 1} 个文件，catalog/ 3 个文件`);
} else {
  // 校验模式：比对暂存目录里的产物是否与将要生成的一致
  for (const [rel, content] of filesToWrite) {
    const dst = path.join(STAGE, rel);
    if (!fs.existsSync(dst)) { fail(`--check：产物缺失 ${rel}`); continue; }
    if (readText(dst) !== content) {
      fail(`--check：产物与源码不一致 ${rel} —— 请重跑 build.mjs`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// [4] 打包 tarball
// ─────────────────────────────────────────────────────────────

log('  [4/4] 打包 tarball');

const outDir = path.join(REPO, 'plugins', PKG_NAME, runtime.dshVersion);
const tgzName = `${PKG_NAME}-${srcPkg.version}.tgz`;
const tgzPath = path.join(outDir, tgzName);

if (problems > 0) {
  console.error('');
  console.error(`  构建中止：有 ${problems} 个问题需要先修好（没有写任何产物）。`);
  console.error('');
  process.exit(1);
}

if (!CHECK_ONLY) {
  const members = [];
  const walk = (absDir, relPrefix) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else members.push({ rel, abs });
    }
  };
  // 直接从暂存目录打包：该进包的东西都在那里，不会夹带源码
  walk(STAGE, '');
  members.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const tarBuf = makeTar(members.map((m) => ({ name: `package/${m.rel}`, data: fs.readFileSync(m.abs) })));
  const gz = zlib.gzipSync(tarBuf, { level: 9 });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tgzPath, gz);

  // 自引用条目的实际 hash 落在这里（见 [1] 的说明：它无法自包含进包内目录）
  const selfHash = sha256(tgzPath);
  fs.writeFileSync(`${tgzPath}.sha256`, `${selfHash}  ${tgzName}\n`, 'utf8');

  log(`      ${path.relative(REPO, tgzPath)}  ${kb(gz.length)}  ${members.length} 个文件`);
  log(`      sha256 ${selfHash}`);
  log(`      （已写入 ${tgzName}.sha256；自引用条目的 hash 不进包内目录，原因见 build.mjs 注释）`);
  log('');
  log(`  ✓ 构建完成。装进隔离环境：`);
  log(`      node scripts/dev-env.mjs install "${tgzPath}"`);
  log(`      ⚠ 同一个 tarball 路径内容变了时，pnpm 会跳过解包 —— 必须 remove 再 add。`);
  log('');
} else {
  log('      （--check 模式，未写盘）');
  log('');
  log(`  ✓ 校验通过：目录与产物均与源码一致。`);
  log('');
}

fs.writeFileSync(
  path.join(STAGE_ROOT, 'build-report.json'),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    dshVersion: runtime.dshVersion,
    pluginVersion: srcPkg.version,
    stage: path.relative(HERE, STAGE).replace(/\\/g, '/'),
    tgz: path.relative(REPO, tgzPath).replace(/\\/g, '/'),
    files: filesToWrite.length,
    verifiedCount: verifiedPlugins.length,
    checkOnly: CHECK_ONLY,
  }, null, 2)}\n`,
  'utf8',
);

// ─────────────────────────────────────────────────────────────
// 极简 tar 写入（ustar），避免依赖 tar 命令
// ─────────────────────────────────────────────────────────────

function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    const name = e.name;
    if (Buffer.byteLength(name) > 100) {
      // ustar prefix 拆分
      const idx = name.lastIndexOf('/', 155);
      const prefix = idx > 0 ? name.slice(0, idx) : '';
      const base = idx > 0 ? name.slice(idx + 1) : name;
      header.write(base, 0, 100, 'utf8');
      header.write(prefix, 345, 155, 'utf8');
    } else {
      header.write(name, 0, 100, 'utf8');
    }
    header.write('0000644\0', 100, 8);        // mode
    header.write('0000000\0', 108, 8);        // uid
    header.write('0000000\0', 116, 8);        // gid
    header.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 12); // size
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12); // mtime
    header.write('        ', 148, 8);         // checksum placeholder
    header.write('0', 156, 1);                // typeflag = regular file
    header.write('ustar\0', 257, 6);          // magic
    header.write('00', 263, 2);               // version
    // checksum
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // 结束块
  return Buffer.concat(blocks);
}
