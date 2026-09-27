/**
 * 清单与跨版本适配的**不变量**。
 *
 * 这一组测试回答的是「这个包能不能被 0.1.5 / 0.1.6 / 0.1.7（含官方桌面版）装上并加载」。
 * 它们比功能测试更重要：功能坏了用户看得见，清单坏了是「装不上」或者
 * 「装了但界面上没有」，而这两种症状都不会在开发机上出现。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEq, eq, ok, test } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package.json：没有 dependencies / peerDependencies / optionalDependencies', () => {
  // ★ 这是「一个包同时活在多个 dsh 版本上」的核心前提：
  //   dsh 0.1.7 起会在导入插件前核对 peerDependencies 里的 @deepseek-ai/dsh*
  //   与运行时版本是否一致。写了 peer 就等于把自己钉在一个版本上。
  eq(pkg.dependencies, undefined, 'dependencies 必须不存在');
  eq(pkg.peerDependencies, undefined, 'peerDependencies 必须不存在');
  eq(pkg.optionalDependencies, undefined, 'optionalDependencies 必须不存在');
});

test('package.json：engines.dsh 不存在（声明了就会挡住旧版本）', () => {
  eq(pkg.engines?.dsh, undefined, 'engines.dsh 不该声明');
  ok(typeof pkg.engines?.node === 'string', 'engines.node 应当是一个宽松的下限');
});

test('package.json：dsh 清单是 0.1.7 校验器接受的形状', () => {
  eq(pkg.dsh?.manifestVersion, 1);
  ok(typeof pkg.dsh?.bundle?.patch === 'string' || Array.isArray(pkg.dsh?.bundle?.patch),
    'dsh.bundle.patch 必须是文件路径或路径数组');
  // 0.1.7 的解析器会对这些字段做类型校验，类型不对会直接抛错
  eq(typeof pkg.dsh?.client?.platform, 'string', 'dsh.client.platform 必须是字符串');
  ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject 必须是数组');
  ok(Array.isArray(pkg.dsh?.client?.external), 'dsh.client.external 必须是数组');
  if (pkg.dsh?.client?.immediately !== undefined) {
    eq(typeof pkg.dsh.client.immediately, 'boolean', 'dsh.client.immediately 必须是布尔值');
  }
});

test('dsh.bundle.patch 指向的文件真的存在，且 insert 行 name 等于包名', () => {
  const patchPath = path.join(ROOT, pkg.dsh.bundle.patch.replace(/^\.\//, ''));
  ok(fs.existsSync(patchPath), `patch 文件不存在：${pkg.dsh.bundle.patch}`);
  const text = fs.readFileSync(patchPath, 'utf8');
  ok(text.includes(`name: '${pkg.name}'`) || text.includes(`name: "${pkg.name}"`) || text.includes(`name: ${pkg.name}`),
    'patch 里的 insert 行 name 必须是真实包名（它同时是 boot 图行 id）');
});

test('exports 覆盖 "."、"./client"、"./package.json"，且文件都存在', () => {
  // 0.1.7：声明了 dsh.client 却没有 exports["./client"] 会报
  // “declares dsh.client but exports no "./client" bundle”
  for (const key of ['.', './client', './package.json']) {
    const entry = pkg.exports?.[key];
    ok(entry, `exports["${key}"] 必须存在`);
    const target = typeof entry === 'string' ? entry : entry.default;
    ok(target, `exports["${key}"].default 必须存在`);
    ok(fs.existsSync(path.join(ROOT, target.replace(/^\.\//, ''))), `exports["${key}"] 指向的文件不存在：${target}`);
  }
});

test('main 与 exports["."] 指向同一个文件（两种解析路径必须一致）', () => {
  const norm = (p) => String(p).replace(/^\.\//, '');
  const exp = pkg.exports['.'];
  eq(norm(typeof exp === 'string' ? exp : exp.default), norm(pkg.main));
});

test('files 白名单包含运行必需的东西，且不含测试与缓存', () => {
  const files = pkg.files ?? [];
  for (const need of ['src', 'cordis.patch.yml', 'README.md']) {
    ok(files.includes(need), `files 里缺少 ${need}`);
  }
  for (const bad of ['test', '.cache', 'scripts']) {
    ok(!files.includes(bad), `files 里不该包含 ${bad}`);
  }
  // 包内离线兜底快照必须在包里，否则没网时面板是空的
  ok(files.includes('catalog/snapshot.json'), 'files 里必须有 catalog/snapshot.json');
});

test('★ files 必须排除 catalog/index.json（否则远程那条路就废了）', () => {
  // 这不是体积问题，是**行为**问题：
  //   · 包里带了完整索引 → pluginDir()/catalog/index.json 存在 → 永远走「本地检出」
  //     分支（source: checkout）→ 用户看到的是**安装那一天**的数据，再也不会更新；
  //   · 排除它 → 走远程（source: remote）→ 每次打开都能拿到当天的采集结果。
  // 实测确认过：从 GitHub 装的那一份正是靠这条，起来就 source=remote、9423 条。
  const files = pkg.files ?? [];
  ok(!files.includes('catalog'), 'files 里不要写整个 catalog/ —— 那会把 7.8MB 的完整索引打进包');
  ok(!files.some((f) => f === 'catalog/index.json' || f.startsWith('catalog/index')),
    '完整索引不进包，包内只留 catalog/snapshot.json');
});

test('compatibility.json 记录了 desktop 0.1.7-rc.2，且不构成任何闸门', () => {
  const compat = JSON.parse(fs.readFileSync(path.join(ROOT, 'compatibility.json'), 'utf8'));
  const versions = (compat.runtimes ?? []).map((r) => r.dshVersion);
  ok(versions.includes('0.1.7-rc.2'), `compatibility.json 里应当有 desktop 的 0.1.7-rc.2，实际有 ${versions.join('、')}`);
  ok(versions.includes('0.1.6-alpha.1'), '应当保留 0.1.6-alpha.1');
  ok(versions.some((v) => v.startsWith('0.1.5')), '应当保留 0.1.5 系列');
  ok(compat.gate === undefined, '兼容矩阵里不该有 gate 之类的拦截配置');
});

test('仓库根就是插件包（官方桌面版只能从仓库根安装）', () => {
  // ★ 0.1.7 的安装规格解析器只接受 host/owner/repo 形状：
  //   `https://github.com/a/b/sub` 会被拒（"a URL must point at a git repository or a tarball"）。
  //   所以插件必须躺在仓库根，不能放在子目录里。
  ok(fs.existsSync(path.join(ROOT, 'package.json')));
  ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')));
  ok(fs.existsSync(path.join(ROOT, 'src', 'server', 'index.js')));
  ok(fs.existsSync(path.join(ROOT, 'src', 'client', 'app.js')));
  // 旧的「子目录里的插件包」结构不该再出现，否则会有人误以为要装那个
  ok(!fs.existsSync(path.join(ROOT, 'plugins-src')), 'plugins-src/ 已废弃，插件就在仓库根');
});

test('服务器半只 import Node 内置模块（没有裸包名）', () => {
  const dir = path.join(ROOT, 'src', 'server');
  const bare = [];
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      bare.push(`${file}: ${spec}`);
    }
  }
  deepEq(bare, [], '服务器半不许依赖第三方包');
});
