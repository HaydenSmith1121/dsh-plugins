/**
 * 只读确认：生产 3080 环境没有被这次开发影响。
 *
 *   node test/prod-untouched.mjs
 *
 * 只做 GET / 与静态探测，不调任何会写盘的 RPC，不改任何东西。
 */

const BASE = process.env.PROD_BASE ?? 'http://127.0.0.1:3080';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

console.log('');
console.log('  生产环境（3080）只读检查');
console.log(`  ${'-'.repeat(72)}`);

try {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(8000) });
  // 401 也算「活着」：harness 没带 token 时就是这个回应，正好证明服务在跑。
  if (res.ok) ok(`GET ${BASE} → HTTP ${res.status}`);
  else if (res.status === 401) ok(`GET ${BASE} → HTTP 401（需要 token，说明服务是活的）`);
  else bad(`GET ${BASE} → HTTP ${res.status}`);
  if (res.ok) {
    const html = await res.text();
    if (/dsh/i.test(html)) ok('页面是 harness 的（含 dsh 标识）');
    else bad('返回内容不像 harness 页面');
  }
} catch (err) {
  bad(`连不上 ${BASE}：${err?.message ?? err}（如果生产没在跑，这是正常的）`);
}

// 生产 profile 清单：确认没有被塞进开发件
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const prodPkg = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json');
try {
  const pkg = JSON.parse(fs.readFileSync(prodPkg, 'utf8'));
  const deps = Object.entries(pkg.dependencies ?? {});
  const devish = deps.filter(([, spec]) => {
    const s = String(spec);
    return /file:.*(\\|\/)(Temp|tmp|_probe|_work|pack-)/i.test(s) || /dsh-dev-test/i.test(s);
  });
  if (devish.length === 0) ok(`生产 profile 里没有开发类 file: 依赖（共 ${deps.length} 条依赖）`);
  else bad(`生产 profile 里有开发类依赖：${devish.map(([n, s]) => `${n} → ${s}`).join('；')}`);

  const market = deps.find(([n]) => n === 'dsh-plugins-market');
  if (market) ok(`生产装的 market 版本：${String(market[1]).split('/').pop()}`);
  else ok('生产没有装 market 插件');
} catch (err) {
  bad(`读不到生产 profile：${err?.message ?? err}`);
}

console.log('');
if (failed === 0) {
  console.log('  ✓ 生产环境未被影响。');
  console.log('');
} else {
  console.error(`  ✗ 有 ${failed} 项需要确认。`);
  console.error('');
  process.exit(1);
}
