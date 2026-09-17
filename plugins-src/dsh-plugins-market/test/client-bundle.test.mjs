/**
 * 客户端半（浏览器 bundle）的形状测试。
 *
 * 为什么这个测试值得单独写：客户端半的错误**在 CLI 侧完全查不出来**。
 * 仓库里已经有过一次真实事故（dsh-opencode-go-plus 0.2.0）：服务器半装配
 * 一切正常、四步校验全绿，但客户端半的注册 id 写错，结果浏览器白屏
 * 「Failed to load plugins」。这类错误只有把 bundle 真正「执行一遍」才发现得了。
 *
 * 这个测试用一个 stub 的 window.__ModuleLoader__ + React 把 bundle 跑一遍，
 * 断言：
 *   - 它在**顶层同步**注册了自己（异步注册会撞 "loaded without registering"）
 *   - 注册 id 严格等于包名（否则 boot 图对不上）
 *   - 只 require 了基线模块表里白名单内的东西（其它都要声明 external）
 *   - apply() 注册的 sidebar.panellist id 与 main key **同名**
 *     （不同名时 layout.selectPanel 会抛错，面板点不开）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, test, assert, eq } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
// 测的是**打包后的产物**（暂存目录），不是源码树 —— 见 layout.test.mjs 顶部说明
const BUNDLE = path.join(PKG, '.build', 'package', 'lib', 'client.js');
const PKG_NAME = 'dsh-plugins-market';

/** 基线模块表（shell 里 tw() 提供的那些，可以不声明直接 require） */
const BASELINE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/** 覆盖官方 slot 键的名单（本插件只允许用这两个） */
const REQUIRED_SLOTS = ['sidebar.panellist', 'main'];

function makeReactStub() {
  const h = (type, props, ...children) => ({
    $$typeof: Symbol.for('react.element'),
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? (props?.children ?? null) : children.length === 1 ? children[0] : children },
    key: props?.key ?? null,
  });
  const state = new Map();
  let cursor = 0;
  // 错误边界会用 React.Component 的原型链（函数组件无法实现 componentDidCatch），
  // 所以 stub 里必须有 Component，否则一执行到错误边界就抛 "reading 'prototype'"。
  class Component {
    constructor(props) { this.props = props ?? {}; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; }
    render() { return null; }
  }
  return {
    createElement: h,
    Component,
    PureComponent: Component,
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      const i = cursor++;
      if (!state.has(i)) state.set(i, typeof initial === 'function' ? initial() : initial);
      return [state.get(i), (v) => state.set(i, typeof v === 'function' ? v(state.get(i)) : v)];
    },
    useEffect() { cursor++; return undefined; },
    useLayoutEffect() { cursor++; return undefined; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useRef(v) { cursor++; return { current: v }; },
    useSyncExternalStore(_sub, get) { cursor++; return get(); },
    createContext: (v) => ({ Provider: null, Consumer: null, _currentValue: v }),
    memo: (c) => c,
    forwardRef: (c) => c,
    __resetHooks() { cursor = 0; },
  };
}

/** 把 bundle 当经典脚本执行一遍，返回它注册的工厂 */
function evaluateBundle({ fetchImpl } = {}) {
  const registrations = [];
  const requiredSpecs = new Set();
  const windowStub = {
    __ModuleLoader__: {
      mode: 'queue',
      load(reg) { registrations.push(reg); },
    },
  };
  const styleTags = [];
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute() {}, textContent: '' }),
    head: { appendChild: (el) => styleTags.push(el) },
  };
  const fetchStub = fetchImpl ?? (async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }));

  // 经典脚本：用 new Function 在给定作用域里求值（bundle 自己会去拿 window）
  const code = fs.readFileSync(BUNDLE, 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'fetch', 'globalThis', code);
  fn(windowStub, documentStub, fetchStub, { window: windowStub, document: documentStub, fetch: fetchStub });

  const reactStub = makeReactStub();
  const requireStub = (spec) => {
    requiredSpecs.add(spec);
    if (spec === 'react') return reactStub;
    throw new Error(`测试环境没有提供模块：${spec}`);
  };

  return { registrations, requiredSpecs, reactStub, requireStub, styleTags, windowStub };
}

