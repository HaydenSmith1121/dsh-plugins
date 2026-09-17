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
		var Btn = function (props) {
			var cls = "dpm-btn";
			if (props.variant === "primary") cls += " dpm-btn-primary";
			else if (props.variant === "danger") cls += " dpm-btn-danger";
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

		var Chip = function (props) {
			return h("span", { className: "dpm-chip" }, props.children);
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
			var inst = props.installed || null;
			var tier = e.tier || "community";
			var peerVerdict = e.peerVerdict;

			return h(
				"div",
				{ className: "dpm-card", "data-tier": tier },
				h(
					"div",
					{ className: "dpm-card-top" },
					h("span", { className: "dpm-card-name" }, txt(e.title, e.id)),
					h(Badge, { kind: tierBadgeKind(tier) }, txt(e.tierLabel, tier)),
					e.version ? h("span", { className: "dpm-card-id" }, (e.package || e.id) + "@" + e.version) : h("span", { className: "dpm-card-id" }, txt(e.package, e.id)),
					inst ? h(Badge, { kind: inst.inBundles ? "ok" : "bad" }, inst.inBundles ? "已安装" : "装了未挂载") : null,
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
					h(Btn, {
						small: true,
						variant: tier === "community" ? undefined : "primary",
						onClick: function () { props.onGate(e, true); },
					}, "安装"),
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
					h(
						"div",
						{ className: "dpm-verdict dpm-verdict-" + vi.cls },
						h("span", null, vi.ico),
						h("span", null, vi.title, h("span", { className: "dpm-verdict-sub" }, vi.sub)),
					),

					h(
						"div",
						{ className: "dpm-kv" },
						h("span", { className: "dpm-kv-k" }, "插件"),
						h("span", { className: "dpm-kv-v" }, txt(g.pluginId)),
						h("span", { className: "dpm-kv-k" }, "层级"),
						h("span", { className: "dpm-kv-v" }, txt(g.tierLabel, g.tier)),
						h("span", { className: "dpm-kv-k" }, "目标 profile"),
						h("span", { className: "dpm-kv-v" }, txt(g.targetProfile)),
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
					h(Btn, {
						variant: "primary",
						disabled: !g.canInstall || (g.requiresRiskAck && !ack) || props.busy,
						onClick: function () { props.onInstall(g, ack); },
					}, props.busy ? "安装中…" : "开始安装"),
					h(Btn, { onClick: props.onClose, disabled: props.busy }, "取消"),
					h("span", { className: "dpm-spacer" }),
					h("span", { className: "dpm-muted" },
						g.canInstall
							? (g.requiresRiskAck ? "需要先勾选确认" : "可以安装")
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
							h("span", null, "安装成功", h("span", { className: "dpm-verdict-sub" }, r.restartHint || "重启 dsh web 后生效。")))
						: h("div", { className: "dpm-verdict dpm-verdict-block" },
							h("span", null, "✗"),
							h("span", null, "安装未完成",
								h("span", { className: "dpm-verdict-sub" },
									FAILURE_TEXT[r.failure] || ("失败于阶段：" + txt(r.failure)) + "。"),
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
		var CATALOG_TABS = [
			{ key: "verified", label: "已验证" },
			{ key: "reviewed", label: "已审核" },
			{ key: "community", label: "未审核" },
		];

		var Panel = function (props) {
			var [toast, setToast] = useState(null);
			var [status, setStatus] = useState(null);
			var [tab, setTab] = useState("verified");
			var [q, setQ] = useState("");
			var [page, setPage] = useState(0);
			var [list, setList] = useState(null);
			var [listBusy, setListBusy] = useState(false);

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

			var loadList = useCallback(async function (tier, query, pageIdx) {
				if (CATALOG_TABS.map(function (t) { return t.key; }).indexOf(tier) < 0) return;
				setListBusy(true);
				try {
					var r = await api("catalog", { tier: tier, query: query, limit: PAGE_SIZE, offset: pageIdx * PAGE_SIZE });
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
				loadList("verified", "", 0);
			}, [loadStatus, loadList]);

			// 切 tab / 翻页
			useEffect(function () {
				if (CATALOG_TABS.map(function (t) { return t.key; }).indexOf(tab) < 0) return;
				loadList(tab, q, page);
			}, [tab, page, loadList]); // q 由搜索按钮显式提交，不放进依赖

			// 非目录页的按需加载
			useEffect(function () {
				if (tab === "installed") loadStatus();
				if (tab === "health") {
					api("backups").then(function (r) { if (aliveRef.current) setBackups(r); }).catch(fail);
				}
				if (tab === "log") {
					api("log", { n: 200 }).then(function (r) { if (aliveRef.current) setLogs(r); }).catch(fail);
				}
			}, [tab, loadStatus, fail]);

			var submitSearch = useCallback(function () {
				setPage(0);
				loadList(tab, q, 0);
			}, [tab, q, loadList]);

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
					// 安装后顺手刷新状态
					await loadStatus();
					loadList("verified", "", 0);
				} catch (err) {
					fail(err);
					if (aliveRef.current) setInstallResult({ ok: false, failure: "rpc", steps: [] });
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [drawer, fail, loadStatus, loadList]);

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
				setToast("正在刷新目录（公共索引较大，首次拉取可能需要十几秒）…");
				try {
					var r = await api("refresh");
					if (r && r.ok === false) fail(new Error(r.error || "刷新失败"));
					else if (aliveRef.current) setToast(null);
					await loadStatus();
					await loadList(tab, q, page);
				} catch (err) {
					fail(err);
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}, [fail, loadStatus, loadList, tab, q, page]);

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
			var tiers = catalog.tiers || [];
			var installed = (status && status.installed) || [];

			var subParts = [];
			if (env.dsh) subParts.push("dsh " + txt(env.dsh.version));
			if (profile.name) subParts.push("profile " + profile.name);
			if (env.node) subParts.push("node " + txt(env.node.version));
			if (env.pnpm) subParts.push("pnpm " + txt(env.pnpm.version));
			if (compat.dshVersion) subParts.push("矩阵：" + (compat.supported || []).join(" / ") || "—");

			var tierCount = {};
			tiers.forEach(function (t) { tierCount[t.id] = t.count; });

			// ── 渲染 ──
			var body = null;

			if (CATALOG_TABS.map(function (t) { return t.key; }).indexOf(tab) >= 0) {
				var items = (list && list.items) || [];
				var total = list ? list.total : 0;
				var maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
				body = h(
					"div",
					null,
					h(
						"div",
						{ className: "dpm-toolbar dpm-toolbar-sticky" },
						h("input", {
							className: "dpm-input",
							type: "search",
							placeholder: tab === "community" ? "在 7000+ 个公共插件里搜（服务端检索）…" : "搜索…",
							value: q,
							onChange: function (ev) { setQ(ev.target.value); },
							onKeyDown: function (ev) { if (ev.key === "Enter") submitSearch(); },
						}),
						h(Btn, { onClick: submitSearch, variant: "primary" }, "搜索"),
						h(Btn, { onClick: function () { setQ(""); setPage(0); loadList(tab, "", 0); } }, "重置"),
						listBusy ? h(Spinner, null) : null,
						h("span", { className: "dpm-spacer" }),
						h("span", { className: "dpm-pager-info" }, "共 " + total + " 条"),
					),

					tab === "community" && list && list.communityMeta && list.communityMeta.error
						? h(Flag, { kind: "risk", icon: "!" }, "公共索引拉取有问题：" + list.communityMeta.error + "（下面的结果可能来自磁盘缓存）")
						: null,
					tab === "verified" && list && list.verifiedAvailable === false
						? h(Flag, { kind: "bad", icon: "✗" }, "包内目录缺失：" + txt(list.verifiedError))
						: null,

					items.length === 0 && !listBusy
						? h(Empty, null, tab === "community"
							? "没有匹配的插件。公共索引第一次需要联网拉取，可以在「体检」页点「刷新目录」。"
							: "没有匹配的条目。")
						: h("div", { className: "dpm-cards" },
							items.map(function (e) {
								return h(EntryCard, {
									key: e.id,
									entry: e,
									installed: installed.filter(function (i) { return i.name === (e.package || e.id); })[0] || null,
									onGate: openGate,
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
									h("span", { className: "dpm-spacer" }),
									h(Btn, { small: true, onClick: function () { doVerify(i.name); } }, "校验"),
									h(Btn, { small: true, variant: "danger", disabled: busy, onClick: function () { doUninstall(i); } }, "卸载"),
								);
							}),
							installed.some(function (i) { return i.installed && !i.inBundles; })
								? h("div", { style: { marginTop: 14 } },
									h(Flag, { kind: "bad", icon: "!" }, "有依赖「装了但没挂载」—— 这是 pnpm 以非 0 退出时 dsh 不会把包写进 bundles 造成的静默残局，GUI 里看不到它。到「体检」页点「修复」可以让 dsh 重新对齐。"))
								: null,
						),
				);
			}

			if (tab === "health") {
				var hc = (health && health.checks) || [];
				var hFatal = hc.filter(function (c) { return classifyCheck(c) === "fatal"; });
				var hOther = hc.filter(function (c) { return classifyCheck(c) !== "fatal" && classifyCheck(c) !== "pass"; });
				var hPass = hc.filter(function (c) { return classifyCheck(c) === "pass"; });
				var repairables = hc.filter(function (c) { return c.repairable; });

				body = h(
					"div",
					null,
					h("div", { className: "dpm-toolbar" },
						h(Btn, { variant: "primary", onClick: doProfileCheck }, "检查 profile"),
						h(Btn, { onClick: function () { doVerify(null); } }, "校验三层"),
						h(Btn, { disabled: busy, onClick: doBootVerify }, "真实启动校验"),
						h(Btn, { onClick: function () { api("backups").then(function (r) { setBackups(r); }).catch(fail); } }, "刷新快照列表"),
						busy ? h(Spinner, null) : null,
					),

					h(Flag, { kind: "info", icon: "i" },
						"「校验三层」= 依赖层 / 注册表层 / 装配层，全部只读、秒级完成。"
						+ "「真实启动校验」会真的起一次 dsh（自动选空闲端口），是唯一能验证「模块能不能 import」的办法，约需 30–40 秒。"),

					repairables.length > 0
						? h("div", { style: { marginTop: 12 } },
							h(Flag, { kind: "risk", icon: "!" }, "有 " + repairables.length + " 项可以自动修复。"),
							h("div", { className: "dpm-card-act" },
								repairables.map(function (c, i) {
									return h(Btn, { key: "r" + i, variant: "primary", disabled: busy, onClick: function () { doRepair(c); } }, "修复：" + txt(c.title, c.id));
								})))
						: null,

					health
						? h("div", { style: { marginTop: 14 } },
							h("div", { className: "dpm-kv" },
								h("span", { className: "dpm-kv-k" }, "检查项"),
								h("span", { className: "dpm-kv-v" }, hc.length + " 项（致命 " + hFatal.length + " / 提醒 " + hOther.length + " / 通过 " + hPass.length + "）"),
							),
							hFatal.length > 0 ? h(Fold, { title: "致命", count: hFatal.length }, hFatal.map(function (c, i) { return h(CheckItem, { key: "hf" + i, check: c }); })) : null,
							hOther.length > 0 ? h(Fold, { title: "提醒", count: hOther.length }, hOther.map(function (c, i) { return h(CheckItem, { key: "ho" + i, check: c }); })) : null,
							hPass.length > 0 ? h(Fold, { title: "通过", count: hPass.length, defaultOpen: false }, hPass.map(function (c, i) { return h(CheckItem, { key: "hp" + i, check: c }); })) : null,
						)
						: h(Empty, null, "点「检查 profile」跑一次体检。"),

					bootResult
						? h("div", { style: { marginTop: 18 } },
							h("h3", { className: "dpm-group-h" }, "真实启动校验结果"),
							h("div", { className: "dpm-kv" },
								h("span", { className: "dpm-kv-k" }, "结论"),
								h("span", { className: "dpm-kv-v" }, bootResult.ok ? "通过（打印了访问地址，且无致命错误）" : "未通过"),
								h("span", { className: "dpm-kv-k" }, "看到地址"),
								h("span", { className: "dpm-kv-v" }, bootResult.sawUrl ? "是" : "否"),
								h("span", { className: "dpm-kv-k" }, "退出码"),
								h("span", { className: "dpm-kv-v" }, txt(bootResult.exitCode)),
							),
							(bootResult.fatalHits || []).length > 0
								? h(Flag, { kind: "bad", icon: "✗" }, "命中致命特征：" + bootResult.fatalHits.join("、"))
								: null,
							(bootResult.warnings || []).length > 0
								? h("pre", { className: "dpm-pre" }, bootResult.warnings.join("\n"))
								: null,
							bootResult.output ? h("pre", { className: "dpm-pre" }, bootResult.output) : null,
						)
						: null,

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

				h(
					"div",
					{ className: "dpm-strip" },
					tiers.map(function (t) {
						return h(Badge, { key: t.id, kind: tierBadgeKind(t.id) }, t.label + " " + (t.count === undefined ? "—" : t.count));
					}),
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

				h(
					"div",
					{ className: "dpm-tabs" },
					CATALOG_TABS.map(function (t) {
						return h("button", {
							key: t.key, type: "button", className: "dpm-tab",
							"data-on": tab === t.key ? "1" : undefined,
							onClick: function () { setTab(t.key); setPage(0); setQ(""); },
						}, t.label + (tierCount[t.key] === undefined ? "" : " " + tierCount[t.key]));
					}),
					h("button", {
						key: "installed", type: "button", className: "dpm-tab",
						"data-on": tab === "installed" ? "1" : undefined,
						onClick: function () { setTab("installed"); },
					}, "已装"),
					h("button", {
						key: "health", type: "button", className: "dpm-tab",
						"data-on": tab === "health" ? "1" : undefined,
						onClick: function () { setTab("health"); },
					}, "体检"),
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
