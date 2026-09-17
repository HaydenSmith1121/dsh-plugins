/**
 * 基础设施层测试：tar 只读访问、YAML 局部合并、patch 行抽取。
 *
 * 这三块都是「自己实现、不引依赖」的部分，也就是最容易出错的部分，
 * 所以用仓库里真实存在的 8 个 tarball 做输入来测。
 */

import fs from 'node:fs';
import path from 'node:path';
import { suite, test, assert, eq, REPO_ROOT as REPO, importBuilt } from './harness.mjs';

const { readTarGzEntries, listTarGzEntries, extractPatchRows, readAllowBuilds, mergeAllowBuilds, checkWorkspaceInvariants } =
  await importBuilt('lib/util.js');

const compat = JSON.parse(fs.readFileSync(path.join(REPO, 'compatibility.json'), 'utf8'));
const runtime = compat.runtimes.find((r) => r.status === 'supported' && r.recommended);
const first = runtime.plugins[0];
const tgzPath = path.join(REPO, first.tarball);

suite('util / tar');

test('能从真实 tarball 里读出 package.json 与 cordis.patch.yml', () => {
  assert(fs.existsSync(tgzPath), `测试前置：找不到 ${first.tarball}`);
  const entries = readTarGzEntries(tgzPath, ['package/package.json', 'package/cordis.patch.yml']);
  assert(entries, 'readTarGzEntries 返回 null（gzip 解压失败）');
  assert(entries.has('package/package.json'), '没读到 package/package.json');
  const pkg = JSON.parse(entries.get('package/package.json').toString('utf8'));
  eq(pkg.name, first.package, 'tarball 里的包名应与 compatibility.json 一致');
  eq(pkg.version, first.version, 'tarball 里的版本应与 compatibility.json 一致');
});

test('文件条目数与 compatibility.json 记录的 files 一致', () => {
  const list = listTarGzEntries(tgzPath);
  assert(Array.isArray(list) && list.length > 0, '应列出至少一个文件条目');
  if (typeof first.files === 'number') {
    eq(list.length, first.files, `${first.package} 的 tarball 文件数`);
  }
});

test('8 个 tarball 全部可读且都声明了 dsh.bundle.patch', () => {
  for (const p of runtime.plugins) {
    const abs = path.join(REPO, p.tarball);
    assert(fs.existsSync(abs), `${p.package}: tarball 缺失`);
    const e = readTarGzEntries(abs, ['package/package.json', 'package/cordis.patch.yml']);
    assert(e?.has('package/package.json'), `${p.package}: 读不到 package.json`);
    const manifest = JSON.parse(e.get('package/package.json').toString('utf8'));
    assert(manifest.dsh?.bundle?.patch, `${p.package}: 没有声明 dsh.bundle.patch（装了也不会加载）`);
    const rel = `package/${String(manifest.dsh.bundle.patch).replace(/^\.\//, '')}`;
    assert(e.has(rel), `${p.package}: 声明了 ${manifest.dsh.bundle.patch} 但包里没有 ${rel}（boot 期会 fatal）`);
  }
});

suite('util / yaml');

test('抽取 cordis.patch.yml 的 insert 行 id / name', () => {
  const rows = extractPatchRows([
    '# 注释',
    '- insert:',
    "    - id: opencode-go-plus",
    '      name: dsh-opencode-go-plus',
    '',
  ].join('\n'));
  eq(rows, [{ id: 'opencode-go-plus', name: 'dsh-opencode-go-plus' }]);
});

test('抽取值带引号的 name', () => {
  const rows = extractPatchRows([
    '- insert:',
    '    - id: dsh-market',
    "      name: '@dsh-market/plugin'",
  ].join('\n'));
  eq(rows, [{ id: 'dsh-market', name: '@dsh-market/plugin' }]);
});

test('识破 dsh-session-cleanup 那种「先 disable 再 insert」的 patch', () => {
  const rows = extractPatchRows([
    '- id: ui-settings-unarchive-sessions',
    '  disabled: true',
    '- insert:',
    '    - id: session-cleanup',
    '      name: dsh-session-cleanup',
  ].join('\n'));
  assert(rows.some((r) => r.id === 'session-cleanup' && r.name === 'dsh-session-cleanup'), '应抽到 insert 行');
});

test('★ 不把 patch 的定位目标与嵌套 config 里的 id 当插入行（dsh-ark-plans 真实形状）', () => {
  // 真实事故：只按「缩进不小于 insert」判定时，llm-pi-ai（patch 的定位目标）
  // 和几十个模型 id 全被当成插入行，导致闸门对仓库自带的已验证插件报出假的 id 冲突。
  const rows = extractPatchRows([
    '- insert:',
    '    - id: ark-plans',
    '      name: dsh-ark-plans',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      - id: ark-agent-plan',
    '        api: openai-completions',
    '        models:',
    '          - id: ark-code-latest',
    '            name: Ark 智能路由 (ark-code-latest)',
    '          - id: glm-5.3',
    '            name: GLM-5.3',
  ].join('\n'));
  eq(rows, [{ id: 'ark-plans', name: 'dsh-ark-plans' }]);
});