/** 造一个最小的 ctx.slots / ctx.get，记录 apply() 到底注册了什么 */
function fakeCtx({ layout = { selectPanel() {} } } = {}) {
  const registered = [];
  const injected = [];
  const ctx = {
    get: (name) => (name === 'layout' ? layout : undefined),
    effect: (fn, _label) => { try { return fn(); } catch { return () => {}; } },
    slots: {
      inject(key, cb) {
        injected.push(key);
        const dispose = cb();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
      entries: () => registered.map((r) => ({ options: r.options })),
      entriesOfSlot: () => registered.map((r) => ({ options: r.options })),
      subscribe: () => () => {},
      getVersion: () => 0,
      spec: () => ({ kind: 'list', scope: 'root' }),
      snapshot: () => ({}),
      renderSlot: () => null,
    },
  };
  return { ctx, registered, injected };
}

suite('client bundle');

test('产物存在且是经典脚本（不含 import/export）', () => {
  assert(fs.existsSync(BUNDLE), `缺少产物 ${BUNDLE} —— 先跑 node build.mjs`);
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/^\s*import\s/m.test(stripped), '经典脚本里出现 import 会直接 SyntaxError');
  assert(!/^\s*export\s/m.test(stripped), '经典脚本里出现 export 会直接 SyntaxError');
});

test('顶层同步注册，且注册 id 严格等于包名', () => {
  const { registrations } = evaluateBundle();
  eq(registrations.length, 1, '应当恰好注册一次（多次注册会撞 duplicate factory registration）');
  eq(registrations[0].id, PKG_NAME, 'load() 的 id 必须等于包名 —— 否则报 "bundle loaded without registering"');
  eq(typeof registrations[0].factory, 'function', 'factory 必须是函数');
});

test('工厂返回 { apply, inject }，且 inject 只含必然存在的服务', () => {
  const { registrations, requireStub } = evaluateBundle();
  const mod = registrations[0].factory(requireStub);
  eq(typeof mod.apply, 'function', '必须导出 apply');
  assert(Array.isArray(mod.inject), '必须导出 inject 数组');
  // 客户端 inject 里多写一个不存在的服务 → 整个页面 boot 失败（web boot: N entries did not activate）。
  // slots 由 ui-renderer 提供、layout 由 ui-layout 提供，这两个在 web roster 里必然存在。
  for (const s of mod.inject) {
    assert(['slots', 'layout'].includes(s), `inject 里出现了不该声明的服务 "${s}" —— 一旦它没到位，整页功能都会加载失败`);
  }
  assert(mod.inject.includes('slots'), 'slots 是必需的');
});

test('只 require 基线模块表里的东西（其余必须声明 dsh.client.external）', () => {
  const { registrations, requireStub, requiredSpecs } = evaluateBundle();
  registrations[0].factory(requireStub);
  assert(requiredSpecs.size > 0, '工厂应当 require 了 react');
  for (const spec of requiredSpecs) {
    assert(BASELINE.has(spec), `require("${spec}") 不在基线模块表里 —— 需要写进 package.json 的 dsh.client.external，否则浏览器报 "missed the module table"`);
  }
});

test('★ sidebar.panellist 的 id 与 main 的 key 同名（否则面板点不开）', () => {
  const { registrations, requireStub } = evaluateBundle();
  const mod = registrations[0].factory(requireStub);
  const { ctx, registered, injected } = fakeCtx();
  mod.apply(ctx);

  const panelist = registered.find((r) => r.options?.name === 'sidebar.panellist');
  const panel = registered.find((r) => r.options?.name === 'main');
  assert(panelist, '没有注册 sidebar.panellist —— 左侧导航栏不会有入口');
  assert(panel, '没有注册 main —— 面板本体不存在');

  eq(panelist.options.id, PKG_NAME, 'sidebar.panellist 需要 options.id');
  eq(panel.options.key, PKG_NAME, 'main 需要 options.key');
  eq(panelist.options.id, panel.options.key, '★ 两者必须同名：sidebar 点击会调 layout.selectPanel(id)，对不上会抛错');
  eq(typeof panelist.component, 'function', '入口图标应当是组件');
  eq(typeof panel.component, 'function', '面板应当是组件');

  // 必须走 slots.inject（直接 register 会在 slot 尚未声明时抛 "is not declared"）
  for (const key of registered.map((r) => r.options.name)) {
    assert(injected.includes(key), `slot "${key}" 必须通过 ctx.slots.inject 注册`);
  }
});

