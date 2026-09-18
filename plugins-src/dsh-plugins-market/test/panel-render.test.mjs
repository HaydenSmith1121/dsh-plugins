/**
 * 客户端半的**渲染形状**测试 —— 把 Panel 渲染出的元素树真的走一遍。
 *
 * 为什么补这一组：
 *
 * 仓库里已经有过一次真实事故 —— 服务端一切正常、四步校验全绿，
 * 但客户端半出错，结果浏览器**白屏**，CLI 侧完全查不出来。
 * 这次改动动的正是界面主体（页签、按钮置灰、收藏、层级标签的移除），
 * 而「点开插件市场是白屏」是这类改动最典型的翻车方式。
 *
 * 这里做的事情很朴素：用 stub 的 React 把 Panel 渲染一次，然后
 * **遍历整棵元素树**，断言：
 *   - 它真的渲染出了内容（不是 null / 空树）
 *   - 「已是最新」的插件，它的安装按钮是 disabled 的
 *   - 「可升级」的插件，按钮文案是「更新到 x.y.z」且可点
 *   - 收藏按钮存在，且状态跟着 entry 走
 *   - 三个目录页签已经合并成一个
 *
 * 这不是端到端渲染（没有 react-dom），但足以钉住上面每一条。
 */

import fs from 'node:fs';
import path from 'node:path';
import { suite, test, assert, eq } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PKG = path.resolve(HERE, '..');
const BUNDLE = path.join(PKG, '.build', 'package', 'lib', 'client.js');
const PKG_NAME = 'dsh-plugins-market';

/** 与 client-bundle.test.mjs 同款的 React stub（这里只需要能建树 + 存 hook 状态） */
/**
 * 极简 React hook stub。
 *
 * ★ 状态为什么用「调用序号」而不是别的：React 本身就是按 hook 调用顺序
 *   对号入座的。但这里有个陷阱 —— 我的两趟渲染之间**组件树形状可能不同**
 *   （第一趟 status/list 还是 null，走的是「正在读取状态」分支，
 *   渲染出的卡片数量为 0；第二趟数据到了才渲染出卡片）。
 *   卡片内部也有 hook，所以第二趟的 hook 总数比第一趟多。
 *
 *   这正好模拟真实的 React：只要顶部那批组件的调用顺序保持一致，
 *   序号就是稳定的。Panel 自己的 state 都在卡片之前声明，
 *   所以第二趟能正确读到第一趟写进去的 status / list。
 */
function makeReactStub() {
  const h = (type, props, ...children) => ({
    $$typeof: Symbol.for('react.element'),
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? (props?.children ?? null) : children.length === 1 ? children[0] : children,
    },
    key: props?.key ?? null,
  });
  const state = new Map();
  const effects = [];
  let cursor = 0;
  /*
   * ★ Component 必须是**可当函数调用**的。
   *
   * bundle 里的错误边界是 ES5 写法：
   *     function Catcher(props){ react.Component.call(this, props); ... }
   *     Catcher.prototype = Object.create(react.Component.prototype)
   * 如果 stub 用 `class Component {}`，那句 `Component.call(this, props)` 会抛
   * "Class constructor Component cannot be invoked without 'new'" ——
   * 而这个类包在整棵树最外层，于是每个用例都一起打挂。
   * 用普通函数（可 new 也可 call）就能两边都兼容。
   */
  function Component(props) {
    this.props = props ?? {};
    this.state = {};
  }
  Component.prototype.setState = function (next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
  };
  Component.prototype.render = function () { return null; };
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
    /*
     * ★ useEffect 必须**真的执行**，否则面板永远停在「正在读取状态…」：
     *   列表数据是在 effect 里发请求加载的，不跑 effect 就一条都渲染不出来，
     *   所有针对卡片的断言都会落空（而面板本身"渲染成功"，看起来像没问题）。
     *   这里同步调用一次并记录清理函数，由测试在渲染后 await 一拍。
     */
    useEffect(fn) { cursor++; effects.push(fn); return undefined; },
    useLayoutEffect(fn) { cursor++; effects.push(fn); return undefined; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useRef(v) { cursor++; return { current: v }; },
    useSyncExternalStore(_s, get) { cursor++; return get(); },
    createContext: (v) => ({ Provider: null, Consumer: null, _currentValue: v }),
    memo: (c) => c,
    forwardRef: (c) => c,
    __resetHooks() { cursor = 0; effects.length = 0; },
    __effects: effects,
    /**
     * 只归零 hook 游标，**不动已存的状态**。
     * 重渲时必须用这个：状态（列表数据）正是上一趟 effect 写进去的，
     * 连带清掉就等于每趟都从「正在读取状态…」重新开始 —— 卡片永远渲染不出来。
     */
    __rewind() { cursor = 0; effects.length = 0; },
  };
}

