/*
 * dsh-plugins-market —— 客户端半（浏览器 bundle）
 *
 * ★ 这是一个 **classic script**，不是 ES module：
 *   不能出现 import / export / 顶层 await。宿主是用 `<script async src=...>`
 *   加载它的（没有 type="module"），一旦写了 export 就是 SyntaxError，
 *   页面会报 “bundle ... loaded without registering ...”。
 *
 * ★ load({ id }) 里的 id **必须**等于包名 dsh-plugins-market：
 *   它同时是启动图的行 id（= cordis.patch.yml 里的 name），也是
 *   ClientModuleRegistry 用来做 arrive() 断言的键。
 *
 * ★ 只 require("react")：它是 shell 内置的 baseline seed word。
 *   别的 baseline 词（react-dom / dsh-client-store / dsh-client-ui-primitives …）
 *   虽然也能 require，但这里刻意一个都不用，把依赖面压到最小。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugins-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;
		var useMemo = react.useMemo;
		var useRef = react.useRef;

		//#region ── 样式 ────────────────────────────────────────────────
		/*
		 * 宿主没有 CSS loader 契约。约定做法是在 factory 里注入一个 <style>：
		 *   - factory 只在「物化」时执行一次，所以注入点天然正确；
		 *   - data-plugin 必须是包名（HMR 靠它认领/移除标签）；
		 *   - data-plugin-css 用稳定的 <包名>/<文件> 形式做幂等判断；
		 *   - typeof document 守卫与 querySelector 幂等检查缺一不可（HMR 会重新物化）。
		 */
		var CSS = `
.dpm-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#252525);background:var(--dsw-alias-bg-base,#fff)}
.dpm-head{flex:0 0 auto;padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.dpm-head-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dpm-title{margin:0;font-size:16px;font-weight:650;letter-spacing:.2px}
.dpm-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#5f6670);display:flex;flex-wrap:wrap;gap:4px 10px}
.dpm-sub code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);padding:1px 5px;border-radius:4px}
.dpm-spacer{flex:1 1 auto}
.dpm-strip{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.dpm-tabs{flex:0 0 auto;display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);overflow-x:auto}
.dpm-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5f6670);font-size:13px;padding:9px 12px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;font-family:inherit}
.dpm-tab:hover{color:var(--dsw-alias-label-primary,#252525)}
.dpm-tab[data-on]{color:var(--dsw-alias-label-primary,#252525);border-bottom-color:var(--dpm-brand,#4d6bfe);font-weight:600}
.dpm-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 40px}
.dpm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
/*
 * 搜索行固定在列表顶部：结果很长时往下滚，搜索框仍然在，不用滚回去改关键词。
 * 做法是标准的「带内边距的滚动容器里做通栏 sticky」：
 *   - 负 margin 抵消 .dpm-body 的 14px/18px 内边距，让不透明底色铺满整宽
 *     （否则两侧会露出下面滚过去的卡片）；
 *   - 再用等量 padding 把视觉间距补回来；
 *   - top:-14px 让它吸到滚动口最顶端，而不是留出 14px 缝隙。
 * 底色必须不透明，且与 .dpm-root 一致（暗色模式下也要跟着变，见下面的媒体查询）。
 */
.dpm-toolbar-sticky{position:sticky;top:-14px;z-index:6;margin:-14px -18px 12px;padding:14px 18px 12px;background:var(--dsw-alias-bg-base,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
/* 搜索框给个宽度上限：窗口很宽时不让它无限拉伸，按钮和计数才不会被推到天边 */
.dpm-input{flex:1 1 220px;min-width:180px;max-width:520px;font-family:inherit;font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:inherit}
.dpm-input:focus{outline:none;border-color:var(--dpm-brand,#4d6bfe)}
.dpm-btn{appearance:none;font-family:inherit;font-size:12px;line-height:1;padding:7px 11px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#252525);white-space:nowrap}
.dpm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f1f3)}
.dpm-btn:disabled{opacity:.45;cursor:not-allowed}
.dpm-btn-primary{background:var(--dpm-brand,#4d6bfe);border-color:var(--dpm-brand,#4d6bfe);color:#fff;font-weight:600}
.dpm-btn-primary:hover:not(:disabled){background:var(--dpm-brand-strong,#2e4bd8);border-color:var(--dpm-brand-strong,#2e4bd8)}
.dpm-btn-danger{color:#b91c1c;border-color:#f5c6c6;background:#fdeaea}
.dpm-btn-danger:hover:not(:disabled){background:#fbdcdc}
.dpm-btn-sm{padding:5px 9px;font-size:11.5px}
.dpm-cards{display:flex;flex-direction:column;gap:10px}
.dpm-card{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-base,#fff)}
.dpm-card-top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.dpm-card-name{font-size:13.5px;font-weight:650;word-break:break-all}
.dpm-card-id{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a919f);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.dpm-card-sum{margin:7px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5f6670);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dpm-card-meta{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dpm-card-act{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
.dpm-flag{margin-top:8px;font-size:12px;padding:6px 9px;border-radius:7px;display:flex;gap:7px;align-items:flex-start}
.dpm-flag-ok{background:#e8f6ee;color:#15803d;border:1px solid #bfe3cd}
.dpm-flag-risk{background:#fef7e7;color:#a97f1f;border:1px solid #f0dfae}
.dpm-flag-bad{background:#fdeaea;color:#b91c1c;border:1px solid #f5c6c6}
.dpm-flag-info{background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6670);border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.dpm-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;white-space:nowrap}
.dpm-badge-neutral{background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6670);border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.dpm-badge-bad{background:#fdeaea;color:#b91c1c;border:1px solid #f5c6c6}
.dpm-badge-ok{background:#e8f6ee;color:#15803d;border:1px solid #bfe3cd}
.dpm-chip{display:inline-block;font-size:11px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6670);border:1px solid var(--dsw-alias-border-l1,#eceef1)}
.dpm-empty{padding:36px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#8a919f);font-size:12.5px}
.dpm-pager{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:16px;flex-wrap:wrap}
.dpm-pager-info{font-size:12px;color:var(--dsw-alias-label-secondary,#5f6670)}
.dpm-drawer{position:absolute;inset:0;z-index:20;background:var(--dsw-alias-bg-base,#fff);display:flex;flex-direction:column;min-height:0}
.dpm-drawer-head{flex:0 0 auto;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);display:flex;gap:10px;align-items:center}
.dpm-drawer-title{font-size:14px;font-weight:650;margin:0}
.dpm-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 24px}
.dpm-drawer-foot{flex:0 0 auto;padding:11px 18px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.dpm-verdict{border-radius:9px;padding:11px 13px;font-size:13px;font-weight:600;display:flex;gap:9px;align-items:flex-start;margin-bottom:14px}
.dpm-verdict-pass{background:#e8f6ee;color:#15803d;border:1px solid #bfe3cd}
.dpm-verdict-warn{background:#fef7e7;color:#a97f1f;border:1px solid #f0dfae}
.dpm-verdict-block{background:#fdeaea;color:#b91c1c;border:1px solid #f5c6c6}
.dpm-verdict-sub{display:block;font-weight:400;font-size:12px;margin-top:3px;opacity:.92}
/* 安装方式选择：两张卡并排，选中的那张有明显的边框和底色 */
.dpm-method-head{font-size:12px;font-weight:700;letter-spacing:.02em;color:#4b5563;margin:16px 0 8px}
.dpm-methods{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.dpm-method{position:relative;text-align:left;display:flex;flex-direction:column;gap:5px;padding:13px 14px;border-radius:10px;border:1px solid #d8dde3;background:#fff;cursor:pointer;font:inherit;color:#1f2937;transition:border-color .12s,box-shadow .12s,background .12s}
.dpm-method:hover:not(:disabled){border-color:#9aa4b2}
.dpm-method[data-on]{border-color:#2f6fd0;background:#f4f8ff;box-shadow:0 0 0 2px rgba(47,111,208,.14)}
.dpm-method:disabled{cursor:not-allowed;opacity:.55;background:#f6f7f9}
.dpm-method-ico{font-size:17px;line-height:1}
.dpm-method-t{font-size:13.5px;font-weight:700}
.dpm-method-d{font-size:12px;line-height:1.5;color:#5b6472}
.dpm-method-on{position:absolute;top:9px;right:10px;font-size:11px;font-weight:700;color:#2f6fd0}
/* 自动安装的规格框 / 手动安装的提示条 */
.dpm-plan-box{margin-top:12px;padding:12px 13px;border-radius:10px;background:#f7f9fc;border:1px solid #e2e7ee}
.dpm-plan-box .dpm-kv{margin-bottom:8px}
.dpm-note{display:flex;gap:7px;align-items:flex-start;font-size:12.5px;line-height:1.6;color:#3f4855;padding:6px 0;border-bottom:1px dashed #e6e9ee}
.dpm-note:last-child{border-bottom:none}
.dpm-note-ico{flex:0 0 auto;color:#8b95a3}
.dpm-group{margin:14px 0}
.dpm-group-h{font-size:12px;font-weight:650;margin:0 0 7px;display:flex;gap:7px;align-items:center;cursor:pointer;user-select:none}
.dpm-check{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:9px 11px;margin-bottom:7px;background:var(--dsw-alias-bg-base,#fff)}
.dpm-check[data-sev="fatal"]{border-left:3px solid #dc2626}
.dpm-check[data-sev="warn"]{border-left:3px solid #d97706}
.dpm-check[data-sev="info"]{border-left:3px solid #16a34a}
.dpm-check[data-sev="skip"]{border-left:3px solid #9ca3af}
/*
 * ── 收藏 ──────────────────────────────────────────────────────
 * 一个按钮（0.5.0 删掉了点赞）。★ 刻意做成「描边」而不是大色块：
 * 收藏是个人偏好，不该比「装不装得上」这类安全信号更抢眼。
 * data-on 只看布尔值，颜色一律走 CSS —— 组件里不拼颜色字符串，
 * 暗色模式下才不用再判一次。
 */
.dpm-mark{appearance:none;display:inline-flex;align-items:center;gap:4px;font-family:inherit;font-size:11.5px;line-height:1;padding:5px 9px;border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5f6670)}
.dpm-mark:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f1f3)}
.dpm-mark:disabled{opacity:.45;cursor:not-allowed}
.dpm-mark[data-on]{font-weight:600}
.dpm-mark-fav[data-on]{background:#fef7e7;border-color:#f0dfae;color:#a16207}
.dpm-mark-ico{font-size:12px;line-height:1}
/*
 * ── 状态徽标 ────────────────────────────────────────────────
 * 已安装 / 已是最新 / 可升级 三种。可升级用蓝色而不是绿色 ——
 * 绿色在本插件里一律表示「无需动作」，可升级是「有个动作值得做」。
 */
.dpm-badge-update{background:#eaf2fb;color:#2e4bd8;border:1px solid #c9d4f5}
.dpm-badge-current{background:#e8f6ee;color:#15803d;border:1px solid #bfe3cd}
/* 已经装过、但没有新版时，「安装」按钮置灰 —— 灰底灰字，明确不可点 */
/* ★ .dpm-btn-installed 随「已安装即置灰」一起删掉了：重装是正当需求，不再有置灰态 */
.dpm-btn-update{background:var(--dpm-brand,#4d6bfe);border-color:var(--dpm-brand,#4d6bfe);color:#fff;font-weight:600}
.dpm-btn-update:hover:not(:disabled){background:var(--dpm-brand-strong,#2e4bd8);border-color:var(--dpm-brand-strong,#2e4bd8)}
/*
 * ── 筛选行 ──────────────────────────────────────────────────
 * 部门筛选（已审核 / 未审核 / 已收藏 / 可升级…）做成 chips：
 * 它们是可以叠加的「视图开关」，不是页签 —— 页签一次只能选一个，
 * 而这些筛选天然要能组合（比如「已收藏 + 可升级」）。
 */
.dpm-filters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px}
.dpm-filter{appearance:none;font-family:inherit;font-size:11.5px;line-height:1;padding:6px 10px;border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5f6670);white-space:nowrap}
.dpm-filter:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f1f3)}
.dpm-filter[data-on]{background:var(--dpm-brand,#4d6bfe);border-color:var(--dpm-brand,#4d6bfe);color:#fff;font-weight:600}
.dpm-filter:disabled{opacity:.45;cursor:not-allowed}
.dpm-filter-n{opacity:.75;margin-left:3px}
.dpm-check-top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dpm-check-t{font-size:12.5px;font-weight:600}
.dpm-check-d{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#5f6670);white-space:pre-wrap;word-break:break-word}
.dpm-check-hint{margin:5px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a919f);white-space:pre-wrap}
.dpm-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px;margin:8px 0 0}
.dpm-kv-k{color:var(--dsw-alias-label-secondary,#8a919f);white-space:nowrap}
.dpm-kv-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.dpm-steps{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.dpm-step{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:9px 11px}
.dpm-step-ico{flex:0 0 auto;width:16px;text-align:center;font-weight:700;line-height:1.5}
.dpm-step[data-s="ok"] .dpm-step-ico{color:#15803d}
.dpm-step[data-s="fail"] .dpm-step-ico{color:#b91c1c}
.dpm-step[data-s="warn"] .dpm-step-ico{color:#b45309}
.dpm-step[data-s="running"] .dpm-step-ico{color:var(--dpm-brand,#4d6bfe)}
.dpm-step-l{font-size:12.5px;font-weight:600}
.dpm-step-d{font-size:12px;color:var(--dsw-alias-label-secondary,#5f6670);white-space:pre-wrap;margin-top:2px}
.dpm-pre{margin:7px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-layer-1,#f6f7f9);border:1px solid var(--dsw-alias-border-l1,#eceef1);border-radius:7px;padding:8px 10px;max-height:260px;overflow:auto}
.dpm-split{display:flex;gap:9px;align-items:center;font-size:12px;margin:9px 0;flex-wrap:wrap}
/* ★ .dpm-ack（「我确认有风险」勾选框）随装前检查一起删掉了：市场不再要求任何风险确认 */
.dpm-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:9px 11px;margin-bottom:7px}
.dpm-row-name{font-size:12.5px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.dpm-toast{flex:0 0 auto;margin:0 18px 12px;padding:9px 12px;border-radius:8px;background:#fdeaea;border:1px solid #f5c6c6;color:#b91c1c;font-size:12px;display:flex;gap:9px;align-items:flex-start}
.dpm-toast[data-k=info]{background:#eef3fd;border-color:#c9d8f5;color:#2b4c8c}
.dpm-toast[data-k=warn]{background:#fef7e7;border-color:#f0dfae;color:#7c5a12}

/* ── profile 体检横幅 ─────────────────────────────────────────── */
.dpm-alert{flex:0 0 auto;margin:12px 18px 0;padding:11px 13px;border-radius:10px;background:#fef7e7;border:1px solid #f0dfae;font-size:12px}
.dpm-alert-h{display:flex;gap:8px;align-items:center;font-weight:700;color:#7c5a12;margin-bottom:7px}
.dpm-alert-item{border-top:1px dashed #f0dfae;padding-top:8px;margin-top:8px}
.dpm-alert-item:first-of-type{border-top:0;padding-top:0;margin-top:0}
.dpm-alert-t{font-weight:600;color:#7c5a12;margin-bottom:3px}
.dpm-alert-fix{display:flex;flex-direction:column;gap:4px;margin-top:7px}

/* ── 安装进度（阶段 / 预计时间 / 中止）───────────────────────── */
.dpm-prog{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:12px 13px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.dpm-prog[data-s=succeeded]{border-color:#b7e0c4;background:#f2fbf5}
.dpm-prog[data-s=failed]{border-color:#f0c2c2;background:#fdf4f4}
.dpm-prog[data-s=cancelled],.dpm-prog[data-s=timeout]{border-color:#f0dfae;background:#fefaf0}
.dpm-prog-head{display:flex;gap:9px;align-items:center;font-size:12.5px;font-weight:600;margin-bottom:9px}
/* 正在装的是什么 / 用什么方式装 —— 自动安装看不到命令窗口，这两行就是「可观察性」*/
.dpm-prog-what{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;font-weight:700;margin-bottom:7px}
.dpm-prog-pkg{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dpm-prog-ver{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}
.dpm-prog-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#8a919f);margin-bottom:9px;padding-bottom:9px;border-bottom:1px dashed var(--dsw-alias-border-l1,#e5e7eb)}
.dpm-prog-meta .dpm-mono{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.dpm-prog-ico{font-size:13px}
.dpm-prog-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpm-prog-eta{font-weight:600;color:var(--dpm-brand,#4d6bfe);white-space:nowrap;font-size:12px}
.dpm-bar{height:6px;border-radius:99px;background:var(--dsw-alias-border-l1,#e5e7eb);overflow:hidden}
.dpm-bar-fill{height:100%;background:var(--dpm-brand,#4d6bfe);border-radius:99px;transition:width .45s ease}
.dpm-prog[data-s=succeeded] .dpm-bar-fill{background:#2f9e5f}
.dpm-prog[data-s=failed] .dpm-bar-fill{background:#d64545}
.dpm-prog-sub{display:flex;gap:7px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#8a919f);margin-top:7px}
.dpm-phases{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}
.dpm-phase{font-size:10.5px;padding:2px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-secondary,#8a919f);white-space:nowrap;max-width:210px;overflow:hidden;text-overflow:ellipsis}
.dpm-phase[data-s=running]{border-color:var(--dpm-brand,#4d6bfe);color:var(--dpm-brand,#4d6bfe);font-weight:600}
.dpm-phase[data-s=ok]{border-color:#b7e0c4;color:#2f7a4d}
.dpm-phase[data-s=fail]{border-color:#f0c2c2;color:#b3352f}
.dpm-phase[data-s=warn]{border-color:#f0dfae;color:#7c5a12}

/* ── 手动安装命令 ─────────────────────────────────────────────── */
.dpm-manual{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:12px 13px}
.dpm-manual-h{font-size:12.5px;font-weight:700;margin-bottom:6px}
.dpm-manual-step{margin-top:11px}
.dpm-manual-t{font-size:12px;font-weight:600;margin-bottom:3px}
.dpm-manual-tips{font-size:11px;color:var(--dsw-alias-label-secondary,#8a919f);margin-top:5px;line-height:1.6}
.dpm-shellpick{display:flex;gap:6px;margin:9px 0 3px}
.dpm-cmdgroup{margin-top:6px}
.dpm-cmd{display:flex;gap:8px;align-items:center;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:7px;padding:5px 6px 5px 10px;margin-bottom:4px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dpm-cmd[data-comment]{border-style:dashed;background:transparent}
.dpm-cmd-t{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all;white-space:pre-wrap;line-height:1.5}
.dpm-cmd-copy{flex:0 0 auto}
.dpm-cmdgroup-foot{display:flex;justify-content:flex-end;margin-top:2px}
.dpm-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dsw-alias-border-l1,#d4d7dc);border-top-color:var(--dpm-brand,#4d6bfe);border-radius:50%;animation:dpm-spin .7s linear infinite;vertical-align:-1px}
@keyframes dpm-spin{to{transform:rotate(360deg)}}
.dpm-err{padding:20px;font-size:12.5px;color:#b91c1c}
.dpm-err pre{margin:10px 0 0;font-size:11px;white-space:pre-wrap;background:#fdeaea;border:1px solid #f5c6c6;border-radius:7px;padding:9px 11px;max-height:220px;overflow:auto}
.dpm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dpm-muted{color:var(--dsw-alias-label-secondary,#8a919f)}
@media (prefers-color-scheme:dark){
  .dpm-root{background:#1c1d1f;color:#e8eaed}
  .dpm-card,.dpm-check,.dpm-step,.dpm-row{background:#232427;border-color:#34363a}
  .dpm-head,.dpm-tabs,.dpm-drawer-head,.dpm-drawer-foot,.dpm-strip{border-color:#34363a}
  /* 固定搜索行的底色必须跟着暗色模式改，否则它会是一块白条 */
  .dpm-toolbar-sticky{background:#1c1d1f;border-color:#34363a}
  .dpm-strip,.dpm-drawer-foot{background:#202124}
  .dpm-card-sum,.dpm-check-d,.dpm-step-d,.dpm-sub{color:#a9adb5}
  .dpm-chip,.dpm-badge-neutral{background:#2b2d31;border-color:#3a3d42;color:#b6bac2}
  .dpm-input{background:#232427;border-color:#3a3d42;color:#e8eaed}
  .dpm-btn{background:#2b2d31;border-color:#3a3d42;color:#e8eaed}
  .dpm-pre{background:#1a1b1d;border-color:#34363a}
  .dpm-drawer{background:#1c1d1f}
  .dpm-flag-info{background:#2b2d31;border-color:#3a3d42}
  .dpm-mark{background:#2b2d31;border-color:#3a3d42;color:#b6bac2}
  .dpm-mark-like[data-on]{background:#3a2320;border-color:#6b3a2e;color:#f0a58a}
  .dpm-mark-fav[data-on]{background:#3a3320;border-color:#6b5f2e;color:#e8c46a}
  .dpm-filter{background:#2b2d31;border-color:#3a3d42;color:#b6bac2}
  .dpm-filter[data-on]{background:var(--dpm-brand,#4d6bfe);border-color:var(--dpm-brand,#4d6bfe);color:#fff}
  .dpm-badge-update{background:#20293d;color:#8fb0f5;border-color:#33415e}
  .dpm-badge-current{background:#1e2f24;color:#7fd39b;border-color:#2f4a38}
  /* ★ 对应浅色主题里的 .dpm-btn-installed，已随置灰态一起删除 */
  .dpm-prog{background:#232427;border-color:#34363a}
  .dpm-prog[data-s=succeeded]{background:#1e2f24;border-color:#2f4a38}
  .dpm-prog[data-s=failed]{background:#2f2020;border-color:#4a2f2f}
  .dpm-prog[data-s=cancelled],.dpm-prog[data-s=timeout]{background:#2f2b1e;border-color:#4a4230}
  .dpm-bar{background:#34363a}
  .dpm-phase{border-color:#34363a}
  .dpm-phase[data-s=ok]{border-color:#2f4a38;color:#7fd39b}
  .dpm-phase[data-s=fail]{border-color:#4a2f2f;color:#f0a58a}
  .dpm-phase[data-s=warn]{border-color:#4a4230;color:#e8c46a}
  .dpm-cmd{background:#232427;border-color:#34363a}
  .dpm-cmd-t{color:#dfe3ea}
  .dpm-toast[data-k=info]{background:#20293d;border-color:#33415e;color:#8fb0f5}
  .dpm-toast[data-k=warn]{background:#2f2b1e;border-color:#4a4230;color:#e8c46a}
  .dpm-alert{background:#2f2b1e;border-color:#4a4230}
  .dpm-alert-h,.dpm-alert-t{color:#e8c46a}
  .dpm-alert-item{border-color:#4a4230}
}
`;
		var CSS_TAG_ID = "dsh-plugins-market/panel.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null
		) {
			var styleTag = document.createElement("style");
			styleTag.dataset.plugin = "dsh-plugins-market";
			styleTag.dataset.pluginCss = CSS_TAG_ID;
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
		}
		//#endregion

		//#region ── RPC ──────────────────────────────────────────────────
		var API_PATH = "/dsh-plugins-market/api";

		/** 同源 POST，与宿主既有插件一致的传输方式。 */
		async function api(method, args) {
			var res = await fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: method, args: args || {} }),
			});
			var data;
			try {
				data = await res.json();
			} catch (err) {
				throw new Error("服务端返回了非 JSON 响应（HTTP " + res.status + "）");
			}
			if (!data || data.ok !== true) {
				throw new Error((data && data.error) || "RPC failed (HTTP " + res.status + ")");
			}
			return data.result;
		}
		//#endregion

		//#region ── 小工具 ────────────────────────────────────────────────
		var PANEL_ID = "dsh-plugins-market";

		function txt(v, fallback) {
			return v === null || v === undefined || v === "" ? (fallback === undefined ? "—" : fallback) : String(v);
		}

		/**
		 * 耗时文案。
		 * ★ 有意的取舍：超过 90 秒就不再逐秒跳动，改成「1 分 32 秒」。
		 *   一个每秒都在变的数字会让人盯着它，而安装本来就可能要几分钟；
		 *   给个稳定的量级比给个假的精度更有用。
		 */
		function dur(ms) {
			var s = Math.max(0, Math.round(Number(ms || 0) / 1000));
			if (s < 60) return s + " 秒";
			var m = Math.floor(s / 60);
			var r = s % 60;
			return r ? m + " 分 " + r + " 秒" : m + " 分";
		}

		/** 复制到剪贴板：file:// 与 http://（非 https）下 navigator.clipboard 都可能不可用，必须有兜底 */
		function copyText(text) {
			var s = String(text == null ? "" : text);
			try {
				if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
					navigator.clipboard.writeText(s);
					return true;
				}
			} catch (e) { /* 落到下面的兜底 */ }
			try {
				var ta = document.createElement("textarea");
				ta.value = s;
				ta.setAttribute("readonly", "readonly");
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				document.body.appendChild(ta);
				ta.select();
				var ok = document.execCommand("copy");
				document.body.removeChild(ta);
				return ok;
			} catch (e2) {
				return false;
			}
		}

		function ageText(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "未知";
			var s = Math.floor(ms / 1000);
			if (s < 60) return s + " 秒前";
			var m = Math.floor(s / 60);
			if (m < 60) return m + " 分钟前";
			var hr = Math.floor(m / 60);
			if (hr < 24) return hr + " 小时前";
			return Math.floor(hr / 24) + " 天前";
		}

		function dateText(iso) {
			if (!iso) return "—";
			try {
				var d = new Date(iso);
				if (isNaN(d.getTime())) return String(iso);
				var p = function (n) { return String(n).padStart(2, "0"); };
				return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
			} catch (e) {
				return String(iso);
			}
		}

		/**
		 * 检查项归类。
		 *
		 * ★ 0.6.0 起这里只剩两种用途：**profile 体检**（「已装」页）与装前体检的
		 *   问题清单 —— 都是**诊断**，不再参与任何「放行 / 拦截」判定。
		 *   以前那个多出来的 "overridable" 档（默认拦截但可覆盖）随装前检查一起删了。
		 */
		function classifyCheck(c) {
			if (!c) return "skip";
			if (c.status === "pass") return "pass";
			if (c.status === "skip") return "skip";
			if (c.status === "fail" && c.severity === "fatal") return "fatal";
			if (c.status === "warn" || (c.status === "fail" && c.severity === "warn")) return "warn";
			if (c.status === "fail") return "fatal";
			return "skip";
		}

		/** 安装规格的来源：这份「怎么装」是从哪儿来的 —— 如实标注，别让人以为是探测确认过的 */
		var SPEC_SOURCE_TEXT = {
			config: "插件自己的配置文件",
			"config-command": "插件自己的配置文件（采集来的安装命令）",
			"derived-github": "从仓库地址推导（pnpm 直接解析该仓库）",
			"probed-npm": "探测确认 npm 上有这个包",
			local: "本地指定的安装包",
			repo: "本机仓库里的离线包",
			remote: "仓库托管的离线包（需要下载）",
		};

		function specSourceText(s) {
			return SPEC_SOURCE_TEXT[s] || txt(s, "配置文件");
		}

		function stepIcon(s) {
			if (s === "ok") return "✓";
			if (s === "fail") return "✗";
			if (s === "warn") return "!";
			return "•";
		}

		var FAILURE_TEXT = {
			"no-spec": "没有可自动执行的安装方式 —— 请用下面的手动安装命令。",
			"fetch": "没能拿到安装包（本地没有、下载也失败）。",
			"backup": "备份 profile 失败 —— 出于安全考虑没有继续动任何东西。",
			"preflight": "装前体检发现 profile 有问题（见下方清单）—— 这些问题会让安装变慢甚至必然失败，所以这次没有开始。",
			"install-command": "安装命令以非 0 退出。dsh 在 pnpm 非 0 时不会把包写进 bundles。",
			"verify": "安装命令成功了，但装后校验没通过。",
			"uninstall-command": "卸载命令以非 0 退出。",
			"timeout": "安装超时，已强制中止并回滚。",
			"aborted-by-user": "已按你的要求中止安装。",
			"busy": "已经有一个安装任务在跑 —— 同时改同一个 profile 会互相破坏，所以这次没有开始。",
		};
		//#endregion

		//#region ── 基础组件 ──────────────────────────────────────────────
		/*
		 * ★ variant 到样式类的映射必须**表驱动**，不能写成 if/else 链。
		 *
		 *   原来这里是：
		 *     if (variant === "primary") … else if (variant === "danger") …
		 *   于是新增一个 variant（"update"）时，它不匹配任何分支、也不报错 ——
		 *   按钮照样渲染、能点、文案也对，只是**完全没有样式**，看着像个裸按钮。
		 *   这种「静默丢失」在界面上极难发现（谁会盯着按钮说「它怎么不蓝」）：
		 *   本插件加「更新」按钮时就真的踩了一次，被渲染测试抓出来。
		 *   改成一张表：加 variant 时顺手加一行，漏了也一眼看得出来。
		 */
		var BTN_VARIANTS = {
			primary: "dpm-btn-primary",
			danger: "dpm-btn-danger",
			update: "dpm-btn-update",
		};

		var Btn = function (props) {
			var cls = "dpm-btn";
			var variantCls = BTN_VARIANTS[props.variant];
			if (variantCls) cls += " " + variantCls;
			else if (props.variant) {
				// 认不出的 variant 要吵一声，而不是安静地退化成默认样式
				try { console.warn("[dsh-plugins-market] 未知的按钮 variant：" + props.variant); } catch (e) { /* 忽略 */ }
			}
			if (props.small) cls += " dpm-btn-sm";
			if (props.className) cls += " " + props.className;
			return h(
				"button",
				{
					type: "button",
					className: cls,
					disabled: props.disabled ? true : undefined,
					title: props.title || undefined,
					onClick: props.disabled ? undefined : props.onClick,
				},
				props.children,
			);
		};

		var Badge = function (props) {
			return h("span", { className: "dpm-badge dpm-badge-" + (props.kind || "neutral") }, props.children);
		};

		/*
		 * ── 安装状态 ─────────────────────────────────────────────
		 *
		 * 服务端把每个条目的状态算好了传过来（installState），客户端**只做展示**。
		 * 不在浏览器里比版本号的原因很实际：semver 的预发布规则一错，
		 * 「已是最新」就会说反，而这种错在界面上完全看不出来。
		 * 服务端那份判定有单测覆盖（test/state.test.mjs）。
		 */
		var STATE_TEXT = {
			"not-installed": "未安装",
			"current": "已是最新",
			"upgradable": "可升级",
			"older": "已装（更新）",
			"unknown": "已安装",
		};

		function stateOf(entry) {
			return (entry && entry.installState) || { status: "not-installed", installed: false, canInstall: true, action: "install" };
		}

		/** 主按钮文案：没装 → 安装；有新版 → 更新到 x.y.z；已最新 → 重新安装 */
		function primaryLabel(entry) {
			var st = stateOf(entry);
			if (st.status === "upgradable") return "更新到 " + txt(st.target, "新版本");
			if (st.status === "current") return "重新安装";
			if (st.installed) return "重新安装";
			return "安装";
		}

		/**
		 * 主按钮是否禁用。
		 *
		 * ★ 0.6.0 起这个函数**恒为 false**：市场不再拦任何插件，所有插件都可装。
		 *   保留成函数而不是删掉，是因为「按钮能不能点」这件事在结构上仍然属于
		 *   卡片自己的状态判断 —— 将来若真有「点了也没意义」的情形（例如任务在跑
		 *   时的并发保护），入口在这里，而不是散在 JSX 里。
		 *   「已是最新版」**不再**是这种情形：重装是正当需求，文案是「重新安装」。
		 */
		function primaryDisabled(entry) {
			var st = stateOf(entry);
			if (st.status === "current") return false;
			// 「装了但没挂载」是坏状态，这时候必须允许重装，不能置灰
			if (st.installed && !st.inBundles) return false;
			return false;
		}

		function primaryTitle(entry) {
			var st = stateOf(entry);
			if (st.status === "current") {
				return "已经装的是 " + txt(st.installedVersion) + "，与目录里的版本一致。点进去可以选择重新安装（装坏了要修、想换一种装法、或者只想确认命令能跑通）。";
			}
			if (st.status === "upgradable") {
				return "已装 " + txt(st.installedVersion) + "，目录里是 " + txt(st.target) + "。更新会先移除旧版本再装新版本（会自动备份，失败自动回滚）。";
			}
			if (st.status === "unknown" && st.installed) return st.reason || "已安装，但无法判断目录里的版本是否更新。";
			return null;
		}

		/** 「安装状态」徽标（未安装时不显示 —— 没有信息量，只会占地方） */
		function installBadge(entry) {
			var st = stateOf(entry);
			if (!st.installed) return null;
			if (st.status === "upgradable") return h(Badge, { kind: "update" }, "可升级 " + txt(st.target));
			if (st.status === "current") return h(Badge, { kind: "current" }, "已是最新 " + txt(st.installedVersion));
			if (!st.inBundles) return h(Badge, { kind: "bad" }, "装了未挂载");
			return h(Badge, { kind: "ok" }, "已安装 " + txt(st.installedVersion));
		}

		var Chip = function (props) {
			return h("span", { className: "dpm-chip" }, props.children);
		};

		/*
		 * ── 收藏 ─────────────────────────────────────────────────────
		 *
		 * 它是**本地标记**，不上传、不做排行榜 —— 因为本插件没有后端，
		 * 假装有全局热度是骗人；界面上也如实写成「记在本机」。
		 *
		 * 交互上刻意做成「乐观更新」：点下去立刻变色，请求失败再回滚。
		 * 这个动作只是写一个本地 JSON，失败概率极低，等往返反而显得卡。
		 */
		var MarkButton = function (props) {
			var on = Boolean(props.on);
			var cls = "dpm-mark dpm-mark-fav";
			return h(
				"button",
				{
					type: "button",
					className: cls,
					"data-on": on ? "1" : undefined,
					disabled: props.disabled ? true : undefined,
					title: props.title || undefined,
					onClick: props.disabled ? undefined : props.onClick,
					"aria-pressed": on ? "true" : "false",
				},
				h("span", { className: "dpm-mark-ico" }, props.kind === "like" ? (on ? "♥" : "♡") : (on ? "★" : "☆")),
				h("span", null, props.label),
			);
		};

		function Flag(props) {
			return h("div", { className: "dpm-flag dpm-flag-" + props.kind }, h("span", null, props.icon), h("span", null, props.children));
		}

		var Spinner = function () {
			return h("span", { className: "dpm-spin" });
		};

		var Empty = function (props) {
			return h("div", { className: "dpm-empty" }, props.children);
		};

		/** 折叠区块，默认展开与否可配 —— 「通过」项默认折叠，避免淹没重点。 */
		var Fold = function (props) {
			var st = useState(props.defaultOpen !== false);
			var open = st[0];
			var setOpen = st[1];
			return h(
				"div",
				{ className: "dpm-group" },
				h(
					"div",
					{ className: "dpm-group-h", onClick: function () { setOpen(!open); } },
					h("span", null, open ? "▾" : "▸"),
					h("span", null, props.title),
					props.count !== undefined ? h("span", { className: "dpm-muted" }, "(" + props.count + ")") : null,
				),
				open ? props.children : null,
			);
		};

		/**
		 * 一条诊断结论。
		 *
		 * ★ 0.6.0 起它只出现在**体检**里（profile 体检、装前体检的问题清单）——
		 *   是「这台机器哪儿不对」，不是「这个插件能不能装」。
		 *   所以文案里不再有「拦截 / 覆盖」这类放行词汇。
		 */
		var CheckItem = function (props) {
			var c = props.check || {};
			var kind = classifyCheck(c);
			var sev = kind === "fatal" ? "fatal" : kind === "warn" ? "warn" : kind === "pass" ? "info" : "skip";
			return h(
				"div",
				{ className: "dpm-check", "data-sev": sev },
				h(
					"div",
					{ className: "dpm-check-top" },
					h("span", { className: "dpm-check-t" }, txt(c.title, c.id)),
					h(Badge, { kind: kind === "fatal" ? "bad" : kind === "pass" ? "ok" : "neutral" },
						kind === "fatal" ? "有问题"
							: kind === "warn" ? "提醒"
								: kind === "pass" ? "通过"
									: "跳过"),
					c.id ? h("span", { className: "dpm-card-id" }, c.id) : null,
				),
				c.detail ? h("p", { className: "dpm-check-d" }, c.detail) : null,
				c.hint ? h("p", { className: "dpm-check-hint" }, "建议：" + c.hint) : null,
				c.repairable ? h("p", { className: "dpm-check-hint" }, "（这一项可以自动修复）") : null,
				Array.isArray(c.rows) && c.rows.length > 0
					? h("pre", { className: "dpm-pre" }, c.rows.map(function (r) {
						return [r.key, "要求 " + r.range, "本机 " + (r.actual || "未找到"), r.result].filter(Boolean).join("  ");
					}).join("\n"))
					: null,
			);
		};

		var StepList = function (props) {
			var steps = props.steps || [];
			if (steps.length === 0) return null;
			return h(
				"div",
				{ className: "dpm-steps" },
				steps.map(function (s, i) {
					return h(
						"div",
						{ key: (s.id || "step") + "-" + i, className: "dpm-step", "data-s": s.status || "running" },
						h("span", { className: "dpm-step-ico" }, s.status === "running" ? h(Spinner, null) : stepIcon(s.status)),
						h(
							"div",
							{ style: { minWidth: 0, flex: "1 1 auto" } },
							h("div", { className: "dpm-step-l" }, txt(s.label, s.id)),
							s.detail ? h("div", { className: "dpm-step-d" }, s.detail) : null,
							s.output ? h("pre", { className: "dpm-pre" }, s.output) : null,
						),
					);
				}),
			);
		};

		//#region ── 命令框 / 安装进度 / 手动安装 ──────────────────────────

		/**
		 * 一条命令 + 复制按钮。
		 *
		 * ★ 复制按钮必须**每条命令一个**，不能只在整段上放一个「复制全部」：
		 *   用户真正会做的事是「就敲这一条」。整段复制反而要他手工删掉注释行。
		 */
		var CopyBox = function (props) {
			var st = useState(null);
			var copied = st[0];
			var setCopied = st[1];
			var text = String(props.text || "");
			var isComment = props.kind === "comment" || /^\s*#/.test(text);
			return h(
				"div",
				{ className: "dpm-cmd", "data-comment": isComment ? "1" : undefined },
				h("code", { className: "dpm-cmd-t" }, text),
				isComment
					? null
					: h(Btn, {
						small: true,
						className: "dpm-cmd-copy",
						onClick: function () {
							var ok = copyText(text);
							setCopied(ok ? "ok" : "fail");
							setTimeout(function () { setCopied(null); }, 1600);
						},
					}, copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制"),
			);
		};

		/** 一组命令（同一个 shell），可整组复制 */
		var CmdGroup = function (props) {
			var cmds = props.commands || [];
			if (cmds.length === 0) return null;
			var joined = cmds.map(function (c) { return c.text; }).join("\n");
			return h(
				"div",
				{ className: "dpm-cmdgroup" },
				cmds.map(function (c, i) { return h(CopyBox, { key: "c" + i, text: c.text, kind: c.kind }); }),
				cmds.length > 1
					? h("div", { className: "dpm-cmdgroup-foot" },
						h(Btn, {
							small: true,
							onClick: function () { copyText(joined); },
						}, "复制这 " + cmds.length + " 条"),
					)
					: null,
			);
		};

		/** 命令按 shell 分类：用户用的是哪种，自己要能选 */
		function pickShell(commands, pref) {
			var has = {};
			(commands || []).forEach(function (c) { has[c.shell || "any"] = true; });
			if (pref && (has[pref] || has.any)) return pref;
			for (var i = 0; i < (commands || []).length; i++) {
				if (commands[i].shell && commands[i].shell !== "any") return commands[i].shell;
			}
			return "any";
		}

		var SHELL_LABEL = { powershell: "PowerShell", bash: "bash / Git Bash", any: "任意终端" };

		/**
		 * 手动安装面板。
		 *
		 * ★ 这是用户明确要求的能力：自动安装卡住时，他必须能「停下来，自己敲命令装」。
		 *   所以这里给的不是「请联系维护者」，而是一份**拿到就能执行**的方案：
		 *   装哪个文件（含 sha256）、敲哪条命令、装完怎么确认、出问题怎么办。
		 */
		var ManualPanel = function (props) {
			var plan = props.plan;
			var st = useState(null);
			var shell = st[0];
			var setShell = st[1];
			var saveSt = useState(null);
			var saved = saveSt[0];
			var setSaved = saveSt[1];
			if (!plan) {
				return h("div", { className: "dpm-muted" }, "手动安装方案正在生成…");
			}

			var kinds = [];
			(plan.steps || []).forEach(function (s) {
				(s.commands || []).forEach(function (c) {
					var k = c.shell || "any";
					if (kinds.indexOf(k) < 0 && !(k === "any" && kinds.length > 0)) kinds.push(k);
				});
			});
			if (kinds.indexOf("any") >= 0 && kinds.length > 1) kinds = kinds.filter(function (k) { return k !== "any"; });
			var active = shell || pickShell(plan.steps && plan.steps[0] ? plan.steps[0].commands : [], null) || "any";

			return h(
				"div",
				{ className: "dpm-manual" },
				h("div", { className: "dpm-manual-h" },
					h("span", null, "手动安装（同样的效果，你自己敲命令）"),
				),
				h("div", { className: "dpm-muted", style: { marginBottom: 8 } },
					"自动安装卡住、失败、或者你只是想自己掌控节奏时，用下面这套。方案里的 tarball 就是本次自动化会用的那一个（本仓库为每条插件都存了快照）。"),

				h("div", { className: "dpm-kv" },
					h("span", { className: "dpm-kv-k" }, "安装包"),
					h("span", { className: "dpm-kv-v dpm-mono" }, txt(plan.tarball || plan.tarballUrl)),
					h("span", { className: "dpm-kv-k" }, "来源"),
					h("span", { className: "dpm-kv-v" }, txt(plan.tarballSourceText)),
					plan.sha256
						? h("span", { className: "dpm-kv-k" }, "sha256")
						: null,
					plan.sha256
						? h("span", { className: "dpm-kv-v dpm-mono" }, plan.sha256)
						: null,
					h("span", { className: "dpm-kv-k" }, "profile"),
					h("span", { className: "dpm-kv-v dpm-mono" }, txt(plan.profile)),
				),
				plan.sha256Note ? h("div", { className: "dpm-muted", style: { marginBottom: 8 } }, plan.sha256Note) : null,

				kinds.length > 1
					? h("div", { className: "dpm-shellpick" },
						kinds.map(function (k) {
							return h(Btn, {
								key: k, small: true, variant: active === k ? "primary" : undefined,
								onClick: function () { setShell(k); },
							}, SHELL_LABEL[k] || k);
						}))
					: null,

				(plan.steps || []).map(function (s, i) {
					var cmds = (s.commands || []).filter(function (c) {
						var k = c.shell || "any";
						return k === "any" || kinds.length <= 1 || k === active;
					});
					if (cmds.length === 0) return null;
					return h("div", { key: s.id || i, className: "dpm-manual-step" },
						h("div", { className: "dpm-manual-t" }, txt(s.title, s.id)),
						s.why ? h("div", { className: "dpm-muted" }, s.why) : null,
						h(CmdGroup, { commands: cmds }),
						(s.tips || []).length > 0
							? h("div", { className: "dpm-manual-tips" }, (s.tips || []).map(function (t, j) { return h("div", { key: "t" + j }, "· " + t); }))
							: null,
					);
				}),

				(plan.notes || []).length > 0
					? h("div", { className: "dpm-manual-tips" }, plan.notes.map(function (t, j) { return h("div", { key: "n" + j }, "· " + t); }))
					: null,

				h(Fold, { title: "出问题时怎么办", count: (plan.recovery || []).length, defaultOpen: false },
					(plan.recovery || []).map(function (r, i) {
						var cmds = (r.commands || []).filter(function (c) {
							var k = c.shell || "any";
							return k === "any" || kinds.length <= 1 || k === active;
						});
						return h("div", { key: r.id || i, className: "dpm-manual-step" },
							h("div", { className: "dpm-manual-t" }, txt(r.title, r.id)),
							r.why ? h("div", { className: "dpm-muted" }, r.why) : null,
							h(CmdGroup, { commands: cmds }),
						);
					})),

				h("div", { className: "dpm-split", style: { marginTop: 10 } },
					h(Btn, {
						small: true,
						onClick: function () { copyText(plan.text || ""); },
					}, "复制整份方案（纯文本）"),
					h(Btn, {
						small: true,
						onClick: function () {
							setSaved("saving");
							api("manualCommands", { id: plan.package, save: "txt" })
								.then(function (r) { setSaved(r && r.saved && r.saved.file ? r.saved.file : "ok"); })
								.catch(function () { setSaved("fail"); });
						},
					}, "另存为 .txt"),
					h(Btn, {
						small: true,
						onClick: function () {
							setSaved("saving");
							api("manualCommands", { id: plan.package, save: "ps1" })
								.then(function (r) { setSaved(r && r.saved && r.saved.file ? r.saved.file : "ok"); })
								.catch(function () { setSaved("fail"); });
						},
					}, "另存为 .ps1"),
					h(Btn, {
						small: true,
						onClick: function () {
							setSaved("saving");
							api("manualCommands", { id: plan.package, save: "sh" })
								.then(function (r) { setSaved(r && r.saved && r.saved.file ? r.saved.file : "ok"); })
								.catch(function () { setSaved("fail"); });
						},
					}, "另存为 .sh"),
				),
				saved
					? h("div", { className: "dpm-muted", style: { marginTop: 6 } },
						saved === "saving" ? "正在写文件…"
							: saved === "fail" ? "写文件失败 —— 用上面的「复制整份方案」也一样。"
								: ("已写入：" + saved))
					: null,
			);
		};

		/**
		 * 安装进度面板。
		 *
		 * ★ 三个必须存在的元素（缺一个这个面板就没意义）：
		 *   1. **现在在哪一步** —— 阶段名 + 已耗时
		 *   2. **还要多久** —— 预计剩余（区间，不是假精确值）
		 *   3. **怎么退出** —— 中止按钮，永远可见（排队中也能中止）
		 *
		 * ★ 0.6.0 补上第四个：**正在装的是什么、用什么方式装**。
		 *   自动安装的整个卖点就是「命令窗口不会弹出来」—— 那市场就必须自己
		 *   把这件事说清楚，否则用户面对的就是一段无法观察的黑盒等待。
		 *   包名、版本、方式、规格全部由任务快照带过来（关掉页面再回来也还在）。
		 */
		var ProgressPanel = function (props) {
			var job = props.job;
			if (!job) return null;
			var phases = job.allPhases || [];
			var done = 0;
			var total = 0;
			phases.forEach(function (p) {
				var w = 1;
				if (p.state === "ok") done += w;
				else if (p.state === "running") done += 0.45 * w;
				total += w;
			});
			var pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
			var running = job.state === "queued" || job.state === "running";
			if (job.state === "succeeded") pct = 100;

			var entry = job.entry || {};
			var auto = job.auto || null;

			return h("div", { className: "dpm-prog", "data-s": job.state },
				// ① 正在装什么 —— 一行标题，别让人回头翻卡片
				h("div", { className: "dpm-prog-what" },
					h("span", { className: "dpm-prog-pkg" }, txt(entry.package || job.pkgName || job.pluginId, "插件")),
					entry.version ? h("span", { className: "dpm-prog-ver" }, "@" + txt(entry.version)) : null,
					job.kind === "upgrade" ? h(Badge, { kind: "update" }, "更新") : null,
					job.reinstall ? h(Badge, { kind: "neutral" }, "重新安装") : null,
					h("span", { className: "dpm-spacer" }),
					h(Badge, { kind: "neutral" }, "自动安装"),
				),

				// ② 方式 / 规格 / profile：自动安装在界面上不显示命令窗口，
				//    所以这条命令本身必须能被看见（不是日志，是「市场替你跑了什么」）
				auto
					? h("div", { className: "dpm-prog-meta" },
						h("span", null, "方式 " + txt(auto.kind)),
						h("span", { className: "dpm-mono", title: txt(auto.spec) }, txt(auto.spec)),
						auto.needsDownload ? h("span", null, "需要先下载安装包") : null,
						job.profile ? h("span", null, "profile " + txt(job.profile)) : null,
					)
					: null,

				h("div", { className: "dpm-prog-head" },
					running ? h(Spinner, null) : h("span", { className: "dpm-prog-ico" },
						job.state === "succeeded" ? "✓" : job.state === "cancelled" ? "■" : job.state === "timeout" ? "⏱" : "✗"),
					h("span", { className: "dpm-prog-title" },
						job.state === "queued"
							? "排队中（前面还有一个安装任务在跑）"
							: job.state === "running"
								? txt(job.currentPhaseLabel, "准备中")
								: job.state === "succeeded" ? "安装完成"
									: job.state === "cancelled" ? "已中止"
										: job.state === "timeout" ? "超时已中止" : "安装失败"),
					h("span", { className: "dpm-spacer" }),
					h("span", { className: "dpm-prog-eta" },
						running
							? (job.eta && job.eta.text ? job.eta.text : "正在估算…")
							: "用时 " + dur(job.elapsedMs)),
				),
				h("div", { className: "dpm-bar" }, h("div", { className: "dpm-bar-fill", style: { width: pct + "%" } })),
				h("div", { className: "dpm-prog-sub" },
					h("span", null, "已用 " + dur(job.elapsedMs)),
					job.currentPhase && running ? h("span", null, "· 本步已用 " + dur(job.currentPhaseElapsedMs)) : null,
					job.startedAt ? h("span", null, "· 开始于 " + new Date(job.startedAt).toLocaleTimeString()) : null,
				),

				// 疑似卡住：如实说，并把「中止 → 手动装」这条出路摆在旁边
				job.staleness
					? h(Flag, { kind: job.staleness.level === "stalled" ? "risk" : "info", icon: job.staleness.level === "stalled" ? "!" : "…" },
						job.staleness.text)
					: null,

				// 中止请求已发出：说明接下来会发生什么，避免用户以为「按了没反应」
				job.abortRequestedAt && running
					? h(Flag, { kind: "warn", icon: "■" }, "已发出中止请求：正在结束 pnpm 进程（连同它的子进程），随后会用安装前的快照还原 profile。这一步不能打断。")
					: null,

				// 阶段清单：让人看到「已经过了哪几步」，而不是只有一个转圈
				h("div", { className: "dpm-phases" },
					phases.map(function (p) {
						return h("span", {
							key: p.id, className: "dpm-phase", "data-s": p.state,
							title: p.label,
						}, (p.state === "ok" ? "✓ " : p.state === "running" ? "▶ " : p.state === "fail" ? "✗ " : "○ ") + p.label);
					})),

				(job.pnpmTail || []).length > 0
					? h(Fold, { title: "pnpm 实时输出", count: job.pnpmTail.length, defaultOpen: true },
						h("pre", { className: "dpm-pre" }, job.pnpmTail.join("\n")))
					: null,
			);
		};
		//#endregion

		/** 渲染崩溃兜底：宁可只坏这一块，也不能把整页带走。 */
		var ErrorBoundary = function (props) {			var st = useState(null);
			var err = st[0];
			var setErr = st[1];
			useEffect(function () {
				if (!err) return undefined;
				return undefined;
			}, [err]);
			if (err) {
				return h(
					"div",
					{ className: "dpm-err" },
					h("strong", null, (props.label || "插件市场") + " 渲染出错"),
					h("div", { style: { marginTop: 6 } }, String(err && err.message ? err.message : err)),
					h("button", { type: "button", className: "dpm-btn dpm-btn-sm", style: { marginTop: 10 }, onClick: function () { setErr(null); } }, "重试"),
				);
			}
			return h(ErrorCatcher, { onError: setErr }, props.children);
		};

		/** React 没有函数组件版的 componentDidCatch，用一个极小的 class 桥接。 */
		var ErrorCatcher = (function () {
			function Catcher(props) {
				react.Component.call(this, props);
				this.state = { failed: false };
			}
			Catcher.prototype = Object.create(react.Component.prototype);
			Catcher.prototype.constructor = Catcher;
			Catcher.getDerivedStateFromError = function () {
				return { failed: true };
			};
			Catcher.prototype.componentDidCatch = function (error) {
				if (this.props && typeof this.props.onError === "function") this.props.onError(error);
			};
			Catcher.prototype.render = function () {
				if (this.state.failed) return null;
				return this.props.children;
			};
			return Catcher;
		})();
		//#endregion

		//#region ── 左侧导航图标 ──────────────────────────────────────────
		/* owner 会传 { size, active }，并把它渲染在官方 .panelRow 里，
		   颜色走 currentColor 即可自动跟随选中态。 */
		var RailIcon = function (props) {
			var size = props && props.size ? props.size : 18;
			return h(
				"svg",
				{
					width: size, height: size, viewBox: "0 0 24 24", fill: "none",
					stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
					"aria-hidden": "true", focusable: "false",
				},
				h("path", { d: "M3 9.5 5 4h14l2 5.5" }),
				h("path", { d: "M4 9.5h16V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5Z" }),
				h("path", { d: "M9 13.5h6" }),
			);
		};
		//#endregion

		//#region ── 条目卡片 ──────────────────────────────────────────────
		var EntryCard = function (props) {
			var e = props.entry || {};
			var peerVerdict = e.peerVerdict;
			var st = stateOf(e);
			var badge = installBadge(e);

			return h(
				"div",
				{ className: "dpm-card" },
				h(
					"div",
					{ className: "dpm-card-top" },
					h("span", { className: "dpm-card-name" }, txt(e.title, e.id)),
					e.version ? h("span", { className: "dpm-card-id" }, (e.package || e.id) + "@" + e.version) : h("span", { className: "dpm-card-id" }, txt(e.package, e.id)),
					badge,
					e.favorited ? h(Badge, { kind: "neutral" }, "★ 已收藏") : null,
				),

				// ★ 0.5.0 去掉了「已验证 / 已审核 / 未审核」三条横幅与卡片角标。
				//   目录就是一份平铺列表，这里不再替用户给插件分级。
				//   真正要说清楚的是下面这些**具体事实**：有没有新版、装没装好、peer 能不能配上。

				// ★ 升级提示（问题 1）：装过、仓库里有新版
				st.status === "upgradable"
					? h(Flag, { kind: "info", icon: "↑" }, "有新版本：" + txt(st.installedVersion) + " → " + txt(st.target) + "。点「更新到 " + txt(st.target) + "」即可升级；会自动备份 profile，失败自动回滚。")
					: null,
				st.installed && !st.inBundles
					? h(Flag, { kind: "bad", icon: "!" }, "已经装在 node_modules 里，却不在 dsh.profile.bundles 中 —— 这种状态下 GUI 里看不到它。重新安装可以让 dsh 重新对齐。")
					: null,

				peerVerdict === "critical"
					? h(Flag, { kind: "bad", icon: "✗" }, "该包精确 pin 了 dsh 运行时版本，换版本会导致整棵插件树加载失败。")
					: null,
				peerVerdict === "warn"
					? h(Flag, { kind: "risk", icon: "!" }, "该包的 peer 约束与当前 dsh 只是警告级不匹配，实测通常仍可加载。")
					: null,
				e.needsConfig ? h(Flag, { kind: "info", icon: "i" }, "安装后需要配置（API Key / Token 等）。") : null,
				e.risky ? h(Flag, { kind: "risk", icon: "!" }, "公共索引把这一条标记为有风险。") : null,

				e.summary ? h("p", { className: "dpm-card-sum" }, e.summary) : null,

				h(
					"div",
					{ className: "dpm-card-meta" },
					e.author ? h(Chip, null, "作者 " + e.author) : null,
					typeof e.stars === "number" ? h(Chip, null, "★ " + e.stars) : null,
					e.license ? h(Chip, null, e.license) : null,
					e.pushedAt ? h(Chip, null, "更新 " + String(e.pushedAt).slice(0, 10)) : null,
					(e.tags || []).slice(0, 5).map(function (t, i) { return h(Chip, { key: "t" + i }, t); }),
				),

				h(
					"div",
					{ className: "dpm-card-act" },
					/*
					 * ★ 卡片上只剩一个安装入口。
					 *
					 *   以前这里是两个按钮：「装前检查」+「安装」—— 前者先给人一份
					 *   判定，后者才真的装。0.6.0 把装前检查删掉之后，那个按钮就没有
					 *   存在的理由了：点「安装」直接进安装方案页，**在里面选**
					 *   自动还是手动。一个入口，两条路，不再有中间那个判决。
					 *
					 *   「已是最新版」也不再置灰 —— 重装是正当需求（修坏了、
					 *   换装法、验证命令），文案变成「重新安装」。
					 */
					h(Btn, {
						small: true,
						variant: st.status === "upgradable" ? "update" : "primary",
						title: primaryTitle(e) || undefined,
						onClick: function () { props.onInstall(e, true); },
					}, primaryLabel(e)),
					h(MarkButton, {
						kind: "fav",
						on: e.favorited,
						label: e.favorited ? "已收藏" : "收藏",
						title: "收藏（只记在本机，可用「我收藏的」筛选）",
						onClick: function () { props.onMark(e, "favorite"); },
					}),
					e.upstream ? h(Btn, { small: true, onClick: function () { try { window.open(e.upstream, "_blank", "noopener"); } catch (err) { /* 忽略 */ } } }, "仓库") : null,
				),
			);
		};
		//#endregion

		//#region ── 安装方案抽屉（选自动 / 手动）────────────────────────
		/**
		 * 安装方案抽屉。
		 *
		 * ★ 这里以前是「装前检查」：它先给一个 verdict，然后按钮可能被禁掉。
		 *   0.6.0 把它换成了**一个选择**而不是一个判决 —— 市场不再拦任何插件，
		 *   它只回答「怎么装」：
		 *
		 *     自动安装   市场替你执行命令，界面上不会出现命令窗口，
		 *                安装过程用进度页展示（见 ProgressPanel）
		 *     手动安装   把命令给你，你自己执行 —— 节奏完全由你控制
		 *
		 *   两条路**同时摆在最上面**，谁都不藏在折叠里。原因很直接：用户点进
		 *   「安装」是想装东西，不是想看一份体检报告；而「不给命令」和「不给按钮」
		 *   都会让他卡在原地。
		 *
		 *   `notes` 是我们知道的**事实**（没声明 dsh.bundle、与已装的冲突、
		 *   需要配置…）—— 它们以提示的形式列在最后，不改变任何按钮的可用性。
		 */
		var InstallPlanDrawer = function (props) {
			var plan = props.plan;
			/**
			 * 选中哪条路。
			 *
			 * ★ 这里**刻意不用 useEffect 去「同步」默认值**。
			 *
			 *   用 effect 写（`useEffect(() => setMethod(default), [plan.pluginId])`）
			 *   看着直观，但它是「先渲染错的、再纠正」——中间那一帧是真的会画出来的，
			 *   而且把「默认值是什么」这件事从一个纯函数变成了时序问题。
			 *   这里改成在渲染期直接推导：记住用户选的是哪个插件的哪条路，
			 *   换插件时那条记忆自然失效，于是回落到默认值。没有 effect、没有中间帧。
			 */
			var [choice, setChoice] = useState(null); // { forId, method }
			var planId = plan ? plan.pluginId : null;
			var chosen = choice && choice.forId === planId ? choice.method : null;

			if (!plan) {
				return h(
					"div",
					{ className: "dpm-drawer-body" },
					h("div", { className: "dpm-split" }, h(Spinner, null),
						h("span", null, "正在生成安装方案…（读取这个插件的配置文件、解析出可执行的安装规格）")),
				);
			}

			var auto = plan.auto || { available: false, reason: "没有可自动执行的安装方式。" };
			var active = chosen || (auto.available ? "auto" : "manual");
			var st = plan.installState || null;
			var reinstall = Boolean(plan.alreadyLatest);
			var pick = function (m) { setChoice({ forId: planId, method: m }); };

			/** 一张方式卡：两种方式用同一个组件渲染，避免它们长得不一样 */
			var MethodCard = function (p) {
				var on = active === p.value;
				return h("button", {
					type: "button",
					className: "dpm-method",
					"data-on": on ? "1" : undefined,
					"data-off": p.value === "auto" && !auto.available ? "1" : undefined,
					disabled: p.disabled,
					onClick: function () { if (!p.disabled) pick(p.value); },
				},
					h("span", { className: "dpm-method-ico" }, p.ico),
					h("span", { className: "dpm-method-t" }, p.title),
					h("span", { className: "dpm-method-d" }, p.desc),
					on ? h("span", { className: "dpm-method-on" }, "已选择") : null,
				);
			};

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
				h(
					"div",
					{ className: "dpm-drawer-body" },

					// ── 这个插件是什么、现在处于什么状态 ──────────────
					h(
						"div",
						{ className: "dpm-kv" },
						h("span", { className: "dpm-kv-k" }, "插件"),
						h("span", { className: "dpm-kv-v" }, txt(plan.package || plan.pluginId)),
						h("span", { className: "dpm-kv-k" }, "目录里的版本"),
						h("span", { className: "dpm-kv-v" }, txt(plan.version)),
						h("span", { className: "dpm-kv-k" }, "目标 profile"),
						h("span", { className: "dpm-kv-v" }, txt(props.profile, "—")),
						plan.upstream
							? h("span", { className: "dpm-kv-k" }, "仓库")
							: null,
						plan.upstream
							? h("span", { className: "dpm-kv-v" }, h("a", {
								href: plan.upstream, target: "_blank", rel: "noopener noreferrer",
								style: { color: "inherit" },
							}, txt(plan.upstream)))
							: null,
						st && st.installed ? h("span", { className: "dpm-kv-k" }, "当前已装") : null,
						st && st.installed ? h("span", { className: "dpm-kv-v" }, txt(st.installedVersion)) : null,
					),

					plan.upgrade
						? h(Flag, { kind: "info", icon: "↑" },
							"这是一次**更新**：" + txt(st && st.installedVersion) + " → " + txt(st && st.target)
							+ "。会先移除旧版本再装新版本；安装前自动备份 profile，任何一步失败都会自动回滚。")
						: null,
					reinstall
						? h(Flag, { kind: "info", icon: "↻" },
							"已经装的是同一版本（" + txt(st && st.installedVersion) + "）。再装一次是**重新安装** —— "
							+ "装坏了要修、想换一种装法、或者只是想确认命令能跑通时都该走这条路。profile 一样先备份、失败一样回滚。")
						: null,

					// ── 核心：选哪条路 ───────────────────────────────
					h("div", { className: "dpm-method-head" }, "选择安装方式"),
					h("div", { className: "dpm-methods" },
						h(MethodCard, {
							value: "auto",
							ico: "⚡",
							title: "自动安装",
							desc: auto.available
								? "市场替你执行安装命令，界面上不会弹出命令窗口，安装过程用进度页展示。"
								: "这个条目没有可自动执行的安装方式，请看右边的手动安装。",
							disabled: !auto.available,
						}),
						h(MethodCard, {
							value: "manual",
							ico: "⌨",
							title: "手动安装",
							desc: "把安装命令给你，你自己在终端里执行，节奏完全由你控制。",
						}),
					),

					/**
					 * ★ 自动那条路不可用时，**原因永远显示**（不管当前选的是哪条路）。
					 *
					 *   以前这句只在「选中自动」时才渲染，于是默认落到手动之后，用户
					 *   只看得到命令，看不到「为什么没有自动」——他会以为是自己没找到按钮。
					 */
					!auto.available
						? h("div", { style: { marginTop: 10 } }, h(Flag, { kind: "info", icon: "i" }, auto.reason))
						: null,

					// ── 自动那条路的细节 ─────────────────────────────
					active === "auto" && auto.available
						? h("div", { className: "dpm-plan-box" },
							h("div", { className: "dpm-kv" },
								h("span", { className: "dpm-kv-k" }, "方式"),
								h("span", { className: "dpm-kv-v" }, txt(auto.kind)),
								h("span", { className: "dpm-kv-k" }, "规格"),
								h("span", { className: "dpm-kv-v dpm-mono" }, txt(auto.spec)),
								h("span", { className: "dpm-kv-k" }, "来源"),
								h("span", { className: "dpm-kv-v" }, specSourceText(auto.source)),
								auto.needsDownload ? h("span", { className: "dpm-kv-k" }, "需要下载") : null,
								auto.needsDownload ? h("span", { className: "dpm-kv-v" }, "是，安装时会先下载安装包再校验") : null,
								auto.sha256 ? h("span", { className: "dpm-kv-k" }, "sha256") : null,
								auto.sha256 ? h("span", { className: "dpm-kv-v dpm-mono" }, auto.sha256) : null,
							),
							h("div", { className: "dpm-muted" },
								"点「开始安装」之后，市场会在服务端跑这条命令：命令窗口不会弹出来，"
								+ "你在下面这个页面能看到阶段、耗时、预计剩余和实时输出，也可以随时中止。"
								+ "关掉这个页面任务不会停，回来还能接着看。"),
						)
						: null,

					// ── 手动那条路：命令直接铺在这里 ─────────────────
					active === "manual"
						? h("div", { style: { marginTop: 12 } }, h(ManualPanel, { plan: props.manual }))
						: null,

					// ── 我们知道的事实（提示，不是判决）───────────────
					(plan.notes || []).length > 0
						? h(Fold, { title: "装之前你可能想知道", count: plan.notes.length, defaultOpen: true },
							plan.notes.map(function (n, i) {
								return h("div", { key: n.id || i, className: "dpm-note" },
									h("span", { className: "dpm-note-ico" }, "·"),
									h("span", null, txt(n.text)));
							}))
						: null,

					plan.configError
						? h(Flag, { kind: "warn", icon: "!" },
							"读这个插件的配置文件时出了问题：" + txt(plan.configError)
							+ "。下面展示的安装方案来自目录索引，可能与配置文件不一致。")
						: null,
				),

				h(
					"div",
					{ className: "dpm-drawer-foot" },
					active === "auto" && auto.available
						? h(Btn, {
							variant: plan.upgrade ? "update" : "primary",
							disabled: Boolean(props.busy),
							onClick: function () { props.onAutoInstall(plan); },
						}, props.busy ? "正在启动…" : (plan.upgrade ? "开始更新" : reinstall ? "重新安装" : "开始安装"))
						: h(Btn, {
							variant: "primary",
							onClick: function () { props.onCopyManual(plan); },
						}, "复制全部命令"),
					h(Btn, { onClick: props.onClose, disabled: Boolean(props.busy) }, "取消"),
					h("span", { className: "dpm-spacer" }),
					h("span", { className: "dpm-muted" },
						active === "auto"
							? (auto.available
								? (plan.upgrade ? "会自动先移除旧版本" : "会自动备份 profile，失败自动回滚")
								: "这条插件没有可自动执行的安装方式，请用手动安装")
							: "命令在上方，复制后在终端里执行即可"),
				),
			);
		};
		//#endregion

		//#region ── 安装进度 ──────────────────────────────────────────────
		/**
		 * 安装抽屉。
		 *
		 * ★ 与旧版的根本差别：旧版是「等一个 Promise」，期间只有一句
		 *   「正在安装…请勿关闭页面」，没有任何出口。现在它是**任务视图**：
		 *
		 *   - 进度来自轮询服务端的任务快照（阶段、已耗时、预计剩余、pnpm 输出）
		 *   - 「中止安装」按钮永远可见，且真的会杀掉 pnpm 的整棵进程树
		 *   - 「手动安装」始终挂在下面 —— 不等失败就能看到，这才是真正的兜底
		 *   - 关掉这个抽屉不会中止任务；重新打开还能接着看
		 */
		var InstallView = function (props) {
			var r = props.result;
			var job = props.job;
			var plan = props.manual;

			var running = job && (job.state === "queued" || job.state === "running");
			var steps = (job && job.steps) || (r && r.steps) || [];

			if (!job && !r) {
				return h("div", { className: "dpm-drawer-body" },
					h("div", { className: "dpm-split" }, h(Spinner, null), h("span", null, "正在启动安装任务…")),
					h("div", { className: "dpm-muted" }, "安装会在服务端后台进行：你可以关掉这个页面，任务不会中断，回来还能看到进度。"),
				);
			}

			var rolledOk = r && r.rollback && r.rollback.ok;
			var aborted = (r && r.aborted) || (job && job.state === "cancelled");
			var timedOut = (r && (r.timedOut || r.failure === "timeout")) || (job && job.state === "timeout");
			// 「已有任务在跑」不是失败，是**这次没开始** —— 文案与结论必须与真正的失败区分开
			var refusedBusy = Boolean(r && r.refused && r.busy);

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
				h(
					"div",
					{ className: "dpm-drawer-body" },

					// ① 正在进行 —— 这一块是整个改动的核心
					job ? h(ProgressPanel, { job: job }) : null,

					// ①b 这次没开始（已有任务在跑）：必须说清楚，不能显示成「你的安装开始了」
					refusedBusy
						? h("div", { className: "dpm-verdict dpm-verdict-block" },
							h("span", null, "!"),
							h("span", null, "这次安装没有开始",
								h("span", { className: "dpm-verdict-sub" },
									txt(r.message, "已经有一个安装任务在跑 —— 同时改同一个 profile 会互相破坏。"))))
						: null,

					// ② 结论（只在结束时出现）
					job && !running && !refusedBusy
						? (job.state === "succeeded"
							? h("div", { className: "dpm-verdict dpm-verdict-pass" },
								h("span", null, "✓"),
								h("span", null, job.kind === "upgrade" ? "更新成功" : job.reinstall ? "重新安装成功" : "安装成功",
									h("span", { className: "dpm-verdict-sub" },
										"用时 " + dur(job.elapsedMs) + "。"
										+ ((r && r.restartHint) || "重启 dsh web 后生效。"))))
							: h("div", { className: "dpm-verdict dpm-verdict-block" },
								h("span", null, aborted ? "■" : "✗"),
								h("span", null,
									aborted ? "已中止安装"
										: timedOut ? "安装超时，已中止"
											: (job.kind === "upgrade" ? "更新未完成" : "安装未完成"),
									h("span", { className: "dpm-verdict-sub" },
										aborted
											? "这是你要的结果：安装已经停下，profile 已还原到安装前的状态。下面有手动安装命令，节奏完全由你控制。"
											: timedOut
												? "超过时限仍未结束，已强制中止并回滚。常见原因是网络慢、依赖树大，或者 profile 里有断链的本地依赖 —— 下面两条路都能走：重试，或者手动装。"
												: (FAILURE_TEXT[(r && r.failure) || (job && job.failure)] || ("失败于阶段：" + txt((r && r.failure) || (job && job.failure))) + "。")),
								)))
						: null,

					// ③ 回滚说明（中止 / 超时 / 失败时才需要解释 profile 现在是什么状态）
					(r && !r.ok) || aborted || timedOut
						? h("div", { style: { marginBottom: 12 } },
							rolledOk
								? h(Flag, { kind: "ok", icon: "↩" }, "已自动回滚：profile 已用安装前的快照还原，并重新链接了 node_modules。你的 harness 保持安装前的状态。")
								: r && r.rollback
									? h(Flag, { kind: "bad", icon: "✗" }, "回滚失败！请手动处理。快照位置见下方步骤里的「备份 profile」。")
									: h(Flag, { kind: "info", icon: "i" }, aborted
										? "这次中止发生在动到 profile 之前（或已回滚），没有留下半截状态。"
										: "这次失败发生在动到 profile 之前，没有需要回滚的改动。"))
						: null,

					job && job.state === "succeeded"
						? h(Flag, { kind: "risk", icon: "⟳" }, "必须重启 dsh web 才会生效 —— 新增的 bundle 是在启动时合成的，热重载不会把它加进去。")
						: null,

					// ④ 已经跑过的步骤（结束态才有意义；进行中由阶段条呈现）
					!running ? h(StepList, { steps: steps }) : null,

					// ⑤ ★ 手动安装：不管成功失败都给
					h("div", { style: { marginTop: 14 } }, h(ManualPanel, { plan: plan })),
				),

				h(
					"div",
					{ className: "dpm-drawer-foot" },
					running
						? h(Btn, {
							variant: "danger",
							disabled: Boolean(job && job.abortRequestedAt),
							onClick: function () { props.onAbort(job); },
							title: "结束 pnpm 进程，并用安装前的快照把 profile 还原。之后你可以照下面的命令自己装。",
						}, job && job.abortRequestedAt ? "正在中止…" : "中止安装")
						: h(Btn, { variant: "primary", onClick: props.onClose }, "完成"),
					h(Btn, { onClick: props.onRefresh }, "刷新状态"),
					h("span", { className: "dpm-spacer" }),
					h("span", { className: "dpm-muted" },
						running
							? "可以关掉这个页面 —— 任务在服务端继续跑，回来还能看到进度。"
							: "下面那份手动命令，就是刚才自动化执行的那条。"),
				),
			);
		};
		//#endregion

		//#region ── 三层校验视图 ──────────────────────────────────────────
		var VerifyView = function (props) {
			var r = props.result;
			if (!r) {
				return h("div", { className: "dpm-drawer-body" },
					h("div", { className: "dpm-split" }, h(Spinner, null), h("span", null, "正在校验…")));
			}
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
				h(
					"div",
					{ className: "dpm-drawer-body" },
					r.layers
						? h("div", null,
							r.layers.map(function (l, i) {
								return h(
									"div",
									{ key: l.id || i, className: "dpm-step", "data-s": l.ok ? "ok" : "fail" },
									h("span", { className: "dpm-step-ico" }, l.ok ? "✓" : "✗"),
									h("div", { style: { minWidth: 0, flex: "1 1 auto" } },
										h("div", { className: "dpm-step-l" }, txt(l.label, l.id)),
										h("div", { className: "dpm-step-d" }, txt(l.detail)),
									),
								);
							}),
						)
						: null,

					!r.layers
						? h("div", null,
							h("div", { className: "dpm-kv" },
								h("span", { className: "dpm-kv-k" }, "装配树"),
								h("span", { className: "dpm-kv-v" }, r.treeOk ? "解析成功" : ("失败：" + txt(r.treeError))),
								h("span", { className: "dpm-kv-k" }, "bundle 层数"),
								h("span", { className: "dpm-kv-v" }, txt((r.heads || []).filter(function (x) { return !x.patchedBy; }).length)),
								h("span", { className: "dpm-kv-k" }, "装配行数"),
								h("span", { className: "dpm-kv-v" }, txt((r.rows || []).length)),
							),
							(r.orphans || []).length > 0
								? h(Flag, { kind: "bad", icon: "!" }, "bundles 里有孤儿项（既不是依赖也不是内置 bundle）：" + r.orphans.join("、"))
								: null,
							(r.drift || []).length > 0
								? h(Flag, { kind: "risk", icon: "!" }, "版本漂移：" + r.drift.map(function (d) { return d.name + "（声明 " + d.specVersion + "，实际 " + d.installedVersion + "）"; }).join("；"))
								: null,
							(r.heads || []).length > 0
								? h("pre", { className: "dpm-pre" }, r.heads.map(function (x) { return (x.patchedBy ? "  ↳ patched by " + x.patchedBy : "# " + x.package); }).join("\n"))
								: null,
							r.stderr ? h("pre", { className: "dpm-pre" }, r.stderr) : null,
						)
						: null,
				),
				h("div", { className: "dpm-drawer-foot" }, h(Btn, { onClick: props.onClose }, "关闭")),
			);
		};
		//#endregion

		//#region ── 主面板 ────────────────────────────────────────────────
		/*
		 * ★ 0.5.0：目录就是**一个列表**，没有层级页签、也没有层级筛选。
		 *
		 *   这里曾经并排摆过三个页签（已验证 / 已审核 / 未审核），后来收敛成一个列表
		 *   外加一组「已审核 / 未审核」筛选 —— 但那个区分对用户要回答的问题
		 *   （「这个插件我这儿装不装得上」）没有帮助：它只是一个维护者贴的标签。
		 *
		 *   0.6.0 把最后那点评判也拿掉了：**市场不再判定任何插件能不能装**，
		 *   所有插件都可装，用户要选的只是「自动装还是手动装」。
		 *   现在顶部只剩一组与**用户自己**有关的筛选：已安装 / 可升级 / 我收藏的。
		 */
		var CATALOG_TAB = "market";

		/** 目录页的筛选：全部与用户自己的三种标记 */
		var ONLY_FILTERS = [
			{ key: null, label: "全部" },
			{ key: "installed", label: "已安装", title: "只看已经装上的插件" },
			{ key: "upgradable", label: "可升级", title: "只看装了、且仓库里有新版本的插件" },
			{ key: "favorited", label: "我收藏的", title: "只看你收藏的插件（记在本机）" },
		];

		var Panel = function (props) {
			var [toast, setToast] = useState(null);
			var [status, setStatus] = useState(null);
			var [tab, setTab] = useState("market");
			var [q, setQ] = useState("");
			var [page, setPage] = useState(0);
			var [list, setList] = useState(null);
			var [listBusy, setListBusy] = useState(false);

			// 筛选状态
			var [only, setOnly] = useState(null);       // null | 'installed' | 'upgradable' | 'favorited'

			var [drawer, setDrawer] = useState(null); // { kind, id, entry }
			var [plan, setPlan] = useState(null);      // installPlan 的结果：自动规格 + 手动方案 + 已知事实
			var [installResult, setInstallResult] = useState(null);
			var [verifyResult, setVerifyResult] = useState(null);
			var [busy, setBusy] = useState(false);

			// ── 安装任务（问题：装的时候只在页面上干等）──
			// job 是服务端任务的快照，靠轮询更新；manual 是手动安装方案。
			// 两者都不属于某个抽屉的局部状态 —— 关掉抽屉再回来还要能看到。
			var [job, setJob] = useState(null);
			var [manual, setManual] = useState(null);
			var [abortArmed, setAbortArmed] = useState(false);

			var [health, setHealth] = useState(null);
			var [bootResult, setBootResult] = useState(null);
			var [backups, setBackups] = useState(null);
			var [logs, setLogs] = useState(null);

			var PAGE_SIZE = 24;
			var aliveRef = useRef(true);
			useEffect(function () {
				aliveRef.current = true;
				return function () { aliveRef.current = false; };
			}, []);

			var fail = useCallback(function (err) {
				var msg = err && err.message ? err.message : String(err);
				if (aliveRef.current) setToast(msg);
				return null;
			}, []);

			var loadStatus = useCallback(async function () {
				try {
					var s = await api("status");
					if (aliveRef.current) setStatus(s);
					// ★ 服务端在 status 里也带当前任务：这样「刷新状态」按钮和
					//   首次加载都能把安装进度接上，不需要用户重新点一次安装。
					if (s && s.job && aliveRef.current) {
						setJob(function (cur) {
							// 不做版本比较，服务端是唯一真相源；但保留更"新"的那一份：
							// 轮询拿到的快照一定不比 status 旧
							if (cur && cur.id === s.job.id && cur.state === s.job.state
								&& (cur.elapsedMs || 0) > (s.job.elapsedMs || 0)) return cur;
							return s.job;
						});
					}
					return s;
				} catch (err) {
					return fail(err);
				}
			}, [fail]);

			var loadList = useCallback(async function (query, pageIdx, onl) {
				setListBusy(true);
				try {
					var args = { query: query, limit: PAGE_SIZE, offset: pageIdx * PAGE_SIZE };
					if (onl) args.only = onl;
					var r = await api("catalog", args);
					if (aliveRef.current) setList(r);
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setListBusy(false);
				}
			}, [fail]);

			// 首次加载
			useEffect(function () {
				loadStatus();
				loadList("", 0, null);
			}, [loadStatus, loadList]);

			// 筛选 / 翻页变化时重新拉列表
			useEffect(function () {
				if (tab !== CATALOG_TAB) return;
				loadList(q, page, only);
			}, [tab, page, only, loadList]); // q 由搜索按钮显式提交，不放进依赖

			// 非目录页的按需加载
			useEffect(function () {
				if (tab === "installed") {
					loadStatus();
					// 快照列表随「已装」页一起取 —— 原先它在「体检」页，
					// 那个页签已按用户要求去掉，而「回滚到快照」搬到了这里。
					api("backups").then(function (r) { if (aliveRef.current) setBackups(r); }).catch(fail);
				}
				if (tab === "log") {
					api("log", { n: 200 }).then(function (r) { if (aliveRef.current) setLogs(r); }).catch(fail);
				}
			}, [tab, loadStatus, fail]);

			/**
			 * 安装任务轮询。
			 *
			 * ★ 600ms 是一个刻意的取值：比它快没有意义（pnpm 的输出本来就不是
			 *   逐字的），比它慢会让「已用时间」看起来一跳一跳的。
			 *   任务一进终态就立刻停表，不留一个空转的定时器。
			 */
			useEffect(function () {
				if (!job) return undefined;
				if (job.state !== "running" && job.state !== "queued") return undefined;
				var alive = true;
				var timer = setInterval(function () {
					api("installProgress", { jobId: job.id })
						.then(function (r) {
							if (!alive || !aliveRef.current) return;
							if (r && r.job) {
								setJob(r.job);
								if (r.job.state === "succeeded" || r.job.state === "failed"
									|| r.job.state === "cancelled" || r.job.state === "timeout") {
									setInstallResult(r.job.result || null);
									// 完成后刷新列表与状态：状态条里的「可更新」计数就在 status 里
									loadStatus();
									loadList(q, page, only);
								}
							}
						})
						.catch(function () { /* 轮询失败不打扰用户，下一拍会重试 */ });
				}, 600);
				return function () { alive = false; clearInterval(timer); };
			}, [job && job.id, job && job.state, loadStatus, loadList, q, page, only]);

			/**
			 * 首次加载 / 切回市场页时，问一次服务端「现在有没有正在跑的安装任务」。
			 *
			 * ★ 这一条是为了「关掉页面再回来」：任务活在服务端，界面必须能重新接上，
			 *   而不是显示成什么都没发生。
			 */
			useEffect(function () {
				api("installProgress", {})
					.then(function (r) {
						if (!aliveRef.current || !r || !r.job) return;
						if (r.job.state === "running" || r.job.state === "queued") {
							setJob(r.job);
							setManual(r.job.manual || null);
							setDrawer({ kind: "install", id: r.job.pluginId, entry: r.job.entry || null, resumed: true });
						}
					})
					.catch(function () { /* 没有任务或服务端旧版本，忽略 */ });
			}, []);

			var submitSearch = useCallback(function () {
				setPage(0);
				loadList(q, 0, only);
			}, [q, only, loadList]);

			/**
			 * 收藏（0.5.0 起只剩这一个标记动作，点赞已删除）。
			 *
			 * 乐观更新：先改本地那一份（列表 + 状态里的个人统计），请求回来再以
			 * 服务端返回为准；失败就整体回滚并把错误抛给 toast。
			 * 这个动作只写一个本地 JSON，正常情况下一帧就回来了。
			 */
			var doMark = useCallback(async function (entry, action) {
				if (action !== "favorite") return;
				var next = !entry.favorited;
				var prevList = list;
				var prevStatus = status;

				setList(function (cur) {
					if (!cur) return cur;
					return {
						...cur,
						items: cur.items.map(function (it) {
							return it.id === entry.id ? { ...it, favorited: next } : it;
						}),
						marks: cur.marks ? {
							...cur.marks,
							favorited: Math.max(0, (cur.marks.favorited || 0) + (next ? 1 : -1)),
						} : cur.marks,
					};
				});

				try {
					var r = await api("mark", { action: action, id: entry.id, value: next });
					if (!aliveRef.current) return;
					// 服务端是真值来源：取消收藏时它会把整条删掉
					setList(function (cur) {
						if (!cur) return cur;
						return {
							...cur,
							items: cur.items.map(function (it) {
								return it.id === entry.id ? { ...it, favorited: r.favorited } : it;
							}),
						};
					});
				} catch (err) {
					if (aliveRef.current) { setList(prevList); setStatus(prevStatus); }
					fail(err);
				}
			}, [list, status, fail]);

			var openPlan = useCallback(async function (entry, forInstall) {
				setToast(null);
				setInstallResult(null);
				setPlan(null);
				setManual(null);
				setDrawer({ kind: "plan", id: entry.id, entry: entry, forInstall: !!forInstall });
				setBusy(true);
				try {
					// ★ 一次请求同时拿回三样东西：这个插件是什么状态、自动那条路的规格、
					//   以及手动那条路的完整命令。两条路都要能在**按下任何按钮之前**看完 ——
					//   让用户先选，而不是先点再发现问题。
					var r = await api("installPlan", { id: entry.id });
					if (aliveRef.current) setPlan(r);
					if (r && r.manual && aliveRef.current) setManual(r.manual);
				} catch (err) {
					fail(err);
					if (aliveRef.current) setDrawer(null);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail]);

			/** 手动那条路上的「复制全部命令」—— 纯本地动作，不碰服务端 */
			var doCopyManual = useCallback(function (plan) {
				var p = (plan && plan.id) ? plan : (plan && plan.pluginId) || {};
				var text = (manual && manual.text) || "";
				if (!text) {
					setToast({ kind: "warn", text: "手动方案还没生成出来，稍等一下再点。" });
					return;
				}
				copyText(text);
				setToast({ kind: "info", text: "已复制 " + txt(p.package || (manual && manual.package) || "", "安装") + " 的手动安装命令，粘到终端里执行即可。" });
			}, [manual]);

			/**
			 * 开始安装（自动那条路）。
			 *
			 * ★ 与旧版的关键差别：这里**不等**安装跑完。请求只负责「把任务排上去」，
			 *   几百毫秒就返回一个 jobId；进度、耗时、预计剩余、以及中止能力，
			 *   全部走任务快照。这样即使 pnpm 要跑五分钟，界面也是活的。
			 */
			var doInstall = useCallback(async function (plan) {
				setBusy(true);
				setAbortArmed(false);
				setInstallResult(null);
				setJob(null);
				setManual(plan && plan.manual ? plan.manual : manual);
				setDrawer({ kind: "install", id: plan.pluginId, entry: drawer && drawer.entry });
				try {
					var r = await api("install", { id: plan.pluginId });
					if (!aliveRef.current) return;

					if (r && r.busy) {
						// 服务端已经有一个任务在跑：**不接上它**，而是如实说「这次没开始」。
						// ★ 这里有个容易搞错的细节：如果顺手把 job 设成那个正在跑的任务，
						//   安装抽屉就会显示成「这一次安装的进度」，用户会以为自己的点击成功了。
						//   正确做法是清掉 job，让抽屉显示「被拒绝」的说明 + 手动命令。
						setJob(null);
						setAbortArmed(false);
						setInstallResult({
							ok: false, refused: true, busy: true,
							failure: 'busy',
							steps: [],
							message: r.message || '已经有一个安装任务在跑，这次没有开始。',
						});
						return;
					}
					if (r && r.refused) {
						setInstallResult(r);
						return;
					}
					if (r && r.manual) setManual(r.manual);
					if (r && r.job) setJob(r.job);
					if (r && r.jobId) {
						// 立刻拉一次，拿到第一个阶段，别让面板空一拍
						api("installProgress", { jobId: r.jobId })
							.then(function (p) { if (aliveRef.current && p && p.job) setJob(p.job); })
							.catch(function () { /* 忽略 */ });
					}
				} catch (err) {
					fail(err);
					if (aliveRef.current) setInstallResult({ ok: false, failure: "rpc", steps: [] });
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [drawer, fail, manual]);

			/**
			 * 中止安装。
			 *
			 * ★ 二次确认是必要的：这一步会杀掉正在跑的 pnpm 并回滚 profile。
			 *   单击直接执行的话，误触的代价是「装到一半被自己打断」。
			 */
			var doAbort = useCallback(async function (j) {
				if (!j) return;
				if (!abortArmed) {
					setAbortArmed(true);
					setToast({ kind: "warn", text: "再点一次「中止安装」确认：会结束 pnpm 进程，并用安装前的快照还原 profile。之后可以照下面的命令手动安装。" });
					setTimeout(function () { if (aliveRef.current) setAbortArmed(false); }, 6000);
					return;
				}
				setAbortArmed(false);
				try {
					var r = await api("installAbort", { jobId: j.id });
					if (r && r.job) setJob(r.job);
					setToast({ kind: "info", text: (r && r.message) || "已发出中止请求。" });
				} catch (err) {
					fail(err);
				}
			}, [abortArmed, fail]);

			/**
			 * 移除断链依赖（体检横幅上的「一键修复」）。
			 *
			 * ★ 这是「装很久装不上」最常见的根因，所以修复必须是一步的：
			 *   让用户自己去 profile 目录里改 JSON 是不现实的，而 `dsh plugin remove`
			 *   命令又不该要求他先看懂体检报告。
			 */
			var doRemoveDependency = useCallback(async function (pkgName) {
				setToast(null);
				setBusy(true);
				try {
					var r = await api("removeDependency", { package: pkgName });
					if (!aliveRef.current) return;
					if (r && r.ok) {
						setToast({ kind: "info", text: "已移除 " + pkgName + "，profile 现在没有断链依赖了。" });
					} else {
						setToast({ kind: "warn", text: "移除未完成：" + txt((r && (r.error || r.failure)) || "见操作日志") + " —— 可以照命令自己来。" });
					}
					await loadStatus();
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail, loadStatus]);

			var doUninstall = useCallback(async function (item) {
				setToast(null);
				setJob(null);
				setManual(null);
				setDrawer({ kind: "install", id: item.name, entry: { id: item.name, title: item.name, package: item.name } });
				setInstallResult(null);
				setBusy(true);
				try {
					var r = await api("uninstall", { id: item.name });
					if (aliveRef.current) setInstallResult(r);
					await loadStatus();
				} catch (err) {
					fail(err);
					if (aliveRef.current) setInstallResult({ ok: false, failure: "rpc", steps: [] });
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail, loadStatus]);

			var doVerify = useCallback(async function (id) {
				setToast(null);
				setVerifyResult(null);
				setDrawer({ kind: "verify", id: id });
				try {
					var r = await api("verify", id ? { id: id } : {});
					if (aliveRef.current) setVerifyResult(r);
				} catch (err) {
					fail(err);
					if (aliveRef.current) setDrawer(null);
				}
			}, [fail]);

			var doProfileCheck = useCallback(async function () {
				setToast(null);
				try {
					var r = await api("profileCheck");
					if (aliveRef.current) setHealth(r);
				} catch (err) {
					fail(err);
				}
			}, [fail]);

			var doRepair = useCallback(async function (check) {
				setBusy(true);
				setToast(null);
				try {
					var r = check && check.id === "profile.allowbuilds"
						? await api("fixAllowBuilds")
						: await api("repair");
					if (aliveRef.current) setToast(null);
					if (r && r.ok === false) fail(new Error(check && check.id === "profile.allowbuilds" ? (r.error || "allowBuilds 修复失败") : ("修复未完全成功，退出码 " + r.exitCode)));
					await doProfileCheck();
					await loadStatus();
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail, doProfileCheck, loadStatus]);

			var doBootVerify = useCallback(async function () {
				setBusy(true);
				setBootResult(null);
				setToast("真实启动校验正在运行：会另起一个 dsh 进程（自动选空闲端口），约需 30–40 秒。");
				try {
					var r = await api("bootVerify", { timeoutMs: 45000 });
					if (aliveRef.current) { setBootResult(r); setToast(null); }
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail]);

			var doRefresh = useCallback(async function () {
				setBusy(true);
				setToast("正在刷新目录…");
				try {
					var r = await api("refresh");
					if (r && r.ok === false) fail(new Error(r.error || "刷新失败"));
					else if (aliveRef.current) {
						/*
						 * ★ 如实报出**目录是从哪来的**。
						 *
						 *   自 0.4.0 起目录只有一个来源：市场仓库里的 catalog/index.json
						 *   （由「一个插件一个配置文件」catalog/plugins/*.json 派生）。
						 *   刷新不再是一次大下载：它是仓库里的静态文件，带 ETag，
						 *   目录没变时服务端答 304，传输量几乎为零。
						 *   所以提示语要说「目录未变」而不是让用户以为白点了一下。
						 *
						 *   ★ 来源是 cache / bundled 时必须显式说出来 ——
						 *   那意味着显示的版本号可能不是最新的，这是用户唯一能判断的依据。
						 */
						var srcText = {
							'remote': "远程最新",
							'remote-304': "目录未变（304）",
							'cache': "本地缓存",
							'cache-error': "网络失败，用本地缓存",
							'bundled': "离线包内快照",
							'unavailable': "不可用",
						};
						var stale = r.source === 'bundled' || r.source === 'cache' || r.source === 'cache-error';
						var counts = r.counts || {};
						setToast(
							"目录已刷新 · " + (srcText[r.source] || r.source || "?")
							+ (counts.total ? " · 共 " + counts.total + " 条" : "")
							+ (r.upstreamGeneratedAt ? " · 上游索引生成于 " + r.upstreamGeneratedAt.slice(0, 10) : "")
							+ (stale ? "（没取到远程目录，显示的版本可能不是最新）" : ""),
						);
					}
					await loadStatus();
					await loadList(q, page, only);
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail, loadStatus, loadList, q, page, only]);

			var closeDrawer = useCallback(function () {
				setDrawer(null);
				setInstallResult(null);
				setVerifyResult(null);
			}, []);

			// ── 派生数据 ──
			var env = (status && status.env) || {};
			var profile = (status && status.profile) || {};
			var compat = (status && status.compat) || {};
			var catalog = (status && status.catalog) || {};
			var installed = (status && status.installed) || [];
			var upgradable = (status && status.upgradable) || [];
			var userData = (status && status.userData) || { favorited: 0 };
			var catalogCounts = catalog.counts || { total: 0 };

			// ── 渲染 ──
			var body = null;

			if (tab === CATALOG_TAB) {
				var items = (list && list.items) || [];
				var total = list ? list.total : 0;
				var maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
				var counts = (list && list.marks) || { favorited: 0 };

				body = h(
					"div",
					null,
					h(
						"div",
						{ className: "dpm-toolbar dpm-toolbar-sticky" },
						h("input", {
							className: "dpm-input",
							type: "search",
							placeholder: "搜索插件（名称 / 包名 / 作者 / 标签，服务端检索）…",
							value: q,
							onChange: function (ev) { setQ(ev.target.value); },
							onKeyDown: function (ev) { if (ev.key === "Enter") submitSearch(); },
						}),
						h(Btn, { onClick: submitSearch, variant: "primary" }, "搜索"),
						h(Btn, {
							onClick: function () { setQ(""); setPage(0); setOnly(null); loadList("", 0, null); },
						}, "重置"),
						listBusy ? h(Spinner, null) : null,
						h("span", { className: "dpm-spacer" }),
						h("span", { className: "dpm-pager-info" }, "共 " + total + " 条"),

						/*
						 * ★ 筛选器只剩与**用户自己**有关的三项：已安装 / 可升级 / 我收藏的。
						 *   原来还有一组「审核状态」（全部 / 已审核 / 未审核），
						 *   随信任分级一起删掉了 —— 目录里已经没有这个维度。
						 */
						h(
							"div",
							{ className: "dpm-filters", style: { flexBasis: "100%", marginTop: 2 } },
							ONLY_FILTERS.map(function (f) {
								return h("button", {
									key: "of" + String(f.key),
									type: "button",
									className: "dpm-filter",
									title: f.title,
									"data-on": only === f.key ? "1" : undefined,
									onClick: function () { setOnly(only === f.key ? null : f.key); setPage(0); },
								}, f.label,
									f.key === "upgradable" && upgradable.length > 0
										? h("span", { className: "dpm-filter-n" }, upgradable.length)
										: null,
									f.key === "favorited" && counts.favorited > 0 ? h("span", { className: "dpm-filter-n" }, counts.favorited) : null);
							}),
							h("span", { className: "dpm-spacer" }),
							h("span", { className: "dpm-pager-info" }, "收藏 " + txt(counts.favorited, "0") + "（记在本机）"),
						),
					),

					list && list.indexMeta && list.indexMeta.error
						? h(Flag, { kind: "risk", icon: "!" },
							"目录没能从仓库拉取：" + txt(list.indexMeta.error)
							+ "（下面的结果来自本机缓存或包内离线快照，版本号可能不是最新的）")
						: null,
					list && list.indexMeta && list.indexMeta.source === 'bundled'
						? h(Flag, { kind: "risk", icon: "!" },
							"正在用**包内离线目录**：它只含字节由本仓库托管的那些插件，"
							+ "完整的 7000+ 条插件列表需要联网从仓库拉取。")
						: null,

					// ★ 问题 1 的全局提示：装了但仓库里有新版
					upgradable.length > 0
						? h(Flag, { kind: "info", icon: "↑" },
							"有 " + upgradable.length + " 个插件可以更新："
							+ upgradable.map(function (u) { return u.name + " " + txt(u.from) + " → " + txt(u.to); }).join("；")
							+ "。点插件上的「更新」按钮即可（会自动备份 profile，失败自动回滚）。")
						: null,

					items.length === 0 && !listBusy
						? h(Empty, null, only === "favorited" ? "还没有收藏任何插件。点插件卡片上的「收藏」即可。"
							: only === "upgradable" ? "没有可更新的插件 —— 装了的都是目录里的最新版本。"
								: only === "installed" ? "还没有安装任何目录里的插件。"
									: "没有匹配的插件。首次使用需要联网拉取完整目录，点右上方「刷新目录」。")
						: h("div", { className: "dpm-cards" },
							items.map(function (e) {
								return h(EntryCard, {
									key: e.id,
									entry: e,
									onInstall: openPlan,
									onMark: doMark,
								});
							})),

					total > PAGE_SIZE
						? h(
							"div",
							{ className: "dpm-pager" },
							h(Btn, { disabled: page <= 0, onClick: function () { setPage(Math.max(0, page - 1)); } }, "‹ 上一页"),
							h("span", { className: "dpm-pager-info" }, "第 " + (page + 1) + " / " + (maxPage + 1) + " 页"),
							h(Btn, { disabled: page >= maxPage, onClick: function () { setPage(page + 1); } }, "下一页 ›"),
						)
						: null,
				);
			}

			if (tab === "installed") {
				body = h(
					"div",
					null,
					h("div", { className: "dpm-toolbar" },
						h(Btn, { onClick: loadStatus }, "刷新"),
						h(Btn, { onClick: function () { doVerify(null); } }, "校验三层"),
						/**
						 * ★ 「体检」原先是一个独立页签，被删掉之后它只剩这个按钮 ——
						 *   而结果一直没人渲染（health 被 set 了却从不显示）。
						 *   0.6.0 把它接回页面上：这组结论描述的是**这台机器 / 这个 profile**
						 *   的健康状况（Node、pnpm、断链的 file: 依赖、allowBuilds…），
						 *   与装哪个插件无关，但会让**任何**安装失败。
						 */
						h(Btn, { disabled: busy, onClick: function () { setHealth(null); doProfileCheck(); } }, "体检"),
						// ★ 「修复」这个能力不能跟着页签消失：
						//   它是「装了但没挂载」那类静默残局的唯一出路。
						h(Btn, {
							disabled: busy,
							title: "检查 profile 并修复可自动修复的问题（allowBuilds 占位符、依赖未挂载等）。修复前会自动拍快照。",
							onClick: async function () {
								setToast(null);
								try {
									var r = await api("profileCheck");
									if (aliveRef.current) setHealth(r);
									var repairables = ((r && r.checks) || []).filter(function (c) { return c.repairable; });
									if (repairables.length === 0) { setToast("profile 检查通过，没有需要修复的项目。"); return; }
									if (typeof window !== "undefined" && window.confirm
										&& !window.confirm("发现 " + repairables.length + " 项可自动修复，现在修复？（会先自动拍快照）")) return;
									for (var i = 0; i < repairables.length; i++) await doRepair(repairables[i]);
									setToast("已修复 " + repairables.length + " 项。");
									await loadStatus();
									api("backups").then(function (x) { if (aliveRef.current) setBackups(x); }).catch(fail);
								} catch (err) { fail(err); }
							},
						}, "修复 profile"),
						h("span", { className: "dpm-spacer" }),
						h("span", { className: "dpm-pager-info" }, installed.length + " 个依赖 · " + (profile.bundles || []).length + " 个 bundle 层"),
					),
					installed.length === 0
						? h(Empty, null, "这个 profile 还没有装任何第三方插件。")
						: h("div", null,
							installed.map(function (i) {
								var notMounted = i.installed && !i.inBundles;
								return h(
									"div",
									{ key: i.name, className: "dpm-row" },
									h("span", { className: "dpm-row-name" }, i.name),
									i.installedVersion ? h(Chip, null, i.installedVersion) : null,
									i.isBundle ? h(Badge, { kind: "neutral" }, "bundle") : h(Badge, { kind: "neutral" }, "普通依赖"),
									i.inBundles ? h(Badge, { kind: "ok" }, "已挂载") : null,
									notMounted ? h(Badge, { kind: "bad" }, "装了但没挂载") : null,
									i.mismatch ? h(Badge, { kind: "bad" }, "版本漂移") : null,
									!i.installed ? h(Badge, { kind: "bad" }, "未安装") : null,
									// ★ 问题 1：这一行能升级时直接在这里标出来，并在右边给升级入口
									i.upgrade ? h(Badge, { kind: "update" }, "可升级 " + txt(i.targetVersion)) : null,
									i.inCatalog === false && i.installed ? h(Badge, { kind: "neutral" }, "不在目录里") : null,
									h("span", { className: "dpm-spacer" }),
									i.upgrade
										? h(Btn, {
											small: true, variant: "update", disabled: busy,
											title: "更新到 " + txt(i.targetVersion) + "（会先移除旧版本再装，自动备份、失败自动回滚）",
											onClick: function () {
												openPlan({
													id: i.name, package: i.name, title: i.name,
													installState: { status: "upgradable", installed: true, installedVersion: i.installedVersion, target: i.targetVersion, inBundles: i.inBundles, canInstall: true, canUpgrade: true, action: "update", isLatest: false },
												}, true);
											},
										}, "更新到 " + txt(i.targetVersion))
										: null,
									h(Btn, { small: true, onClick: function () { doVerify(i.name); } }, "校验"),
									h(Btn, { small: true, variant: "danger", disabled: busy, onClick: function () { doUninstall(i); } }, "卸载"),
								);
							}),
							installed.some(function (i) { return i.installed && !i.inBundles; })
								? h("div", { style: { marginTop: 14 } },
									h(Flag, { kind: "bad", icon: "!" }, "有依赖「装了但没挂载」—— 这是 pnpm 以非 0 退出时 dsh 不会把包写进 bundles 造成的静默残局，GUI 里看不到它。点上方「修复 profile」可以让 dsh 重新对齐。"))
								: null,
						),

					// 体检结果（环境层 + profile 层）。只读诊断，与「装不装得上某个插件」无关。
					health
						? h("div", { style: { marginTop: 16 } },
							h(Fold, {
								title: "体检结果 · 环境与 profile",
								count: ((health && health.checks) || []).length,
								defaultOpen: true,
							},
								((health && health.checks) || []).length === 0
									? h("div", { className: "dpm-muted" }, "没有检查项。")
									: ((health && health.checks) || []).map(function (c, i) {
										return h(CheckItem, { key: c.id || i, check: c });
									})))
						: null,

					/*
					 * ★ 「回滚到快照」原在「体检」页。用户要求去掉那个页签，但它承载的
					 *   恢复能力不能跟着消失 —— 装坏了的人本来就会来「已装」页看，
					 *   所以搬到这里。
					 */
					h("div", { style: { marginTop: 18 } },
						h("h3", { className: "dpm-group-h" }, "回滚到快照"),
						(backups && backups.items && backups.items.length > 0)
							? h("div", null, backups.items.slice(0, 10).map(function (b, i) {
								return h(
									"div",
									{ key: b.name || i, className: "dpm-row" },
									h("span", { className: "dpm-row-name" }, txt(b.meta && b.meta.label, "snapshot")),
									h(Chip, null, dateText(b.meta && b.meta.createdAt)),
									h(Chip, null, ((b.meta && b.meta.bundles) || []).length + " bundles"),
									h("span", { className: "dpm-spacer" }),
									h(Btn, {
										small: true, variant: "danger", disabled: busy,
										onClick: async function () {
											if (typeof window !== "undefined" && window.confirm && !window.confirm("确定回滚到这个快照？会覆盖当前 profile 的 package.json / pnpm-workspace.yaml / cordis.patch.yml 等状态文件，并重新链接 node_modules。")) return;
											setBusy(true);
											try {
												var r = await api("rollback", { dir: b.dir });
												if (!r.ok) fail(new Error(r.error || "回滚失败"));
												else setToast("已回滚，请重启 dsh web。");
												await loadStatus();
											} catch (err) { fail(err); } finally { if (aliveRef.current) setBusy(false); }
										},
									}, "回滚到此"),
								);
							}))
							: h(Empty, null, "还没有快照。每次安装/卸载/修复前都会自动拍一份。"),
					),
				);
			}

			/*
			 * ★ 「体检」页签已按用户要求移除（连它的分支一起）。
			 *
			 *   要去掉的是**页面**，不是兼容性检查：装前闸门（三层判定 + 致命项硬拦截）
			 *   照旧在每次安装前自动执行，结果就在安装抽屉里。
			 *
			 *   原页面承载的能力没有被丢掉，只是换了入口：
			 *     · 回滚到快照   → 「已装」页
			 *     · 修复 profile → 「已装」页工具条上的按钮
			 *     · 校验三层     → 本来「已装」页就有一份
			 *   真实启动校验属于开发期诊断，随页面一起去掉（后端 API 仍在）。
			 */
			if (tab === "log") {
				var items = (logs && logs.items) || [];
				body = h(
					"div",
					null,
					h("div", { className: "dpm-toolbar" },
						h(Btn, { onClick: function () { api("log", { n: 200 }).then(function (r) { setLogs(r); }).catch(fail); } }, "刷新"),
						h(Btn, {
							variant: "danger",
							onClick: async function () {
								if (typeof window !== "undefined" && window.confirm && !window.confirm("清空操作日志？")) return;
								try { await api("clearLog"); setLogs({ items: [] }); } catch (err) { fail(err); }
							},
						}, "清空"),
						h("span", { className: "dpm-spacer" }),
						h("span", { className: "dpm-pager-info" }, items.length + " 条"),
					),
					items.length === 0
						? h(Empty, null, "还没有操作记录。")
						: h("div", null, items.map(function (r, i) {
							return h(
								"div",
								{ key: "log" + i, className: "dpm-row" },
								h(Chip, null, dateText(r.at)),
								h(Badge, { kind: r.ok === false ? "bad" : r.ok === true ? "ok" : "neutral" }, txt(r.op, "—")),
								r.pluginId ? h("span", { className: "dpm-row-name" }, r.pluginId) : null,
								r.failure ? h(Badge, { kind: "bad" }, r.failure) : null,
								h("span", { className: "dpm-spacer" }),
								h("span", { className: "dpm-muted" }, txt(r.detail, "")),
							);
						})),
				);
			}

			var drawerContent = null;
			if (drawer && drawer.kind === "plan") {
				drawerContent = h(InstallPlanDrawer, {
					plan: plan,
					manual: manual,
					profile: plan && plan.targetProfile,
					busy: busy,
					onClose: closeDrawer,
					onAutoInstall: doInstall,
					onCopyManual: doCopyManual,
				});
			} else if (drawer && drawer.kind === "install") {
				drawerContent = h(InstallView, {
					result: installResult,
					job: job,
					manual: manual,
					onClose: closeDrawer,
					onAbort: doAbort,
					onRefresh: function () { loadStatus(); closeDrawer(); },
				});
			} else if (drawer && drawer.kind === "verify") {
				drawerContent = h(VerifyView, { result: verifyResult, onClose: closeDrawer });
			}

			return h(
				"div",
				{ className: "dpm-root" },
				h(
					"div",
					{ className: "dpm-head" },
					h(
						"div",
						{ className: "dpm-head-row" },
						h(
							"div",
							{ style: { minWidth: 0, flex: "1 1 260px" } },
							h("h2", { className: "dpm-title" }, "插件市场"),
						),
						h(Btn, { disabled: busy, onClick: doRefresh }, "刷新目录"),
						h(Btn, { onClick: function () { if (props.onClose) props.onClose(); } }, "关闭"),
					),
				),

				/*
				 * ★ profile 装前体检横幅。
				 *
				 *   放在最顶上、且**不折叠**，因为这一类问题（断链的 file: 依赖）
				 *   会导致「任何插件都装很久装不上」，用户却完全看不到原因 ——
				 *   他只会以为市场坏了。这里直接告诉他是什么、并给一个能点的修复按钮。
				 */
				(status && status.preflight && (status.preflight.problems || []).length > 0)
					? h("div", { className: "dpm-alert" },
						h("div", { className: "dpm-alert-h" },
							h("span", null, "!"),
							h("span", null, "profile 里有问题，会拖慢甚至挡住所有安装")),
						(status.preflight.problems || []).map(function (p, i) {
							return h("div", { key: p.id || i, className: "dpm-alert-item" },
								h("div", { className: "dpm-alert-t" }, txt(p.title, p.id)),
								h("div", { className: "dpm-muted" }, txt(p.detail)),
								(p.items || []).length > 0
									? h("pre", { className: "dpm-pre" }, p.items.join("\n"))
									: null,
								h("div", { className: "dpm-alert-fix" },
									(p.fixes || []).map(function (f, j) {
										if (f.kind !== 'remove-dependency') {
											return h(CopyBox, { key: "f" + j, text: f.command });
										}
										return h("div", { key: "f" + j, className: "dpm-split" },
											h(Btn, {
												small: true,
												variant: "danger",
												disabled: busy,
												title: "从 profile 里移除这条断链依赖（会先备份，失败自动回滚）",
												onClick: function () {
													if (!window.confirm("移除断链依赖 " + f.package + "？\n\n会先给 profile 拍快照，失败自动回滚。")) return;
													doRemoveDependency(f.package);
												},
											}, txt(f.label, "移除 " + f.package)),
											h(CopyBox, { text: f.command }),
										);
									})),
							);
						}),
						h("div", { className: "dpm-alert-fix" },
							h(Btn, { small: true, disabled: busy, onClick: function () { loadStatus(); } }, "重新体检")),
					)
					: null,

				/*
				 * 状态条。
				 *
				 * ★ 0.5.0 去掉了「已验证 / 已审核 / 未审核」三个层级数字。
				 *   目录是一份平铺列表，共多少条就写在筛选行那里（「共 N 条」）。
				 *   这里留下的是**与层级无关、且用户真的需要**的信息：
				 *   有几个可以更新、目录是从哪儿取的、上游索引是什么时候生成的。
				 */
				h(
					"div",
					{ className: "dpm-strip" },
					upgradable.length > 0
						? h(Badge, { kind: "update" }, "可更新 " + upgradable.length)
						: null,
					/*
					 * 目录取用情况的如实提示。
					 *
					 * 目录现在是 market 仓库里的 catalog/index.json（静态文件，带 ETag）。
					 * 来源是 cache / bundled 时，显示的版本号可能不是最新的 ——
					 * 这一点必须让用户看见，而不是让他以为看到的就是最新的。
					 */
					catalog.index && catalog.index.error
						? h(Badge, { kind: "neutral" }, "目录：" + txt(catalog.index.source))
						: null,
					catalog.index && (catalog.index.source === 'bundled')
						? h(Badge, { kind: "bad" }, "离线包内目录（可能不是最新）")
						: null,
					catalog.index && catalog.index.source === 'cache'
						? h(Badge, { kind: "neutral" }, "目录缓存 " + ageText(catalog.index.ageMs))
						: null,
					catalog.index && catalog.index.sourceIndex && catalog.index.sourceIndex.generatedAt
						? h("span", { className: "dpm-muted" }, "上游索引 " + catalog.index.sourceIndex.generatedAt.slice(0, 10))
						: null,
					h("span", { className: "dpm-spacer" }),
					status && status.repo && status.repo.detected
						? h(Badge, { kind: "ok" }, "已识别本地仓库")
						: h(Badge, { kind: "neutral" }, "未识别本地仓库（tarball 将联网下载）"),
				),

				h(
					"div",
					{ className: "dpm-tabs" },
					h("button", {
						key: "market", type: "button", className: "dpm-tab",
						"data-on": tab === CATALOG_TAB ? "1" : undefined,
						onClick: function () { setTab(CATALOG_TAB); setPage(0); setQ(""); },
					}, "插件市场 " + (catalogCounts.total || "")),
					h("button", {
						key: "installed", type: "button", className: "dpm-tab",
						"data-on": tab === "installed" ? "1" : undefined,
						onClick: function () { setTab("installed"); },
					}, "已装" + (upgradable.length > 0 ? " ↑" + upgradable.length : "")),
					// 「体检」页签已移除（其能力搬到「已装」页，见那里的说明）。
					h("button", {
						key: "log", type: "button", className: "dpm-tab",
						"data-on": tab === "log" ? "1" : undefined,
						onClick: function () { setTab("log"); },
					}, "日志"),
				),

				h(
					"div",
					{ className: "dpm-body" },
					!status && !toast
						? h("div", { className: "dpm-split" }, h(Spinner, null), h("span", null, "正在读取状态…"))
						: body,
				),

				toast ? h("div", {
					className: "dpm-toast",
					"data-k": (toast && toast.kind) || "bad",
				}, h("span", null, (toast && toast.kind) === "info" ? "i" : (toast && toast.kind) === "warn" ? "!" : "!"),
					h("span", { style: { flex: "1 1 auto" } }, txt(toast && toast.text !== undefined ? toast.text : toast)),
					h("button", { type: "button", className: "dpm-btn dpm-btn-sm", onClick: function () { setToast(null); } }, "知道了")) : null,

				drawer
					? h(
						"div",
						{ className: "dpm-drawer" },
						h(
							"div",
							{ className: "dpm-drawer-head" },
							h("h3", { className: "dpm-drawer-title" },
								drawer.kind === "plan" ? "安装 · " + txt(drawer.entry && (drawer.entry.title || drawer.entry.id))
									: drawer.kind === "install" ? (job ? "安装进度 · " : "安装 · ") + txt(drawer.entry && (drawer.entry.title || drawer.entry.id))
										: "校验 · " + txt(drawer.id, "profile")),
							h("span", { className: "dpm-spacer" }),
							drawer.kind === "plan" && plan
								? h(Badge, { kind: plan.auto && plan.auto.available ? "ok" : "neutral" },
									plan.auto && plan.auto.available ? "可自动安装" : "需手动安装")
								: null,
							// 抽屉标题上的「回到安装进度」：关掉抽屉后任务还在跑，
							// 用户得有个明显入口回去看
							drawer.kind !== "install" && job && (job.state === "running" || job.state === "queued")
								? h(Btn, {
									small: true,
									variant: "primary",
									onClick: function () { setDrawer({ kind: "install", id: job.pluginId, entry: job.entry }); },
								}, "安装进行中 · 查看进度")
								: null,
						),
						drawerContent,
					)
					: null,
			);
		};
		//#endregion

		//#region ── 注册 ──────────────────────────────────────────────────
		/*
		 * inject 只声明 slots 与 layout：两者在 web 版里恒存在。
		 * ★ 客户端声明的服务若最终没有就绪，整页 boot 都会失败（宿主会抛
		 *   “web boot: N entries did not activate”），所以这里绝不能多写。
		 *   其余一切都走 ctx.get(...) 并在使用时判空。
		 */
		var inject = ["slots", "layout"];

		function apply(ctx) {
			var layout = ctx.get("layout");

			// 左栏导航图标：list slot → 必须有 options.id
			ctx.slots.inject("sidebar.panellist", function () {
				return ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: 6, label: "插件市场" },
					RailIcon,
				);
			});

			// 中央面板：keyed slot → 必须有 options.key，且必须与上面的 id 同名，
			// 否则 layout.selectPanel(id) 会因为「main 里没有这个 key」直接抛错。
			ctx.slots.inject("main", function () {
				return ctx.slots.register(
					{ name: "main", key: PANEL_ID },
					function () {
						return h(
							ErrorBoundary,
							{ label: "插件市场" },
							h(Panel, {
								onClose: function () {
									if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
								},
							}),
						);
					},
				);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
