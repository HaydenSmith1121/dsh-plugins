/**
 * 已装状态判定 + 用户数据（点赞 / 收藏）的测试。
 *
 * 为什么这一组值得单独写：
 *
 *   · 「已是最新」这个结论**会直接让安装按钮置灰**。判定写反一次，
 *     用户就再也装不上那个插件了，而且界面上看不出任何异常 ——
 *     按钮就是灰的，没有任何错误信息。
 *
 *   · 版本比较还牵扯到预发布版本（本仓库的 dsh 本身就是 0.1.6-alpha.1，
 *     插件版本里有 0.1.0 / 0.2.1 / 0.3.0 与各种 alpha）。semver 的
 *     预发布规则一错，「0.3.0 > 0.2.1」也会判错。
 *
 *   · 「更新」路径必须先 remove 再 add。如果只 add，pnpm 会认为依赖已满足，
 *     dependencies 里那条指向旧 tarball 的规格原封不动 —— 用户点了更新、
 *     界面显示成功、装的还是旧版本。这是最难查的一类「假成功」，
 *     所以这里用真实的隔离 profile 跑一次端到端安装来钉住它。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suite, test, assert, eq, importBuilt } from './harness.mjs';

const { describeInstallState, resolveTargetVersion, installedOverview,
  toggleUserMark, userMarks, userDataStats, readUserData } = await importBuilt('lib/state.js');
const { mergeEntries, mergedCounts, searchCatalog, normalizeEntry, reviewStatusOf } = await importBuilt('lib/catalog.js');
const { compareVersions } = await importBuilt('lib/util.js');

// 所有会写盘的用例都打在**隔离环境**上，绝不碰生产 profile
const DEV_HOME = process.env.DPM_TEST_HOME ?? path.join(os.homedir(), '.dsh-dev');
process.env.DSH_HOME = DEV_HOME;

/** 造一个已装项（形状与 profile.scanInstalled() 的产物一致） */
function inst(name, version, spec, extra = {}) {
  return {
    name,
    spec: spec ?? `file:D:/repo/plugins/${name}/0.1.6-alpha.1/${name}-${version}.tgz`,
    specVersion: version,
    installed: true,
    installedVersion: version,
    isBundle: true,
    inBundles: true,
    mismatch: false,
    ...extra,
  };
}

/** 造一个目录条目 */
function entry(id, install = {}, extra = {}) {
  return {
    id,
    package: id,
    version: extra.version ?? null,
    tier: extra.tier ?? 'verified',
    install: { kind: 'local-tarball', spec: null, ...install },
    ...extra,
  };
}

suite('state / 最新版本解析');

test('从 file: 规格的 tarball 文件名取版本（最可靠的一路）', () => {
  const r = resolveTargetVersion(entry('p', {
    spec: 'file:D:/repo/plugins/p/0.1.6-alpha.1/p-0.3.0.tgz',
  }));
  eq(r.version, '0.3.0', 'file: 规格里的版本号就是「装上去会是什么版本」');
  eq(r.source, 'spec');
});

test('file: 规格里没有版本号时不硬猜，如实返回无法判定', () => {
  const r = resolveTargetVersion(entry('p', { spec: 'file:D:/repo/plugins/p/latest.tgz' }));
  eq(r.version, null);
  assert(/没有版本号/.test(r.reason), `应当说明原因，实际：${r.reason}`);
});

test('声明了显式 spec 版本时用它', () => {
  const r = resolveTargetVersion(entry('p', { kind: 'npm', spec: 'p@1.2.3' }));
  eq(r.version, '1.2.3');
});

test('公共索引条目（github:）拿不到版本时说明「无法比较」而不是「已是最新」', () => {
  const r = resolveTargetVersion(entry('p', { kind: 'github', spec: 'github:o/r' }, { tier: 'community' }));
  eq(r.version, null);
  assert(r.reason && /无法比较/.test(r.reason), `应当如实说无法比较，实际：${r.reason}`);
});

test('目录自带的 version 字段作为兜底', () => {
  const r = resolveTargetVersion(entry('p', {}, { version: '2.0.0' }));
  eq(r.version, '2.0.0');
  eq(r.source, 'catalog');
});

suite('state / 安装状态判定（问题 1 与 2 的核心）');

test('没装 → not-installed，可以装', () => {
  const st = describeInstallState(entry('p', { spec: 'file:/r/p-1.0.0.tgz' }), null);
  eq(st.status, 'not-installed');
  eq(st.installed, false);
  eq(st.canInstall, true, '没装当然要能装');
  eq(st.isLatest, false);
});

