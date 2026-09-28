/**
 * 客户端半的**纯逻辑**测试。
 *
 * 做法：在一个沙箱里把整个 bundle 物化出来（给它一个假的 window 与一个最小的
 * react 桩），再直接调用内部函数。
 *
 * ★ 为什么必须这么做：这里曾经有一个真实 bug —— 搜索命中 12 条，列表却是空的。
 *   原因是把「行在完整列表里的下标」当成了「它在当前结果里的位置」，
 *   于是 12 条结果被绝对定位到 5432 × 96 ≈ 52 万像素处。
 *   计数、状态、控制台全都没有任何异常，只有人眼看界面才发现得了。
 *   下面那条断言（渲染项必须落在容器高度之内）就是为它写的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, ok, deepEq } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'src', 'client', 'app.js');

/** 最小的 react 桩：factory 在模块作用域只会读这些键 */
const reactStub = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  memo: (fn) => fn,
  Component: function Component() {},
};

function materialize() {
  const code = fs.readFileSync(CLIENT, 'utf8');
  let definition = null;
  const fakeWindow = { __ModuleLoader__: { load: (def) => { definition = def; } } };
  // document 传 undefined：bundle 里的样式注入有 typeof document 守卫，会安全跳过
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', code)(fakeWindow, undefined, undefined);
  ok(definition, 'bundle 必须自注册到 window.__ModuleLoader__');
  const mod = definition.factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`客户端半不该 require ${id}`);
  });
  return { definition, mod };
}

const { definition, mod } = materialize();
const I = mod.__internals;

test('刷新按钮：离线兜底不能提示已是最新数据', async () => {
  const code = fs.readFileSync(CLIENT, 'utf8').replace('exports.__internals = {', 'exports.__internals = { Panel: Panel,');
  let definition;
  const nodes = [], updates = [];
  const react = { ...reactStub,
    createElement: (type, props, ...children) => { const node = { type, props, children }; nodes.push(node); return node; },
    useState: (initial) => [initial, value => updates.push(value)],
    useRef: initial => ({ current: initial }),
  };
  new Function('window', 'document', 'navigator', 'fetch', 'setTimeout', code)(
    { __ModuleLoader__: { load: def => { definition = def; } } }, undefined, undefined,
    async () => ({ json: async () => ({ ok: true, result: { changed: false, meta: { error: '拉取索引失败（已用包内快照）' } } }) }),
    () => 0,
  );
  const module = definition.factory(() => react);
  module.__internals.Panel({});
  const sorting = nodes.find(node => node.type === 'select' && node.props?.['aria-label'] === '搜索结果排序');
  ok(sorting, '搜索框旁必须有可访问的排序下拉框');
  eq(sorting.props.value, 'relevance');
  deepEq(sorting.children.map(option => option.props.value), ['relevance', 'stars-desc', 'stars-asc']);
  sorting.props.onChange({ target: { value: 'stars-desc' } });
  ok(updates.includes('stars-desc'), '切换下拉框必须更新排序状态');
  const refresh = nodes.find(node => node.props?.title === '去仓库确认一次有没有更新（没更新时几乎不消耗流量）');
  ok(refresh, '面板必须有刷新按钮');
  refresh.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  ok(updates.includes('拉取索引失败（已用包内快照）'));
  ok(!updates.includes('已是最新数据'));
});

test('沙箱物化：id 正确、apply/inject 齐全、内部出口可用', () => {
  eq(definition.id, 'dsh-plugins-market');
  eq(typeof mod.apply, 'function');
  deepEq(mod.inject, ['slots']);
  ok(I && typeof I.searchRows === 'function' && typeof I.windowOf === 'function');
});