test('入口图标组件能接受 owner 传入的 { size, active } 并渲染', () => {
  const { registrations, requireStub } = evaluateBundle();
  const mod = registrations[0].factory(requireStub);
  const { ctx, registered } = fakeCtx();
  mod.apply(ctx);
  const icon = registered.find((r) => r.options?.name === 'sidebar.panellist').component;
  const out = icon({ size: 18, active: false });
  assert(out, '图标组件应返回一个元素');
  const out2 = icon({ size: 16, active: true });
  assert(out2, '选中态也应能渲染');
});

test('面板组件首屏能渲染（不抛异常）', () => {
  const { registrations, requireStub, reactStub } = evaluateBundle();
  const mod = registrations[0].factory(requireStub);
  const { ctx, registered } = fakeCtx();
  mod.apply(ctx);
  const Panel = registered.find((r) => r.options?.name === 'main').component;
  reactStub.__resetHooks();
  // 面板会被 owner 用标准 props + ownerProps 调用；尽量给全，避免因缺 prop 误报
  const props = {
    onClose: () => {},
    useResource: () => ({ data: null, loading: false }),
    useSessions: () => ({ sessions: [] }),
    usePanelInfo: (sel) => (typeof sel === 'function' ? sel({ activePanelId: PKG_NAME }) : { activePanelId: PKG_NAME }),
    useWorkspaces: () => ({ workspaces: [] }),
    useSessionPendingInteraction: () => null,
  };
  const out = Panel(props);
  assert(out, '面板组件应返回一个元素（首屏 = 加载中）');
});

test('面板内不会在模块求值阶段发请求（请求只应发生在挂载后）', () => {
  let calls = 0;
  const { registrations, requireStub } = evaluateBundle({
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ ok: true, result: {} }) }; },
  });
  registrations[0].factory(requireStub);
  eq(calls, 0, '工厂执行（= 模块被 materialize）时不应该发任何网络请求');
});

test('样式标签按约定打了 data-plugin / data-plugin-css 标记', () => {
  const { registrations, requireStub, styleTags } = evaluateBundle();
  registrations[0].factory(requireStub);
  assert(styleTags.length >= 1, '应当注入至少一个 <style>');
  const tag = styleTags[0];
  eq(tag.dataset.plugin, PKG_NAME, 'data-plugin 必须是包名 —— HMR 靠它回收样式');
  assert(tag.dataset.pluginCss, 'data-plugin-css 应当是稳定的样式 id');
});

test('★ 搜索行是固定的（滚动结果时不会跟着滚走）', () => {
  const { registrations, requireStub, styleTags } = evaluateBundle();
  registrations[0].factory(requireStub);
  const css = styleTags[0].textContent;

  // CSS 规则本身
  assert(/\.dpm-toolbar-sticky\s*\{[^}]*position\s*:\s*sticky/.test(css), '搜索行必须有 position:sticky');
  assert(/\.dpm-toolbar-sticky\s*\{[^}]*\btop\s*:\s*-14px/.test(css), 'top 必须抵消 .dpm-body 的 14px 上内边距，否则会留一条缝');
  assert(/\.dpm-toolbar-sticky\s*\{[^}]*background\s*:/.test(css), '必须有底色，否则下面滚过去的卡片会透出来');

  // 深色模式必须覆盖底色，否则固定行会是一条白条
  const dark = /@media\s*\(prefers-color-scheme:dark\)\{([\s\S]*)\}\s*$/.exec(css);
  assert(dark, '应当有暗色模式媒体查询');
  assert(/\.dpm-toolbar-sticky\s*\{[^}]*background\s*:/.test(dark[1]), '暗色模式下必须覆盖固定行的底色');

  // 搜索框宽度上限
  assert(/\.dpm-input\s*\{[^}]*max-width\s*:/.test(css), '搜索框应当有宽度上限，窗口很宽时不该无限拉伸');

  // 组件里真的用上了这个类
  const { ctx, registered } = fakeCtx();
  const src = fs.readFileSync(BUNDLE, 'utf8');
  assert(/dpm-toolbar-sticky/.test(src), '客户端源码里应当引用了 dpm-toolbar-sticky');
  assert(/"dpm-toolbar dpm-toolbar-sticky"/.test(src), '目录页的搜索行应当同时带上这两个类');
});