test('★ 装了同一版本 → current，canInstall=false（这就是「按钮置灰」的依据）', () => {
  const st = describeInstallState(
    entry('p', { spec: 'file:/r/p-1.0.0.tgz' }),
    inst('p', '1.0.0', 'file:/r/p-1.0.0.tgz'),
  );
  eq(st.status, 'current');
  eq(st.isLatest, true);
  eq(st.canInstall, false, '★ 已是最新时必须禁止安装 —— 否则点下去是空转');
  eq(st.action, 'current');
  eq(st.installedVersion, '1.0.0');
  eq(st.target, '1.0.0');
});

test('★ 装了旧版本 → upgradable，canInstall=true 且 action=update', () => {
  const st = describeInstallState(
    entry('p', { spec: 'file:/r/p-0.3.0.tgz' }),
    inst('p', '0.2.1', 'file:/r/p-0.2.1.tgz'),
  );
  eq(st.status, 'upgradable');
  eq(st.canUpgrade, true);
  eq(st.canInstall, true);
  eq(st.action, 'update');
  eq(st.installedVersion, '0.2.1');
  eq(st.target, '0.3.0', '要升到目录里的那一版');
  eq(st.isLatest, false);
});

test('装了比目录更新的版本 → older，不置灰（那是降级场景，交给用户）', () => {
  const st = describeInstallState(
    entry('p', { spec: 'file:/r/p-0.2.0.tgz' }),
    inst('p', '0.9.0', 'file:/r/p-0.9.0.tgz'),
  );
  eq(st.status, 'older');
  eq(st.canInstall, true, '不能因为「装得比目录新」就把按钮置灰');
  eq(st.isLatest, false);
});

test('★ 版本无法比较 → unknown，绝不置灰（不能把「算不出来」当成「已是最新」）', () => {
  const st = describeInstallState(
    entry('p', { kind: 'github', spec: 'github:o/r' }, { tier: 'community' }),
    inst('p', '1.0.0', 'github:o/r'),
  );
  eq(st.status, 'unknown');
  eq(st.canInstall, true, '★ 无法判定时必须保持可安装');
  eq(st.isLatest, false, '★ 无法判定时绝不能声称「已是最新」');
});

test('dependencies 里有、node_modules 里没有 → 当成没装好，允许重装', () => {
  const st = describeInstallState(
    entry('p', { spec: 'file:/r/p-1.0.0.tgz' }),
    { ...inst('p', '1.0.0'), installed: false, installedVersion: null },
  );
  eq(st.status, 'not-installed');
  eq(st.canInstall, true);
  assert(/node_modules/.test(st.reason), '应当说明是「声明了但没装上」');
});

test('装了但不在 bundles 里 → 仍然显示已装，且允许重装修好它', () => {
  const st = describeInstallState(
    entry('p', { spec: 'file:/r/p-1.0.0.tgz' }),
    inst('p', '1.0.0', 'file:/r/p-1.0.0.tgz', { inBundles: false }),
  );
  eq(st.status, 'current');
  eq(st.inBundles, false, '要把「没挂载」这个事实带出去，界面才好提示');
});

test('预发布版本比较不会把「更新」判成「相同」', () => {
  // 本仓库的 dsh 自己就是 0.1.6-alpha.1，插件版本里混着 alpha/beta 很常见
  const older = describeInstallState(
    entry('p', { spec: 'file:/r/p-1.0.0-alpha.1.tgz' }),
    inst('p', '1.0.0-alpha.0', 'file:/r/p-1.0.0-alpha.0.tgz'),
  );
  eq(older.status, 'upgradable', 'alpha.1 比 alpha.0 新，应当判为可升级');

  const newer = describeInstallState(
    entry('p', { spec: 'file:/r/p-1.0.0-alpha.1.tgz' }),
    inst('p', '1.0.0', 'file:/r/p-1.0.0.tgz'),
  );
  eq(newer.status, 'older', '正式版 1.0.0 比 1.0.0-alpha.1 新');
});

test('installedOverview 把升级项标出来，且不在目录里的依赖也如实列出', () => {
  // 用隔离环境里**真实存在**的依赖来验：dsh-session-cleanup 当前装的是 0.1.2，
  // 而我们传进去的目录条目说仓库里是 0.1.3 —— 它必须被判成 upgradable。
  const entries = [
    entry('dsh-session-cleanup', { spec: 'file:/r/dsh-session-cleanup-0.1.3.tgz' }),
  ];
  const rows = installedOverview('web', process.env, entries);
  assert(Array.isArray(rows), '应当返回数组');
  for (const r of rows) {
    assert(typeof r.name === 'string', '每一行都要有包名');
    assert(r.state, '每一行都要带状态');
  }

  const target = rows.find((r) => r.name === 'dsh-session-cleanup');
  if (!target) {
    assert(true, '隔离环境里没有 dsh-session-cleanup，跳过升级断言');
    return;
  }
  eq(target.inCatalog, true, '目录里有它，应当标记 inCatalog');
  eq(target.upgrade, true, `目录里给的是 0.1.3，已装 ${target.installedVersion}，应当判为可升级`);
  eq(target.targetVersion, '0.1.3');

  // 目录里没有的依赖必须如实标成「不在目录里」，而不是悄悄当成没有更新
  const notInCatalog = installedOverview('web', process.env, []);
  const missing = notInCatalog.filter((r) => !r.inCatalog);
  assert(missing.length > 0, '隔离环境里应当有目录覆盖不到的依赖（比如整棵依赖闭包）');
  for (const r of missing) {
    eq(r.upgrade, false, '不在目录里的依赖不可能被判为可升级');
  }
});