// ── 列式数据的构造：与 src/server/catalog.js 的 COLUMNS 对齐 ──
const cols = ['id', 'desc', 'descZh', 'stars', 'forks', 'lang', 'topics', 'pushedAt', 'license', 'archived', 'homepage'];
const C = I.colIndex(cols);
const row = (id, desc, stars, extra = {}) => {
  const r = new Array(cols.length).fill(null);
  r[C.id] = id;
  r[C.desc] = desc;
  r[C.stars] = stars;
  r[C.topics] = extra.topics ?? [];
  r[C.lang] = extra.lang ?? null;
  return r;
};
const rows = [
  row('HaydenSmith1121/dsh-usage-stats', 'Token usage statistics for DeepSeek Harness', 120, { topics: ['dsh-plugin'] }),
  row('HaydenSmith1121/dsh-opencode-go-plus', 'OpenCode Go provider plugin', 88),
  row('someone/dsh-memory', 'Long term memory for dsh sessions', 900, { topics: ['dsh-plugin', 'memory'] }),
  row('other/hayden-tools', null, 5),
  row('third/unrelated', 'nothing to see', 1),
];

test('searchRows：多词是 AND，不是 OR', () => {
  const out = [];
  I.searchRows(rows, C, 'hayden dsh', out);
  // 三行含 hayden，但只有两行同时含 dsh
  eq(out.length, 2);
  const ids = out.map((i) => rows[i][C.id]).sort();
  deepEq(ids, ['HaydenSmith1121/dsh-opencode-go-plus', 'HaydenSmith1121/dsh-usage-stats']);

  const none = [];
  I.searchRows(rows, C, 'hayden 不存在这个词', none);
  eq(none.length, 0);
});

test('searchRows：描述为 null 的行不会让搜索崩掉', () => {
  const out = [];
  I.searchRows(rows, C, 'hayden', out);
  eq(out.length, 3, 'other/hayden-tools 的描述是 null，但仍应被仓库名命中');
});

test('searchRows：命中项按相关度排序，且返回的是行下标', () => {
  const out = [];
  I.searchRows(rows, C, 'memory', out);
  eq(out.length, 1);
  eq(out[0], 2, '返回的必须是 rows 里的下标');
  eq(rows[out[0]][C.id], 'someone/dsh-memory');

  const byName = [];
  I.searchRows(rows, C, 'dsh-memory', byName);
  eq(byName[0], 2, '精确的仓库名匹配排最前');
});

test('searchRows：空查询返回 null（表示「不搜索，原样显示」）', () => {
  const out = [];
  eq(I.searchRows(rows, C, '   ', out), null);
  eq(out.length, 0);
});

test('searchRows：Star 排序不改变匹配集合，同 Star 保留相关度顺序', () => {
  const sample = [row('o/memory', 'memory', 2), row('o/popular', 'memory', 100), row('o/unknown', 'memory', null), row('o/another', 'memory', 2), row('o/unrelated', 'other', 999)];
  const before = JSON.stringify(sample), out = [];
  I.searchRows(sample, C, 'memory', out, 'stars-desc');
  deepEq(out, [1, 0, 3, 2]);
  I.searchRows(sample, C, 'memory', out, 'stars-asc');
  deepEq(out, [2, 0, 3, 1]);
  I.searchRows(sample, C, 'memory', out, 'relevance');
  eq(out[0], 0);
  eq(JSON.stringify(sample), before, '不得改动原始目录');
});

test('searchRows：名称缩写、漏字、错字和相邻字母颠倒均可模糊匹配', () => {
  const sample = [row('o/dsh-memory', '长期记忆插件', 5), row('o/unrelated', 'other', 500)];
  for (const query of ['dshmem', 'memry', 'memori', 'memroy', '记忆']) {
    const out = [];
    I.searchRows(sample, C, query, out);
    deepEq(out, [0], query);
  }
  const out = [];
  I.searchRows(sample, C, 'memroy 不存在', out);
  eq(out.length, 0, '模糊搜索仍要求每个词都匹配');
});

test('searchRows：精确匹配优先于高 Star 的模糊匹配', () => {
  const sample = [row('o/memroy', 'tool', 1), row('o/memory', 'tool', 100)];
  const out = [];
  I.searchRows(sample, C, 'memroy', out);
  deepEq(out, [0, 1]);
  I.searchRows(sample, C, 'memroy', out, 'stars-desc');
  deepEq(out, [1, 0]);
});