/**
 * 执行 bundle，拿到注册的工厂。
 *
 * ★ fetch 必须在这里注入，不能事后改 globalThis。
 *   bundle 是用 `new Function('window','document','fetch','globalThis', code)`
 *   求值的 —— 也就是说 `fetch` 是**形参**，`api()` 闭包捕获的是它。
 *   事后改 globalThis.fetch 完全不起作用：请求会走形参里那个 stub，
 *   数据永远进不来，画面永远停在「正在读取状态…」。
 *   所以把 fetchStub 作为参数传进来，在求值时就绑好。
 */
function loadFactory(fetchStub) {
  const registrations = [];
  const windowStub = { __ModuleLoader__: { mode: 'queue', load(reg) { registrations.push(reg); } } };
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute() {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const fetchImpl = fetchStub ?? (async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }));
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'fetch', 'globalThis', code);
  fn(windowStub, documentStub, fetchImpl, { window: windowStub, document: documentStub, fetch: fetchImpl });
  const reactStub = makeReactStub();
  const mod = registrations[0].factory((spec) => {
    if (spec === 'react') return reactStub;
    throw new Error(`测试环境没有提供模块：${spec}`);
  });
  return { mod, reactStub };
}

/**
 * 把渲染结果做成一个可查询的树。
 *
 * 面板是分好几层函数组件嵌套的（Panel → EntryCard → Btn/MarkButton…），
 * 所以这里**递归展开函数组件**：遇到函数类型的 type 就调用它，
 * 直到剩下宿主元素（字符串 tag）。
 */
function renderTree(element, reactStub, depth = 0) {
  if (element === null || element === undefined || typeof element !== 'object') return element;
  if (Array.isArray(element)) return element.map((e) => renderTree(e, reactStub, depth));
  const { type, props } = element;
  if (typeof type === 'function') {
    if (depth > 60) return null; // 防死循环
    /*
     * 错误边界是 ES5 写法（prototype 链挂到 Component 上），必须 new 出来。
     * 判据：它的 prototype 链上有 render —— 这类组件不可当普通函数调用。
     */
    const isClassLike = typeof type.prototype?.render === 'function';
    if (isClassLike) {
      const inst = new type(props);
      inst.state = inst.state ?? {};
      inst.props = props;
      return renderTree(inst.render(), reactStub, depth + 1);
    }
    return renderTree(type(props), reactStub, depth + 1);
  }
  return {
    tag: String(type),
    props,
    children: (Array.isArray(props?.children) ? props.children : [props?.children])
      .filter((c) => c !== null && c !== undefined && c !== false)
      .map((c) => (typeof c === 'object' ? renderTree(c, reactStub, depth + 1) : c)),
  };
}

/**
 * 收集树里所有可见文本。
 *
 * ★ 只收真正的文本节点，**不要**再额外去读 node.props.children ——
 *   children 已经在展开时进了 node.children，两边都读会把同一段文字数两遍，
 *   于是「按钮文案」这类断言会看到重复项（例如 2 个按钮被数成 4 个）。
 */
function allText(node, out = []) {
  if (node === null || node === undefined) return out.join(' ');
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out.join(' '); }
  if (Array.isArray(node)) { node.forEach((n) => allText(n, out)); return out.join(' '); }
  if (node.children) node.children.forEach((c) => allText(c, out));
  return out.join(' ');
}

/**
 * 收集树里所有宿主元素（带 tag 的那种）。
 * 同样要能穿透嵌套数组 —— renderTree 遇到数组会原样返回数组，
 * 数组里还可能是数组（React 的 children 展平语义），
 * 所以这里必须递归，不能只 walk 一层。
 */
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, out)); return out; }
  if (node.tag && pred(node)) out.push(node);
  if (node.children) node.children.forEach((c) => findAll(c, pred, out));
  return out;
}

