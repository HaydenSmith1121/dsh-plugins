/**
 * 极简测试脚手架 —— 不引第三方依赖（与插件的「零依赖」原则一致）。
 *
 * 测试一律针对**打包产物**（`.build/package/`）而不是源码树：
 * 源码里服务器半在 `src/server/`、打包后平铺到 `lib/`，相对深度不同，
 * 只测源码会漏掉一整类「能跑但全错」的问题（cwd/资源解析错位）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 打包产物目录（由 build.mjs 生成） */
export const PKG_ROOT = path.resolve(HERE, '..');
export const BUILT = path.join(PKG_ROOT, '.build', 'package');
export const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

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