test('★ 对仓库里 8 个真实 tarball 抽出的插入行都只有自己那一条', () => {
  const runtime = compat.runtimes.find((r) => r.status === 'supported' && r.recommended);
  for (const p of runtime.plugins) {
    const abs = path.join(REPO, p.tarball);
    const e = readTarGzEntries(abs, ['package/cordis.patch.yml']);
    assert(e?.has('package/cordis.patch.yml'), `${p.package}: 读不到 cordis.patch.yml`);
    const rows = extractPatchRows(e.get('package/cordis.patch.yml').toString('utf8'));
    assert(Array.isArray(rows) && rows.length >= 1, `${p.package}: 应当至少抽到一条插入行`);
    // 每个包的 patch 只应插入它自己 —— 多出来的都是把嵌套数据误当插入行
    eq(rows.length, 1, `${p.package} 应当只抽到 1 条插入行，实际抽到 ${rows.length} 条：${JSON.stringify(rows)}`);
    assert(rows[0].id, `${p.package}: 插入行应当有 id`);
    // 这些 bundle 的插入行 name 就是包名本身（install 的注释里说明过这个约定）
    eq(rows[0].name, p.package, `${p.package}: 插入行的 name 应当是包名`);
  }
});

test('解析不出来时返回 null（调用方要降级为「无法判定」而不是硬拦）', () => {
  eq(extractPatchRows('这不是 YAML'), null);
  eq(extractPatchRows(null), null);
  eq(extractPatchRows(''), null);
});

test('读 allowBuilds 块，含占位符识别', () => {
  const ab = readAllowBuilds([
    'packages:',
    '  - .',
    '',
    'allowBuilds:',
    "  '@google/genai': false",
    '  protobufjs: set this to true or false',
  ].join('\n'));
  eq(ab['@google/genai'], false);
  eq(ab.protobufjs, 'placeholder', '占位符必须被识别出来 —— 它是 ERR_PNPM_IGNORED_BUILDS 的直接信号');
});

test('mergeAllowBuilds：替换占位符而不动其它任何一行', () => {
  const before = [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
    'allowBuilds:',
    "  '@google/genai': set this to true or false",
    '  protobufjs: set this to true or false',
    '',
  ].join('\n');
  const r = mergeAllowBuilds(before, { '@google/genai': false, protobufjs: false });
  eq(r.changed, true);
  assert(r.text.includes('nodeLinker: hoisted'), 'nodeLinker 不能被改动');
  assert(r.text.includes('autoInstallPeers: false'), 'autoInstallPeers 不能被改动');
  assert(!/set this to true or false/.test(r.text), '占位符应被替换掉');
  assert(/'@google\/genai': false/.test(r.text), '应写入 false');
});

test('mergeAllowBuilds：块内补缺失的键', () => {
  const before = ['packages:', '  - .', '', 'allowBuilds:', "  '@google/genai': false", ''].join('\n');
  const r = mergeAllowBuilds(before, { protobufjs: false });
  eq(r.added, ['protobufjs']);
  eq(readAllowBuilds(r.text).protobufjs, false);
});

test('mergeAllowBuilds：没有 allowBuilds 块时新建', () => {
  const before = ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n');
  const r = mergeAllowBuilds(before, { protobufjs: false });
  eq(r.changed, true);
  const ab = readAllowBuilds(r.text);
  eq(ab.protobufjs, false);
  assert(checkWorkspaceInvariants(r.text).nodeLinkerHoisted, '新建块后不变量仍在');
  assert(checkWorkspaceInvariants(r.text).autoInstallPeersFalse, '新建块后不变量仍在');
});

test('★ 关键回归：profile 还没初始化时不能把整个文件写成空', () => {
  // 仓库原 install.mjs 在这里有个缺陷：它把「初始化之前」读到的空内容写了回去，
  // 结果抹掉了 dsh 刚建好的 packages/nodeLinker/autoInstallPeers。
  // 我们的契约是：文本为 null/空时**不**声称改过任何东西。
  const r = mergeAllowBuilds('', { protobufjs: false });
  // 空文本时应当新建块，而不是覆盖成空
  assert(r.text.trim() !== '', '空输入也不能产出空文件');
  assert(checkWorkspaceInvariants(r.text).packages === false, '空输入本来就没有 packages 键 —— 这正说明调用方必须先确保文件存在');
});

test('checkWorkspaceInvariants 检出丢失的键', () => {
  const good = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n';
  eq(checkWorkspaceInvariants(good), { packages: true, nodeLinkerHoisted: true, autoInstallPeersFalse: true });
  const bad = 'packages:\n  - .\n';
  eq(checkWorkspaceInvariants(bad), { packages: true, nodeLinkerHoisted: false, autoInstallPeersFalse: false });
});
