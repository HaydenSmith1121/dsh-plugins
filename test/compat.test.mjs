/**
 * 跨版本适配层（src/server/compat.js）。
 *
 * ★ 这一层最重要的性质是「**永不拦截**」：它只回答「这个版本有没有被实测过」，
 *   不回答「能不能用」。下面的测试把这个态度钉住 —— 将来如果有人想在这里
 *   加一个「版本不在矩阵里就禁用功能」，这些测试会先红。
 */

import { test, eq, ok } from './harness.mjs';
import { compareVersions, matchRuntime, parseVersion, probeHost } from '../src/server/compat.js';

test('parseVersion：正常的、预发布的、带 build 的都能解析', () => {
  eq(parseVersion('0.1.7-rc.2').major, 0);
  eq(parseVersion('0.1.7-rc.2').minor, 1);
  eq(parseVersion('0.1.7-rc.2').patch, 7);
  eq(parseVersion('v1.2.3').major, 1);
  eq(parseVersion('1.2.3+build.5').patch, 3);
  eq(parseVersion('0.1'), null, '不足三段的不猜');
  eq(parseVersion(null), null);
});

test('compareVersions：预发布 < 正式版，数字标识符 < 字母标识符', () => {
  eq(compareVersions('0.1.7-rc.2', '0.1.7'), -1);
  eq(compareVersions('0.1.7-rc.2', '0.1.7-rc.10'), -1, 'rc.2 < rc.10（数字比较，不是字符串比较）');
  eq(compareVersions('0.1.7-rc.2', '0.1.6-alpha.1'), 1);
  eq(compareVersions('0.1.6-alpha.1', '0.1.6-alpha.1'), 0);
  eq(compareVersions('0.1.6-alpha.1', 'nonsense'), null);
});

const COMPAT = {
  runtimes: [
    { dshVersion: '0.1.7-rc.2', status: 'supported', verifiedAt: '2026-09-27' },
    { dshVersion: '0.1.6-alpha.1', status: 'supported', verifiedAt: '2026-09-17' },
    { dshVersion: '0.1.5-rc.1', status: 'unverified', verifiedAt: null },
  ],
};

test('matchRuntime：矩阵里有的版本直接命中', () => {
  const m = matchRuntime(COMPAT, '0.1.7-rc.2');
  eq(m.verified, true);
  eq(m.reason, 'listed');
  eq(m.entry.dshVersion, '0.1.7-rc.2');
});

test('matchRuntime：矩阵里没有的版本给出「最接近的实测结论」，但不算命中', () => {
  const sameSeries = matchRuntime(COMPAT, '0.1.7-rc.5');
  eq(sameSeries.verified, false);
  eq(sameSeries.reason, 'same-series');
  eq(sameSeries.nearest.dshVersion, '0.1.7-rc.2', '同一 minor 系列里最接近的那条');

  const unlisted = matchRuntime(COMPAT, '0.2.0');
  eq(unlisted.verified, false);
  eq(unlisted.reason, 'unlisted');
  eq(unlisted.nearest, null);
});

test('matchRuntime：探测不到版本也不抛错、不禁用', () => {
  const m = matchRuntime(COMPAT, null);
  eq(m.verified, false);
  eq(m.reason, 'unknown-version');
  eq(m.entry, null);
});

test('probeHost：拿不到的服务不抛错，如实报 false', () => {
  const empty = probeHost({});
  eq(empty.effect, false);
  eq(empty.webServer.present, false);
  eq(empty.webServer.register, false);

  const real = probeHost({
    effect() {},
    get(name) { return name === 'webServer' ? { register() {} } : undefined; },
  });
  eq(real.effect, true);
  eq(real.webServer.present, true);
  eq(real.webServer.register, true);
  eq(real.webServer.registerFallback, false, '0.1.6 没有的能力要如实报 false');
});

test('probeHost：服务抛错时不影响其它探测项', () => {
  const caps = probeHost({
    effect() {},
    get() { throw new Error('boom'); },
  });
  eq(caps.effect, true);
  eq(caps.webServer.present, false);
  ok(Object.keys(caps.services).length > 0, '服务表照常给出（全 false）');
});