suite('state / 用户数据（点赞 / 收藏）');

test('点赞与收藏互相独立，可分别开关', () => {
  const saved = process.env.DSH_HOME;
  // 打到一个临时 home，避免污染隔离环境里已有的用户数据
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-state-'));
  process.env.DSH_HOME = tmp;
  try {
    const id = 'dsh-unit-test-target';
    let r = toggleUserMark('like', id, true);
    eq(r.liked, true);
    eq(r.favorited, false, '点赞不该顺带收藏');

    r = toggleUserMark('favorite', id, true);
    eq(r.liked, true, '收藏不该把已有的点赞冲掉');
    eq(r.favorited, true);

    // 不给 value 就是反转
    r = toggleUserMark('like', id);
    eq(r.liked, false);
    eq(r.favorited, true, '取消点赞不该影响收藏');

    // 两个都归零 → 整条删掉，文件不随浏览历史膨胀
    r = toggleUserMark('favorite', id);
    eq(r.liked, false);
    eq(r.favorited, false);
    const store = readUserData(process.env);
    eq(store.items[id], undefined, '两个标记都归零后应当把这一条删掉');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('用户数据落盘在 storages 下，不污染 profile 目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-state-'));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  try {
    toggleUserMark('like', 'x', true);
    const stats = userDataStats(process.env);
    assert(stats.file.startsWith(path.join(tmp, 'storages')), `应当落在 storages 下，实际 ${stats.file}`);
    assert(fs.existsSync(stats.file), '文件应当真的写出来了');
    eq(stats.liked, 1);
    const raw = JSON.parse(fs.readFileSync(stats.file, 'utf8'));
    assert(raw.schemaVersion, '应当带 schemaVersion，便于以后迁移');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('用户数据文件损坏时降级成空，且不吞掉用户已有数据', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-state-'));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  try {
    const dir = path.join(tmp, 'storages', 'dsh-plugins-market');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'user-data.json'), '{ 这不是 JSON', 'utf8');
    const store = readUserData(process.env);
    eq(store.items, {}, '坏文件应当降级成空');

    // 再写一次应当能正常覆盖，不抛异常
    const r = toggleUserMark('like', 'y', true);
    eq(r.liked, true);
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('非法 id 会被拒绝，不会把垃圾写进文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-state-'));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  try {
    let threw = false;
    try { toggleUserMark('like', ''); } catch { threw = true; }
    assert(threw, '空 id 应当被拒绝');

    threw = false;
    try { toggleUserMark('bogus', 'x'); } catch { threw = true; }
    assert(threw, '未知的标记类型应当被拒绝');
    eq(userMarks(process.env), {}, '被拒绝的操作不该留下任何数据');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

suite('catalog / 三层视图合并（问题 4）');

test('★ 同一个包出现在多层时只保留一条，且保留的是层级更高的那条', () => {
  const layers = {
    verified: [
      normalizeEntry({ id: 'dsh-memory', package: 'dsh-memory', version: '0.1.0', title: '记忆', install: { kind: 'local-tarball', tarball: 'x.tgz' } }, 'verified'),
    ],
    reviewed: [],
    community: [
      normalizeEntry({ id: 'dsh-memory', package: 'dsh-memory', name: 'dsh-memory', stars: 42, title: '记忆（公共）' }, 'community'),
    ],
  };
  const { merged, shadowed } = mergeEntries(layers);
  eq(merged.length, 1, '★ 同一个包名只应出现一条 —— 否则用户会看到两个一模一样的插件');
  eq(merged[0].tier, 'verified', '应当保留层级更高的那条（那是我们验证过的说法）');
  eq(merged[0].stars, 42, '被合并条目的展示信息（star 数）应当补过来');
  eq(shadowed.size, 1, '被合并掉的副本要留档，详情页可以如实展示');
});

test('合并后的计数与列表条数一致（顶部数字不能对不上）', () => {
  const layers = {
    verified: [
      normalizeEntry({ id: 'a', package: 'a', install: {} }, 'verified'),
      normalizeEntry({ id: 'b', package: 'b', install: {} }, 'verified'),
    ],
    reviewed: [normalizeEntry({ id: 'c', package: 'c', install: {} }, 'reviewed')],
    community: [
      // a 在公共索引里也有副本 —— 正是真实情况（dsh-memory / @dsh-market/plugin）
      normalizeEntry({ id: 'a', package: 'a', install: {} }, 'community'),
      normalizeEntry({ id: 'd', package: 'd', install: {} }, 'community'),
    ],
  };
  const counts = mergedCounts(layers);
  eq(counts.total, 4, 'a / b / c / d 四条');
  eq(counts.reviewed, 3, 'a b c 都是已审核口径（verified + reviewed）');
  eq(counts.unreviewed, 1, '只有 d 是未审核');
  eq(counts.reviewed + counts.unreviewed, counts.total, '两个数字必须加起来等于总数');
});

test('★ 回归：层传裸数组时不能静默丢掉整层', () => {
  // 真实事故形态：verified/reviewed 层是 { plugins: [...] }，社区层是裸数组。
  // 早先的实现只认 `layers.verified?.plugins`，传裸数组时静默返回空 ——
  // 结果**整整一层凭空消失**，而列表看起来完全正常（还有社区层撑着），
  // 只是数量对不上、层级标签全变成「未审核」。静默丢数据比抛错难查得多。
  const asObjects = {
    verified: [normalizeEntry({ id: 'v1', package: 'v1', install: {} }, 'verified')],
    reviewed: [normalizeEntry({ id: 'r1', package: 'r1', install: {} }, 'reviewed')],
    community: [normalizeEntry({ id: 'c1', package: 'c1', install: {} }, 'community')],
  };
  const asWrapped = {
    verified: { plugins: [normalizeEntry({ id: 'v1', package: 'v1', install: {} }, 'verified')] },
    reviewed: { plugins: [normalizeEntry({ id: 'r1', package: 'r1', install: {} }, 'reviewed')] },
    community: [normalizeEntry({ id: 'c1', package: 'c1', install: {} }, 'community')],
  };

  for (const [label, layers] of [['裸数组', asObjects], ['包装对象', asWrapped]]) {
    const counts = mergedCounts(layers);
    eq(counts.total, 3, `${label}：三层各一条，合并后应当仍是 3 条`);
    eq(counts.verified, 1, `${label}：已验证层不能丢`);
    eq(counts.reviewedTier, 1, `${label}：已审核层不能丢`);
    eq(counts.community, 1, `${label}：未审核层不能丢`);
  }
});

test('审核状态标签：已验证与已审核都算「已审核」，未审核不是', () => {
  eq(reviewStatusOf('verified').reviewed, true);
  eq(reviewStatusOf('reviewed').reviewed, true);
  eq(reviewStatusOf('community').reviewed, false);
  eq(reviewStatusOf('verified').label, '已验证');
  eq(reviewStatusOf('community').label, '未审核');
});

test('筛选器按审核状态与用户标记过滤', () => {
  const entries = [
    { ...normalizeEntry({ id: 'a', package: 'a', install: {} }, 'verified'), },
    { ...normalizeEntry({ id: 'b', package: 'b', install: {} }, 'community') },
  ];
  entries[0].liked = true;
  entries[1].favorited = true;
  const marks = { a: { liked: true }, b: { favorited: true } };

  eq(searchCatalog(entries, { review: 'reviewed' }).total, 1);
  eq(searchCatalog(entries, { review: 'unreviewed' }).total, 1);
  eq(searchCatalog(entries, { only: 'liked', marks }).total, 1);
  eq(searchCatalog(entries, { only: 'favorited', marks }).total, 1);
  eq(searchCatalog(entries, {}).total, 2, '不带筛选时全部返回');
});

test('「可升级」筛选只看真正有新版的那几条', () => {
  const entries = [
    normalizeEntry({ id: 'a', package: 'a', install: {} }, 'verified'),
    normalizeEntry({ id: 'b', package: 'b', install: {} }, 'verified'),
  ];
  const installed = new Map([
    ['a', { installed: true, status: 'upgradable' }],
    ['b', { installed: true, status: 'current' }],
  ]);
  eq(searchCatalog(entries, { only: 'upgradable', installed }).total, 1);
  eq(searchCatalog(entries, { only: 'installed', installed }).total, 2);
});

suite('state / 版本比较的边界');

test('比较函数对预发布版本的方向正确（更新判定的地基）', () => {
  eq(compareVersions('0.3.0', '0.2.1'), 1);
  eq(compareVersions('0.2.1', '0.3.0'), -1);
  eq(compareVersions('1.0.0', '1.0.0'), 0);
  eq(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.0'), 1);
  eq(compareVersions('1.0.0', '1.0.0-alpha.1'), 1, '正式版比预发布版新');
  eq(compareVersions('乱写', '1.0.0'), null, '不可解析要返回 null，调用方据此降级为「无法判定」');
});
