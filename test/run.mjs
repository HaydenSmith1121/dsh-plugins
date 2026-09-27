/**
 * 测试入口：node test/run.mjs
 *
 * 覆盖四层，按「坏了会是什么症状」排序：
 *   1. 清单与适配不变量（manifest.test.mjs）—— 坏了整个插件装不上 / 加载不了
 *   2. 采集格式（format.test.mjs）          —— 坏了索引会天天产生假 diff
 *   3. 服务器半（catalog / server）          —— 坏了面板读不到数据
 *   4. 客户端半（bundle.test.mjs）           —— 坏了整页白屏
 * 外加一条对着**仓库里真实数据**跑的自洽校验（data.test.mjs）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tests } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

for (const file of files) {
  await import(new URL(`./${file}`, import.meta.url));
}

let passed = 0;
const failures = [];

for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    process.stdout.write(`  ✓ ${t.name}\n`);
  } catch (err) {
    failures.push({ name: t.name, err });
    process.stdout.write(`  ✗ ${t.name}\n`);
  }
}

process.stdout.write('\n');
if (failures.length > 0) {
  for (const f of failures) {
    process.stdout.write(`  ✗ ${f.name}\n     ${String(f.err?.stack ?? f.err).split('\n').slice(0, 6).join('\n     ')}\n\n`);
  }
  process.stdout.write(`  ${passed}/${tests.length} 通过，${failures.length} 失败\n\n`);
  process.exit(1);
}
process.stdout.write(`  ✓ ${passed}/${tests.length} 全部通过\n\n`);
