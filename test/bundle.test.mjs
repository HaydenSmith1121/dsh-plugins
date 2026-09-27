/**
 * 客户端半的**静态检查**。
 *
 * 客户端半是 classic script，一旦写错（用了 import / 顶层 await / 注册 id 不对）
 * 症状是**整页白屏或整个面板不出来**，而且不会有任何编译期报错 ——
 * 宿主只会在控制台留一句 “loaded without registering”。
 * 所以这些约束必须在测试里钉住。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, ok, includes } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'src', 'client', 'app.js');
const text = fs.readFileSync(CLIENT, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** 去掉注释再判断语法层面的东西 —— 注释里出现 import 字样是正常的 */
const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('classic script：没有 import / export / 顶层 await', () => {
  ok(!/^\s*(import|export)\s/m.test(code), '出现 import/export 就是 SyntaxError');
  ok(!/^\s*await\s/m.test(code), '经典脚本不支持顶层 await');
});

test('自注册：id 严格等于包名，且有 factory(require)', () => {
  includes(code, 'window.__ModuleLoader__.load({');
  includes(code, `id: "${pkg.name}"`);
  ok(/factory:\s*\(require\)\s*=>/.test(code), '必须有 factory(require)');
});

test('三件套齐全：exports.apply / exports.inject / return module.exports', () => {
  includes(code, 'exports.apply = apply;');
  includes(code, 'exports.inject = inject;');
  includes(code, 'return module.exports;');
});

test('依赖面只有一个 baseline seed word：react', () => {
  const requires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const unique = [...new Set(requires)];
  eq(unique.length, 1, `客户端半只该 require 一个模块，实际 ${unique.join('、')}`);
  eq(unique[0], 'react', 'react 是各版本都在的 baseline seed word');
});

test('inject 只声明 slots', () => {
  ok(/var inject = \["slots"\]/.test(code), '声明的服务没就绪会让整页 boot 失败，所以只能写最少的一个');
});

test('样式标签按约定打标（HMR 靠它认领与回收）', () => {
  includes(code, 'styleTag.dataset.plugin = "dsh-plugins-market"');
  includes(code, 'styleTag.dataset.pluginCss = CSS_TAG_ID');
  includes(code, 'document.querySelector("style[data-plugin-css="');
});

test('注册 slot 之前必须先 slots.inject，且 main 的 key 与侧栏 id 同名', () => {
  includes(code, 'ctx.slots.inject("sidebar.panellist"');
  includes(code, 'ctx.slots.inject("main"');
  includes(code, 'name: "sidebar.panellist", id: PANEL_ID');
  includes(code, 'name: "main", key: PANEL_ID');
  eq((code.match(/PANEL_ID = "dsh-plugins-market"/g) ?? []).length, 1, '面板 id 必须与包名同源');
});

test('错误边界是 class 组件（函数组件接不住渲染错误）', () => {
  includes(code, 'componentDidCatch');
  includes(code, 'react.Component.call(this, props)');
});

test('面板只读：不出现任何安装 / 卸载 / 体检类动作', () => {
  for (const banned of ['installPlan', 'installProgress', 'installAbort', 'uninstall', 'rollback', 'bootVerify', 'profileCheck', 'preflight']) {
    ok(!code.includes(`"${banned}"`), `客户端不该再调用 ${banned}`);
  }
  // 只允许这三个读数据的方法，外加一个「清掉自己的缓存」——
  // 它们都不碰 harness、不碰 profile、不执行任何命令。
  const rpcCalls = [...code.matchAll(/api\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(rpcCalls)].sort();
  eq(unique.join(','), 'dropCache,index,refresh,status', `客户端只能调这四个方法，实际 ${unique.join(',')}`);
});

test('虚拟滚动：行高是常量，位置与高度都由它算出来', () => {
  includes(code, 'var ROW_H = 96');
  includes(code, 'top: index * ROW_H');
  includes(code, 'height: ROW_H');
  includes(code, 'OVERSCAN');
});

test('列表渲染有 memo 包裹（否则滚动时每帧都要重渲染可见行）', () => {
  ok(/var Row = memo\(/.test(code), 'Row 必须用 memo 包住');
});

test('复制出去的是官方桌面版能识别的安装地址', () => {
  includes(code, 'return "github:" + row[C.id];');
  includes(code, '设置 → 插件 → 添加插件');
});

test('设计令牌：颜色走 --dsw-alias-*，不写死主题色', () => {
  const tokens = (code.match(/--dsw-alias-[a-z-]+/g) ?? []).length;
  ok(tokens > 20, `应当大量使用宿主的设计令牌，实际只找到 ${tokens} 处`);
  includes(code, 'prefers-color-scheme: dark');
});