/**
 * 造一个能渲染出「有内容」的 fetch stub：status + catalog 都返回真实形状的数据。
 *
 * extra 用来注入本次用例关心的额外方法（gate / install / installProgress …）——
 * 形如 { gate: (args) => result }，返回的 result 会被包成 { ok: true, result }。
 */
function makeFetchStub(items, extra = {}) {
  return async (url, init) => {
    const payload = JSON.parse(init?.body ?? '{}');
    if (extra[payload.method]) {
      const r = await extra[payload.method](payload.args ?? {});
      if (r && r.__raw) return { ok: true, json: async () => r.__raw };
      return { ok: true, json: async () => ({ ok: true, result: r }) };
    }
    if (payload.method === 'status') {
      return { ok: true, json: async () => ({ ok: true, result: {
        market: { version: '0.1.1' },
        env: { dsh: { version: '0.1.6-alpha.1' }, node: { version: '24.14.0' }, pnpm: { version: '12.4.2' } },
        profile: { name: 'web', bundles: [] },
        compat: { dshVersion: '0.1.6-alpha.1', supported: ['0.1.6-alpha.1'] },
        catalog: { counts: { total: items.length }, index: { source: 'remote' } },
        installed: [],
        upgradable: items.filter((i) => i.installState.status === 'upgradable')
          .map((i) => ({ name: i.package, from: i.installState.installedVersion, to: i.installState.target })),
        userData: { favorited: 0, marks: {} },
        backups: [], repo: { detected: true },
        preflight: extra.__preflight ?? { ok: true, problems: [], notices: [] },
        // 服务端会在 status 里带当前安装任务：界面据此在标题栏给「查看进度」入口
        job: extra.__job ?? null,
      } }) };
    }
    if (payload.method === 'catalog') {
      return { ok: true, json: async () => ({ ok: true, result: {
        total: items.length, offset: 0, limit: 24, items,
        marks: { favorited: 0 },
        indexMeta: { source: 'remote', counts: { total: items.length } },
      } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
}

function entryFixture(over) {
  return {
    id: over.package ?? 'x', package: 'x', title: 'X',
    version: '1.0.0', summary: '示例', tags: [], favorited: false,
    installState: {
      status: 'not-installed', installed: false, installedVersion: null, target: '1.0.0',
      reason: null, inBundles: false, canInstall: true, canUpgrade: false, action: 'install', isLatest: false,
    },
    ...over,
  };
}

/**
 * 从「注册出来的组件」里剥出真正的 Panel。
 *
 * 注册的形状是：ErrorBoundary( label, children=<Panel/> )，
 * 而 Panel 是通过 children 传进去的。这里顺着 children 找第一个
 * 「名字叫 Panel」的函数组件。
 */
function findPanelComponent(element) {
  if (!element || typeof element !== 'object' || !element.props) return null;
  const kids = Array.isArray(element.props.children) ? element.props.children : [element.props.children];
  for (const kid of kids) {
    if (!kid || typeof kid !== 'object') continue;
    if (typeof kid.type === 'function' && kid.type.name === 'Panel') return kid.type;
    const found = findPanelComponent(kid);
    if (found) return found;
  }
  return null;
}

/** 渲染面板：跑一遍 effect（发请求）→ 等一拍 → 再用拿到的数据重渲一次 */
async function renderPanel(items, opts = {}) {
  const { mod, reactStub } = loadFactory(makeFetchStub(items, opts.extra ?? {}));
  const registered = [];
  const ctx = {
    get: (n) => (n === 'layout' ? { selectPanel() {} } : undefined),
    effect: (fn) => { try { return fn(); } catch { return () => {}; } },
    slots: {
      inject: (k, cb) => { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
      entries: () => [], entriesOfSlot: () => [], subscribe: () => () => {},
      getVersion: () => 0, spec: () => ({ kind: 'list' }), snapshot: () => ({}), renderSlot: () => null,
    },
  };
  mod.apply(ctx);
  const registeredComp = registered.find((r) => r.options?.name === 'main').component;

  /*
   * ★ 注册的是「包了错误边界的 Panel」，不是 Panel 本身。
   *   直接渲染它只会得到 ErrorBoundary → ErrorCatcher → children 这一串壳，
   *   而 children 是宿主在渲染 slot 时才注入的 —— 测试里没有宿主，
   *   于是走到 ErrorCatcher 就断了，Panel 根本不执行（effect 数为 0，
   *   数据永远不加载，画面停在「正在读取状态…」）。
   *
   *   所以这里手工把壳剥掉：调用注册组件拿回元素树，
   *   顺着 children 一路找到真正的 Panel 并开始渲染。
   *   这样测的仍然是**打包产物里的真实组件**，只是替宿主把 slot 的 children 补上。
   */
  const shell = registeredComp({ onClose: () => {} });
  const Panel = findPanelComponent(shell);
  if (!Panel) throw new Error('没能从注册组件里找到 Panel —— 注册结构可能变了（检查 apply() 里的 slots.register）');

  /*
   * 多趟渲染，直到画面稳定。
   *
   * 为什么要循环而不是固定两趟：面板是「挂载 → effect 发请求 → 拿到数据重渲」
   * 的异步形状，而且第一趟渲染出的子组件数量与第二趟不同（没数据时没有卡片）。
   * 固定趟数很容易停在「数据到了但还没重渲」的中间态，
   * 于是断言看到的是「共 undefined 条」这种半成品画面 —— 那是测试脚手架的问题，
   * 不是界面的问题。这里跑到**文字不再变化**为止，最多 6 趟。
   */
  let tree = null;
  let prevText = null;
  for (let pass = 0; pass < 6; pass++) {
    reactStub.__rewind();
    tree = renderTree(Panel({ onClose: () => {} }), reactStub);
    // 跑本趟注册的 effect（第一趟会触发发请求；后续趟多为空依赖 effect）
    for (const fn of reactStub.__effects) { try { fn(); } catch { /* 忽略 */ } }
    // 让 pending 的 promise 链跑完（api() 里有两层 await）
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const text = allText(tree);
    if (text === prevText) break;
    prevText = text;
  }
  return tree;
}

/**
 * 把「真实交互 → 重新渲染」跑起来的小驱动。
 *
 * ★ 为什么需要它：这次改动的核心（点安装 → 立刻出进度面板 → 能中止 → 手动命令常在）
 *   全都发生在**交互之后**。只渲染首屏的话，这些代码一行都不会执行 ——
 *   测试会是绿的，而功能可能整个是坏的。
 *
 * 用法：`const d = await openPanel(items, extra)`；点某个按钮 → `await d.settle()`。
 */
export async function openPanel(items, extra = {}) {
  const { mod, reactStub } = loadFactory(makeFetchStub(items, extra));
  const registered = [];
  const ctx = {
    get: (n) => (n === 'layout' ? { selectPanel() {} } : undefined),
    effect: (fn) => { try { return fn(); } catch { return () => {}; } },
    slots: {
      inject: (k, cb) => { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
      entries: () => [], entriesOfSlot: () => [], subscribe: () => () => {},
      getVersion: () => 0, spec: () => ({ kind: 'list' }), snapshot: () => ({}), renderSlot: () => null,
    },
  };
  mod.apply(ctx);
  const registeredComp = registered.find((r) => r.options?.name === 'main').component;
  const shell = registeredComp({ onClose: () => {} });
  const Panel = findPanelComponent(shell);
  if (!Panel) throw new Error('没能从注册组件里找到 Panel');

  const driver = {
    reactStub,
    tree: null,
    async settle(passes = 3) {
      let prev = null;
      for (let p = 0; p < passes; p++) {
        reactStub.__rewind();
        driver.tree = renderTree(Panel({ onClose: () => {} }), reactStub);
        for (const fn of reactStub.__effects) { try { fn(); } catch { /* 忽略 */ } }
        for (let i = 0; i < 6; i++) await Promise.resolve();
        await new Promise((r) => setTimeout(r, 8));
        for (let i = 0; i < 6; i++) await Promise.resolve();
        const text = allText(driver.tree);
        if (text === prev) break;
        prev = text;
      }
      return driver.tree;
    },
    text() { return allText(driver.tree); },
    buttons() { return findAll(driver.tree, (n) => n.tag === 'button'); },
    /** 按可见文案找一个按钮并点它 */
    async click(pred, label = '目标按钮') {
      const b = driver.buttons().find(pred);
      if (!b) throw new Error(`找不到${label}。现有按钮：${driver.buttons().map((x) => allText(x).trim()).join(' | ')}`);
      assert(typeof b.props.onClick === 'function', `${label} 必须可点（有 onClick）`);
      b.props.onClick({ target: { checked: true } });
      await driver.settle();
      return b;
    },
  };
  await driver.settle();
  return driver;
}

export { allText, findAll };

suite('client / 市场面板渲染形状');

test('面板能渲染出内容（不是白屏）', async () => {
  const tree = await renderPanel([entryFixture({ package: 'dsh-memory', title: '跨会话长期记忆' })]);
  assert(tree, '面板应当返回一棵元素树');
  const text = allText(tree);
  assert(text.includes('插件市场'), `页面上应当有「插件市场」标题，实际文本片段：${text.slice(0, 200)}`);
});

test('★ 只有一个「插件市场」页签，没有层级页签', async () => {
  const tree = await renderPanel([entryFixture({ package: 'a' })]);
  const tabs = findAll(tree, (n) => n.tag === 'button' && String(n.props?.className ?? '').includes('dpm-tab'));
  // tab 的 children 是数组（文案 + 计数），allText 展开后再 trim
  const labels = tabs.map((t) => allText(t).replace(/\s+/g, ' ').trim());
  assert(labels.some((l) => l.startsWith('插件市场')), `应当有「插件市场」页签，实际：${labels.join(' | ')}`);
  for (const gone of ['已验证', '已审核', '未审核']) {
    assert(!labels.some((l) => l.startsWith(gone)), `不应再有独立的「${gone}」页签，实际：${labels.join(' | ')}`);
  }
  // 页签应当只剩 插件市场 / 已装 / 日志 —— 「体检」已按用户要求移除。
  // ★ 去掉的是**页面**：装前兼容性闸门照旧每次安装自动执行，这条断言不影响它。
  eq(labels.length, 3, `页签数量应当收敛到 3 个（体检页已移除），实际：${labels.join(' | ')}`);
  assert(!labels.some((l) => l.startsWith('体检')), `「体检」页签应当已移除，实际：${labels.join(' | ')}`);
});

test('★ 已是最新的插件：安装按钮 disabled，文案是「已安装」（问题 2）', async () => {
  const tree = await renderPanel([entryFixture({
    package: 'dsh-receipt', title: '凭证', version: '0.1.0',
    installState: {
      status: 'current', installed: true, installedVersion: '0.1.0', target: '0.1.0',
      reason: null, inBundles: true, canInstall: false, canUpgrade: false, action: 'current', isLatest: true,
    },
  })]);
  const buttons = findAll(tree, (n) => n.tag === 'button');
  /*
   * ★ 不能用「文案是已安装」来定位 —— 顶部筛选器里也有一个叫「已安装」的 chip，
   *   find() 会先撞上它，于是断言看的是筛选器而不是卡片按钮。
   *   按样式类定位才唯一：置灰的安装按钮带 dpm-btn-installed。
   */
  const installBtn = buttons.find((b) => String(b.props.className ?? '').includes('dpm-btn-installed'));
  assert(installBtn, `应当有一个置灰的安装按钮。按钮：${buttons.map((b) => allText(b).trim()).join(' | ')}`);
  eq(allText(installBtn).trim(), '已安装', '置灰按钮的文案应当是「已安装」');
  assert(installBtn.props.disabled === true, '★ 已是最新时安装按钮必须 disabled —— 这是问题 2 的核心');
  assert(!installBtn.props.onClick, '禁用按钮不该还挂着 onClick');
});

test('★ 可升级的插件：按钮文案是「更新到 x.y.z」且可点（问题 1）', async () => {
  const tree = await renderPanel([entryFixture({
    package: 'dsh-opencode-go-plus', title: 'OpenCode Go', version: '0.3.0',
    installState: {
      status: 'upgradable', installed: true, installedVersion: '0.2.1', target: '0.3.0',
      reason: '已装 0.2.1，仓库里是 0.3.0', inBundles: true, canInstall: true, canUpgrade: true,
      action: 'update', isLatest: false,
    },
  })]);
  const buttons = findAll(tree, (n) => n.tag === 'button');
  // 同样按样式类定位：dpm-btn-update 只出现在「更新到 …」按钮上
  const upd = buttons.find((b) => String(b.props.className ?? '').includes('dpm-btn-update'));
  assert(upd, `应当有一个「更新到 …」按钮。按钮：${buttons.map((b) => allText(b).trim()).join(' | ')}`);
  assert(allText(upd).includes('更新到'), '按钮文案应当是「更新到 …」形式');
  assert(allText(upd).includes('0.3.0'), '按钮上应当写明升到哪一版');
  assert(upd.props.disabled !== true, '可升级时按钮必须可点');
  assert(typeof upd.props.onClick === 'function', '可升级时按钮必须真的能点（有 onClick）');

  // 卡片上还应当有「有新版本」的说明
  const text = allText(tree);
  assert(text.includes('有新版本'), '卡片上应当明确提示有新版本');
  assert(text.includes('0.2.1'), '应当说清当前是哪一版');
});

test('★ 未安装的插件：按钮是「安装」且可点（不能被误置灰）', async () => {
  const tree = await renderPanel([entryFixture({
    package: 'dsh-memory', title: '记忆', version: '0.1.0',
    installState: {
      status: 'not-installed', installed: false, installedVersion: null, target: '0.1.0',
      reason: null, inBundles: false, canInstall: true, canUpgrade: false, action: 'install', isLatest: false,
    },
  })]);
  const buttons = findAll(tree, (n) => n.tag === 'button');
  const btn = buttons.find((b) => allText(b).trim() === '安装');
  assert(btn, `应当有一个「安装」按钮。按钮文案：${buttons.map((b) => allText(b)).join(' | ')}`);
  assert(btn.props.disabled !== true, '没装过时必须能点');
  assert(typeof btn.props.onClick === 'function', '没装过时按钮必须真的能点');
});

test('★ 无法判定版本时不能置灰（不能把「算不出来」当成「已是最新」）', async () => {
  const tree = await renderPanel([entryFixture({
    package: 'some-community-plugin', title: '社区插件',
    installState: {
      status: 'unknown', installed: true, installedVersion: '1.2.3', target: null,
      reason: '公共索引条目拿不到「仓库里现在是哪个版本」，无法比较',
      inBundles: true, canInstall: true, canUpgrade: false, action: 'install', isLatest: false,
    },
  })]);
  const buttons = findAll(tree, (n) => n.tag === 'button');
  // 装了但版本不明 → 按钮应当是「重新安装」，且必须可点
  const btn = buttons.find((b) => allText(b).includes('重新安装'));
  assert(btn, `版本无法判定时应当给「重新安装」入口。按钮文案：${buttons.map((b) => allText(b)).join(' | ')}`);
  assert(btn.props.disabled !== true, '★ 无法判定版本时绝不能置灰');
  assert(typeof btn.props.onClick === 'function', '★ 无法判定版本时必须真的能点');
});

test('★ 只剩「收藏」一个标记按钮，点赞已删除（0.5.0）', async () => {
  const unmarked = await renderPanel([entryFixture({ package: 'p1', title: '插件一' })]);
  // 只有 <button> 才是真按钮：类名同时出现在按钮和它内部的图标 span 上，按类名数会翻倍
  let marks = findAll(unmarked, (n) => n.tag === 'button' && String(n.props?.className ?? '').includes('dpm-mark'));
  eq(marks.length, 1, '每张卡片应当只有「收藏」一个标记按钮');
  eq(marks.filter((m) => m.props['data-on']).length, 0, '没收藏时不该是高亮态');
  assert(allText(unmarked).includes('收藏'), '应当有「收藏」文案');
  eq(allText(unmarked).includes('点赞'), false, '★ 点赞按钮与文案都不该再出现');

  const marked = await renderPanel([entryFixture({ package: 'p2', title: '插件二', favorited: true })]);
  marks = findAll(marked, (n) => n.tag === 'button' && String(n.props?.className ?? '').includes('dpm-mark'));
  eq(marks.length, 1, '仍然只有一个按钮');
  eq(marks.filter((m) => m.props['data-on']).length, 1, '收藏过之后应当是点亮态');
  assert(allText(marked).includes('已收藏'), '收藏后文案应当变成「已收藏」');
});

test('★ 顶部筛选器只剩「全部 / 已安装 / 可升级 / 我收藏的」', async () => {
  const tree = await renderPanel([entryFixture({ package: 'a' })]);
  const filters = findAll(tree, (n) => n.tag === 'button' && String(n.props?.className ?? '').includes('dpm-filter'));
  const labels = filters.map((f) => allText(f).replace(/\s+/g, ' ').trim());
  for (const want of ['全部', '已安装', '可升级', '我收藏的']) {
    assert(labels.some((l) => l.includes(want)), `筛选器里应当有「${want}」，实际：${labels.join(' | ')}`);
  }
  // ★ 0.5.0 删掉的两组筛选：审核状态（层级没了）与「我点赞的」（点赞没了）
  for (const gone of ['已审核', '未审核', '我点赞的', '点赞']) {
    eq(labels.some((l) => l.includes(gone)), false, `筛选器里不该再有「${gone}」`);
  }
});

test('★ 卡片上不再有层级角标与层级说明横幅（0.5.0）', async () => {
  const tree = await renderPanel([
    entryFixture({ package: 'v', title: 'V' }),
    entryFixture({ package: 'c', title: 'C' }),
  ]);
  const text = allText(tree);
  // 三种层级标签、以及它们各自的解释横幅，一个都不该再出现
  for (const gone of ['已验证', '已审核', '未审核']) {
    eq(text.includes(gone), false, `卡片上不该再出现「${gone}」`);
  }
  const badges = findAll(tree, (n) => n.props?.className && String(n.props.className).includes('dpm-badge'));
  const kinds = badges.map((b) => String(b.props.className));
  for (const gone of ['dpm-badge-verified', 'dpm-badge-reviewed', 'dpm-badge-community']) {
    eq(kinds.some((k) => k.includes(gone)), false, `不该再渲染 ${gone} 角标`);
  }
});

test('★ 有可更新插件时，页面顶部给出汇总提示（问题 1 的可见性）', async () => {
  const tree = await renderPanel([entryFixture({
    package: 'dsh-opencode-go-plus', title: 'OpenCode Go',
    installState: {
      status: 'upgradable', installed: true, installedVersion: '0.2.1', target: '0.3.0',
      reason: null, inBundles: true, canInstall: true, canUpgrade: true, action: 'update', isLatest: false,
    },
  })]);
  const text = allText(tree);
  assert(text.includes('可以更新'), `顶部应当提示有插件可以更新，实际文本片段：${text.slice(0, 300)}`);
});

test('★ 回归：每个用到的按钮 variant 都必须真的有对应样式类', async () => {
  /*
   * 真实踩过的坑：Btn 里 variant → class 的映射原来写成 if/else 链，
   * 新增 "update" 时既没匹配上也不报错 —— 按钮照样渲染、能点、文案也对，
   * 只是**完全没有样式**，看着像个裸按钮。这种静默降级在界面上极难发现，
   * 正是渲染测试该抓的东西。
   *
   * 这里把三种状态一次渲染出来，逐个断言 class 真的带上了。
   */
  const tree = await renderPanel([
    entryFixture({
      package: 'c1', title: '最新的',
      installState: { status: 'current', installed: true, installedVersion: '1.0.0', target: '1.0.0', inBundles: true, canInstall: false, canUpgrade: false, action: 'current', isLatest: true, reason: null },
    }),
    entryFixture({
      package: 'c2', title: '可升级的',
      installState: { status: 'upgradable', installed: true, installedVersion: '0.2.1', target: '0.3.0', inBundles: true, canInstall: true, canUpgrade: true, action: 'update', isLatest: false, reason: null },
    }),
    entryFixture({
      package: 'c3', title: '没装的',
      installState: { status: 'not-installed', installed: false, installedVersion: null, target: '1.0.0', inBundles: false, canInstall: true, canUpgrade: false, action: 'install', isLatest: false, reason: null },
    }),
  ]);
  const buttons = findAll(tree, (n) => n.tag === 'button');
  const classes = buttons.map((b) => String(b.props.className ?? ''));

  assert(classes.some((c) => c.includes('dpm-btn-update')), `更新按钮必须带 dpm-btn-update 样式类。实际类名：${classes.join(' | ')}`);
  assert(classes.some((c) => c.includes('dpm-btn-installed')), '置灰按钮必须带 dpm-btn-installed');
  assert(classes.some((c) => c.includes('dpm-btn-primary')), '普通安装按钮必须带 dpm-btn-primary');
});
