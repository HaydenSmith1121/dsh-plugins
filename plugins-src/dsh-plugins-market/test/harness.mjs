/**
 * 极简测试脚手架 —— 不引第三方依赖（与插件的「零依赖」原则一致）。
 *
 * 测试一律针对**打包产物**（`.build/package/`）而不是源码树：
 * 源码里服务器半在 `src/server/`、打包后平铺到 `lib/`，相对深度不同，
 * 只测源码会漏掉一整类「能跑但全错」的问题（cwd/资源解析错位）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 打包产物目录（由 build.mjs 生成） */
export const PKG_ROOT = path.resolve(HERE, '..');
export const BUILT = path.join(PKG_ROOT, '.build', 'package');
export const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

/**
 * 测试用的隔离 home。
 *
 * 默认 `~/.dsh-dev`（开发机上的隔离环境，端口 3090），可以用 DPM_TEST_HOME 指到别处。
 * **绝不碰生产的 `~/.dsh`。**
 */
export const TEST_HOME = process.env.DPM_TEST_HOME ?? path.join(os.homedir(), '.dsh-dev');

/**
 * ★ 确保隔离 profile **可读**，读不到就铺一份最小可用的 fixture。
 *
 * 为什么需要它：闸门那组测试要在一个「已经初始化过的 profile」上跑，
 * 而 CI（ubuntu-latest）上根本没有 dsh，也就没有人替我们建这个 profile ——
 * 于是整组测试会在 CI 里恒红，而开发机上恒绿。那种「只在 CI 红」的测试很快就
 * 会被当成噪音忽略掉，所以宁可自己铺一份最小 fixture。
 *
 * fixture **只包含读 profile 状态所需的最少内容**（一个 package.json 与一个
 * pnpm-workspace.yaml），不含 node_modules、不装任何插件：
 * 它测的是「判定逻辑」，不是「真装一次」—— 后者是隔离环境端到端实测的事。
 *
 * 已经存在的 profile **一个字节都不动**（开发机上那份是真的）。
 */
export function ensureTestProfile({ home = TEST_HOME, profile = 'web' } = {}) {
  const dir = path.join(home, 'profiles', profile);
  const manifest = path.join(dir, 'package.json');
  if (fs.existsSync(manifest)) return { dir, created: false };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    version: '0.0.0',
    dependencies: {},
    dsh: {
      profile: {
        // 内置 bundle 必须至少在位：闸门拿它区分「内置」与「用户装的」
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'live',
      },
    },
  }, null, 2)}\n`, 'utf8');

  // 这三个键是 profile 的不变量：少 autoInstallPeers 会让 pnpm 去 registry 装 peer，
  // 进而在 profile 里出现第二份 @deepseek-ai/* —— 那是「插件树加载失败」的经典成因。
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n'), 'utf8');

  return { dir, created: true };
}

/**
 * 动态 import 打包产物里的一层模块。
 * ★ Windows 上必须转成 file:// URL —— 直接传 `D:\...` 会被当成协议 `d:`，
 *   报 "Only URLs with a scheme in: file, data, and node are supported"。
 */
export function importBuilt(rel) {
  return import(pathToFileURL(path.join(BUILT, rel)).href);
}

const cases = [];
let currentFile = '';

export function suite(file) {
  currentFile = file;
}

export function test(name, fn) {
  cases.push({ file: currentFile, name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败');
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? '值不相等'}\n    实际: ${a}\n    期望: ${e}`);
}

export async function run() {
  let pass = 0;
  const failures = [];
  let lastFile = '';
  for (const c of cases) {
    if (c.file !== lastFile) {
      console.log(`\n  ${c.file}`);
      lastFile = c.file;
    }
    try {
      await c.fn();
      pass++;
      console.log(`    ✓ ${c.name}`);
    } catch (err) {
      failures.push({ ...c, err });
      console.log(`    ✗ ${c.name}`);
      console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
    }
  }
  console.log('');
  console.log(`  ${'-'.repeat(70)}`);
  if (failures.length === 0) {
    console.log(`  ✓ 全部通过：${pass} 项`);
    console.log('');
    return 0;
  }
  console.log(`  ✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  if (process.env.DPM_TEST_VERBOSE) {
    for (const f of failures) console.log(`\n  [${f.file}] ${f.name}\n${f.err.stack}`);
  }
  console.log('');
  return 1;
}
