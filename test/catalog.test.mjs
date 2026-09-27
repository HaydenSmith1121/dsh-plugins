/**
 * 服务器半：索引层（src/server/catalog.js）。
 *
 * 重点是**出参形状**：前端按 COLUMNS 这张表还原数据，列顺序错了界面就会串列，
 * 而这种错误在服务端看起来一切正常。所以这里把契约钉死。
 */

import { test, eq, ok, deepEq } from './harness.mjs';
import { COLUMNS, buildPayload, normalizeIndex } from '../src/server/catalog.js';

const sample = {
  schemaVersion: 2,
  generatedAt: '2026-09-27T00:00:00.000Z',
  counts: { total: 2 },
  sources: [],
  plugins: [
    {
      id: 'a/one', owner: 'a', name: 'one', url: 'https://github.com/a/one',
      description: 'x'.repeat(500), descriptionZh: '中文描述', author: 'a',
      stars: 1200, forks: 3, language: 'TypeScript',
      topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
      license: 'MIT', homepage: null, pushedAt: '2026-09-20T10:00:00.000Z',
      archived: true, sources: ['github-search'], firstSeenAt: null, lastSyncedAt: null,
    },
    {
      id: 'b/two', owner: 'b', name: 'two', url: 'https://github.com/b/two',
      description: null, descriptionZh: null, author: 'b',
      stars: null, forks: null, language: null, topics: [],
      license: null, homepage: null, pushedAt: null, archived: false,
      sources: [], firstSeenAt: null, lastSyncedAt: null,
    },
  ],
};

test('normalizeIndex：形状不对就返回 null，而不是半个文档', () => {
  eq(normalizeIndex(null), null);
  eq(normalizeIndex({}), null, '没有 plugins 数组');
  eq(normalizeIndex({ plugins: 'nope' }), null);
  ok(normalizeIndex({ plugins: [] }) !== null, '空数组是合法的');
  const filtered = normalizeIndex({ plugins: [null, { noId: 1 }, { id: 'a/b' }] });
  eq(filtered.plugins.length, 1, '没有 id 的记录会被丢掉');
});

test('COLUMNS 的顺序就是契约（改动 = 前后端同时串列）', () => {
  deepEq(COLUMNS, [
    'id', 'desc', 'descZh', 'stars', 'forks', 'lang', 'topics', 'pushedAt', 'license', 'archived', 'homepage',
  ]);
});

test('buildPayload：列式输出，行序与索引一致', () => {
  const p = buildPayload(sample, { loaded: { source: 'checkout', url: 'x' } });
  eq(p.total, 2);
  deepEq(p.cols, COLUMNS);
  deepEq(p.rows.map((r) => r[0]), ['a/one', 'b/two'], '顺序必须原样保留（排序只在采集端做一次）');
  eq(p.meta.source, 'checkout');
});

test('buildPayload：长字段被截断，topic 数量受限', () => {
  const p = buildPayload(sample, { loaded: { source: 'cache' } });
  const [one] = p.rows;
  ok(one[COLUMNS.indexOf('desc')].length <= 301, '描述要截断');
  eq(one[COLUMNS.indexOf('descZh')], '中文描述', '中文描述原样保留');
  eq(one[COLUMNS.indexOf('topics')].length, 6, 'topic 最多带 6 个');
  eq(one[COLUMNS.indexOf('pushedAt')], '2026-09-20', '推送时间只到日期');
  eq(one[COLUMNS.indexOf('archived')], 1, '归档标记用 0/1');
});

test('buildPayload：缺字段的记录不会渲染出 undefined', () => {
  const p = buildPayload(sample, { loaded: { source: 'cache' } });
  const two = p.rows[1];
  eq(two[COLUMNS.indexOf('desc')], null);
  eq(two[COLUMNS.indexOf('stars')], null);
  eq(two[COLUMNS.indexOf('archived')], 0);
  deepEq(two[COLUMNS.indexOf('topics')], []);
  ok(!JSON.stringify(two).includes('undefined'), 'payload 里不该出现 undefined');
});

test('buildPayload：空索引也能安全出参', () => {
  const p = buildPayload(null, { loaded: { source: 'bundled', error: '没网' } });
  eq(p.total, 0);
  deepEq(p.rows, []);
  eq(p.meta.error, '没网');
  eq(p.meta.source, 'bundled');
});
