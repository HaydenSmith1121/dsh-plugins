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
.dpm-card[data-tier="verified"]{border-left:3px solid #16a34a}
.dpm-card[data-tier="reviewed"]{border-left:3px solid #4d6bfe}
.dpm-card[data-tier="community"]{border-left:3px solid #d97706}
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
.dpm-badge-verified{background:#e8f6ee;color:#15803d;border:1px solid #bfe3cd}
.dpm-badge-reviewed{background:#eaf2fb;color:#2e4bd8;border:1px solid #c9d4f5}
.dpm-badge-community{background:#fef7e7;color:#a97f1f;border:1px solid #f0dfae}
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
.dpm-verdict-blockover{background:#fef3e2;color:#b45309;border:1px solid #f0d9a8}
.dpm-verdict-block{background:#fdeaea;color:#b91c1c;border:1px solid #f5c6c6}
.dpm-verdict-sub{display:block;font-weight:400;font-size:12px;margin-top:3px;opacity:.92}
.dpm-group{margin:14px 0}
.dpm-group-h{font-size:12px;font-weight:650;margin:0 0 7px;display:flex;gap:7px;align-items:center;cursor:pointer;user-select:none}
.dpm-check{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:9px 11px;margin-bottom:7px;background:var(--dsw-alias-bg-base,#fff)}
.dpm-check[data-sev="fatal"]{border-left:3px solid #dc2626}
.dpm-check[data-sev="warn"]{border-left:3px solid #d97706}
.dpm-check[data-sev="info"]{border-left:3px solid #16a34a}
.dpm-check[data-sev="skip"]{border-left:3px solid #9ca3af}
/*
 * ── 点赞 / 收藏 ──────────────────────────────────────────────
 * 两个按钮。★ 刻意做成「描边 + 数字」而不是大色块：收藏是个人偏好，
 * 不该比「审核状态」这个安全信号更抢眼。
 * data-on 只看布尔值，颜色一律走 CSS —— 组件里不拼颜色字符串，
 * 暗色模式下才不用再判一次。
 */
.dpm-mark{appearance:none;display:inline-flex;align-items:center;gap:4px;font-family:inherit;font-size:11.5px;line-height:1;padding:5px 9px;border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#d4d7dc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5f6670)}
.dpm-mark:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f1f3)}
.dpm-mark:disabled{opacity:.45;cursor:not-allowed}
.dpm-mark[data-on]{font-weight:600}
.dpm-mark-like[data-on]{background:#fdeaea;border-color:#f5c6c6;color:#c2410c}
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
.dpm-btn-installed:disabled{background:var(--dsw-alias-bg-layer-1,#f3f4f6);border-color:var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-secondary,#8a919f);opacity:1}
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
.dpm-ack{display:flex;gap:8px;align-items:flex-start;font-size:12px;padding:9px 11px;border-radius:8px;background:#fef7e7;border:1px solid #f0dfae;color:#7c5a12;cursor:pointer;margin-top:4px}
.dpm-ack input{margin-top:2px;flex:0 0 auto}
.dpm-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:9px 11px;margin-bottom:7px}
.dpm-row-name{font-size:12.5px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.dpm-toast{flex:0 0 auto;margin:0 18px 12px;padding:9px 12px;border-radius:8px;background:#fdeaea;border:1px solid #f5c6c6;color:#b91c1c;font-size:12px;display:flex;gap:9px;align-items:flex-start}
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
  .dpm-btn-installed:disabled{background:#2b2d31;border-color:#3a3d42;color:#7d828c}
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

		/** 检查项归类：致命硬拦截 / 无法确认可覆盖 / 提醒 / 通过 / 跳过 */
		function classifyCheck(c) {
			if (!c) return "skip";
			if (c.status === "pass") return "pass";
			if (c.status === "skip") return "skip";
			if (c.status === "fail" && c.severity === "fatal") return c.overridable ? "overridable" : "fatal";
			if (c.status === "warn" || (c.status === "fail" && c.severity === "warn")) return "warn";
			if (c.status === "fail") return "overridable";
			return "skip";
		}

		function verdictInfo(v) {
			switch (v) {
				case "pass":
					return { cls: "pass", ico: "✓", title: "检查全部通过", sub: "没发现会让 harness 起不来的问题。" };
				case "warn":
					return { cls: "warn", ico: "!", title: "有提醒项，可以继续", sub: "下面列出的都是已知的软风险，不影响启动。" };
				case "block-overridable":
					return { cls: "blockover", ico: "!", title: "有无法确认的项目，默认已拦截", sub: "不是「确认它不安全」，而是「无法确认它安全」。勾选确认后可以强制继续。" };
				case "block":
					return { cls: "block", ico: "✗", title: "已硬拦截", sub: "有确定会导致 dsh 无法启动的问题，这一项不提供覆盖入口。" };
				default:
					return { cls: "warn", ico: "?", title: "未知结论", sub: "" };
			}
		}

		function stepIcon(s) {
			if (s === "ok") return "✓";
			if (s === "fail") return "✗";
			if (s === "warn") return "!";
			return "•";
		}

		var FAILURE_TEXT = {
			"gate-blocked": "装前检查没有放行，安装未开始。",
			"fetch": "没能拿到安装包（本地没有、下载也失败）。",
			"backup": "备份 profile 失败 —— 出于安全考虑没有继续动任何东西。",
			"install-command": "安装命令以非 0 退出。dsh 在 pnpm 非 0 时不会把包写进 bundles。",
			"verify": "安装命令成功了，但装后校验没通过。",
			"uninstall-command": "卸载命令以非 0 退出。",
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

		function tierBadgeKind(tier) {
			if (tier === "verified") return "verified";
			if (tier === "reviewed") return "reviewed";
			if (tier === "community") return "community";
			return "neutral";
		}

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

		/** 主按钮文案：没装 → 安装；有新版 → 更新到 x.y.z；已最新 → 已安装 */
		function primaryLabel(entry) {
			var st = stateOf(entry);
			if (st.status === "upgradable") return "更新到 " + txt(st.target, "新版本");
			if (st.status === "current") return "已安装";
			if (st.installed) return "重新安装";
			return "安装";
		}

		/** 主按钮是否禁用 —— 问题 2 的核心：已经装了最新版就不该还能点 */
		function primaryDisabled(entry) {
			var st = stateOf(entry);
			if (st.status === "current") return true;
			// 「装了但没挂载」是坏状态，这时候必须允许重装，不能置灰
			if (st.installed && !st.inBundles) return false;
			return false;
		}

		function primaryTitle(entry) {
			var st = stateOf(entry);
			if (st.status === "current") {
				return "已经装的是 " + txt(st.installedVersion) + "，与目录里的版本一致 —— 无需安装。目录里出现新版本时这里会变成「更新」。";
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
		 * ── 点赞 / 收藏 ─────────────────────────────────────────────
		 *
		 * 两个都是**本地标记**，不上传、不做排行榜。
		 * 点赞数只统计你自己点过的，收藏同理 —— 因为本插件没有后端，
		 * 假装有全局热度是骗人；界面上也如实写成「本机」。
		 *
		 * 交互上刻意做成「乐观更新」：点下去立刻变色，请求失败再回滚。
		 * 这两个动作只是写一个本地 JSON，失败概率极低，等往返反而显得卡。
		 */
		var MarkButton = function (props) {
			var on = Boolean(props.on);
			var cls = "dpm-mark dpm-mark-" + (props.kind === "like" ? "like" : "fav");
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

		var CheckItem = function (props) {
			var c = props.check || {};
			var kind = classifyCheck(c);
			var sev = kind === "fatal" ? "fatal" : kind === "warn" || kind === "overridable" ? "warn" : kind === "pass" ? "info" : "skip";
			return h(
				"div",
				{ className: "dpm-check", "data-sev": sev },
				h(
					"div",
					{ className: "dpm-check-top" },
					h("span", { className: "dpm-check-t" }, txt(c.title, c.id)),
					h(Badge, { kind: kind === "fatal" ? "bad" : kind === "pass" ? "ok" : "neutral" },
						kind === "fatal" ? "致命 · 不可覆盖"
							: kind === "overridable" ? "无法确认 · 可覆盖"
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

		/** 渲染崩溃兜底：宁可只坏这一块，也不能把整页带走。 */
		var ErrorBoundary = function (props) {
			var st = useState(null);
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
			var tier = e.tier || "community";
			var peerVerdict = e.peerVerdict;
			var st = stateOf(e);
			var badge = installBadge(e);

			return h(
				"div",
				{ className: "dpm-card", "data-tier": tier },
				h(
					"div",
					{ className: "dpm-card-top" },
					h("span", { className: "dpm-card-name" }, txt(e.title, e.id)),
					// ★ 审核状态标签：三层视图合一之后，这里就是「已审核 / 未审核」的唯一出处
					h(Badge, { kind: tierBadgeKind(tier) }, txt(e.tierLabel, tier)),
					e.version ? h("span", { className: "dpm-card-id" }, (e.package || e.id) + "@" + e.version) : h("span", { className: "dpm-card-id" }, txt(e.package, e.id)),
					badge,
					e.favorited ? h(Badge, { kind: "neutral" }, "★ 已收藏") : null,
				),

				// 层级提示 —— 这是用户最需要一眼看到的东西
				tier === "verified"
					? h(Flag, { kind: "ok", icon: "✓" }, "已验证 · 本仓库自带，已按当前 dsh 版本实测，可直接安装（离线 tarball）。")
					: null,
				tier === "reviewed"
					? h(Flag, { kind: "ok", icon: "✓" }, "已审核 · 维护者人工审核收录"
						+ (e.review && e.review.reviewedAt ? "（" + e.review.reviewedAt + "）" : "")
						+ "，仍需通过装前检查。")
					: null,
				tier === "community"
					? h(Flag, { kind: "risk", icon: "!" }, "未审核 · 来自公共索引，本仓库未做适配验证，可能存在不兼容或其它风险。装前检查只能做尽力而为的静态探测。")
					: null,

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
					h(Btn, { small: true, onClick: function () { props.onGate(e, false); } }, "装前检查"),
					/*
					 * ★ 问题 1 + 2 的落点。
					 *   - 已是最新 → 按钮置灰，文案「已安装」，title 里说明原因
					 *   - 有新版   → 蓝色「更新到 x.y.z」，点了走同一条闸门 → 安装流程
					 *   - 没装     → 原来的「安装」
					 */
					st.status === "current"
						? h(Btn, { small: true, className: "dpm-btn-installed", disabled: true, title: primaryTitle(e) }, primaryLabel(e))
						: h(Btn, {
							small: true,
							variant: st.status === "upgradable" ? "update" : (tier === "community" ? undefined : "primary"),
							title: primaryTitle(e) || undefined,
							onClick: function () { props.onGate(e, true); },
						}, primaryLabel(e)),
					h(MarkButton, {
						kind: "like",
						on: e.liked,
						label: "点赞",
						title: "点赞（只记在本机，不上传）",
						onClick: function () { props.onMark(e, "like"); },
					}),
					h(MarkButton, {
						kind: "fav",
						on: e.favorited,
						label: e.favorited ? "已收藏" : "收藏",
						title: "收藏（只记在本机，可用「已收藏」筛选）",
						onClick: function () { props.onMark(e, "favorite"); },
					}),
					e.upstream ? h(Btn, { small: true, onClick: function () { try { window.open(e.upstream, "_blank", "noopener"); } catch (err) { /* 忽略 */ } } }, "仓库") : null,
				),
			);
		};
		//#endregion

		//#region ── 装前检查抽屉 ──────────────────────────────────────────
		var GateDrawer = function (props) {
			var g = props.gate;
			var [ack, setAck] = useState(false);
			var [showPass, setShowPass] = useState(false);

			useEffect(function () { setAck(false); }, [g && g.pluginId]);

			if (!g) {
				return h(
					"div",
					{ className: "dpm-drawer-body" },
					h("div", { className: "dpm-split" }, h(Spinner, null), h("span", null, "正在做装前检查…（会依次核对 Node / dsh / pnpm、profile 状态、以及这个包本身的静态信息）")),
				);
			}

			var vi = verdictInfo(g.verdict);
			var checks = g.checks || [];
			var fatal = checks.filter(function (c) { return classifyCheck(c) === "fatal"; });
			var overridable = checks.filter(function (c) { return classifyCheck(c) === "overridable"; });
			var warns = checks.filter(function (c) { return classifyCheck(c) === "warn"; });
			var passes = checks.filter(function (c) { return classifyCheck(c) === "pass"; });
			var skips = checks.filter(function (c) { return classifyCheck(c) === "skip"; });

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
				h(
					"div",
					{ className: "dpm-drawer-body" },
					/*
					 * 「已是最新」是个**结论**，不是一条检查项 —— 用和判定同级的
					 * 大色块说清楚，别让人在检查列表里找。
					 */
					g.upToDate
						? h("div", { className: "dpm-verdict dpm-verdict-pass" },
							h("span", null, "✓"),
							h("span", null, "已是最新版本，无需安装",
								h("span", { className: "dpm-verdict-sub" },
									"已经装的是 " + txt(g.installState && g.installState.installedVersion)
									+ "，与目录里的版本一致。目录里出现更新的版本时，按钮会变成「更新到 x.y.z」。")))
						: h(
							"div",
							{ className: "dpm-verdict dpm-verdict-" + vi.cls },
							h("span", null, vi.ico),
							h("span", null, vi.title, h("span", { className: "dpm-verdict-sub" }, vi.sub)),
						),

					// 更新场景：把「从哪一版到哪一版」摆在最上面，别让人以为是在重装
					g.upgrade
						? h(Flag, { kind: "info", icon: "↑" },
							"这是一次**更新**：" + txt(g.installState && g.installState.installedVersion)
							+ " → " + txt(g.installState && g.installState.target)
							+ "。会先移除旧版本再装新版本；安装前自动备份 profile，任何一步失败都会自动回滚。")
						: null,

					h(
						"div",
						{ className: "dpm-kv" },
						h("span", { className: "dpm-kv-k" }, "插件"),
						h("span", { className: "dpm-kv-v" }, txt(g.pluginId)),
						h("span", { className: "dpm-kv-k" }, "层级"),
						h("span", { className: "dpm-kv-v" }, txt(g.tierLabel, g.tier)),
						h("span", { className: "dpm-kv-k" }, "目标 profile"),
						h("span", { className: "dpm-kv-v" }, txt(g.targetProfile)),
						g.installState && g.installState.installed
							? h("span", { className: "dpm-kv-k" }, "当前已装")
							: null,
						g.installState && g.installState.installed
							? h("span", { className: "dpm-kv-v" }, txt(g.installState.installedVersion))
							: null,
						g.installState && g.installState.target
							? h("span", { className: "dpm-kv-k" }, "目录里的版本")
							: null,
						g.installState && g.installState.target
							? h("span", { className: "dpm-kv-v" }, txt(g.installState.target))
							: null,
						h("span", { className: "dpm-kv-k" }, "安装规格"),
						h("span", { className: "dpm-kv-v" },
							g.installSpec
								? txt(g.installSpec.kind) + " → " + txt(g.installSpec.resolvedPath || g.installSpec.spec)
								: "（没有可用的安装方式）"),
						g.installSpec && g.installSpec.needsDownload
							? h("span", { className: "dpm-kv-k" }, "需要下载")
							: null,
						g.installSpec && g.installSpec.needsDownload
							? h("span", { className: "dpm-kv-v" }, txt(g.installSpec.downloadUrl))
							: null,
						h("span", { className: "dpm-kv-k" }, "耗时"),
						h("span", { className: "dpm-kv-v" }, txt(g.durationMs, "0") + " ms"),
					),

					g.manifest
						? h(
							"div",
							{ className: "dpm-kv" },
							h("span", { className: "dpm-kv-k" }, "包清单"),
							h("span", { className: "dpm-kv-v" }, txt(g.manifest.name) + "@" + txt(g.manifest.version)),
							g.manifest.dsh && g.manifest.dsh.bundle && g.manifest.dsh.bundle.patch
								? h("span", { className: "dpm-kv-k" }, "bundle patch")
								: null,
							g.manifest.dsh && g.manifest.dsh.bundle && g.manifest.dsh.bundle.patch
								? h("span", { className: "dpm-kv-v" }, g.manifest.dsh.bundle.patch)
								: null,
						)
						: null,

					g.probe
						? h(
							"div",
							{ className: "dpm-kv" },
							h("span", { className: "dpm-kv-k" }, "远程探测"),
							h("span", { className: "dpm-kv-v" }, g.probe.available ? txt(g.probe.source) : ("失败：" + txt(g.probe.error))),
							g.probe.monorepoHint ? h("span", { className: "dpm-kv-k" }, "提示") : null,
							g.probe.monorepoHint ? h("span", { className: "dpm-kv-v" }, "仓库根 package.json 未声明 dsh.bundle，且看起来是 monorepo —— 插件可能在子目录里。") : null,
						)
						: null,

					fatal.length > 0
						? h(Fold, { title: "致命 · 已硬拦截（不可覆盖）", count: fatal.length },
							fatal.map(function (c, i) { return h(CheckItem, { key: "f" + i, check: c }); }))
						: null,
					overridable.length > 0
						? h(Fold, { title: "无法确认 · 默认拦截但可覆盖", count: overridable.length },
							overridable.map(function (c, i) { return h(CheckItem, { key: "o" + i, check: c }); }))
						: null,
					warns.length > 0
						? h(Fold, { title: "提醒 · 可以继续", count: warns.length },
							warns.map(function (c, i) { return h(CheckItem, { key: "w" + i, check: c }); }))
						: null,
					passes.length > 0
						? h(Fold, { title: "通过", count: passes.length, defaultOpen: showPass },
							h("div", null,
								h(Btn, { small: true, onClick: function () { setShowPass(!showPass); } }, showPass ? "收起" : "展开"),
								passes.map(function (c, i) { return h(CheckItem, { key: "p" + i, check: c }); })))
						: null,
					skips.length > 0
						? h(Fold, { title: "跳过 / 无法判定", count: skips.length, defaultOpen: false },
							skips.map(function (c, i) { return h(CheckItem, { key: "s" + i, check: c }); }))
						: null,

					g.requiresRiskAck
						? h(
							"label",
							{ className: "dpm-ack" },
							h("input", {
								type: "checkbox",
								checked: ack,
								onChange: function (ev) { setAck(ev.target.checked); },
							}),
							h("span", null,
								g.tier === "community"
									? "我已阅读上述风险，确认在「未经本仓库审核」的情况下继续安装。若该插件与当前 dsh 版本不兼容，可能导致 harness 无法启动。"
									: "我已阅读上述「无法确认」的项目，确认强制继续安装。"),
						)
						: null,
				),

				h(
					"div",
					{ className: "dpm-drawer-foot" },
					/*
					 * 主按钮。
					 * ★ 「已是最新」时**不渲染**安装按钮，只留「关闭」——
					 *   渲染一个禁用的按钮会让人反复怀疑「是不是哪里没满足」，
					 *   而这里根本没有可做的事。
					 */
					g.upToDate
						? h(Btn, { variant: "primary", onClick: props.onClose }, "好，知道了")
						: h(Btn, {
							variant: g.upgrade ? "update" : "primary",
							disabled: !g.canInstall || (g.requiresRiskAck && !ack) || props.busy,
							onClick: function () { props.onInstall(g, ack); },
						}, props.busy
							? (g.upgrade ? "更新中…" : "安装中…")
							: (g.upgrade ? "开始更新" : "开始安装")),
					h(Btn, { onClick: props.onClose, disabled: props.busy }, "取消"),
					h("span", { className: "dpm-spacer" }),
					h("span", { className: "dpm-muted" },
						g.upToDate ? "已经是最新版本，无需操作"
							: g.canInstall
								? (g.requiresRiskAck ? "需要先勾选确认" : (g.upgrade ? "可以更新" : "可以安装"))
								: (g.installable ? "已被拦截，不能安装" : "没有可用的安装方式")),
				),
			);
		};
		//#endregion

		//#region ── 安装进度 ──────────────────────────────────────────────
		var InstallView = function (props) {
			var r = props.result;
			if (!r) {
				return h("div", { className: "dpm-drawer-body" },
					h("div", { className: "dpm-split" }, h(Spinner, null), h("span", null, "正在安装…请勿关闭页面。安装完成后会打印每一步的结果。")),
					h("div", { className: "dpm-muted" }, "每次安装前都会先给 profile 拍一份快照；任何一步失败都会自动回滚。"),
				);
			}

			var rolledOk = r.rollback && r.rollback.ok;
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
				h(
					"div",
					{ className: "dpm-drawer-body" },
					r.ok
						? h("div", { className: "dpm-verdict dpm-verdict-pass" },
							h("span", null, "✓"),
							h("span", null, r.upgrade ? "更新成功" : "安装成功",
								h("span", { className: "dpm-verdict-sub" },
									(r.upgrade && r.fromVersion && r.toVersion ? r.fromVersion + " → " + r.toVersion + "。" : "")
									+ (r.restartHint || "重启 dsh web 后生效。"))))
						: h("div", { className: "dpm-verdict dpm-verdict-block" },
							h("span", null, "✗"),
							h("span", null, r.upToDate ? "无需安装" : (r.upgrade ? "更新未完成" : "安装未完成"),
								h("span", { className: "dpm-verdict-sub" },
									r.upToDate
										? (r.message || "已经装的是最新版本。")
										: (FAILURE_TEXT[r.failure] || ("失败于阶段：" + txt(r.failure)) + "。")),
							)),

					!r.ok
						? h("div", { style: { marginBottom: 12 } },
							rolledOk
								? h(Flag, { kind: "ok", icon: "↩" }, "已自动回滚：profile 已用安装前的快照还原，并重新链接了 node_modules。你的 harness 保持安装前的状态。")
								: r.rollback
									? h(Flag, { kind: "bad", icon: "✗" }, "回滚失败！请手动处理。快照位置见下方步骤里的「备份 profile」。")
									: h(Flag, { kind: "info", icon: "i" }, "这次失败发生在动到 profile 之前，没有需要回滚的改动。"))
						: null,

					r.ok
						? h(Flag, { kind: "risk", icon: "⟳" }, "必须重启 dsh web 才会生效 —— 新增的 bundle 是在启动时合成的，热重载不会把它加进去。")
						: null,

					h(StepList, { steps: r.steps }),
				),
				h(
					"div",
					{ className: "dpm-drawer-foot" },
					h(Btn, { onClick: props.onClose }, "关闭"),
					h(Btn, { onClick: props.onRefresh, variant: r.ok ? "primary" : undefined }, "刷新状态"),
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
		 * ★ 原来是三个平级页签（已验证 / 已审核 / 未审核）。
		 *
		 * 那个切分对用户没有意义：他要回答的是「这个插件装得安不安全」，
		 * 而 verified 与 reviewed 在这一点上给出的答案**是同一个**（都过了
		 * 本仓库的适配验证），却被拆成两个页签让人来回切。
		 *
		 * 现在并成一个「插件市场」列表，安全差异交给每条插件自己的**审核标签**
		 * 承载（已验证 / 已审核 / 未审核），顶部再加一组可叠加的筛选器。
		 */
		var CATALOG_TAB = "market";

		/** 目录页的三组筛选：审核状态（单选）、我的标记（多选）、安装状态（多选） */
		var REVIEW_FILTERS = [
			{ key: null, label: "全部" },
			{ key: "reviewed", label: "已审核" },
			{ key: "unreviewed", label: "未审核" },
		];

		var ONLY_FILTERS = [
			{ key: "installed", label: "已安装", title: "只看已经装上的插件" },
			{ key: "upgradable", label: "可升级", title: "只看装了、且仓库里有新版本的插件" },
			{ key: "liked", label: "我点赞的", title: "只看你点过赞的插件（记在本机）" },
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
			var [review, setReview] = useState(null);   // null | 'reviewed' | 'unreviewed'
			var [only, setOnly] = useState(null);       // null | 'installed' | 'upgradable' | 'liked' | 'favorited'

			var [drawer, setDrawer] = useState(null); // { kind, id, entry }
			var [gate, setGate] = useState(null);
			var [installResult, setInstallResult] = useState(null);
			var [verifyResult, setVerifyResult] = useState(null);
			var [busy, setBusy] = useState(false);

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
					return s;
				} catch (err) {
					return fail(err);
				}
			}, [fail]);

			var loadList = useCallback(async function (query, pageIdx, rev, onl) {
				setListBusy(true);
				try {
					var args = { query: query, limit: PAGE_SIZE, offset: pageIdx * PAGE_SIZE };
					if (rev) args.review = rev;
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
				loadList("", 0, null, null);
			}, [loadStatus, loadList]);

			// 筛选 / 翻页变化时重新拉列表
			useEffect(function () {
				if (tab !== CATALOG_TAB) return;
				loadList(q, page, review, only);
			}, [tab, page, review, only, loadList]); // q 由搜索按钮显式提交，不放进依赖

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

			var submitSearch = useCallback(function () {
				setPage(0);
				loadList(q, 0, review, only);
			}, [q, review, only, loadList]);

			/**
			 * 点赞 / 收藏。
			 *
			 * 乐观更新：先改本地那一份（列表 + 状态里的个人统计），请求回来再以
			 * 服务端返回为准；失败就整体回滚并把错误抛给 toast。
			 * 这两个动作只写一个本地 JSON，正常情况下一帧就回来了。
			 */
			var doMark = useCallback(async function (entry, action) {
				var field = action === "like" ? "liked" : "favorited";
				var next = !entry[field];
				var prevList = list;
				var prevStatus = status;

				setList(function (cur) {
					if (!cur) return cur;
					return {
						...cur,
						items: cur.items.map(function (it) {
							return it.id === entry.id ? { ...it, [field]: next } : it;
						}),
						marks: cur.marks ? {
							...cur.marks,
							[action === "like" ? "liked" : "favorited"]:
								Math.max(0, (cur.marks[action === "like" ? "liked" : "favorited"] || 0) + (next ? 1 : -1)),
						} : cur.marks,
					};
				});

				try {
					var r = await api("mark", { action: action, id: entry.id, value: next });
					if (!aliveRef.current) return;
					// 服务端是真值来源：它可能因为「两个标记都归零」而把整条删掉
					setList(function (cur) {
						if (!cur) return cur;
						return {
							...cur,
							items: cur.items.map(function (it) {
								return it.id === entry.id ? { ...it, liked: r.liked, favorited: r.favorited } : it;
							}),
						};
					});
				} catch (err) {
					if (aliveRef.current) { setList(prevList); setStatus(prevStatus); }
					fail(err);
				}
			}, [list, status, fail]);

			var openGate = useCallback(async function (entry, forInstall) {
				setToast(null);
				setInstallResult(null);
				setGate(null);
				setDrawer({ kind: "gate", id: entry.id, entry: entry, forInstall: !!forInstall });
				setBusy(true);
				try {
					var r = await api("gate", { id: entry.id });
					if (aliveRef.current) setGate(r);
				} catch (err) {
					fail(err);
					if (aliveRef.current) setDrawer(null);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail]);

			var doInstall = useCallback(async function (g, ack) {
				setBusy(true);
				setDrawer({ kind: "install", id: g.pluginId, entry: drawer && drawer.entry });
				try {
					var r = await api("install", { id: g.pluginId, acknowledgeRisk: !!ack });
					if (aliveRef.current) setInstallResult(r);
					if (r && r.steps) {
						// 安装过程中把已完成步骤先渲染出来
						if (aliveRef.current) setToast(null);
					}
					// 安装后顺手刷新状态（两处都要刷：状态条里的「可更新」计数就在 status 里）
					await loadStatus();
					await loadList(q, page, review, only);
				} catch (err) {
					fail(err);
					if (aliveRef.current) setInstallResult({ ok: false, failure: "rpc", steps: [] });
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [drawer, fail, loadStatus, loadList, q, page, review, only]);

			var doUninstall = useCallback(async function (item) {
				setToast(null);
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
						 * ★ 如实报出三层各自的来源。
						 *
						 *   刷新不再必然是一次大下载：公共索引带 ETag，目录没变时服务端答 304，
						 *   传输量几乎为零（原先无条件重下 4.8MB，在这条线路上要 ~28 秒）。
						 *   所以提示语要说「目录未变」而不是让用户以为白点了一下。
						 *
						 *   verified 现在是远程优先的，它到底是「远程」还是「离线包内兜底」
						 *   直接决定用户看到的版本新不新 —— 这个必须显式说出来，不能藏。
						 */
						var srcText = {
							'remote': "远程最新",
							'remote-304': "目录未变（304）",
							'cache': "本地缓存",
							'cache-error': "网络失败，用本地缓存",
							'bundled': "离线包内快照",
							'unavailable': "不可用",
						};
						setToast(
							"目录已刷新 · 已验证：" + (srcText[r.verified] || r.verified || "?")
							+ " · 已审核：" + (srcText[r.reviewed] || r.reviewed || "?")
							+ " · 公共索引：" + (srcText[r.community] || r.community || "?")
							+ (r.verified === 'bundled' || r.verified === 'cache' ? "（已验证层没能取到远程目录，显示的版本可能不是最新）" : ""),
						);
					}
					await loadStatus();
					await loadList(q, page, review, only);
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail, loadStatus, loadList, q, page, review, only]);

			var closeDrawer = useCallback(function () {
				setDrawer(null);
				setGate(null);
				setInstallResult(null);
				setVerifyResult(null);
			}, []);

			// ── 派生数据 ──
			var env = (status && status.env) || {};
			var profile = (status && status.profile) || {};
			var compat = (status && status.compat) || {};
			var catalog = (status && status.catalog) || {};
			var merged = catalog.merged || { total: 0, reviewed: 0, unreviewed: 0 };
			var installed = (status && status.installed) || [];
			var upgradable = (status && status.upgradable) || [];
			var userData = (status && status.userData) || { liked: 0, favorited: 0 };

			var subParts = [];
			if (env.dsh) subParts.push("dsh " + txt(env.dsh.version));
			if (profile.name) subParts.push("profile " + profile.name);
			if (env.node) subParts.push("node " + txt(env.node.version));
			if (env.pnpm) subParts.push("pnpm " + txt(env.pnpm.version));
			if (compat.dshVersion) subParts.push("矩阵：" + (compat.supported || []).join(" / ") || "—");

			// ── 渲染 ──
			var body = null;

			if (tab === CATALOG_TAB) {
				var items = (list && list.items) || [];
				var total = list ? list.total : 0;
				var maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
				var counts = (list && list.marks) || { liked: 0, favorited: 0 };

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
							onClick: function () { setQ(""); setPage(0); setReview(null); setOnly(null); loadList("", 0, null, null); },
						}, "重置"),
						listBusy ? h(Spinner, null) : null,
						h("span", { className: "dpm-spacer" }),
						h("span", { className: "dpm-pager-info" }, "共 " + total + " 条"),

						/*
						 * ★ 问题 4 的落点：三层视图合一，用这里的筛选 + 卡片上的审核标签区分。
						 *   审核状态是**单选**（全部 / 已审核 / 未审核），
						 *   其余三组是**可叠加**的开关。
						 */
						h(
							"div",
							{ className: "dpm-filters", style: { flexBasis: "100%", marginTop: 2 } },
							REVIEW_FILTERS.map(function (f) {
								return h("button", {
									key: "rf" + String(f.key),
									type: "button",
									className: "dpm-filter",
									"data-on": review === f.key ? "1" : undefined,
									onClick: function () { setReview(f.key); setPage(0); },
								}, f.label,
									f.key === "reviewed" ? h("span", { className: "dpm-filter-n" }, merged.reviewed) : null,
									f.key === "unreviewed" ? h("span", { className: "dpm-filter-n" }, merged.unreviewed) : null);
							}),
							h("span", { style: { width: 10 } }),
							ONLY_FILTERS.map(function (f) {
								return h("button", {
									key: "of" + f.key,
									type: "button",
									className: "dpm-filter",
									title: f.title,
									"data-on": only === f.key ? "1" : undefined,
									onClick: function () { setOnly(only === f.key ? null : f.key); setPage(0); },
								}, f.label,
									f.key === "upgradable" && upgradable.length > 0
										? h("span", { className: "dpm-filter-n" }, upgradable.length)
										: null,
									f.key === "liked" && counts.liked > 0 ? h("span", { className: "dpm-filter-n" }, counts.liked) : null,
									f.key === "favorited" && counts.favorited > 0 ? h("span", { className: "dpm-filter-n" }, counts.favorited) : null);
							}),
							h("span", { className: "dpm-spacer" }),
							h("span", { className: "dpm-pager-info" }, "点赞 " + txt(counts.liked, "0") + " · 收藏 " + txt(counts.favorited, "0") + "（记在本机）"),
						),
					),

					list && list.communityMeta && list.communityMeta.error
						? h(Flag, { kind: "risk", icon: "!" }, "公共索引拉取有问题：" + list.communityMeta.error + "（下面的结果可能来自磁盘缓存）")
						: null,
					list && list.verifiedAvailable === false
						? h(Flag, { kind: "bad", icon: "✗" }, "包内目录缺失：" + txt(list.verifiedError))
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
							: only === "liked" ? "还没有点赞任何插件。点插件卡片上的「点赞」即可。"
								: only === "upgradable" ? "没有可更新的插件 —— 装了的都是目录里的最新版本。"
									: only === "installed" ? "还没有安装任何目录里的插件。"
										: "没有匹配的插件。首次使用需要联网拉取公共索引，点右上方「刷新目录」。")
						: h("div", { className: "dpm-cards" },
							items.map(function (e) {
								return h(EntryCard, {
									key: e.id,
									entry: e,
									onGate: openGate,
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
						// ★ 「体检」页签已按用户要求去掉，但「修复」这个能力不能跟着消失：
						//   它是「装了但没挂载」那类静默残局的唯一出路。搬成一个按钮。
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
												openGate({
													id: i.name, package: i.name, title: i.name,
													tier: i.state === "current" ? "verified" : (i.tier || "verified"),
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
			if (drawer && drawer.kind === "gate") {
				drawerContent = h(GateDrawer, { gate: gate, busy: busy, onClose: closeDrawer, onInstall: doInstall });
			} else if (drawer && drawer.kind === "install") {
				drawerContent = h(InstallView, { result: installResult, onClose: closeDrawer, onRefresh: function () { loadStatus(); closeDrawer(); } });
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
							h("p", { className: "dpm-sub" },
								subParts.map(function (s, i) { return h("span", { key: "s" + i }, s); })),
							h("p", { className: "dpm-sub" },
								h("span", null, "本仓库自带插件"),
								h("code", null, "已验证"),
								h("span", null, "· 可直接安装"),
								h("span", null, "|"),
								h("span", null, "其余"),
								h("code", null, "未审核"),
								h("span", null, "· 装前会提示风险")),
						),
						h(Btn, { disabled: busy, onClick: doRefresh }, "刷新目录"),
						h(Btn, { onClick: function () { if (props.onClose) props.onClose(); } }, "关闭"),
					),
				),

				/*
				 * 状态条。
				 *
				 * ★ 这里原来打的是三层目录的原始条数（已验证 N / 已审核 N / 未审核 N），
				 *   但三层去重合并之后，那三个数字加起来**对不上列表条数** —— 同一个包
				 *   会同时出现在「已验证」和公共索引里，被数两次。用户看到「共 10 条」
				 *   而三个标签加起来是 13，只会以为界面坏了。
				 *   所以改用合并后的口径：已审核 / 未审核 / 可更新。
				 */
				h(
					"div",
					{ className: "dpm-strip" },
					h(Badge, { kind: "verified" }, "已验证 " + txt(merged.verified, "0")),
					h(Badge, { kind: "reviewed" }, "已审核 " + txt(merged.reviewedTier, "0")),
					h(Badge, { kind: "community" }, "未审核 " + txt(merged.unreviewed, "0")),
					h("span", { className: "dpm-muted" }, "去重后共 " + txt(merged.total, "0") + " 条"),
					upgradable.length > 0
						? h(Badge, { kind: "update" }, "可更新 " + upgradable.length)
						: null,
					catalog.verified && catalog.verified.available === false
						? h(Badge, { kind: "bad" }, "包内目录缺失")
						: null,
					catalog.community && catalog.community.error
						? h(Badge, { kind: "neutral" }, "公共索引：" + txt(catalog.community.source))
						: null,
					catalog.community && catalog.community.stale
						? h(Badge, { kind: "neutral" }, "索引缓存 " + ageText(catalog.community.ageMs))
						: null,
					h("span", { className: "dpm-spacer" }),
					status && status.repo && status.repo.detected
						? h(Badge, { kind: "ok" }, "已识别本地仓库")
						: h(Badge, { kind: "neutral" }, "未识别本地仓库（tarball 将联网下载）"),
				),

				/*
				 * ★ 页签：三个目录页签（已验证 / 已审核 / 未审核）已被**合并成一个
				 *   「插件市场」**，安全差异由卡片上的审核标签 + 顶部筛选器承载。
				 *   这也是用户明确要求的第 4 点。
				 */
				h(
					"div",
					{ className: "dpm-tabs" },
					h("button", {
						key: "market", type: "button", className: "dpm-tab",
						"data-on": tab === CATALOG_TAB ? "1" : undefined,
						onClick: function () { setTab(CATALOG_TAB); setPage(0); setQ(""); },
					}, "插件市场 " + (merged.total === undefined ? "" : merged.total)),
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

				toast ? h("div", { className: "dpm-toast" }, h("span", null, "!"), h("span", { style: { flex: "1 1 auto" } }, toast),
					h("button", { type: "button", className: "dpm-btn dpm-btn-sm", onClick: function () { setToast(null); } }, "知道了")) : null,

				drawer
					? h(
						"div",
						{ className: "dpm-drawer" },
						h(
							"div",
							{ className: "dpm-drawer-head" },
							h("h3", { className: "dpm-drawer-title" },
								drawer.kind === "gate" ? "装前检查 · " + txt(drawer.entry && (drawer.entry.title || drawer.entry.id))
									: drawer.kind === "install" ? "安装 · " + txt(drawer.entry && (drawer.entry.title || drawer.entry.id))
									: "校验 · " + txt(drawer.id, "profile")),
							h("span", { className: "dpm-spacer" }),
							drawer.kind === "gate" && gate
								? h(Badge, { kind: gate.verdict === "pass" ? "ok" : gate.verdict === "warn" ? "neutral" : "bad" }, txt(gate.verdict))
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
