/**
 * 极简测试框架 —— 不引第三方依赖（理由同插件本身：依赖越少越不容易坏）。
 *
 * 用法：
 *   import { test, eq, ok, deepEq } from './harness.mjs';
 *   test('名字', () => { ok(true); });
 *
 * run.mjs 先把所有 *.test.mjs 导入一遍（此时只是登记），再依次执行。
 */

export const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function ok(value, message) {
  if (!value) throw new Error(message || `期望为真，实际是 ${JSON.stringify(value)}`);
}

export function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || '结构不相等'}：\n  期望 ${b}\n  实际 ${a}`);
}

export function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || '未包含'}：在 ${JSON.stringify(String(haystack).slice(0, 400))} 里找不到 ${JSON.stringify(needle)}`);
  }
}

export function throws(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message || '期望抛错，但没有');
}
