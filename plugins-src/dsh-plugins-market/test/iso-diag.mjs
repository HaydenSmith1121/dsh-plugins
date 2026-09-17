/**
 * 隔离环境诊断脚本（服务器半，直连不走 HTTP）。
 *
 *   DSH_HOME=<隔离 home> node test/iso-diag.mjs
 *
 * 用来把「哪个环节慢/挂」定位到具体函数，而不是靠猜：
 *   1. detectEnvironment   —— dsh / pnpm 解析
 *   2. composedTree        —— 装配树（安装与校验都要用）
 *   3. preflight           —— profile 体检
 *   4. verifyInstalled     —— 三层校验
 *   5. dshRun(plugin list) —— 真正跑一次 dsh plugin
 */

process.env.DSH_HOME = process.env.DSH_HOME || 'D:/deepseek/_work/dsh-dev-test';

const t = (label, t0) => console.log(`  ${label}  ${Date.now() - t0}ms`);

const util = await import('../src/server/util.js');
const profile = await import('../src/server/profile.js');
const installer = await import('../src/server/installer.js');

console.log('');
console.log(`  DSH_HOME = ${process.env.DSH_HOME}`);
console.log('');

let t0 = Date.now();
const env = util.detectEnvironment(process.env);
t('detectEnvironment', t0);
console.log(`    dsh    ${env.dsh.dir ?? '（未找到）'}  ${env.dsh.version ?? ''}`);
console.log(`    pnpm   ${env.pnpm.dir ?? '（未找到）'}  ${env.pnpm.version ?? ''}`);
console.log(`    launcher ${env.dsh.launcher ?? '—'}`);

t0 = Date.now();
const dc = util.dshCommand(process.env);
t('dshCommand', t0);
console.log(`    解析为 ${dc.resolved}：${dc.command} ${dc.prefixArgs.join(' ')}  shell=${dc.shell}`);

const state = profile.readProfileState('web', process.env);
console.log(`    profile ${state.dir}  initialized=${state.initialized}  deps=${Object.keys(state.dependencies ?? {}).length}  bundles=${(state.bundles ?? []).length}`);

t0 = Date.now();
console.log('  ── composedTree ──');
const tree = await profile.composedTree('web', process.env, { timeout: 60_000 });
t('composedTree', t0);
console.log(`    ok=${tree.ok} heads=${(tree.heads ?? []).length} err=${tree.error ?? '—'}`);
if (tree.stderr) console.log(`    stderr: ${String(tree.stderr).slice(0, 300)}`);

t0 = Date.now();
const pf = installer.preflight({ profileState: state, env });
t('preflight', t0);
console.log(`    ok=${pf.ok} problems=${pf.problems.length} notices=${pf.notices.length}`);

t0 = Date.now();
const ctx = { env, profileState: state, installed: profile.scanInstalled('web', process.env), tree, repoRoot: null, repoRawBase: '' };
const v = await installer.verifyInstalled('dsh-plugins-market', ctx, {});
t('verifyInstalled(market)', t0);
console.log(`    ok=${v.ok} layers=${v.layers.map((l) => `${l.id}:${l.ok ? 'ok' : 'fail'}`).join(' ')}`);

t0 = Date.now();
const r = await installer.dshRun(['plugin', '--profile', 'web', 'list'], ctx, { timeout: 120_000, onOutput: (c) => process.stdout.write(`      [out] ${c}`) });
t('dshRun(plugin list)', t0);
console.log(`    failed=${r.failed} status=${r.status} err=${r.error ?? '—'}`);
console.log(`    stdout: ${String(r.stdout).slice(0, 400).replace(/\n/g, ' | ')}`);

console.log('');
