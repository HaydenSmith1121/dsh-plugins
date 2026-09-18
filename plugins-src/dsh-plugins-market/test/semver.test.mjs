/**
 * semver 子集的行为测试。
 *
 * 这些用例不是随便挑的 —— 它们全部来自本仓库 compatibility.json 里已经写死的
 * 实测结论。prerelease 的匹配规则搞错，闸门就会把「能装的」拦掉、或把
 * 「装了会让整棵树挂掉的」放过去，所以必须钉死。
 */

import { suite, test, assert, eq } from './harness.mjs';
import { satisfies, compareVersions, parseVersion } from '../src/server/util.js';

suite('semver');

test('解析带 prerelease 的版本', () => {
  const v = parseVersion('0.1.6-alpha.1');
  // prerelease 标识符保持字符串形式（比较时再按「纯数字 vs 字母」判定大小）
  eq([v.major, v.minor, v.patch, v.pre], [0, 1, 6, ['alpha', '1']]);
  assert(parseVersion('not-a-version') === null);
  assert(parseVersion('1.2') === null, '缺 patch 段应视为不可解析');
});

test('比较：预发布 < 正式版', () => {
  eq(compareVersions('0.1.6-alpha.1', '0.1.6'), -1);
  eq(compareVersions('0.1.6', '0.1.6-alpha.1'), 1);
  eq(compareVersions('0.1.6-alpha.1', '0.1.6-alpha.1'), 0);
  eq(compareVersions('0.1.6-alpha.2', '0.1.6-alpha.1'), 1);
  eq(compareVersions('0.1.6-alpha.1', '0.1.6-beta.1'), -1);
  eq(compareVersions('0.1.6-rc.1', '0.1.5'), 1);
});

test('精确 pin：完全相等才通过', () => {
  eq(satisfies('0.1.6-alpha.1', '0.1.6-alpha.1'), true);
  eq(satisfies('0.1.5-rc.1', '0.1.6-alpha.1'), false);
});

test('★ dsh-workbuddy-connect 的 ^0.1.5-rc.1 不包含 0.1.6-alpha.1', () => {
  // compatibility.json 的 peerNote 结论：预发布只有在同元组比较器里带 prerelease 才算匹配，
  // 而上界是裸 0.2.0 —— 所以这里必须是 false（这正是它只算「警告」而不是「致命」的原因）
  eq(satisfies('0.1.6-alpha.1', '^0.1.5-rc.1'), false);
  eq(satisfies('0.1.5-rc.1', '^0.1.5-rc.1'), true);
  eq(satisfies('0.1.5-rc.2', '^0.1.5-rc.1'), true);
});

test('★ dsh-connect-trae 的 >=0.1.5-0 <0.2.0-0 按 npm 语义**不**包含 0.1.6-alpha.1', () => {
  // 这条结论用官方 semver 实测核对过：
  //   semver.satisfies('0.1.6-alpha.1', '>=0.1.5-0 <0.2.0-0') === false
  // 预发布版本只有在**同一个 [major,minor,patch] 元组**内存在带预发布的比较器时才算匹配，
  // 而两个比较器的元组分别是 (0,1,5) 和 (0,2,0)，都不是 (0,1,6)。
  //
  // ⚠️ compatibility.json 里 dsh-connect-trae 的 peerNote 写的是「0.1.6-alpha.1 满足该范围」，
  //    那句话是错的（它还说「此前仓库文档写成不在范围里，是错的」—— 其实先前那份才是对的）。
  //    功能结论不受影响：profile 设了 autoInstallPeers: false，peer 不参与安装，实测加载正常。
  eq(satisfies('0.1.6-alpha.1', '>=0.1.5-0 <0.2.0-0'), false);
  eq(satisfies('0.1.5-rc.1', '>=0.1.5-0 <0.2.0-0'), true);
  eq(satisfies('0.2.0', '>=0.1.5-0 <0.2.0-0'), false);
  // 上界带预发布，所以 0.2.0-0 之前的预发布仍可满足「上界」这一侧
  eq(satisfies('0.1.9-alpha.1', '>=0.1.5-0 <0.2.0-0'), false, '元组不同，依然不匹配');
});

test('★ 精确 pin 与范围声明的分档（决定要不要给用户提一句）', () => {
  /*
   * 这条是上面那条结论的**产品后果**：范围不匹配不能当成「这个包装不上」——
   * 仓库自带的 dsh-connect-trae 就是范围声明，把它判成不能装是更严重的错误。
   *
   * ★ 0.6.0 起这个分档不再用于「拦不拦」，只用于「提不提示」：
   *   `installNotes()` 只对**精确 pin 且高于本机**的情况给一句提示，
   *   范围声明一律不提（semver 上本来就允许漂移）。
   *   具体断言在 spec.test.mjs 的「装前提示」那一组。
   */
  const exactPinMismatch = '0.1.5-rc.1';
  const rangeMismatch = '>=0.1.5-0 <0.2.0-0';
  eq(satisfies('0.1.6-alpha.1', exactPinMismatch), false, '精确 pin：不匹配');
  eq(satisfies('0.1.6-alpha.1', rangeMismatch), false, '范围：也不匹配');
  assert(
    /^\d+\.\d+\.\d+/.test(exactPinMismatch) && !/[<>=^~*|\s]/.test(exactPinMismatch),
    '精确 pin 的判别方式（无范围运算符）—— spec.js 的 peerPins() 用的正是这条判据',
  );
});

test('^ 与 ~ 的上界', () => {
  eq(satisfies('1.2.3', '^1.2.3'), true);
  eq(satisfies('2.0.0', '^1.2.3'), false);
  eq(satisfies('0.2.9', '^0.2.3'), true);
  eq(satisfies('0.3.0', '^0.2.3'), false);
  eq(satisfies('0.1.7', '^0.1.6'), true);
  eq(satisfies('1.2.9', '~1.2.3'), true);
  eq(satisfies('1.3.0', '~1.2.3'), false);
});

test('OR 与 hyphen range', () => {
  eq(satisfies('1.5.0', '^1.0.0 || ^2.0.0'), true);
  eq(satisfies('2.5.0', '^1.0.0 || ^2.0.0'), true);
  eq(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
  eq(satisfies('1.5.0', '1.2.3 - 2.0.0'), true);
  eq(satisfies('2.5.0', '1.2.3 - 2.0.0'), false);
});

test('★ engines.node "^22.19.0 || >=24.0.0" 排除 23.x', () => {
  const range = '^22.19.0 || >=24.0.0';
  eq(satisfies('22.19.0', range), true);
  eq(satisfies('22.22.2', range), true);
  eq(satisfies('24.14.0', range), true);
  eq(satisfies('23.5.0', range), false, '23.x 必须不满足 —— 仓库文档只写了「Node ≥ 22.19」，漏了这条');
  eq(satisfies('22.18.0', range), false);
});

test('无法解析的 range 返回 null，而不是 false', () => {
  // 这一点很重要：调用方必须把 null 当作「无法判定」而不是「不满足」，
  // 否则一个手写错的 range 会被当成致命不兼容直接拦掉
  eq(satisfies('1.0.0', 'garbage-range'), null);
  eq(satisfies('not-a-version', '^1.0.0'), null);
  eq(satisfies('1.0.0', ''), null);
});