test('searchRows：模糊名称匹配优先于描述匹配', () => {
  const sample = [row('o/popular', 'memory manager', 999), row('o/memory', 'tool', 1)];
  const out = [];
  I.searchRows(sample, C, 'memroy', out);
  deepEq(out, [1, 0]);
});

test('searchRows：先对全部匹配项排序再截断，空搜索可按 Star 浏览全目录', () => {
  const many = Array.from({ length: 3500 }, (_, i) => row(`o/sort${i}`, 'sortable', i));
  const out = [];
  const result = I.searchRows(many, C, 'sortable', out, 'stars-desc');
  eq(result.total, 3500);
  eq(out.length, 3000);
  eq(out[0], 3499);
  I.searchRows(many, C, '', out, 'stars-asc');
  eq(out.length, 3500);
  eq(out[0], 0);
});

test('searchRows：命中数超过上限时如实标记 capped', () => {
  const many = [];
  for (let i = 0; i < 3500; i += 1) many.push(row(`o/r${i}`, 'dsh plugin', i));
  const out = [];
  const r = I.searchRows(many, C, 'dsh', out);
  eq(r.total, 3500, 'total 报的是真实命中数');
  eq(r.capped, true);
  eq(out.length, 3000, '渲染上限是 3000');
});

test('windowOf：不搜索时位置与行下标相同', () => {
  const w = I.windowOf(100, 0, 300, null);
  ok(w.length > 0);
  ok(w.every((x) => x.pos === x.rowIndex));
  eq(w[0].pos, 0);
});

test('★ windowOf：搜索时「位置」与「行下标」必须分开（那个空列表 bug 的回归测试）', () => {
  // 命中的 12 条来自完整列表的很后面 —— 正是当时的现场
  const order = [5432, 120, 3000, 4111, 77, 900, 2500, 12, 4800, 600, 3300, 1500];
  const total = order.length;
  const w = I.windowOf(total, 0, 640, order);

  eq(w.length, 12, '12 条结果全部在视口内');
  deepEq(w.map((x) => x.pos), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '位置必须是 0..11');
  eq(w[0].rowIndex, 5432, '但取的是完整列表里第 5432 行');

  // ★ 核心断言：任何一条被渲染的行，它的位置都必须落在容器高度之内。
  //   当年的 bug 就是 rowIndex 被当成位置用，于是 5432 × 96 远远超出了 12 × 96。
  const containerHeight = total * I.ROW_H;
  for (const item of w) {
    ok(item.pos * I.ROW_H < containerHeight,
      `${item.pos} × ${I.ROW_H} 超出了容器高度 ${containerHeight} —— 行会被画到看不见的地方`);
  }
});

test('windowOf：滚动位置换算正确，且带上下 overscan', () => {
  const w = I.windowOf(1000, 960, 480, null);   // 滚到第 10 行
  ok(w[0].pos < 10, '上方要留 overscan');
  ok(w[w.length - 1].pos >= 15, '下方要留 overscan');
  ok(w.every((x) => x.pos >= 0 && x.pos < 1000), '不能越界');
  eq(I.windowOf(0, 0, 480, null).length, 0);
});

test('windowOf：滚到底部时不会越界（数学上必须永远小于 total）', () => {
  for (const scrollTop of [0, 1, 95, 96, 10_000, 99_999]) {
    const w = I.windowOf(20, scrollTop, 480, null);
    ok(w.every((x) => x.pos >= 0 && x.pos < 20), `scrollTop=${scrollTop} 时越界了`);
    ok(w.every((x) => x.rowIndex < 20));
  }
});

test('descOf / installSpec / shortName：与面板展示、复制的内容一致', () => {
  const zh = row('a/b', 'english', 1);
  zh[C.descZh] = '中文';
  eq(I.descOf(zh, C), '中文', '有中文描述时优先显示中文');
  eq(I.descOf(rows[3], C), null, '两样都没有时返回 null（界面自己决定怎么显示）');
  eq(I.installSpec(rows[0], C), 'github:HaydenSmith1121/dsh-usage-stats', '复制出去的必须是官方客户端认识的地址');
  eq(I.shortName(rows[0], C), 'dsh-usage-stats');
});
