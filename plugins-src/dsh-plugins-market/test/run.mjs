/**
 * 测试入口：  node test/run.mjs
 *
 * 覆盖范围与「为什么值得测」：
 *   semver        闸门的判定基础（预发布匹配规则一错，拦截就不可信）
 *   util          tar 只读访问 / YAML 局部合并 —— 都是自己实现的部分
 *   gate          ★ 核心安全属性：致命硬拦截 / 可覆盖 / 未审核必须确认
 *   client-bundle ★ CLI 侧查不出来的那类错误（注册 id、slot 同名、经典脚本文法）
 *
 * 前置：先跑 `node build.mjs`（gate 与 client-bundle 都依赖构建产物）。
 * 说明：gate 测试跑在**隔离环境**（DSH_HOME=~/.dsh-dev）上，不会碰生产 profile。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

console.log('');
console.log('  dsh-plugins-market 测试');
console.log(`  ${'-'.repeat(70)}`);

const artifacts = [
  ['.build/package/lib/client.js', '客户端半产物'],
  ['.build/package/lib/index.js', '服务器半产物'],
  ['.build/package/catalog/verified.json', '已验证层目录'],
];
const missing = artifacts.filter(([rel]) => !fs.existsSync(path.join(PKG, rel)));
if (missing.length > 0) {
  console.log('');
  console.log('  ✗ 缺少构建产物，请先运行：  node build.mjs');
  for (const [rel, what] of missing) console.log(`      - ${rel}  (${what})`);
  console.log('');
  process.exit(3);
}

await import('./semver.test.mjs');
await import('./util.test.mjs');
await import('./gate.test.mjs');
await import('./client-bundle.test.mjs');
await import('./layout.test.mjs');

const code = await run();
process.exit(code);
