// fast-ai-cosmic 在桌面和网页界面里的样子：照 iOS 27 的设计规范（Liquid Glass 液态玻璃）。
// 数值取自 ios27-design-system（MIT，github.com/seunghan91/ios27-design-system，按苹果 iOS 27 官方 Figma 套件实测）：
// 系统色、玻璃配方（底色、0.5px 外圈、上下两道内阴影、投影、圆角 34）、弹簧曲线、多层应用图标。
// 用法守它的三条规矩：玻璃只给浮在内容上面的那一层（输入框、弹出面板、确认卡片），首页这种内容区不用玻璃；
// 玻璃上面不再叠玻璃；系统设了「降低透明度」就退成实底。
// 底色、文字是中性灰（本仓库规矩：灰阶不带色相，苹果的灰带一丝蓝，肉眼分不出）；品牌色是系统蓝。
// 浏览器端插件，dsh 的模块加载器直接执行这个文件，不经编译，所以写成普通 JS。
// 名字和标语跟 src/brand.ts 一致（test/dsh/brand.test.ts 核对）。
//
// 改样子的三种办法，按稳到不稳排，能用前面的就不用后面的：
//   1. 主题变量（ctx.theme.overrideTokens）：dsh 的颜色、字体、圆角全是变量，深浅两套各给一个值。
//      背景、文字、侧栏、输入框都引用同一条灰阶 neutral-bluish，把这条灰阶换成中性石墨灰，全界面一起换色调；
//      品牌蓝 deepseek-* 换成系统蓝色阶，状态色换成系统绿、靛蓝、橙、红。
//   2. 插槽：侧栏标志和名字、首页品牌位（图标、标题、名牌）、输入框左边的 JVM 小标签。
//   3. 一份全局样式表（COSMIC_CSS）：只挂在 dsh 写死的 data-* 属性、结构关系和我们自己的类名上，
//      不碰 dsh 编译时会变的类名。dsh 升级后结构变了，最坏是那一处退回 dsh 原样，不会坏掉。
//
// 首页标题那一行（「探索未至之境」）、加载页、「深度求索中」这几处字插件改不了：同一界面字典不许注册两次，
// 抢先注册会让 dsh 的对话界面起不来。字由打包补丁改（scripts/package-desktop.mjs）；
// 首页有名牌时，样式表把 dsh 那行标题藏起来——名牌里已经写着副标题。
window.__ModuleLoader__.load({
	id: "fast-ai-cosmic",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		const PRODUCT_LOGO_NAME = "Fast-AI-COSMIC";
		const PRODUCT_LOGO_MARK = "COSMIC";
		const PRODUCT_LOGO_TAG = "F A S T · A I";
		const PRODUCT_SUBTITLE = "金蝶云·苍穹开发智能体";
		const PRODUCT_TAGLINE = "构建，在真实环境中验证";

		// ── 配色，深浅两套：iOS 27 系统色 ──
		// glow 系统蓝（主按钮、链接、焦点、图标底色），accent 靛蓝（图标底色的另一头、执行中）；
		// hi 最亮的字；deep、line、label 是中性灰；ready / warn / bad 是系统绿、橙、红。
		// 浅色主题里状态色要当字用，取苹果的高对比那一档（白底上读得清）；深色取标准档。
		const PALETTES = {
			dark: {
				accent: [109, 124, 255],
				hi: [255, 255, 255],
				glow: [0, 145, 255],
				deep: [44, 44, 46],
				line: [72, 72, 74],
				label: [142, 142, 147],
				ready: [48, 209, 88],
				run: [109, 124, 255],
				warn: [255, 146, 48],
				bad: [255, 66, 69],
			},
			light: {
				accent: [97, 85, 245],
				hi: [0, 0, 0],
				glow: [0, 136, 255],
				deep: [229, 229, 234],
				line: [199, 199, 204],
				label: [142, 142, 147],
				ready: [0, 137, 50],
				run: [86, 74, 222],
				warn: [197, 83, 0],
				bad: [233, 21, 45],
			},
		};
		const rgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(", ")})`;
		const rgba = (c, a) => `rgba(${c.map((v) => Math.round(v)).join(", ")}, ${a})`;
		const pair = (light, dark) => ({ light, dark });
		const same = (value) => ({ light: value, dark: value });
		const L = PALETTES.light;
		const D = PALETTES.dark;

		/**
		 * dsh 的灰阶（design-platform.css 里的原值）换成中性石墨灰：明度不动，色相只留一丝冷调、饱和度压到个位数。
		 * dsh 原版的灰偏蓝，这样既和它分开，底色和文字也不带任何品牌色。
		 */
		const GRAY_SCALES = {
			"neutral-bluish": {
				"00": 255,
				50: 250,
				55: 247,
				60: 246,
				75: 243,
				90: 240,
				100: 238,
				150: 237,
				200: 231,
				300: 211,
				310: 210,
				400: 178,
				500: 158,
				600: 134,
				700: 102,
				750: 70,
				800: 54,
				850: 45,
				875: 35,
				900: 27,
				950: 21,
				1000: 17,
			},
			neutral: {
				"00": 255,
				50: 250,
				100: 245,
				150: 237,
				200: 229,
				250: 220,
				300: 212,
				400: 164,
				500: 131,
				550: 104,
				600: 85,
				700: 60,
				800: 41,
				850: 34,
				900: 15,
				1000: 0,
			},
		};
		const graphite = (gray) => {
			const light = Math.min(99, (gray / 255) * 100);
			const sat = light >= 80 ? 5 : light >= 20 ? 4 : 6;
			return `hsl(240 ${sat}% ${light.toFixed(1)}%)`;
		};
		/** dsh 的品牌蓝 deepseek-* 换成系统蓝色阶：400 是深色主题的蓝、500 是浅色主题的蓝。 */
		const BRAND_SCALE = {
			50: [235, 245, 255],
			100: [214, 234, 255],
			200: [178, 216, 255],
			300: [122, 190, 255],
			400: D.glow,
			450: [0, 140, 255],
			500: L.glow,
			600: [0, 110, 214],
			"700-delete": [0, 88, 176],
			800: [10, 50, 96],
			900: [8, 34, 66],
		};
		/**
		 * 字：苹果上是 SF Pro / 苹方，Windows 上落到 Segoe UI Variable 和雅黑；代码用 SF Mono 一路的等宽字。
		 * 改的是 dsh 的「内置字体」那一层，用户在设置里自己选的字体照样排在前面。
		 */
		const TEXT =
			"-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', " +
			"'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Hiragino Sans GB', sans-serif";
		const DISPLAY =
			"'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', " +
			"'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";
		const MONO =
			"'SF Mono', ui-monospace, 'JetBrains Mono', 'Cascadia Mono', Consolas, Menlo, " +
			"'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', monospace";

		const TOKENS = {};
		// 我们自己的几样颜色也走主题变量：深浅切换时 dsh 一并换，样式表里直接 var(--cosmic-*)。
		for (const key of Object.keys(D)) TOKENS[`--cosmic-${key}`] = pair(rgb(L[key]), rgb(D[key]));
		for (const [scale, steps] of Object.entries(GRAY_SCALES))
			for (const [step, gray] of Object.entries(steps))
				TOKENS[`--dsw-static-${scale}-${step}`] = same(graphite(gray));
		for (const [step, color] of Object.entries(BRAND_SCALE))
			TOKENS[`--dsw-static-deepseek-${step}`] = same(rgb(color));
		Object.assign(TOKENS, {
			"--dsh-font-family-text-default": same(TEXT),
			"--dsh-font-family-code-default": same(MONO),
			"--dsw-font-family-brand": same(DISPLAY),
			// ── 液态玻璃（Regular，大 / 中号一样）：底色、浅色上再罩一层淡灰、投影、0.5px 外圈、上下两道内阴影 ──
			"--cosmic-glass-rgb": pair("255, 255, 255", "26, 26, 26"),
			"--cosmic-glass-alpha": same("0.7"),
			"--cosmic-glass-overlay": pair("rgba(191, 191, 191, 0.1)", "rgba(26, 26, 26, 0)"),
			"--cosmic-glass-shadow": pair("0 8px 48px rgba(0, 0, 0, 0.25)", "0 8px 48px rgba(0, 0, 0, 0.45)"),
			"--cosmic-glass-rim": pair("#dbdbdb", "#a6a6a6"),
			"--cosmic-glass-inner": pair("rgba(40, 40, 40, 0.12)", "rgba(26, 26, 26, 0.6)"),
			// 系统填充色（灰按钮、小标签、分组底）：四档由浓到淡
			"--cosmic-fill-1": pair("rgba(120, 120, 128, 0.2)", "rgba(120, 120, 128, 0.36)"),
			"--cosmic-fill-2": pair("rgba(120, 120, 128, 0.16)", "rgba(120, 120, 128, 0.32)"),
			"--cosmic-fill-3": pair("rgba(118, 118, 128, 0.12)", "rgba(118, 118, 128, 0.24)"),
			"--cosmic-fill-4": pair("rgba(116, 116, 128, 0.08)", "rgba(118, 118, 128, 0.18)"),
			"--cosmic-separator": pair("rgba(0, 0, 0, 0.12)", "rgba(255, 255, 255, 0.17)"),
			// 首页壁纸：底色上四团柔和的光（终端青绿、靛紫、粉、杏），深色版压暗、收饱和
			"--cosmic-wall-base": pair("#eef2fb", "#07080f"),
			"--cosmic-wall-a": pair("rgba(72, 206, 190, 0.5)", "rgba(0, 150, 138, 0.42)"),
			"--cosmic-wall-b": pair("rgba(146, 128, 255, 0.5)", "rgba(112, 70, 255, 0.48)"),
			"--cosmic-wall-c": pair("rgba(255, 150, 200, 0.42)", "rgba(214, 40, 140, 0.32)"),
			"--cosmic-wall-d": pair("rgba(255, 196, 140, 0.45)", "rgba(255, 120, 60, 0.2)"),
			// 首页小组件：壁纸上的一层轻玻璃
			"--cosmic-widget-bg": pair("rgba(255, 255, 255, 0.55)", "rgba(28, 28, 34, 0.5)"),
			"--cosmic-widget-rim": pair("rgba(255, 255, 255, 0.75)", "rgba(255, 255, 255, 0.1)"),
			"--cosmic-widget-shadow": pair("0 6px 24px rgba(20, 30, 80, 0.08)", "0 6px 24px rgba(0, 0, 0, 0.35)"),
			// 终端青绿（pi 版首页的品牌色）：方块字由亮到暗三档、阴影线、提示符
			"--cosmic-term-hi": pair("rgb(38, 150, 138)", "rgb(186, 250, 238)"),
			"--cosmic-term": pair("rgb(22, 122, 112)", "rgb(112, 226, 208)"),
			"--cosmic-term-lo": pair("rgb(12, 88, 82)", "rgb(58, 172, 156)"),
			"--cosmic-term-shade": pair("rgba(22, 110, 102, 0.42)", "rgba(112, 226, 208, 0.34)"),
			// 工程卡片里的代码：Xcode 默认主题（浅色 / 深色）的语法配色
			"--cosmic-code-kw": pair("rgb(155, 35, 147)", "rgb(255, 122, 178)"),
			"--cosmic-code-decl": pair("rgb(15, 104, 160)", "rgb(78, 176, 204)"),
			"--cosmic-code-prop": pair("rgb(50, 109, 116)", "rgb(103, 183, 164)"),
			"--cosmic-code-str": pair("rgb(196, 26, 22)", "rgb(255, 129, 112)"),
			"--cosmic-code-com": pair("rgb(93, 108, 121)", "rgb(127, 140, 152)"),
			// 玻璃边上那圈高光细线：左上、右下两个角最亮，中段几乎看不见
			"--cosmic-rim-hot": pair("rgba(255, 255, 255, 0.95)", "rgba(255, 255, 255, 0.32)"),
			"--cosmic-rim-cool": pair("rgba(255, 255, 255, 0.18)", "rgba(255, 255, 255, 0.04)"),
			// 输入框是厚玻璃：上面要打字、读字，压过壁纸的颜色
			"--cosmic-field-fill": pair("rgba(255, 255, 255, 0.9)", "rgba(34, 34, 38, 0.9)"),
			// dsh 的弹出菜单（输入框里的「/」「@」菜单等）：不透明，压在首页小组件上也不透字
			"--dsw-menu-surface-fill": pair("rgb(250, 250, 252)", "rgb(38, 38, 42)"),
			"--dsw-specific-menu": pair("rgb(250, 250, 252)", "rgb(38, 38, 42)"),
			// 圆角照 iOS 27 的阶梯：4 / 8 / 10 / 12 / 16，面板 26（玻璃本身是 34，写在样式表里）
			"--dsw-radius-xs": same("4px"),
			"--dsw-radius-sm": same("8px"),
			"--dsw-radius-md": same("10px"),
			"--dsw-radius-lg": same("12px"),
			"--dsw-radius-xl": same("16px"),
			"--dsw-radius-panel": same("26px"),
			"--dsw-alias-brand-primary": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-button-primary-hover": pair(rgb([0, 118, 230]), rgb([40, 164, 255])),
			"--dsw-alias-state-business-primary": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-state-business-tertiary": pair(rgb([229, 241, 255]), rgb([10, 50, 96])),
			"--dsw-alias-state-success-primary": pair(rgb(L.ready), rgb(D.ready)),
			"--dsw-alias-state-warn-primary": pair(rgb(L.warn), rgb(D.warn)),
			"--dsw-alias-state-error-primary": pair(rgb(L.bad), rgb(D.bad)),
			"--dsw-alias-link": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-button-info-fill": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-button-info-hover": pair(rgb([0, 118, 230]), rgb([40, 164, 255])),
			"--dsw-alias-toast-action": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-specific-sidebar-nav-item-active-accent": pair(rgb([229, 241, 255]), rgb([10, 50, 96])),
			"--dsw-focus-ring-color": pair(rgb(L.glow), rgb(D.glow)),
			// 分隔线、悬停底色用中性的黑 / 白透明度：线和底不带品牌色，只有「强调悬停」和选中文字带一点蓝
			"--dsw-alias-border-l1": pair(rgba(L.hi, 0.06), rgba(D.hi, 0.08)),
			"--dsw-alias-border-l2": pair(rgba(L.hi, 0.12), rgba(D.hi, 0.17)),
			"--dsw-alias-border-l2-darkmode-thin": pair(rgba(L.hi, 0.1), rgba(D.hi, 0.1)),
			"--dsw-alias-border-l3": pair(rgba(L.hi, 0.16), rgba(D.hi, 0.2)),
			"--dsw-alias-border-l4": pair(rgba(L.hi, 0.22), rgba(D.hi, 0.26)),
			"--dsw-alias-interactive-bg-hover": pair(rgba(L.hi, 0.04), rgba(D.hi, 0.06)),
			"--dsw-alias-interactive-bg-active": pair(rgba(L.hi, 0.08), rgba(D.hi, 0.1)),
			"--dsw-alias-interactive-bg-hover-accent": pair(rgba(L.glow, 0.1), rgba(D.glow, 0.18)),
			"--dsw-alias-bg-document-selection": pair(rgba(L.glow, 0.2), rgba(D.glow, 0.32)),
			// 用户气泡：信息 App 里「收到的」那种灰泡（系统 gray5 那一档），两套主题都和对话底色分得开
			"--dsw-specific-bubble": pair(graphite(233), graphite(44)),
			"--dsw-specific-bubble-highlight": pair(graphite(222), graphite(58)),
		});
		const C = (key) => `var(--cosmic-${key})`;
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

		// ── 标志：终端 + iOS ──
		// 深色圆角方块里一个终端提示符「❯▌」：银白的箭头、发青绿光的块状光标（pi 版首页提示行末尾那个光标），
		// 底上淡淡几道扫描线、光标周围一团青绿的光。高光只在上下两条边、不随设备晃动，外沿一圈很淡的暗边（iOS 图标规范）。
		// 安装包图标（scripts/package-desktop.mjs 的 MARK）画的是同一个图形，改这里要一起改那边。
		/** 圆角取边长的 22.37%，iOS 图标那条连续曲线在网页上的近似。 */
		const ICON_RX = 5.37;
		const CHEVRON = "M7.2 8.4 10.8 12l-3.6 3.6";
		const SCANLINES = Array.from({ length: 14 }, (_unused, at) => +(2.2 + at * 1.5).toFixed(1));

		/** SVG 里的渐变按 id 引用；同一页上有好几个标志，各用各的 id。 */
		let svgSerial = 0;
		function useSvgId() {
			const fromReact = typeof React.useId === "function" ? React.useId() : null;
			const fallback = React.useRef(null);
			if (fromReact !== null) return `cx${fromReact.replace(/[^A-Za-z0-9_-]/g, "")}`;
			if (fallback.current === null) {
				svgSerial += 1;
				fallback.current = `cxm${svgSerial}`;
			}
			return fallback.current;
		}
		const stop = (offset, color, opacity) =>
			h("stop", { key: offset, offset, stopColor: color, stopOpacity: opacity ?? 1 });

		/** 标志本体：侧栏、安装包都是这一个。 */
		function LogoSvg({ size, className }) {
			const id = useSvgId();
			const ref = (name) => `url(#${id}-${name})`;
			const tile = { x: 0, y: 0, width: 24, height: 24, rx: ICON_RX };
			const chevron = { d: CHEVRON, fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
			return h(
				"svg",
				{
					viewBox: "0 0 24 24",
					width: size,
					height: size,
					className,
					"aria-hidden": true,
					style: { display: "block" },
				},
				h(
					"defs",
					null,
					h("linearGradient", { id: `${id}-bg`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
						stop("0", "#2B2F33"),
						stop("0.6", "#121518"),
						stop("1", "#090B0C"),
					]),
					h("radialGradient", { id: `${id}-bloom`, cx: "63%", cy: "50%", r: "40%" }, [
						stop("0", "#70E2D0", 0.38),
						stop("1", "#70E2D0", 0),
					]),
					h(
						"linearGradient",
						{ id: `${id}-chevron`, gradientUnits: "userSpaceOnUse", x1: 0, y1: 7, x2: 0, y2: 17 },
						[stop("0", "#ffffff"), stop("1", "#BFC8C6")],
					),
					h("linearGradient", { id: `${id}-cursor`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
						stop("0", "#C8FFF5"),
						stop("1", "#46C7B2"),
					]),
					// 只在上下两条边的高光：上边亮一点、下边淡一点，中间是空的
					h("linearGradient", { id: `${id}-edge`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
						stop("0", "#ffffff", 0.32),
						stop("0.05", "#ffffff", 0),
						stop("0.96", "#ffffff", 0),
						stop("1", "#ffffff", 0.12),
					]),
				),
				h("rect", { ...tile, fill: ref("bg") }),
				...SCANLINES.map((y) =>
					h("rect", { key: y, x: 0, y, width: 24, height: 0.35, fill: "#ffffff", fillOpacity: 0.025 }),
				),
				h("rect", { ...tile, fill: ref("bloom") }),
				h("path", { ...chevron, stroke: "#000000", strokeOpacity: 0.45, transform: "translate(0 0.4)" }),
				h("path", { ...chevron, stroke: ref("chevron") }),
				h("rect", { x: 13.2, y: 8.3, width: 3.8, height: 7.4, rx: 0.8, fill: ref("cursor") }),
				h("rect", { x: 13.6, y: 8.55, width: 3, height: 0.35, rx: 0.17, fill: "#ffffff", fillOpacity: 0.7 }),
				h("rect", { ...tile, fill: ref("edge") }),
				h("rect", {
					x: 0.125,
					y: 0.125,
					width: 23.75,
					height: 23.75,
					rx: ICON_RX - 0.1,
					fill: "none",
					stroke: "#000000",
					strokeOpacity: 0.3,
					strokeWidth: 0.25,
				}),
			);
		}

		// ── 首页的方块字：pi 版终端首页那个带阴影的「COSMIC」──
		// 字形照 pi 版 src/agent/ui/banner.ts 的 GLYPHS：每个字六行，█ 是实心格，╗║═╚╝╔ 是阴影。
		// 这里不靠字体排（等宽字体里方框线常对不齐），逐格画成 SVG：一格宽 1、高 2，█ 画方块，阴影画成细线。
		const WORD_GLYPHS = {
			C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
			O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
			S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
			M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
			I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
		};
		/** 阴影字符在一格里的折线（格宽 1、高 2，中心 0.5,1）。 */
		const SHADE_PATHS = {
			"═": "M0 1H1",
			"║": "M.5 0V2",
			"╗": "M0 1H.5V2",
			"╔": "M1 1H.5V2",
			"╚": "M.5 0V1H1",
			"╝": "M.5 0V1H0",
		};
		const WORDMARK = (() => {
			const blocks = [];
			let left = 0;
			for (const letter of PRODUCT_LOGO_MARK) {
				const rows = WORD_GLYPHS[letter];
				if (!rows) continue;
				rows.forEach((row, y) => {
					[...row].forEach((char, x) => {
						if (char === "█") blocks.push({ x: left + x, y: y * 2 });
					});
				});
				left += rows[0].length;
			}
			return { width: left, blocks };
		})();
		/** 阴影一格的折线，平移到 (x, y) 那一格。 */
		function shadeAt(char, x, y) {
			return SHADE_PATHS[char].replace(/([MHV])([\d.]+)(?: ([\d.]+))?/g, (_whole, op, a, b) => {
				if (op === "H") return `H${+a + x}`;
				if (op === "V") return `V${+a + y}`;
				return `M${+a + x} ${+b + y}`;
			});
		}
		const WORDMARK_SHADES = (() => {
			const paths = [];
			let left = 0;
			for (const letter of PRODUCT_LOGO_MARK) {
				const rows = WORD_GLYPHS[letter];
				if (!rows) continue;
				rows.forEach((row, y) => {
					[...row].forEach((char, x) => {
						if (SHADE_PATHS[char]) paths.push(shadeAt(char, left + x, y * 2));
					});
				});
				left += rows[0].length;
			}
			return paths.join("");
		})();

		/** 实心格合成一条路径：一格一个小方块各画各的，相邻处抗锯齿会留下细缝。 */
		const WORDMARK_BLOCKS = WORDMARK.blocks.map((cell) => `M${cell.x} ${cell.y}h1v2h-1z`).join("");

		/**
		 * 方块字本体。开场一块遮罩按格往右揭开（像 pi 版开场的逐列解码），阴影随后淡入；
		 * 一道光（只照在实心格上）扫过去，开场、就绪那一刻各扫一遍，平时隔一阵扫一遍。
		 * 颜色全走 --cosmic-term-* 变量，深浅两套。
		 */
		function Wordmark({ height = 44 }) {
			const id = useSvgId();
			const { width } = WORDMARK;
			return h(
				"svg",
				{
					className: "cx-wm",
					viewBox: `-0.5 -0.5 ${width + 1} 13`,
					height,
					width: (height * (width + 1)) / 13,
					"aria-hidden": true,
				},
				h(
					"defs",
					null,
					h(
						"linearGradient",
						{ id: `${id}-ink`, gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: 0, y2: 12 },
						h("stop", { offset: 0, style: { stopColor: "var(--cosmic-term-hi)" } }),
						h("stop", { offset: 1, style: { stopColor: "var(--cosmic-term-lo)" } }),
					),
					h(
						"linearGradient",
						{ id: `${id}-beam`, x1: 0, y1: 0, x2: 1, y2: 0 },
						stop("0", "#ffffff", 0),
						stop("0.5", "#ffffff", 0.85),
						stop("1", "#ffffff", 0),
					),
					h(
						"mask",
						{ id: `${id}-reveal`, maskUnits: "userSpaceOnUse", x: -1, y: -1, width: width + 2, height: 14 },
						h("rect", {
							className: "cx-wm-reveal",
							x: -0.5,
							y: -0.5,
							width: width + 1,
							height: 13,
							fill: "#ffffff",
						}),
					),
					h("mask", { id: `${id}-cells` }, h("path", { d: WORDMARK_BLOCKS, fill: "#ffffff" })),
				),
				h(
					"g",
					{ mask: `url(#${id}-reveal)` },
					h("path", { className: "cx-wm-shade", d: WORDMARK_SHADES }),
					h("path", { className: "cx-wm-blocks", d: WORDMARK_BLOCKS, fill: `url(#${id}-ink)` }),
				),
				h(
					"g",
					{ mask: `url(#${id}-cells)` },
					h("rect", { className: "cx-wm-beam", x: -8, y: 0, width: 8, height: 12, fill: `url(#${id}-beam)` }),
				),
			);
		}

		/** 侧栏标志：图标本身。 */
		function Mark({ size = 24 }) {
			return h(LogoSvg, { size });
		}

		/** 侧栏名字：COSMIC 用标题字重，小字标跟在后面用次要文字色。 */
		function Name() {
			return h(
				"span",
				{ className: "cx-name", title: PRODUCT_LOGO_NAME },
				h("b", null, PRODUCT_LOGO_MARK),
				h("small", null, PRODUCT_LOGO_TAG),
			);
		}
		// 设置 → 模型页 codex 卡片上的「登录 ChatGPT」。宿主半边在 src/dsh/codex-login.ts，路径和那边的 CODEX_LOGIN_PATH 一致
		// （test/dsh/codex-login.test.ts 核对）。dsh 的模型页只会填 API 密钥，codex 要用 ChatGPT 账号登，原本只能敲 /cosmic-login。
		const CODEX_LOGIN_ROUTE = "api/fast-ai-cosmic.codex-login";
		const CODEX_PROVIDER = "openai-codex";
		const muted = { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 };
		const buttonStyle = (primary) => ({
			padding: "4px 12px",
			borderRadius: 6,
			fontSize: 13,
			cursor: "pointer",
			border: primary ? "none" : "1px solid var(--dsw-alias-label-secondary)",
			background: primary ? "var(--dsw-alias-button-info-fill)" : "transparent",
			color: primary ? "white" : "inherit",
		});

		async function codexLogin(body) {
			const response = await fetch(
				CODEX_LOGIN_ROUTE,
				body === undefined
					? { cache: "no-store" }
					: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
			);
			const value = await response.json().catch(() => ({}));
			if (!response.ok && value.phase === undefined) throw new Error(value.error || `HTTP ${response.status}`);
			return value;
		}

		function CodexLoginCard({ provider }) {
			const [view, setView] = React.useState(null);
			const [failure, setFailure] = React.useState(null);
			const [answer, setAnswer] = React.useState("");
			const isCodex = provider?.provider === CODEX_PROVIDER;
			const call = React.useCallback((body) => {
				codexLogin(body).then(
					(next) => {
						setView(next);
						setFailure(null);
					},
					(error) => setFailure(String(error?.message ?? error)),
				);
			}, []);
			React.useEffect(() => {
				if (isCodex) call();
			}, [isCodex, call]);
			const waiting = view?.phase === "waiting";
			React.useEffect(() => {
				if (!waiting) return;
				const timer = setInterval(() => call(), 1500);
				return () => clearInterval(timer);
			}, [waiting, call]);
			if (!isCodex) return null;
			if (view === null)
				return h(
					"p",
					{ style: muted },
					failure === null ? "正在读取 ChatGPT 登录状态…" : `读不到登录状态：${failure}`,
				);

			const rows = [];
			if (waiting) {
				rows.push(h("p", { key: "w", style: muted }, "已在浏览器打开 ChatGPT 登录页，登录完会自动回到这里。"));
				if (view.url)
					rows.push(
						h(
							"p",
							{ key: "u", style: muted },
							"浏览器没打开的话，",
							h("a", { href: view.url, target: "_blank", rel: "noreferrer" }, "点这里打开登录页"),
						),
					);
				if (view.code) rows.push(h("p", { key: "c", style: muted }, `登录页要的代码：${view.code}`));
				if (view.question)
					rows.push(
						h(
							"form",
							{
								key: "q",
								style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
								onSubmit: (event) => {
									event.preventDefault();
									call({ action: "answer", text: answer });
									setAnswer("");
								},
							},
							h("span", { style: muted }, `${view.question.message}（浏览器登录完没自动回来时填）`),
							h("input", {
								type: view.question.secret ? "password" : "text",
								value: answer,
								placeholder: view.question.placeholder ?? "",
								autoComplete: "off",
								onChange: (event) => setAnswer(event.target.value),
								style: { flex: "1 1 240px", minWidth: 0, padding: "4px 8px" },
							}),
							h("button", { type: "submit", style: buttonStyle(false), disabled: answer.trim() === "" }, "提交"),
						),
					);
			} else if (view.phase === "failed" && view.error) {
				rows.push(
					h(
						"p",
						{ key: "e", style: { ...muted, color: "var(--dsw-alias-state-danger, #d33)" } },
						`登录没做成：${view.error}`,
					),
				);
			} else if (view.phase === "cancelled") {
				rows.push(h("p", { key: "x", style: muted }, "登录已取消。"));
			}

			const status = view.signedIn ? "已登录 ChatGPT 账号" : "还没登录 ChatGPT 账号，codex 的模型用不了";
			const actions = waiting
				? [
						h(
							"button",
							{
								key: "cancel",
								type: "button",
								style: buttonStyle(false),
								onClick: () => call({ action: "cancel" }),
							},
							"取消登录",
						),
					]
				: [
						h(
							"button",
							{
								key: "start",
								type: "button",
								style: buttonStyle(!view.signedIn),
								onClick: () => call({ action: "start" }),
							},
							view.signedIn ? "重新登录" : "登录 ChatGPT",
						),
						view.signedIn &&
							h(
								"button",
								{
									key: "out",
									type: "button",
									style: buttonStyle(false),
									onClick: () => call({ action: "sign-out" }),
								},
								"退出登录",
							),
					];
			return h(
				"div",
				{
					"data-cosmic-codex-login": "",
					style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 8 },
				},
				h(
					"div",
					{ style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
					h("span", { style: { fontSize: 13 } }, status),
					...actions,
				),
				...rows,
				failure === null ? null : h("p", { style: muted }, `刚才那一步没发出去：${failure}`),
			);
		}

		// ── 苍穹 JVM 小标签（输入框左边那一排）和点开的详情面板 ──
		// 宿主半边在 src/dsh/jvm-board.ts，路径和那边的 JVM_BOARD_PATH 一致（test/dsh/jvm-board.test.ts 核对）。
		// 进到一个苍穹会话就发一次 ensure：宿主这时认工程、在后台起 JVM；之后照下面的节奏问状态。
		// 别的预设的会话宿主答 tracked=false，这里什么都不画。
		const JVM_ROUTE = "api/fast-ai-cosmic.jvm";
		let ReactDOM = null;
		try {
			ReactDOM = require("react-dom");
		} catch {
			ReactDOM = null;
		}

		async function jvmCall(sessionId, body, detail) {
			const query = `?session=${encodeURIComponent(sessionId)}${detail ? "&detail=1" : ""}`;
			const response = await fetch(
				body === undefined ? `${JVM_ROUTE}${query}` : JVM_ROUTE,
				body === undefined
					? { cache: "no-store" }
					: {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ session: sessionId, ...body }),
						},
			);
			const value = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
			return value;
		}

		const clock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
		const clockShort = (ms) => clock(ms).slice(0, 5);
		const span = (seconds) => {
			const s = Math.max(0, Math.round(seconds));
			if (s < 60) return `${s} 秒`;
			if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
			return `${(s / 3600).toFixed(1)} 小时`;
		};
		const ago = (ms, now) => {
			const minutes = Math.round((now - ms) / 60000);
			if (minutes < 1) return "刚刚";
			if (minutes < 60) return `${minutes} 分钟前`;
			return `${(minutes / 60).toFixed(1)} 小时前`;
		};
		const memory = (bytes) =>
			bytes == null
				? "内存未知"
				: bytes >= 1024 ** 3
					? `${(bytes / 1024 ** 3).toFixed(1)} GB`
					: `${Math.round(bytes / 1024 ** 2)} MB`;
		// 状态色：就绪绿、执行靛蓝、准备中蓝、警告橙、失败红、闲着灰
		const TONE = {
			ok: C("ready"),
			run: C("run"),
			busy: C("glow"),
			warn: C("warn"),
			bad: C("bad"),
			idle: C("label"),
		};
		const LIVE_TEXT = {
			stopped: "没在跑",
			stopping: "正在停",
			starting: "启动中",
			warming: "预热中",
			ready: "就绪",
			executing: "正在跑探针",
			"pending-sync": "就绪（等换类）",
			syncing: "同步代码中",
			"restart-needed": "要重启才能用新代码",
			restarting: "重启中",
			unresponsive: "进程在、心跳不答",
			unhealthy: "不健康",
			foreign: "端口被别的 JVM 占着",
			checking: "检查中",
		};
		const MACHINE_STATE = {
			ready: "空闲",
			executing: "正在跑",
			starting: "启动中",
			warming: "预热中",
			syncing: "同步代码中",
			unhealthy: "不健康",
			unresponsive: "心跳不答",
		};
		const MACHINE_TAG = {
			ready: "ok",
			executing: "run",
			starting: "busy",
			warming: "busy",
			syncing: "busy",
			unhealthy: "bad",
			unresponsive: "warn",
		};

		/** 小标签上那一行：什么颜色、写什么。开机那一趟还在走时报那一趟，走完了以现查的心跳为准。 */
		/** 小标签的状态：tone 颜色，short 标签上那几个字（输入框里地方小），text 完整一句（悬停提示、首页小组件）。 */
		function jvmChip(view) {
			const boot = view.boot;
			const live = view.live;
			const name = view.project?.name;
			const say = (tone, short, text) => ({ tone, short, text });
			if (boot && !boot.done) {
				const step = boot.steps.find((one) => one.state === "run");
				return say(
					"busy",
					`JVM 启动中 ${span(boot.seconds)}`,
					`苍穹 JVM ${step ? step.label : "准备中"}… ${span(boot.seconds)}`,
				);
			}
			if (boot?.phase === "no-project") return say("idle", "不是苍穹工程", "不是苍穹工程");
			if (boot?.phase === "config") return say("warn", "配置不全", "苍穹工程配置不全");
			if (!live) {
				if (boot?.phase === "failed") return say("bad", "JVM 没起成", "苍穹 JVM 没起成");
				return say("idle", "JVM", "苍穹 JVM");
			}
			const since = live.startedAt ? ` · ${clockShort(live.startedAt)} 起` : "";
			switch (live.kind) {
				case "ready":
				case "pending-sync":
					return boot?.phase === "degraded"
						? say("warn", "JVM 环境有问题", `苍穹 JVM 已起，环境有问题${since}`)
						: say("ok", "JVM 就绪", `本地苍穹 就绪 · ${name}${since}`);
				case "executing":
					return say("run", "JVM 执行中", `本地苍穹 执行中 · ${name}${since}`);
				case "starting":
				case "warming":
				case "syncing":
				case "restarting":
				case "stopping":
				case "checking":
					return say("busy", `JVM ${LIVE_TEXT[live.kind]}…`, `苍穹 JVM ${LIVE_TEXT[live.kind]}…`);
				case "stopped":
					if (boot?.phase === "failed") return say("bad", "JVM 没起成", "苍穹 JVM 没起成");
					if (boot?.phase === "not-built") return say("warn", "工程未构建", "工程还没构建，JVM 没起");
					return say("idle", "JVM 没在跑", "苍穹 JVM 没在跑");
				default:
					return say(
						"warn",
						`JVM ${LIVE_TEXT[live.kind] ?? live.kind}`,
						`苍穹 JVM ${LIVE_TEXT[live.kind] ?? live.kind}`,
					);
			}
		}

		// ── 开机状态：JVM 小标签（会话里）报给首页图标（首页拿不到会话）──
		// loading 开机还在走，图标上的光环转圈；ready 全部就绪，点火、名牌写「就绪」；
		// down 没就绪也不在走（失败、环境异常、没在跑），图标变灰；null 不是苍穹会话，图标照常。
		function bootStateOf(view) {
			if (!view?.tracked) return null;
			const boot = view.boot;
			const live = view.live;
			if (boot && !boot.done) return "loading";
			if (boot?.phase === "no-project") return null;
			if (live && ["starting", "warming", "syncing", "restarting", "checking"].includes(live.kind)) return "loading";
			if (live && ["ready", "pending-sync", "executing"].includes(live.kind))
				return boot?.phase === "degraded" ? "down" : "ready";
			return "down";
		}
		/** 一份跨组件共享的值：一边 set，用到它的组件跟着重画。 */
		function createShared(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				get: () => value,
				set(next) {
					if (next === value) return;
					value = next;
					for (const listener of listeners) listener(next);
				},
				use() {
					const [current, setCurrent] = React.useState(value);
					React.useEffect(() => {
						listeners.add(setCurrent);
						setCurrent(value);
						return () => {
							listeners.delete(setCurrent);
						};
					}, []);
					return current;
				},
			};
		}
		const bootShared = createShared(null);
		const publishBoot = bootShared.set;
		const useBootState = bootShared.use;
		/** 首页 JVM、工程两块小组件要的：状态色、大字、小字、开机进度（0~1，不在开机是 null）、工程、打开详情。 */
		const jvmShared = createShared(null);
		/** 输入框的动作（dsh 给会话插槽的 inputActions）：首页应用图标用它填起手句。 */
		const composerShared = createShared(null);
		function jvmHome(view, open) {
			const chip = jvmChip(view);
			const boot = view.boot;
			const live = view.live;
			const name = view.project?.name ?? "";
			// 开机步骤原样带上（名字、状态、秒数），首页的 JVM 卡片照它排一段启动日志
			const steps = (boot?.steps ?? []).map(({ key, label, state, seconds }) => ({ key, label, state, seconds }));
			const base = { tone: chip.tone, progress: null, steps, project: view.project ?? null, open };
			if (boot && !boot.done) {
				const done = steps.filter((step) => step.state === "ok" || step.state === "skip").length;
				return {
					...base,
					headline: "启动中",
					note: `第 ${Math.min(done + 1, steps.length)}/${steps.length} 步`,
					progress: steps.length ? done / steps.length : 0,
				};
			}
			if (chip.tone === "ok")
				return { ...base, headline: "就绪", note: live?.startedAt ? `${clockShort(live.startedAt)} 起` : name };
			if (chip.tone === "run") return { ...base, headline: "执行中", note: name };
			const headline = chip.text.replace(/^(苍穹 JVM|本地苍穹)\s*/, "").replace(/…$/, "") || "没在跑";
			return { ...base, headline, note: chip.tone === "bad" || chip.tone === "warn" ? "点开看原因" : name };
		}

		// ── 样式表：挂在 <head> 上一份，类名带 cx- / cjvm- / cw- 前缀 ──
		const LABEL1 = "var(--dsw-alias-label-primary)";
		const LABEL2 = "var(--dsw-alias-label-secondary)";
		const LABEL3 = "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))";
		const SEP = C("separator");
		const MONO_FONT = "var(--ds-font-family-code)";
		const DISPLAY_FONT = "var(--dsw-font-family-brand)";
		// iOS 的弹簧曲线（CSS 近似）：snappy 按钮和小控件、gentle 面板进出
		const SNAPPY = "cubic-bezier(0.34, 1.56, 0.64, 1)";
		const GENTLE = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";
		/** 玻璃上「透明度滑块」的两个系数：--cx-glass-t 0 是全实、1 是最透，默认 0.5；系统设了降低透明度就是 0。 */
		const OPACITY_SCALE = "(1.6 - 1.1 * var(--cx-glass-t))";
		const BLUR_SCALE = "(0.5 + 0.8 * var(--cx-glass-t))";
		/**
		 * 液态玻璃（Regular）：半透明底 + 浅色上罩一层淡灰，背后模糊、提饱和；外面一层投影、一圈 0.5px 浅灰边，
		 * 里面上下各一道很窄的内阴影把边勾出来。圆角 34。只给浮在内容上面的那一层用，里面不再叠玻璃。
		 * 内阴影的颜色苹果套件里是不透明的，网页上照搬会在上下边压出一条黑线，这里压到能看出边就够。
		 */
		const GLASS = `
  background-color: rgba(var(--cosmic-glass-rgb), calc(var(--cosmic-glass-alpha) * ${OPACITY_SCALE}));
  background-image: linear-gradient(var(--cosmic-glass-overlay), var(--cosmic-glass-overlay));
  backdrop-filter: blur(calc(14px * ${BLUR_SCALE})) saturate(1.8);
  -webkit-backdrop-filter: blur(calc(14px * ${BLUR_SCALE})) saturate(1.8);
  border-radius: 34px;
  box-shadow: var(--cosmic-glass-shadow), 0 0 0 0.5px var(--cosmic-glass-rim),
    inset 0 40px 10px -40px var(--cosmic-glass-inner), inset 0 -40px 10px -40px var(--cosmic-glass-inner);`;
		const COSMIC_CSS = `
:root { --cx-glass-t: 0.5; }
@media (prefers-reduced-transparency: reduce) { :root { --cx-glass-t: 0; } }
::selection { background: ${tint(C("glow"), 24)}; }

/* ── 历史消息里的 @ 引用：一枚小标签，点开看发给模型的那段 ── */
.cref { display: inline; }
.cref-chip {
  display: inline; padding: 0 6px; margin: 0 1px; border: 0; border-radius: 6px; font: inherit;
  color: ${C("glow")}; background: ${tint(C("glow"), 12)}; cursor: pointer;
}
.cref-chip:disabled { cursor: default; }
.cref-body {
  display: block; margin: 4px 0; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap;
  font-size: 12px; line-height: 1.6; background: ${tint(C("deep"), 60)};
}

/* ── dsh 自己的几处：只挂在它写死的 data-* 属性上 ── */
/* 输入框：一块液态玻璃。打字时外圈换成系统蓝；::after 是 dsh 没选工程时画的虚线圈，不碰它，只让圆角跟上 */
html body [data-composer-card] {
  --dsw-elevation-stroke-color: transparent;
  border: 0;
  ${GLASS}
  background-color: var(--cosmic-field-fill);
  backdrop-filter: blur(28px) saturate(1.8);
  -webkit-backdrop-filter: blur(28px) saturate(1.8);
  border-radius: 28px;
  transition: box-shadow .3s ${GENTLE};
}
html body [data-composer-card]::after { border-radius: inherit; }
html body [data-composer-card]:focus-within {
  box-shadow: var(--cosmic-glass-shadow), 0 0 0 1px ${tint(C("glow"), 70)}, 0 0 0 4px ${tint(C("glow"), 14)},
    inset 0 40px 10px -40px var(--cosmic-glass-inner), inset 0 -40px 10px -40px var(--cosmic-glass-inner);
}
/* 用户发的话：信息 App 那种灰泡，右下角收小，像从右边说出来 */
html body [data-message-bubble] {
  border: 0;
  border-radius: 20px 20px 6px 20px;
  background-color: var(--dsw-specific-bubble);
}

/* 首页：品牌位里是我们的主屏时，它独占一整行、撑满宽度，dsh 那行标题藏起来 */
div:has(> span [data-cosmic-hero]) { flex-direction: column; align-items: stretch; row-gap: 0; }
div:has(> span [data-cosmic-hero]) > span:has([data-cosmic-hero]) { display: block; width: 100%; }
div:has(> span [data-cosmic-hero]) > span:not(:has([data-cosmic-hero])) { display: none; }

/* ── 侧栏名字 ── */
.cx-name { display: inline-flex; align-items: baseline; gap: 7px; font-family: ${DISPLAY_FONT}; white-space: nowrap; }
.cx-name > b { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: ${LABEL1}; }
.cx-name > small { font-size: 10px; font-weight: 600; letter-spacing: 0.12em; color: ${LABEL2}; }

/* ── 首页壁纸：底色上四团柔和的光，慢慢漂；只在首页铺，输入框和小组件的玻璃透出它来 ── */
@keyframes cx-wall-in { from { opacity: 0; } }
@keyframes cx-wall-a { from { transform: translate(-3%, -2%) rotate(0deg); } to { transform: translate(3%, 3%) rotate(8deg); } }
@keyframes cx-wall-b { from { transform: translate(3%, 2%) rotate(0deg); } to { transform: translate(-3%, -3%) rotate(-8deg); } }
[data-conversation-content]:has([data-cosmic-wall]) { isolation: isolate; }
.cx-wall { position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none;
  background: var(--cosmic-wall-base); animation: cx-wall-in .6s ${GENTLE} both; }
.cx-wall::before, .cx-wall::after { content: ""; position: absolute; inset: -25%; }
.cx-wall::before { animation: cx-wall-a 36s ease-in-out infinite alternate;
  background: radial-gradient(26% 30% at 40% 38%, var(--cosmic-wall-a), transparent 72%),
    radial-gradient(24% 28% at 62% 34%, var(--cosmic-wall-b), transparent 72%); }
.cx-wall::after { animation: cx-wall-b 42s ease-in-out infinite alternate;
  background: radial-gradient(24% 26% at 60% 64%, var(--cosmic-wall-c), transparent 72%),
    radial-gradient(22% 24% at 40% 66%, var(--cosmic-wall-d), transparent 72%); }

/* ── 首页：一排小组件 + 一排应用图标，像 iPhone 主屏 ── */
/* 方块字逐列「解码」：遮罩按格跳着往右揭开，字在这期间闪两下再定住，像 pi 版开场的乱码落定 */
@keyframes cx-reveal { from { transform: scaleX(0); } }
@keyframes cx-decode { 0% { opacity: .3; } 30% { opacity: 1; } 45% { opacity: .5; } 70%, 100% { opacity: 1; } }
@keyframes cx-fade { from { opacity: 0; } }
/* 一道光从左扫到右（只照在实心格上）；平时那一遍放在长周期的开头，其余时间不动 */
@keyframes cx-beam { from { transform: translateX(-10px); } to { transform: translateX(60px); } }
@keyframes cx-beam-idle { 0% { transform: translateX(-10px); } 14%, 100% { transform: translateX(60px); } }
@keyframes cx-breathe { 0%, 100% { opacity: .42; } 50% { opacity: .9; } }
@keyframes cx-blink { 50% { opacity: 0; } }
/* 一行字像打出来：从左往右一格一格露出来 */
@keyframes cx-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
/* 终端里转圈的盲文点 */
@keyframes cx-braille { 0% { content: "⠋"; } 10% { content: "⠙"; } 20% { content: "⠹"; } 30% { content: "⠸"; } 40% { content: "⠼"; }
  50% { content: "⠴"; } 60% { content: "⠦"; } 70% { content: "⠧"; } 80% { content: "⠇"; } 90% { content: "⠏"; } }
@keyframes cx-out-flash { 40% { filter: brightness(1.5); transform: translateX(3px); } }
@keyframes cx-glow { 0% { filter: none; } 35% { filter: brightness(1.6) drop-shadow(0 0 6px var(--cosmic-term)); } 100% { filter: none; } }
@keyframes cx-zoom { from { opacity: 0; transform: scale(1.12); } to { opacity: 1; transform: none; } }
@keyframes cx-turn { to { transform: rotate(360deg); } }
.cx-home { container-type: inline-size; display: flex; flex-direction: column; gap: 22px; width: 100%; padding-bottom: 12px; text-align: left;
  font-size: 13px; line-height: 18px; font-weight: 400; color: ${LABEL1}; user-select: none; }
.cx-widgets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
/* 小组件：壁纸上的一层轻玻璃，圆角 24；彼此不叠 */
.cx-widget { position: relative; display: flex; flex-direction: column; min-width: 0; height: 160px; box-sizing: border-box;
  margin: 0; padding: 14px 16px; border: 0; border-radius: 24px; background: var(--cosmic-widget-bg);
  backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8);
  box-shadow: var(--cosmic-widget-shadow), inset 0 0 0 0.5px var(--cosmic-widget-rim);
  color: ${LABEL1}; font: inherit; text-align: left; overflow: hidden; }
/* 高光细边（参考 Liquid Glass 的镜面边）：一层 1px 的渐变环，左上、右下角最亮 */
.cx-widget::before, .cx-app-icon::before { content: ""; position: absolute; inset: 0; padding: 1px; border-radius: inherit; pointer-events: none;
  background: linear-gradient(135deg, var(--cosmic-rim-hot), var(--cosmic-rim-cool) 28%, transparent 50%, var(--cosmic-rim-cool) 72%, var(--cosmic-rim-hot));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
button.cx-widget { cursor: pointer; transition: transform .35s ${SNAPPY}; }
button.cx-widget:hover { transform: scale(1.02); }
button.cx-widget:active { transform: scale(.97); }
.cx-w-brand { grid-column: 1 / -1; height: 176px; padding: 18px 22px; }
.cx-w-jvm, .cx-w-project { height: 150px; }
.cx-w-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
.cx-w-date { flex: none; font-size: 12px; line-height: 16px; color: ${LABEL2}; white-space: nowrap; }
/* 方块字：实心格是青绿渐变，阴影是细线；svg 自己不收缩，窄了整体按比例缩 */
.cx-wm { display: block; max-width: 100%; height: auto; overflow: visible; }
.cx-wm-shade { fill: none; stroke: var(--cosmic-term-shade); stroke-width: .22; stroke-linecap: square; }
.cx-wm-beam { transform: translateX(-10px); }
.cx-wm-reveal { transform-box: fill-box; transform-origin: left center; }
.cx-w-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin-top: 8px; font-size: 13px; color: ${LABEL2}; }
.cx-w-tag { font-family: ${MONO_FONT}; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: var(--cosmic-term); white-space: nowrap; }
/* 提示行：等宽字，像终端里光标停着的那一行 */
.cx-prompt { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: auto; font-family: ${MONO_FONT}; font-size: 13px; line-height: 18px; font-weight: 400; color: ${LABEL2}; }
.cx-prompt-mark { flex: none; color: var(--cosmic-term); font-weight: 700; }
.cx-prompt-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-prompt-text > b { font-weight: 500; color: ${LABEL1}; }
.cx-caret { flex: none; width: 8px; height: 16px; margin-left: -4px; border-radius: 1.5px; background: var(--cosmic-term);
  box-shadow: 0 0 8px ${tint("var(--cosmic-term)", 55)}; animation: cx-blink 1.1s steps(1) infinite; }
.cx-w-cap { font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.04em; color: var(--cx-tone); white-space: nowrap; }
.cx-w-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.cx-w-project .cx-w-cap { color: ${LABEL2}; }
.cx-w-file { font-family: ${MONO_FONT}; font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 6px; background: ${C("fill-4")}; color: ${LABEL3}; }
/* JVM：终端输出。一行命令、一段启动日志、一行结果 */
.cx-term-cmd { margin-top: 10px; font-family: ${MONO_FONT}; font-size: 12px; line-height: 16px; color: ${LABEL2}; }
.cx-term-cmd i { font-style: normal; font-weight: 700; color: var(--cosmic-term); }
.cx-type { display: inline-block; white-space: pre; }
/* 日志窗口：固定三行高，里面整列往上推（新的一步出来，旧的滚走），新出来的那行像打字一样露出来 */
.cx-log { display: block; height: 51px; margin-top: 8px; overflow: hidden; font-family: ${MONO_FONT}; font-size: 12px; line-height: 17px; }
.cx-log-roll { display: flex; flex-direction: column; transition: transform .45s ${GENTLE}; }
.cx-log-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; color: ${LABEL2}; }
.cx-log-line[data-new] { animation: cx-type .4s steps(12) both; }
.cx-log-mark { flex: none; width: 12px; text-align: center; font-weight: 700; }
.cx-log-line[data-state="ok"] .cx-log-mark { color: ${C("ready")}; }
.cx-log-line[data-state="fail"] .cx-log-mark, .cx-log-line[data-state="fail"] .cx-log-label { color: ${C("bad")}; }
.cx-log-line[data-state="skip"], .cx-log-line[data-state="wait"] { color: ${LABEL3}; }
.cx-log-line[data-state="run"] { color: ${LABEL1}; }
.cx-log-line[data-state="run"] .cx-log-mark { color: ${C("glow")}; }
.cx-log-line[data-state="run"] .cx-log-mark::before { content: "⠋"; animation: cx-braille .8s linear infinite; }
.cx-log-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-log-time { flex: none; color: ${LABEL3}; font-variant-numeric: tabular-nums; }
/* 结果行：箭头和状态字跟状态同色，中等字重；开机还在走时末尾一个小光标在闪 */
.cx-log-out { display: flex; align-items: center; min-width: 0; margin-top: auto; padding-top: 4px; font-family: ${MONO_FONT}; font-size: 13px; line-height: 18px; color: ${LABEL2}; white-space: nowrap; }
.cx-log-out > i { flex: none; margin-right: 8px; font-style: normal; font-weight: 700; color: var(--cx-tone); }
.cx-log-out > b { flex: none; font-weight: 500; color: var(--cx-tone); }
.cx-log-out > span:not(.cx-caret) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.cx-caret.cx-caret-sm { width: 7px; height: 14px; margin-left: 6px; background: var(--cx-tone); box-shadow: none; animation-duration: .6s; }
/* 工程：一段代码，左边行号；当前行带一条淡底、行号变青绿，一行一行往下走 */
.cx-code { display: flex; flex-direction: column; margin-top: 10px; font-family: ${MONO_FONT}; font-size: 12px; line-height: 18px; font-weight: 400; }
.cx-code-line { display: flex; gap: 12px; min-width: 0; margin: 0 -8px; padding: 0 8px; border-radius: 6px; transition: background-color .5s ${GENTLE}; }
.cx-code-line[data-on] { background: ${C("fill-4")}; }
.cx-code-no { flex: none; width: 10px; text-align: right; color: ${LABEL3}; transition: color .5s ${GENTLE}; }
.cx-code-line[data-on] .cx-code-no { color: var(--cosmic-term); }
.cx-code-text { min-width: 0; white-space: pre; overflow: hidden; text-overflow: ellipsis; color: ${LABEL2}; }
/* 语法配色照 Xcode：关键字粉紫、声明的名字蓝、属性名青、字符串红、注释灰；全用常规字重 */
.cx-c-k { color: var(--cosmic-code-kw); font-weight: 500; }
.cx-c-v { color: var(--cosmic-code-decl); }
.cx-c-f { color: var(--cosmic-code-prop); }
.cx-c-s { color: var(--cosmic-code-str); }
.cx-c-p { color: ${LABEL3}; }
.cx-c-c { color: var(--cosmic-code-com); font-style: italic; }
/* 应用图标：无色玻璃，60pt、圆角 22.37%，图形用正文色；悬停浮起一点，按下去缩小，像系统里点图标 */
.cx-apps { display: flex; justify-content: center; flex-wrap: wrap; gap: 16px 40px; }
.cx-app { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 76px; padding: 2px 0; border: 0;
  background: none; color: ${LABEL1}; font: inherit; cursor: pointer; outline: none; }
.cx-app-icon { position: relative; display: grid; place-items: center; width: 60px; height: 60px; border-radius: 22.37%;
  background: var(--cosmic-widget-bg); backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8);
  box-shadow: var(--cosmic-widget-shadow), inset 0 0 0 0.5px var(--cosmic-widget-rim); color: ${LABEL1};
  transition: transform .35s ${SNAPPY}, background-color .2s ${GENTLE}; }
.cx-app:hover .cx-app-icon { transform: translateY(-2px) scale(1.05); }
.cx-app:active .cx-app-icon { transform: scale(.9); background-color: ${C("fill-2")}; transition-duration: .12s; }
.cx-app:focus-visible .cx-app-icon { box-shadow: 0 0 0 3px ${tint(C("glow"), 60)}, var(--cosmic-widget-shadow); }
.cx-app-label { max-width: 100%; font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 开场：像解锁回到主屏——小组件和图标从稍大处收拢、淡入，一个接一个；方块字逐列解码出来，阴影随后淡入，一道光扫过 */
.cx-home:not([data-settled]) .cx-widget { animation: cx-zoom .6s ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-widget:nth-child(2) { animation-delay: .06s; }
.cx-home:not([data-settled]) .cx-widget:nth-child(3) { animation-delay: .12s; }
.cx-home:not([data-settled]) .cx-app { animation: cx-zoom .55s calc(.16s + var(--cx-i) * 40ms) ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-wm-reveal { animation: cx-reveal .6s .15s steps(16) both; }
.cx-home:not([data-settled]) .cx-wm-blocks { animation: cx-decode .6s .15s steps(6) both; }
.cx-home:not([data-settled]) .cx-wm-shade { animation: cx-fade .5s .7s ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-wm-beam { animation: cx-beam .9s .75s ${GENTLE} both; }
/* JVM 卡片：命令打出来、方格依次点亮、结果淡入；工程卡片：代码一行一行打出来 */
.cx-home:not([data-settled]) .cx-type { animation: cx-type .45s .3s steps(13) both; }
.cx-home:not([data-settled]) .cx-log-line { animation: cx-type .4s calc(.55s + var(--i) * 90ms) steps(12) both; }
.cx-home:not([data-settled]) .cx-log-out { animation: cx-fade .3s .95s ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-code-line { animation: cx-type .4s calc(.3s + var(--i) * 120ms) steps(14) both; }
/* 定下来以后隔一阵扫一遍光 */
.cx-home[data-settled]:not([data-boot="loading"]):not([data-boot="down"]) .cx-wm-beam { animation: cx-beam-idle 9s 2s ${GENTLE} infinite; }
/* 跟着开机走：还在走时字暗着呼吸、光标快闪；没就绪也不在走就变灰变淡 */
.cx-home[data-boot="loading"] .cx-wm-blocks { animation: cx-breathe 1.8s ease-in-out infinite; }
.cx-home[data-boot="loading"] .cx-caret { animation-duration: .5s; }
.cx-home[data-boot="down"] .cx-wm { filter: grayscale(1); opacity: .45; }
.cx-home[data-boot="down"] .cx-caret { animation: none; opacity: .35; background: ${LABEL3}; box-shadow: none; }
/* 就绪那一刻：字亮一下、光扫一遍，JVM 结果行跳一下 */
.cx-home[data-ignite] .cx-wm { animation: cx-glow .7s ${GENTLE}; }
.cx-home[data-ignite] .cx-wm-beam { animation: cx-beam .7s ${GENTLE}; }
.cx-home[data-ignite] .cx-log-out { animation: cx-out-flash .5s ${SNAPPY}; }
@container (max-width: 560px) {
  .cx-widgets { grid-template-columns: minmax(0, 1fr); }
  .cx-apps { column-gap: 20px; }
}
/* 窗口矮：只留大组件和图标，JVM 状态在输入框的小标签里也看得到 */
@media (max-height: 760px) {
  .cx-w-jvm, .cx-w-project { display: none; }
  .cx-w-brand { height: auto; gap: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .cx-home *, .cx-home, .cx-log-mark::before, .cx-wall, .cx-wall::before, .cx-wall::after, .cx-dot, .cjvm-panel, .cw-card { animation: none !important; }
  .cjvm-btn, .cjvm-chip, .cx-app-icon, .cx-widget { transition: none; }
}

/* ── 状态小圆点：系统绿 / 靛蓝 / 蓝 / 橙 / 红，闲着是空心圈；准备中、执行中是系统那种八根辐条的加载圈 ── */
@keyframes cx-pulse { 0%, 100% { box-shadow: 0 0 0 0 ${tint("var(--cx-tone)", 45)}; } 60% { box-shadow: 0 0 0 5px ${tint("var(--cx-tone)", 0)}; } }
.cx-dot { flex: none; display: inline-block; box-sizing: border-box; width: 8px; height: 8px; margin: 0 2px; border-radius: 50%;
  background: var(--cx-tone); }
.cx-dot[data-kind="wait"], .cx-dot[data-kind="idle"], .cx-dot[data-kind="skip"] {
  background: transparent; border: 1.5px solid ${tint("var(--cx-tone)", 75)}; }
.cx-dot[data-kind="ask"] { animation: cx-pulse 1.6s ease-out infinite; }
.cx-dot[data-spin] { width: 12px; height: 12px; margin: 0; border-radius: 0; background: none; color: var(--cx-tone);
  animation: cx-turn .8s steps(8) infinite; }

/* ── JVM 小标签：输入框里面，所以是填充色不是玻璃（玻璃上不叠玻璃） ── */
.cjvm-chip { display: inline-flex; align-items: center; gap: 7px; max-width: 180px; height: 28px; padding: 0 12px 0 9px;
  border: 0; border-radius: 999px; background: ${C("fill-3")}; color: ${LABEL2}; font: inherit; font-size: 12px; line-height: 1;
  cursor: pointer; white-space: nowrap; transition: background-color .2s ${GENTLE}, color .2s ${GENTLE}, transform .3s ${SNAPPY}; }
.cjvm-chip:hover, .cjvm-chip[aria-expanded="true"] { background: ${C("fill-2")}; color: ${LABEL1}; }
.cjvm-chip:active { transform: scale(.96); }
.cjvm-chip-text { overflow: hidden; text-overflow: ellipsis; }
/* 详情面板：弹出来的一块玻璃，从小标签那里长出来；里面一段段是填充色的分组，圆角和外面同心 */
@keyframes cx-pop-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }
.cjvm-panel { z-index: 1000; width: min(460px, calc(100vw - 16px)); max-height: min(74vh, 640px); overflow-y: auto;
  ${GLASS}
  color: ${LABEL1}; font-size: 13px; line-height: 18px; cursor: default;
  transform-origin: 24px 100%; animation: cx-pop-in .25s ${SNAPPY} both; }
.cjvm-head { display: flex; align-items: center; gap: 8px; padding: 18px 14px 2px 22px; }
.cjvm-brand { font-family: ${DISPLAY_FONT}; font-size: 17px; line-height: 22px; font-weight: 600; white-space: nowrap; }
.cjvm-rule { flex: 1; min-width: 12px; }
.cjvm-state { white-space: nowrap; font-size: 13px; color: var(--cx-tone); font-weight: 600; }
.cjvm-close { flex: none; width: 28px; height: 28px; border: 0; border-radius: 50%; background: ${C("fill-3")};
  color: ${LABEL2}; cursor: pointer; display: grid; place-items: center; }
.cjvm-close:hover { background: ${C("fill-2")}; color: ${LABEL1}; }
.cjvm-sub { padding: 0 22px 12px; font-size: 13px; color: ${LABEL2}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjvm-sub > b { color: ${LABEL1}; font-weight: 500; }
.cjvm-section { display: flex; flex-direction: column; gap: 8px; margin: 0 8px 8px; padding: 12px 14px; border-radius: 26px; background: ${C("fill-4")}; }
.cjvm-section-title { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: ${LABEL1}; font-weight: 600; }
.cjvm-section-title > small { font-size: 12px; font-weight: 400; color: ${LABEL2}; }
.cjvm-stats { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; }
.cjvm-stats > span { color: ${LABEL2}; white-space: nowrap; }
.cjvm-stats > span > b { margin-left: 6px; color: ${LABEL1}; font-weight: 600; font-variant-numeric: tabular-nums; }
/* 开机步骤：左边一根细竖线串起每一步的小圆点 */
.cjvm-tree { position: relative; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cjvm-tree::before { content: ""; position: absolute; left: 5.5px; top: 12px; bottom: 12px; width: 1px; background: ${SEP}; }
.cjvm-row { position: relative; display: flex; align-items: center; gap: 10px; min-height: 26px; font-size: 13px; }
.cjvm-row > .cx-dot { position: relative; }
.cjvm-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjvm-row[data-state="wait"] .cjvm-row-label, .cjvm-row[data-state="skip"] .cjvm-row-label { color: ${LABEL3}; }
.cjvm-row[data-state="run"] .cjvm-row-label { color: ${C("glow")}; font-weight: 600; }
.cjvm-row[data-state="fail"] .cjvm-row-label { color: ${C("bad")}; font-weight: 600; }
.cjvm-row-label > small { margin-left: 8px; font-size: 12px; color: ${LABEL3}; }
.cjvm-row-time { flex: none; color: ${LABEL2}; font-size: 12px; font-variant-numeric: tabular-nums; }
.cjvm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12px; }
.cjvm-kv dt { color: ${LABEL2}; white-space: nowrap; }
.cjvm-kv dd { margin: 0; min-width: 0; word-break: break-all; }
/* 进度条：iOS 27 的定量进度条是 4pt 粗 */
.cjvm-bar { height: 4px; overflow: hidden; border-radius: 999px; background: ${C("fill-2")}; }
.cjvm-bar > span { display: block; height: 100%; border-radius: inherit; background: ${C("glow")}; transition: width .45s ${GENTLE}; }
.cjvm-alert { padding: 10px 14px; border-radius: 16px; background: ${tint("var(--cx-tone)", 12)}; color: ${LABEL1};
  font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.cjvm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 22px 12px; }
.cjvm-actions > .cjvm-note { flex: 1 1 100%; }
/* 按钮：胶囊形。普通是灰色填充，主按钮是系统蓝实底白字，危险操作是淡红底红字；按下去缩一点 */
.cjvm-btn { height: 28px; padding: 0 14px; border: 0; border-radius: 999px; background: ${C("fill-3")};
  color: ${LABEL1}; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background-color .2s ${GENTLE}, filter .2s ${GENTLE}, transform .3s ${SNAPPY}; }
.cjvm-btn:hover:not(:disabled) { background: ${C("fill-2")}; }
.cjvm-btn:active:not(:disabled) { transform: scale(.96); }
.cjvm-btn[data-kind="primary"] { background: ${C("glow")}; color: #fff; font-weight: 600; }
.cjvm-btn[data-kind="primary"]:hover:not(:disabled) { background: ${C("glow")}; filter: brightness(1.08); }
.cjvm-btn[data-kind="danger"] { background: ${tint(C("bad"), 14)}; color: ${C("bad")}; }
.cjvm-btn[data-kind="danger"]:hover:not(:disabled) { background: ${tint(C("bad"), 20)}; }
.cjvm-btn[data-size="sm"] { height: 24px; padding: 0 10px; font-size: 12px; }
.cjvm-btn:disabled { opacity: .4; cursor: default; }
/* 缓存面板：一项一块，头一行是状态点、名字和大小，下面是规则和按钮 */
.ccache-item { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 16px; background: ${C("fill-4")}; }
.ccache-name { display: flex; align-items: center; gap: 8px; font-size: 13px; min-width: 0; }
.ccache-name > b { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccache-name > small { flex: none; color: ${LABEL2}; font-size: 12px; font-variant-numeric: tabular-nums; }
.ccache-what { font-size: 12px; color: ${LABEL2}; }
.ccache-state { font-size: 12px; color: var(--cx-tone); }
.ccache-job { font-size: 12px; color: ${LABEL1}; white-space: pre-wrap; word-break: break-word; }
.ccache-job[data-ok="false"] { color: ${C("bad")}; }
.ccache-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.ccache-confirm { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 12px; background: ${tint(C("warn"), 12)}; font-size: 12px; }
.cjvm-procs { display: flex; flex-direction: column; gap: 6px; }
.cjvm-proc { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 16px; background: ${C("fill-4")}; }
.cjvm-proc[data-mine] { background: ${tint(C("glow"), 10)}; }
.cjvm-proc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cjvm-proc-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; }
.cjvm-proc-name > b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjvm-mine { flex: none; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 600;
  color: ${C("glow")}; background: ${tint(C("glow"), 14)}; }
.cjvm-proc-meta { display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 12px; color: ${LABEL2}; font-variant-numeric: tabular-nums; }
.cjvm-note { margin: 0; font-size: 12px; color: ${LABEL2}; }

/* ── 写元数据确认卡片：占输入框那一栏，宽度跟对话一致。一块玻璃，像系统弹出的确认框；顶上一条橙色的「等你确认」 ── */
@keyframes cx-present { from { opacity: 0; transform: translateY(16px) scale(.98); } to { opacity: 1; transform: none; } }
.cw-root { display: flex; flex-direction: column; align-items: center;
  padding: 8px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 12px; }
.cw-card { width: 100%; max-width: var(--dsh-chat-content-width, 820px); overflow: hidden;
  ${GLASS}
  color: ${LABEL1}; font-size: 13px; line-height: 20px; animation: cx-present .5s ${GENTLE} both; }
.cw-strip { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px 24px; background: ${tint(C("warn"), 12)}; }
.cw-strip-title { white-space: nowrap; color: ${LABEL2}; }
.cw-strip-title > b { color: ${C("warn")}; font-weight: 600; }
.cw-strip-rule { flex: 1; min-width: 12px; }
.cw-strip-state { white-space: nowrap; font-size: 12px; color: ${LABEL2}; }
.cw-body { display: flex; flex-direction: column; gap: 12px; padding: 16px 24px;
  max-height: min(56vh, 480px); overflow-y: auto; outline: none; }
/* 正文限高后整体滚动，里面的块不许被压扁（表格会被压得只剩表头） */
.cw-body > * { flex-shrink: 0; }
.cw-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.cw-title > b { font-family: ${DISPLAY_FONT}; font-size: 20px; line-height: 25px; font-weight: 600; color: ${LABEL1}; }
.cw-purpose { margin: -6px 0 0; font-size: 15px; line-height: 20px; color: ${LABEL2}; }
.cw-code { display: inline; padding: 1px 6px; border-radius: 6px; background: ${C("fill-4")};
  font-family: ${MONO_FONT}; font-size: 12px; color: ${LABEL2}; word-break: break-all; }
.cw-code > i { font-style: normal; color: ${LABEL3}; }
.cw-code > b { font-weight: 600; color: ${LABEL1}; }
.cw-scope { flex: none; padding: 0 8px; border-radius: 999px; background: ${C("fill-3")}; font-size: 11px; line-height: 18px; color: ${LABEL2}; white-space: nowrap; }
.cw-head { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12px; }
.cw-head dt { color: ${LABEL2}; }
.cw-head dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.cw-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding-top: 12px; border-top: 0.5px solid ${SEP}; }
.cw-summary > b { font-size: 15px; color: ${LABEL1}; font-weight: 600; }
.cw-count { padding: 0 9px; border-radius: 999px; font-size: 12px; line-height: 20px; font-weight: 600; color: var(--cx-tone);
  background: ${tint("var(--cx-tone)", 14)}; }
/* 改动清单：一行一处，左边一个带底色的小圆标 */
.cw-diff { display: grid; grid-template-columns: 34px minmax(0, max-content) minmax(0, 1fr); margin-top: -4px; }
.cw-row { display: contents; }
/* 列之间不留空隙、改用右边距：分隔线才能一整条连着画过去 */
.cw-row > * { padding: 7px 12px 7px 0; border-bottom: 0.5px solid ${SEP}; min-width: 0; }
.cw-row > :last-child { padding-right: 0; }
.cw-row:last-child > * { border-bottom: 0; }
.cw-mark { display: grid; place-items: start center; font-weight: 700; color: var(--cx-tone);
  background: radial-gradient(circle at 11px 17px, ${tint("var(--cx-tone)", 16)} 9.5px, transparent 10px); }
.cw-target { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.cw-key { display: inline-flex; align-items: baseline; gap: 5px; color: ${LABEL2}; }
.cw-key-main { color: ${LABEL1}; font-weight: 600; }
.cw-key-main > .cw-code { color: ${LABEL1}; }
.cw-ditto { padding-left: 1ch; color: ${LABEL3}; }
.cw-value { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; word-break: break-word; }
.cw-old { color: ${LABEL3}; text-decoration-color: ${tint(C("bad"), 70)}; }
.cw-old .cw-code { color: ${LABEL3}; }
.cw-row[data-op="remove"] .cw-old { color: ${C("bad")}; }
.cw-new { color: ${C("ready")}; font-weight: 600; }
.cw-row[data-op="set"] .cw-new { color: ${C("run")}; }
.cw-new .cw-code { background: ${tint("var(--cx-tone)", 13)}; color: inherit; }
.cw-new .cw-code > b, .cw-new .cw-code > i { color: inherit; }
.cw-same { color: ${LABEL3}; }
.cw-arrow { color: ${LABEL3}; font-weight: 600; }
.cw-grid-wrap { overflow-x: auto; margin-top: -4px; }
.cw-grid { width: 100%; border-collapse: collapse; font-size: 12px; }
.cw-grid th { padding: 4px 10px 4px 0; text-align: left; font-weight: 500; color: ${LABEL2}; border-bottom: 0.5px solid ${SEP}; white-space: nowrap; }
.cw-grid td { padding: 6px 10px 6px 0; vertical-align: top; border-bottom: 0.5px solid ${SEP}; word-break: break-word; }
.cw-grid tbody tr:last-child td { border-bottom: 0; }
.cw-grid td:first-child { white-space: nowrap; }
.cw-note { display: flex; gap: 10px; margin: 0; padding: 10px 14px; border-radius: 16px; background: ${tint(C("warn"), 12)}; }
.cw-note > b { flex: none; color: ${C("warn")}; }
.cw-decisions { display: flex; flex-direction: column; gap: 8px; }
.cw-section-title { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-weight: 600; color: ${LABEL1}; }
.cw-section-title > small { font-size: 12px; font-weight: 400; color: ${LABEL2}; }
.cw-decision { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-choice { display: inline-flex; gap: 6px; align-items: baseline; padding: 4px 12px; border: 0; border-radius: 999px;
  background: ${C("fill-4")}; color: ${LABEL2}; font: inherit; text-align: left; }
.cw-choice > i { font-style: normal; color: ${LABEL3}; }
.cw-choice[data-picked] { background: ${tint(C("glow"), 14)}; color: ${LABEL1}; }
.cw-choice[data-picked] > i { color: ${C("glow")}; }
button.cw-choice { cursor: pointer; transition: background-color .2s ${GENTLE}, transform .3s ${SNAPPY}; }
button.cw-choice:hover:not(:disabled) { background: ${C("fill-3")}; color: ${LABEL1}; }
button.cw-choice:active:not(:disabled) { transform: scale(.96); }
.cw-facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; padding-top: 12px;
  border-top: 0.5px solid ${SEP}; font-size: 12px; color: ${LABEL2}; }
.cw-facts dt { color: ${LABEL3}; white-space: nowrap; }
.cw-facts dd { margin: 0; min-width: 0; word-break: break-word; display: flex; flex-direction: column; gap: 1px; }
.cw-scope-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.cw-scope-list > li { display: flex; flex-wrap: wrap; gap: 4px; }
.cw-link { padding: 0; border: 0; background: none; font: inherit; color: ${C("glow")}; cursor: pointer; text-align: left; }
.cw-link:hover:not(:disabled) { text-decoration: underline; }
.cw-link:disabled { opacity: .4; cursor: default; }
.cw-said { display: flex; gap: 10px; margin: 0; padding: 10px 24px; border-top: 0.5px solid ${SEP}; }
.cw-said > b { color: ${LABEL3}; font-weight: 400; }
.cw-input { display: block; box-sizing: border-box; width: calc(100% - 40px); margin: 0 20px 6px; padding: 9px 14px; resize: vertical;
  border: 0; border-radius: 16px; background: ${C("fill-4")}; color: ${LABEL1}; font: inherit; outline: none;
  box-shadow: inset 0 0 0 0.5px ${SEP}; transition: box-shadow .2s ${GENTLE}; }
.cw-input:focus { box-shadow: inset 0 0 0 1px ${tint(C("glow"), 70)}, 0 0 0 4px ${tint(C("glow"), 14)}; }
.cw-error { margin: 0; padding: 4px 24px; color: ${C("bad")}; font-size: 12px; }
.cw-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 16px 16px 24px; border-top: 0.5px solid ${SEP}; }
.cw-actions-gap { flex: 1; }
.cw-actions > .cjvm-btn { height: 34px; padding: 0 18px; font-size: 15px; }
.cjvm-btn.cw-approve { padding: 0 22px; }
@media (max-width: 640px) { .cw-strip-state { display: none; } .cw-diff { grid-template-columns: 34px minmax(0, 1fr); }
  .cw-value { grid-column: 2; padding-top: 0; } .cw-row > .cw-target { border-bottom: 0; } }

/* ── 新会话首页上敲的命令的结果：输入框正上方一块轻玻璃（和首页小组件同一层），左边一条状态色 ── */
/* 外层是定高的纵向弹性盒：不许被压扁；左右让出和输入框一样的留白，两边对齐 */
.cc-card { position: relative; overflow: hidden; flex-shrink: 0; margin: 0 var(--dsh-composer-side-clearance, 16px); border-radius: 22px;
  background: var(--cosmic-widget-bg); backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8);
  box-shadow: var(--cosmic-widget-shadow), inset 0 0 0 0.5px var(--cosmic-widget-rim);
  color: ${LABEL1}; font-size: 13px; line-height: 20px; animation: cx-present .4s ${GENTLE} both; }
.cc-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--cx-tone); }
.cc-head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 4px 18px; }
.cc-name { font-family: ${MONO_FONT}; font-size: 12px; font-weight: 600; color: ${LABEL1}; }
.cc-state { padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 18px; font-weight: 600;
  color: var(--cx-tone); background: ${tint("var(--cx-tone)", 14)}; }
.cc-gap { flex: 1; }
.cc-close { width: 24px; height: 24px; border: 0; border-radius: 999px; background: transparent; color: ${LABEL3};
  font-size: 16px; line-height: 24px; cursor: pointer; }
.cc-close:hover { background: ${C("fill-3")}; color: ${LABEL1}; }
.cc-text { margin: 0; padding: 0 18px 12px; max-height: min(36vh, 320px); overflow-y: auto;
  white-space: pre-wrap; word-break: break-word; font: inherit; color: ${LABEL2}; }
@media (prefers-reduced-transparency: reduce) { .cc-card { backdrop-filter: none; -webkit-backdrop-filter: none; background: ${C("deep")}; } }
`;
		const STYLE_ID = "fast-ai-cosmic-style";
		/** 样式表挂一份；内容变了（开发时热替换）就换掉。返回摘掉它的函数。 */
		function ensureStyle() {
			if (typeof document === "undefined") return () => {};
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				document.head.appendChild(style);
			}
			if (style.textContent !== COSMIC_CSS) style.textContent = COSMIC_CSS;
			return () => document.getElementById(STYLE_ID)?.remove();
		}
		const tone = (color) => ({ "--cx-tone": color });

		// ── 状态小圆点：颜色说状态；准备中、执行中是系统那种八根辐条的加载圈，等你确认的那一颗一圈圈往外扩 ──
		const TAG = {
			ok: { color: TONE.ok },
			run: { spin: true, color: TONE.run },
			busy: { spin: true, color: TONE.busy },
			warn: { color: TONE.warn },
			bad: { color: TONE.bad },
			fail: { color: TONE.bad },
			skip: { color: TONE.idle },
			idle: { color: TONE.idle },
			wait: { color: TONE.idle },
			ask: { color: TONE.warn },
		};
		/** 八根辐条：顺时针转，最亮的在最前面，往回（逆时针）一根比一根淡；整体按八格一跳地转。 */
		const SPOKES = Array.from({ length: 8 }, (_unused, at) => {
			const angle = (at / 8) * 2 * Math.PI;
			const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
			return {
				x1: +(6 + 2.6 * sin).toFixed(2),
				y1: +(6 - 2.6 * cos).toFixed(2),
				x2: +(6 + 5 * sin).toFixed(2),
				y2: +(6 - 5 * cos).toFixed(2),
				opacity: +(1 - ((8 - at) % 8) * 0.11).toFixed(2),
			};
		});
		function Tag({ kind }) {
			const known = TAG[kind] ? kind : "idle";
			const tag = TAG[known];
			const common = { className: "cx-dot", "data-kind": known, style: tone(tag.color), "aria-hidden": true };
			if (!tag.spin) return h("span", common);
			return h(
				"svg",
				{ ...common, "data-spin": "", viewBox: "0 0 12 12" },
				...SPOKES.map((spoke, at) =>
					h("line", {
						key: at,
						...spoke,
						stroke: "currentColor",
						strokeWidth: 1.5,
						strokeLinecap: "round",
					}),
				),
			);
		}

		function CloseIcon() {
			return h(
				"svg",
				{
					viewBox: "0 0 24 24",
					width: 14,
					height: 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "square",
					"aria-hidden": true,
				},
				h("path", { d: "M6 6l12 12M18 6L6 18" }),
			);
		}

		const projectName = (root) => (root ? root.replace(/\\/g, "/").split("/").filter(Boolean).pop() : "工程认不出来");
		const STEP_TAG = { wait: "wait", run: "busy", ok: "ok", skip: "skip", fail: "fail" };

		/**
		 * 详情面板，一块玻璃，开机步骤用一根细竖线串起小圆点：
		 *   苍穹 JVM                          ● 就绪  ×
		 *   ● 认工程                              3s
		 *   ◌ 启动苍穹 JVM（转着的光圈）            6s
		 */
		function JvmPanel({ view, chip, now, busy, message, act, stopPid, close, anchor }) {
			const boot = view.boot;
			const live = view.live;
			const project = view.project;
			const running = live && live.kind !== "stopped" && live.kind !== "foreign";
			const booting = boot && !boot.done;
			const machine = view.machine;
			const runningStep = booting ? boot.steps.find((step) => step.state === "run") : undefined;
			// 启动中报这一趟走到哪一步：刚拉起的 JVM 还没报心跳，现查的心跳会写「心跳不答」，那时不是故障
			const stateText = booting
				? `启动中 · ${runningStep?.label ?? "准备中"}`
				: live
					? (LIVE_TEXT[live.kind] ?? live.kind)
					: boot?.phase === "no-project"
						? "不是苍穹工程"
						: boot?.phase === "config"
							? "配置不全"
							: "还没认出工程";

			const rect = anchor?.getBoundingClientRect?.();
			const position =
				ReactDOM && rect
					? {
							position: "fixed",
							left: Math.max(8, Math.min(rect.left, window.innerWidth - 468)),
							bottom: Math.max(8, window.innerHeight - rect.top + 8),
						}
					: { position: "absolute", left: 0, bottom: "calc(100% + 8px)" };

			const section = (key, title, aside, ...children) =>
				h(
					"section",
					{ key, className: "cjvm-section" },
					title === null
						? null
						: h(
								"div",
								{ className: "cjvm-section-title" },
								h("span", null, title),
								aside ? h("small", null, aside) : null,
							),
					...children,
				);
			const entry = (label, value) =>
				value == null || value === ""
					? []
					: [h("dt", { key: `${label}-k` }, label), h("dd", { key: `${label}-v` }, value)];
			const stat = (label, value) => (value == null ? null : h("span", { key: label }, label, h("b", null, value)));

			const stats = running
				? [
						live.startedAt ? stat("已运行", span((now - live.startedAt) / 1000)) : null,
						live.startedAt ? stat("启动于", clock(live.startedAt)) : null,
						live.warmMs != null ? stat("预热", span(live.warmMs / 1000)) : null,
						live.pid ? stat("pid", String(live.pid)) : null,
						live.port ? stat("端口", String(live.port)) : null,
					].filter(Boolean)
				: [];

			const details = [
				...entry("工程", project?.root),
				...entry("运行时", project?.keyId),
				...entry(
					"用户@账套",
					project && (project.user || project.account)
						? `${project.user ?? "?"} @ ${project.account ?? "?"}`
						: null,
				),
				...entry("换类", running ? live.hotSwap : null),
				...entry("共用", view.sharedWith > 0 ? `另外 ${view.sharedWith} 个会话也用这一个 JVM` : null),
			];

			const doneSteps = boot ? boot.steps.filter((step) => step.state === "ok" || step.state === "skip").length : 0;
			const bootPart =
				boot &&
				section(
					"boot",
					booting ? "正在启动" : "进会话时的启动",
					booting ? `已等 ${span(boot.seconds)}` : `${clock(boot.beganAt)} 开始 · 用时 ${span(boot.seconds)}`,
					booting
						? h(
								"div",
								{ key: "bar", className: "cjvm-bar" },
								h("span", { style: { width: `${Math.round((doneSteps / boot.steps.length) * 100)}%` } }),
							)
						: null,
					h(
						"ol",
						{ key: "steps", className: "cjvm-tree" },
						...boot.steps.map((step) =>
							h(
								"li",
								{ key: step.key, className: "cjvm-row", "data-state": step.state },
								h(Tag, { kind: STEP_TAG[step.state] }),
								h(
									"span",
									{ className: "cjvm-row-label" },
									step.label,
									step.state === "skip"
										? h("small", null, "不用做")
										: step.state === "wait" && boot.done
											? h("small", null, "没走到")
											: null,
								),
								h("span", { className: "cjvm-row-time" }, step.seconds == null ? "" : `${step.seconds}s`),
							),
						),
					),
					boot.detail
						? h(
								"div",
								{
									key: "detail",
									className: "cjvm-alert",
									style: tone(boot.phase === "failed" ? TONE.bad : TONE.warn),
								},
								boot.detail,
							)
						: null,
				);

			const total = machine ? machine.jvms.reduce((sum, jvm) => sum + (jvm.memoryBytes ?? 0), 0) : 0;
			const machinePart = section(
				"machine",
				"本机 cosmic 进程",
				machine ? `${machine.jvms.length} 个 · 共 ${memory(total)}` : null,
				machine === undefined
					? h("p", { key: "loading", className: "cjvm-note" }, "正在读本机进程…")
					: machine.jvms.length === 0
						? h("p", { key: "none", className: "cjvm-note" }, "本机没有 cosmic 起的 JVM")
						: h(
								"div",
								{ key: "list", className: "cjvm-procs" },
								...machine.jvms.map((jvm) => {
									const mineBooting = jvm.mine && booting;
									const state = mineBooting ? "启动中" : (MACHINE_STATE[jvm.state] ?? jvm.state);
									return h(
										"div",
										{ key: jvm.pid, className: "cjvm-proc", "data-mine": jvm.mine ? "" : undefined },
										h(Tag, { kind: mineBooting ? "busy" : (MACHINE_TAG[jvm.state] ?? "idle") }),
										h(
											"div",
											{ className: "cjvm-proc-main" },
											h(
												"div",
												{ className: "cjvm-proc-name" },
												h("b", { title: jvm.projectRoot ?? undefined }, projectName(jvm.projectRoot)),
												jvm.mine ? h("span", { className: "cjvm-mine" }, "本会话") : null,
											),
											h(
												"div",
												{ className: "cjvm-proc-meta" },
												h("span", null, `${jvm.kind === "probe" ? "常驻 JVM" : "调试节点"} · ${state}`),
												h("span", null, `pid ${jvm.pid}`),
												h("span", null, memory(jvm.memoryBytes)),
												jvm.lastActiveAt ? h("span", null, `上次用 ${ago(jvm.lastActiveAt, now)}`) : null,
												jvm.idleExitAt ? h("span", null, `${clockShort(jvm.idleExitAt)} 空闲自动退`) : null,
											),
										),
										h(
											"button",
											{
												type: "button",
												className: "cjvm-btn",
												"data-kind": "danger",
												"data-size": "sm",
												disabled: busy,
												onClick: () => stopPid(jvm.pid),
											},
											"停止",
										),
									);
								}),
							),
				machine && !machine.processesListed
					? h("p", { key: "partial", className: "cjvm-note" }, "没查到进程清单，只列心跳答得上的")
					: null,
			);

			const button = (key, label, kind, action) =>
				h(
					"button",
					{
						key,
						type: "button",
						className: "cjvm-btn",
						"data-kind": kind,
						disabled: busy || booting,
						onClick: () => act(action),
					},
					label,
				);
			const actions = [
				!running && boot?.phase !== "no-project" ? button("start", "启动", "primary", "start") : null,
				running ? button("restart", "重启", undefined, "restart") : null,
				running ? button("stop", "停止", "danger", "stop") : null,
			].filter(Boolean);

			const panel = h(
				"div",
				{
					"data-cosmic-jvm-panel": "",
					role: "dialog",
					"aria-label": "苍穹 JVM",
					className: "cjvm-panel",
					style: { ...position, ...tone(TONE[chip.tone]) },
					onMouseDown: (event) => event.stopPropagation(),
				},
				h(
					"header",
					{ className: "cjvm-head" },
					h("span", { className: "cjvm-brand" }, "苍穹 JVM"),
					h("span", { className: "cjvm-rule", "aria-hidden": true }),
					h(Tag, { kind: chip.tone }),
					h("span", { className: "cjvm-state" }, stateText),
					h(
						"button",
						{ type: "button", className: "cjvm-close", "aria-label": "关闭", onClick: close },
						h(CloseIcon),
					),
				),
				h(
					"div",
					{ className: "cjvm-sub", title: project?.root },
					project ? ["工程 ", h("b", { key: "n" }, project.name)] : "这个会话的工作目录还没认出苍穹工程",
				),
				stats.length > 0
					? section("stats", null, null, h("div", { key: "s", className: "cjvm-stats" }, ...stats))
					: null,
				live?.detail && !booting
					? section("live", null, null, h("div", { key: "a", className: "cjvm-alert" }, live.detail))
					: null,
				details.length > 0
					? section("info", "运行环境", null, h("dl", { key: "dl", className: "cjvm-kv" }, ...details))
					: null,
				bootPart,
				actions.length > 0 || message
					? h(
							"div",
							{ className: "cjvm-actions" },
							...actions,
							message ? h("p", { key: "msg", className: "cjvm-note" }, message) : null,
						)
					: null,
				machinePart,
			);
			return ReactDOM && rect ? ReactDOM.createPortal(panel, document.body) : panel;
		}

		function JvmChip({ sessionId, inputActions }) {
			const [view, setView] = React.useState(null);
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);
			const [now, setNow] = React.useState(Date.now());
			const anchor = React.useRef(null);
			const untracked = React.useRef(0);
			ensureStyle();

			const refresh = React.useCallback(
				async (detail) => {
					if (!sessionId) return;
					try {
						let next = await jvmCall(sessionId, undefined, detail);
						untracked.current = next.tracked ? 0 : untracked.current + 1;
						// 进来第一次、换了工作目录：叫宿主认工程、起 JVM（宿主那边重复叫不会重来）
						if (next.tracked && next.project === null && next.boot === null)
							next = (await jvmCall(sessionId, { action: "ensure" })).view ?? next;
						setView((before) => (detail || !before?.machine ? next : { ...next, machine: before.machine }));
					} catch {
						// 宿主没有这条路径（无界面、旧版本）：什么都不画
						setView(null);
					}
					setNow(Date.now());
				},
				[sessionId],
			);

			React.useEffect(() => {
				untracked.current = 0;
				setView(null);
				setOpen(false);
			}, [sessionId]);

			// 首页图标跟着这里的开机状态走；小标签卸掉（离开会话）就不再报
			React.useEffect(() => {
				publishBoot(bootStateOf(view));
			}, [view]);
			React.useEffect(() => {
				jvmShared.set(view?.tracked ? jvmHome(view, () => setOpen(true)) : null);
			}, [view]);
			React.useEffect(() => {
				composerShared.set(inputActions ?? null);
			}, [inputActions]);
			React.useEffect(
				() => () => {
					publishBoot(null);
					jvmShared.set(null);
					composerShared.set(null);
				},
				[],
			);

			const moving =
				view != null &&
				((view.boot && !view.boot.done) ||
					(view.live &&
						["starting", "warming", "syncing", "restarting", "stopping", "executing"].includes(view.live.kind)));
			React.useEffect(() => {
				void refresh(open);
				// 启动中一秒问一次；没登记上的：头半分钟两秒（会话刚建、宿主还没登记完），之后 15 秒（别的预设的会话一直不登记）；
				// 平时五秒；详情开着三秒（带本机进程清单，约一秒）
				const every = moving
					? 1000
					: view?.tracked === false
						? untracked.current < 15
							? 2000
							: 15000
						: open
							? 3000
							: 5000;
				const timer = setInterval(() => void refresh(open), every);
				return () => clearInterval(timer);
			}, [refresh, open, moving, view?.tracked]);

			React.useEffect(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				const onDown = () => setOpen(false);
				window.addEventListener("keydown", onKey);
				window.addEventListener("mousedown", onDown);
				return () => {
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("mousedown", onDown);
				};
			}, [open]);

			if (!view || !view.tracked) return null;
			const chip = jvmChip(view);
			const act = async (action) => {
				setBusy(true);
				try {
					const answer = await jvmCall(sessionId, { action });
					setMessage(answer.result?.text || null);
					if (answer.view) setView((before) => ({ ...answer.view, machine: before?.machine }));
				} catch (error) {
					setMessage(`没发出去：${String(error?.message ?? error)}`);
				}
				setBusy(false);
				void refresh(true);
			};
			const stopPid = async (pid) => {
				setBusy(true);
				try {
					const answer = await jvmCall(sessionId, { action: "stop-pid", pid });
					setMessage(answer.result?.text || null);
				} catch (error) {
					setMessage(`没发出去：${String(error?.message ?? error)}`);
				}
				setBusy(false);
				void refresh(true);
			};
			return h(
				"span",
				{ ref: anchor, style: { position: "relative", display: "inline-flex" } },
				h(
					"button",
					{
						type: "button",
						className: "cjvm-chip",
						"data-cosmic-jvm-chip": chip.tone,
						"aria-expanded": open,
						title: `${chip.text}（点开看详情）`,
						style: tone(TONE[chip.tone]),
						onMouseDown: (event) => event.stopPropagation(),
						onClick: () => {
							setOpen((was) => !was);
							setMessage(null);
						},
					},
					h(Tag, { kind: chip.tone }),
					h("span", { className: "cjvm-chip-text" }, chip.short),
				),
				open &&
					h(JvmPanel, {
						view,
						chip,
						now,
						busy,
						message,
						act,
						stopPid,
						close: () => setOpen(false),
						anchor: anchor.current,
					}),
			);
		}

		// ── 缓存小标签（JVM 小标签右边）和点开的面板 ──
		// 宿主半边在 src/dsh/cache-board.ts，清单在 src/kernel/project/cache-inventory.ts；路径和那边的 CACHE_BOARD_PATH 一致。
		// 关着时一分钟问一次（宿主 15 秒内给上一份），只为小标签的颜色；开着时有事在做两秒一次，没事十秒一次。
		const CACHE_ROUTE = "api/fast-ai-cosmic.cache";
		const CACHE_STATE_TAG = { fresh: "ok", stale: "warn", missing: "idle", info: "idle" };

		async function cacheCall(sessionId, body, fresh) {
			const response = await fetch(
				body === undefined
					? `${CACHE_ROUTE}?session=${encodeURIComponent(sessionId)}${fresh ? "&fresh=1" : ""}`
					: CACHE_ROUTE,
				body === undefined
					? { cache: "no-store" }
					: {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ session: sessionId, ...body }),
						},
			);
			const value = await response.json().catch(() => ({}));
			if (!response.ok && !value.result) throw new Error(value.error || `HTTP ${response.status}`);
			return value;
		}

		const bytesText = (bytes) =>
			bytes == null
				? ""
				: bytes >= 1024 ** 3
					? `${(bytes / 1024 ** 3).toFixed(1)} GB`
					: bytes >= 1024 ** 2
						? `${(bytes / 1024 ** 2).toFixed(1)} MB`
						: bytes >= 1024
							? `${Math.round(bytes / 1024)} KB`
							: `${bytes} B`;
		/** 「今天 15:30」「明天 09:00」「11-26 09:00」；已过的写「已到期」 */
		const whenText = (ms, now) => {
			if (ms <= now) return "已到期";
			const d = new Date(ms);
			const day = (x) => new Date(x).toDateString();
			const hm = clockShort(ms);
			if (day(ms) === day(now)) return `今天 ${hm}`;
			if (day(ms) === day(now + 86400000)) return `明天 ${hm}`;
			return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
		};

		function cacheChip(view) {
			const items = view.groups.flatMap((g) => g.items);
			const running = Object.values(view.jobs).some((job) => job.finishedAt == null);
			const stale = items.filter((it) => it.state === "stale").length;
			if (running) return { tone: "busy", short: "缓存 · 执行中", text: "有操作正在执行" };
			if (stale > 0)
				return { tone: "warn", short: `缓存 · ${stale} 项待更新`, text: `${stale} 项待更新，将自动更新` };
			return { tone: "ok", short: "缓存", text: "均为最新" };
		}

		function CachePanel({ view, now, chip, pending, setPending, act, refresh, close, anchor }) {
			const rect = anchor?.getBoundingClientRect?.();
			const position =
				ReactDOM && rect
					? {
							position: "fixed",
							left: Math.max(8, Math.min(rect.left, window.innerWidth - 468)),
							bottom: Math.max(8, window.innerHeight - rect.top + 8),
						}
					: { position: "absolute", left: 0, bottom: "calc(100% + 8px)" };
			const entry = (label, value) =>
				value == null || value === ""
					? []
					: [h("dt", { key: `${label}-k` }, label), h("dd", { key: `${label}-v` }, value)];
			const button = (key, label, onClick, extra) =>
				h("button", { key, type: "button", className: "cjvm-btn", "data-size": "sm", onClick, ...extra }, label);
			const itemView = (item) => {
				const job = view.jobs[item.id];
				const running = job != null && job.finishedAt == null;
				const size = [item.files > 0 ? `${item.files} 个文件` : "", bytesText(item.bytes)]
					.filter(Boolean)
					.join(" · ");
				const confirming =
					pending && pending.item === item.id ? item.actions.find((a) => a.id === pending.action) : null;
				const next = item.nextAt == null ? item.nextText : `${whenText(item.nextAt, now)} · ${item.nextText}`;
				const jobLine = running
					? h("div", { className: "ccache-job" }, `执行中，已用时 ${span((now - job.startedAt) / 1000)}`)
					: job
						? h(
								"div",
								{ className: "ccache-job", "data-ok": String(job.ok) },
								`${job.ok ? "已完成" : "执行失败"}（${clockShort(job.finishedAt)}）：${job.text}`,
							)
						: null;
				const controls = confirming
					? h(
							"div",
							{ className: "ccache-confirm" },
							confirming.confirm,
							h(
								"div",
								{ className: "ccache-buttons" },
								button(
									"ok",
									"确定",
									() => {
										setPending(null);
										void act(item.id, confirming.id);
									},
									{ "data-kind": "primary" },
								),
								button("no", "取消", () => setPending(null)),
							),
						)
					: item.actions.length > 0
						? h(
								"div",
								{ className: "ccache-buttons" },
								...item.actions.map((action) =>
									button(
										action.id,
										action.jvm ? `${action.label}（需连接环境）` : action.label,
										() =>
											action.confirm
												? setPending({ item: item.id, action: action.id })
												: void act(item.id, action.id),
										{
											disabled: running,
											title: action.jvm ? "需连接苍穹环境，常驻 JVM 须在运行" : undefined,
										},
									),
								),
							)
						: null;
				return h(
					"div",
					{ key: item.id, className: "ccache-item", "data-cosmic-cache-item": item.id },
					h(
						"div",
						{ className: "ccache-name" },
						h(Tag, { kind: running ? "run" : CACHE_STATE_TAG[item.state] }),
						h("b", { title: item.name }, item.name),
						size ? h("small", null, size) : null,
					),
					h("div", { className: "ccache-what" }, item.what),
					item.stateText
						? h(
								"div",
								{ className: "ccache-state", style: tone(TAG[CACHE_STATE_TAG[item.state]].color) },
								item.stateText,
							)
						: null,
					h(
						"dl",
						{ className: "cjvm-kv" },
						...entry(
							"更新时间",
							item.updatedAt == null ? null : `${ago(item.updatedAt, now)}（${clock(item.updatedAt)}）`,
						),
						...entry("自动规则", item.auto),
						...entry("下次自动", next),
						...entry("位置", item.where.join("、")),
					),
					jobLine,
					controls,
				);
			};
			const panel = h(
				"div",
				{
					"data-cosmic-cache-panel": "",
					role: "dialog",
					"aria-label": "缓存与索引",
					className: "cjvm-panel",
					style: { ...position, ...tone(TONE[chip.tone]) },
					onMouseDown: (event) => event.stopPropagation(),
				},
				h(
					"header",
					{ className: "cjvm-head" },
					h("span", { className: "cjvm-brand" }, "缓存与索引"),
					h("span", { className: "cjvm-rule", "aria-hidden": true }),
					h(Tag, { kind: chip.tone }),
					h("span", { className: "cjvm-state" }, chip.text),
					h(
						"button",
						{ type: "button", className: "cjvm-close", "aria-label": "关闭", onClick: close },
						h(CloseIcon),
					),
				),
				h(
					"div",
					{ className: "cjvm-sub", title: view.project?.root },
					"工程 ",
					h("b", { key: "n" }, view.project?.name ?? ""),
					` · 统计于 ${clock(view.at)}，耗时 ${view.ms} 毫秒`,
				),
				h(
					"div",
					{ className: "cjvm-actions" },
					button("recount", "重新统计", () => void refresh(true)),
				),
				...view.groups.map((group) =>
					h(
						"section",
						{ key: group.id, className: "cjvm-section" },
						h(
							"div",
							{ className: "cjvm-section-title" },
							h("span", null, group.name),
							h(
								"small",
								null,
								bytesText(group.items.reduce((n, it) => (it.bytes == null ? n : n + it.bytes), 0)),
							),
						),
						...group.items.map(itemView),
					),
				),
			);
			return ReactDOM && rect ? ReactDOM.createPortal(panel, document.body) : panel;
		}

		function CacheChip({ sessionId }) {
			const [view, setView] = React.useState(null);
			const [open, setOpen] = React.useState(false);
			const [pending, setPending] = React.useState(null);
			const [now, setNow] = React.useState(Date.now());
			const anchor = React.useRef(null);
			ensureStyle();

			const refresh = React.useCallback(
				async (fresh) => {
					if (!sessionId) return;
					try {
						setView(await cacheCall(sessionId, undefined, fresh));
					} catch {
						// 宿主没有这条路径（无界面、旧版本）：什么都不画
						setView(null);
					}
					setNow(Date.now());
				},
				[sessionId],
			);
			React.useEffect(() => {
				setView(null);
				setOpen(false);
				setPending(null);
			}, [sessionId]);
			const running = view != null && Object.values(view.jobs).some((job) => job.finishedAt == null);
			React.useEffect(() => {
				void refresh(open);
				const every = open ? (running ? 2000 : 10000) : 60000;
				const timer = setInterval(() => void refresh(false), every);
				return () => clearInterval(timer);
			}, [refresh, open, running]);
			React.useEffect(() => {
				if (!open) return;
				const tick = setInterval(() => setNow(Date.now()), 1000);
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				const onDown = () => setOpen(false);
				window.addEventListener("keydown", onKey);
				window.addEventListener("mousedown", onDown);
				return () => {
					clearInterval(tick);
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("mousedown", onDown);
				};
			}, [open]);

			if (!view || !view.tracked) return null;
			const chip = cacheChip(view);
			const act = async (item, action) => {
				try {
					const answer = await cacheCall(sessionId, { item, action });
					if (answer.view) setView(answer.view);
				} catch {
					// 发不出去：下一次清点照实画
				}
				setNow(Date.now());
			};
			return h(
				"span",
				{ ref: anchor, style: { position: "relative", display: "inline-flex" } },
				h(
					"button",
					{
						type: "button",
						className: "cjvm-chip",
						"data-cosmic-cache-chip": chip.tone,
						"aria-expanded": open,
						title: `缓存与索引：${chip.text}`,
						style: tone(TONE[chip.tone]),
						onMouseDown: (event) => event.stopPropagation(),
						onClick: () => {
							setOpen((was) => !was);
							setPending(null);
						},
					},
					h(Tag, { kind: chip.tone }),
					h("span", { className: "cjvm-chip-text" }, chip.short),
				),
				open &&
					h(CachePanel, {
						view,
						now,
						chip,
						pending,
						setPending,
						act,
						refresh,
						close: () => setOpen(false),
						anchor: anchor.current,
					}),
			);
		}

		// ── 首页：iPhone 主屏的排法 ──
		//
		//   ┌──────────── 壁纸（柔和的彩色光斑，深浅两版）────────────┐
		//   │ ╭ 大组件 ─────────────────╮ ╭ 苍穹 JVM ╮ ╭ 工程 ───╮ │
		//   │ │ [图标] COSMIC  FAST·AI   │ │  ◯ 圆环  │ │ 名字     │ │
		//   │ │ 下午好 · 11月23日 星期一  │ │  就绪    │ │ 运行时   │ │
		//   │ ╰──────────────────────────╯ ╰──────────╯ ╰──────────╯ │
		//   │            ▢写插件   ▢查元数据   ▢排查问题   ▢真跑业务             │
		//   │ ╭──────────── 输入框（玻璃，当 Dock）────────────╮      │
		//   └──────────────────────────────────────────────────────┘
		//
		// 壁纸挂在 conversation.hero.frame（只在首页铺），组件和图标挂在品牌位（dsh 首页标题那一行，名牌独占一行）。
		// 小组件浮在壁纸上，用一层轻玻璃；它们之间不叠玻璃。JVM 和工程两块的数据来自输入框里的 JVM 小标签（首页拿不到会话），
		// 点 JVM 那块打开小标签的详情面板。应用图标点一下把一句起手的话填进输入框，光标停在末尾接着写。
		// 动画全在样式表里（transform / opacity / filter），这里只按时机切几个 data-* 属性。
		const INTRO_MS = 1300;
		const IGNITE_MS = 700;
		const reducedMotion = () =>
			typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

		/** 开场放完没有：放完以后开场的动画摘掉，开机状态的动画才挂上，两套不会抢。 */
		function useSettled(skip) {
			const [settled, setSettled] = React.useState(skip);
			React.useEffect(() => {
				if (skip) return;
				const timer = setTimeout(() => setSettled(true), INTRO_MS);
				return () => clearTimeout(timer);
			}, [skip]);
			return settled;
		}

		/** 就绪那一刻点火：只在亲眼看着它从「开机还在走」变成「就绪」时放，进来时已经就绪就不放。 */
		function useIgnite(boot) {
			const previous = React.useRef(boot);
			const [ignite, setIgnite] = React.useState(false);
			React.useEffect(() => {
				const lit = previous.current === "loading" && boot === "ready";
				previous.current = boot;
				if (!lit) return;
				setIgnite(true);
				const timer = setTimeout(() => setIgnite(false), IGNITE_MS);
				return () => clearTimeout(timer);
			}, [boot]);
			return ignite;
		}

		/** 现在几点：问候语和日期跟着走，一分钟对一次。 */
		function useMinute() {
			const [now, setNow] = React.useState(() => new Date());
			React.useEffect(() => {
				const timer = setInterval(() => setNow(new Date()), 60_000);
				return () => clearInterval(timer);
			}, []);
			return now;
		}
		const WEEKDAY = "日一二三四五六";
		function greetingOf(now) {
			const hour = now.getHours();
			if (hour < 5) return "夜深了";
			if (hour < 11) return "早上好";
			if (hour < 13) return "中午好";
			if (hour < 18) return "下午好";
			return "晚上好";
		}
		const dateOf = (now) => `${now.getMonth() + 1}月${now.getDate()}日 星期${WEEKDAY[now.getDay()]}`;

		/** 首页铺壁纸：只在首页（空会话、不是嵌在别处的对话）铺，进了会话就撤掉。 */
		function HeroFrame({ hero, children }) {
			return h(
				"div",
				{ style: { display: "contents" } },
				hero ? h("div", { className: "cx-wall", "aria-hidden": true, "data-cosmic-wall": "" }) : null,
				children,
			);
		}

		// 应用图标：无色玻璃方块 + 单色线条图形（iOS 的透明图标模式），点了填进输入框的起手句
		const APPS = [
			{
				id: "plugin",
				label: "写插件",
				starter: "给这张单据写一个插件：",
				glyph: [h("path", { key: "a", d: "M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.6 5.5l-3.2 13" })],
			},
			{
				id: "meta",
				label: "查元数据",
				starter: "查一下这张单据的字段和元数据：",
				glyph: [
					h("circle", { key: "a", cx: 10.5, cy: 10.5, r: 5.5 }),
					h("path", { key: "b", d: "m14.6 14.6 4.9 4.9" }),
				],
			},
			{
				id: "debug",
				label: "排查问题",
				starter: "帮我排查这个问题：",
				glyph: [
					h("path", { key: "a", d: "M12 4.2 3.6 19h16.8z", strokeLinejoin: "round" }),
					h("path", { key: "b", d: "M12 10v4" }),
					h("circle", { key: "c", cx: 12, cy: 16.6, r: 0.4 }),
				],
			},
			{
				id: "run",
				label: "真跑业务",
				starter: "在测试环境真跑一遍：",
				glyph: [h("path", { key: "a", d: "M8.5 6v12l9.5-6z", strokeLinejoin: "round" })],
			},
		];

		/** 把起手句填进输入框，光标放到末尾。拿得到 dsh 的输入框动作就用它整段换掉草稿，拿不到就只把光标送过去。 */
		function startWith(text) {
			const actions = composerShared.get();
			if (actions) actions.setDraft(text);
			const editor = document.querySelector("[data-composer-card] [contenteditable='true']");
			if (!editor) return;
			editor.focus();
			// 等 dsh 把草稿写进编辑器再挪光标
			requestAnimationFrame(() => {
				const selection = window.getSelection();
				if (!selection) return;
				const range = document.createRange();
				range.selectNodeContents(editor);
				range.collapse(false);
				selection.removeAllRanges();
				selection.addRange(range);
			});
		}

		function AppIcon({ app, index }) {
			return h(
				"button",
				{
					type: "button",
					className: "cx-app",
					style: { "--cx-i": index },
					title: app.starter,
					onClick: () => startWith(app.starter),
				},
				h(
					"span",
					{ className: "cx-app-icon", "aria-hidden": true },
					h(
						"svg",
						{
							viewBox: "0 0 24 24",
							width: 30,
							height: 30,
							fill: "none",
							stroke: "currentColor",
							strokeWidth: 1.8,
							strokeLinecap: "round",
						},
						...app.glyph,
					),
				),
				h("span", { className: "cx-app-label" }, app.label),
			);
		}

		// ── JVM 卡片：一段终端里的启动日志 ──
		//   苍穹 JVM                              ●
		//   $ jvm status
		//   ✓ 检查常驻 JVM                     1s     ┐
		//   ✓ 编译探针宿主                     3s     │ 日志窗口三行：新的一步出来，旧的往上滚走
		//   ⠹ 启动苍穹 JVM                     9s     ┘ 正在走的那步是转圈的盲文点
		//   → 启动中 · 第 4/6 步▌
		// 用的是开机的真实步骤（JVM 小标签报过来的），不是装饰。没有步骤可列（JVM 早就在跑、没连上工程）时写一行说明。
		const LOG_ROWS = 3;
		const LOG_MARK = { ok: "✓", skip: "–", fail: "✗", wait: "·", run: "" };
		function logLinesOf(jvm) {
			if (!jvm) return [{ key: "none", state: "wait", label: "还没连上苍穹工程" }];
			const steps = jvm.steps.filter((step) => step.state !== "wait");
			if (steps.length > 0) return steps;
			if (jvm.tone === "ok" || jvm.tone === "run") return [{ key: "live", state: "ok", label: "常驻 JVM 已在运行" }];
			if (jvm.tone === "busy") return [{ key: "live", state: "run", label: jvm.headline }];
			return [{ key: "live", state: jvm.tone === "bad" ? "fail" : "wait", label: jvm.headline }];
		}

		function JvmWidget({ jvm }) {
			const color = jvm ? (TAG[jvm.tone]?.color ?? TONE.idle) : TONE.idle;
			const lines = logLinesOf(jvm);
			const hidden = Math.max(0, lines.length - LOG_ROWS);
			// 只给卡片出来以后才冒出的新一步做打字动画；已有的行本身就可见，不靠动画跑完才露出来
			const seen = React.useRef(null);
			React.useEffect(() => {
				seen.current = new Set(lines.map((line) => line.key));
			});
			const waiting = jvm?.tone === "busy";
			const body = [
				h(
					"span",
					{ key: "head", className: "cx-w-head" },
					h("span", { className: "cx-w-cap" }, "苍穹 JVM"),
					h(Tag, { kind: jvm ? jvm.tone : "idle" }),
				),
				h(
					"span",
					{ key: "cmd", className: "cx-term-cmd" },
					h("span", { className: "cx-type" }, h("i", null, "$"), " jvm status"),
				),
				h(
					"span",
					{ key: "log", className: "cx-log" },
					h(
						"span",
						{ className: "cx-log-roll", style: { transform: `translateY(${-hidden * 17}px)` } },
						...lines.map((line, at) =>
							h(
								"span",
								{
									key: line.key,
									className: "cx-log-line",
									"data-state": line.state,
									style: { "--i": at },
									"data-new": seen.current && !seen.current.has(line.key) ? "" : undefined,
								},
								h("span", { className: "cx-log-mark" }, LOG_MARK[line.state] ?? "·"),
								h("span", { className: "cx-log-label" }, line.label),
								h("span", { className: "cx-log-time" }, line.seconds == null ? "" : `${line.seconds}s`),
							),
						),
					),
				),
				h(
					"span",
					{ key: "out", className: "cx-log-out" },
					h("i", null, "→"),
					h("b", null, jvm?.headline ?? "未连接"),
					h("span", null, jvm ? ` · ${jvm.note}` : " · 选好苍穹工程会自动启动"),
					waiting ? h("span", { className: "cx-caret cx-caret-sm" }) : null,
				),
			];
			const style = tone(color);
			if (!jvm) return h("div", { className: "cx-widget cx-w-jvm", "data-w": 1, style }, ...body);
			return h(
				"button",
				{
					type: "button",
					className: "cx-widget cx-w-jvm",
					"data-w": 1,
					style,
					title: "打开苍穹 JVM 详情",
					onClick: () => jvm.open?.(),
				},
				...body,
			);
		}

		// ── 工程卡片：像编辑器里的一段代码 ──
		//   1  const project = {
		//   2    name: "zlgd_ygpt2.0",
		//   3    runtime: "vdsh-0.1.0",
		//   4    account: "张三 @ demo",
		//   5  }  // 本地测试环境
		// 左边行号；一条「当前行」高亮慢慢往下走（pi 版首页那段代码装饰的「亮光逐行扫过」），开场一行一行打出来。
		const LINE_MS = 1600;
		function codeLinesOf(project) {
			const punct = (text) => h("span", { className: "cx-c-p" }, text);
			const head = [
				h("span", { key: "k", className: "cx-c-k" }, "const"),
				" ",
				h("span", { key: "v", className: "cx-c-v" }, "project"),
				" ",
				punct("= "),
			];
			if (!project)
				return [
					[...head, h("span", { key: "n", className: "cx-c-k" }, "null"), punct(";")],
					[h("span", { key: "c", className: "cx-c-c" }, "// 在下面选一个工作区")],
				];
			const field = (key, value) => [
				"  ",
				h("span", { key: "f", className: "cx-c-f" }, key),
				punct(": "),
				h("span", { key: "s", className: "cx-c-s" }, `"${value}"`),
				punct(","),
			];
			const account = project.user || project.account ? `${project.user ?? "?"} @ ${project.account ?? "?"}` : null;
			return [
				[...head, punct("{")],
				field("name", project.name),
				...(project.keyId ? [field("runtime", project.keyId)] : []),
				...(account ? [field("account", account)] : []),
				[punct("}"), h("span", { key: "c", className: "cx-c-c" }, "  // 本地测试环境")],
			];
		}

		function ProjectWidget({ jvm }) {
			const lines = codeLinesOf(jvm?.project ?? null);
			const still = React.useMemo(reducedMotion, []);
			const [current, setCurrent] = React.useState(0);
			React.useEffect(() => {
				if (still) return;
				const timer = setInterval(() => setCurrent((line) => line + 1), LINE_MS);
				return () => clearInterval(timer);
			}, [still]);
			const active = still ? -1 : current % lines.length;
			return h(
				"div",
				{ className: "cx-widget cx-w-project", "data-w": 2 },
				h(
					"span",
					{ className: "cx-w-head" },
					h("span", { className: "cx-w-cap" }, "工程"),
					h("span", { className: "cx-w-file" }, "project.ts"),
				),
				h(
					"span",
					{ className: "cx-code" },
					...lines.map((parts, at) =>
						h(
							"span",
							{
								key: at,
								className: "cx-code-line",
								style: { "--i": at },
								"data-on": at === active ? "" : undefined,
							},
							h("span", { className: "cx-code-no" }, at + 1),
							h("span", { className: "cx-code-text" }, ...parts),
						),
					),
				),
			);
		}

		/** 首页：大组件（方块字 + 提示行）占一整行，下面 JVM、工程两张卡片并排，再下面一排应用图标。只在首页（空会话）出现。 */
		function HeroMark() {
			ensureStyle();
			const still = React.useMemo(reducedMotion, []);
			const settled = useSettled(still);
			const boot = useBootState();
			const jvm = jvmShared.use();
			const ignite = useIgnite(boot);
			const now = useMinute();
			return h(
				"div",
				{
					className: "cx-home",
					"data-cosmic-hero": "",
					"data-settled": settled ? "" : undefined,
					"data-boot": settled && !ignite ? (boot ?? undefined) : undefined,
					"data-ignite": ignite ? "" : undefined,
					"aria-label": `${PRODUCT_LOGO_NAME} · ${PRODUCT_SUBTITLE}`,
				},
				h(
					"div",
					{ className: "cx-widgets" },
					h(
						"div",
						{ className: "cx-widget cx-w-brand", "data-w": 0 },
						h(
							"div",
							{ className: "cx-w-top" },
							h(Wordmark, { height: 64 }),
							h("small", { className: "cx-w-date" }, dateOf(now)),
						),
						h(
							"div",
							{ className: "cx-w-meta" },
							h("span", { className: "cx-w-tag" }, PRODUCT_LOGO_TAG),
							h("span", null, PRODUCT_SUBTITLE),
						),
						// 终端那样的一行：提示符、问候和口号，末尾一个块状光标
						h(
							"div",
							{ className: "cx-prompt" },
							h("span", { className: "cx-prompt-mark" }, "❯"),
							h("span", { className: "cx-prompt-text" }, h("b", null, `${greetingOf(now)}，`), PRODUCT_TAGLINE),
							h("span", { className: "cx-caret" }),
						),
					),
					h(JvmWidget, { jvm }),
					h(ProjectWidget, { jvm }),
				),
				h("div", { className: "cx-apps" }, ...APPS.map((app, index) => h(AppIcon, { key: app.id, app, index }))),
			);
		}

		// ── 写元数据的确认卡片 ──
		// 工具弹的确认（提问编号 cosmic-write）正文末尾带一段卡片数据（src/agent/state/write-report.ts 的 cardView）。
		// 这里在输入框那一栏抢先认领它，画成对比卡片：每处改动一行，标新增 / 删除 / 修改，原值划掉、新值高亮；
		// 影响、撤回、写入范围收在下面。认不出数据的（旧会话、数据坏了）交还给 dsh 的提问卡照常显示正文。
		const WRITE_QUESTION_ID = "cosmic-write";
		const CARD_FENCE = "cosmic-write-card";
		const CARD_DATA = new RegExp(`\`\`\`\`${CARD_FENCE}\\n([^\\n]+)\\n\`\`\`\`\\s*$`);
		const cardCache = new WeakMap();
		/** 是不是我们的写入确认、带着能读的卡片数据；同一个待答事项只解析一次。 */
		function writeCardOf(pending) {
			if (pending === null || typeof pending !== "object") return null;
			if (cardCache.has(pending)) return cardCache.get(pending);
			let found = null;
			const questions = pending.questions;
			const question = Array.isArray(questions) && questions.length === 1 ? questions[0] : undefined;
			if (
				question?.id === WRITE_QUESTION_ID &&
				typeof question.detail === "string" &&
				typeof pending.answer === "function"
			) {
				const match = CARD_DATA.exec(question.detail);
				try {
					const view = match ? JSON.parse(match[1]) : null;
					if (view?.v === 1) found = { pending, question, view };
				} catch {
					found = null;
				}
			}
			cardCache.set(pending, found);
			return found;
		}

		const OP = {
			add: { mark: "+", text: "新增", color: C("ready") },
			remove: { mark: "−", text: "删除", color: C("bad") },
			change: { mark: "~", text: "修改", color: C("warn") },
			set: { mark: "→", text: "改成", color: C("run") },
			same: { mark: "=", text: "不变", color: C("label") },
		};
		const IDENTIFIER_VALUE = /^[A-Za-z][A-Za-z0-9]*[_.][A-Za-z0-9_.]*$/;
		const JAVA_CLASS = /^((?:[a-z_][a-z0-9_]*\.)+)([A-Z][A-Za-z0-9_$]*)$/;
		const SCOPED = /^(.+?)（([^（）]+)）$/;
		const WHOLE_MARK = /^（(?:新增|删除)）$/;
		/** 「（默认）」这类占位不是真值，改掉它不划删除线。 */
		const PLACEHOLDER_VALUE = /^（.*）$/;

		/** 一格的值：Java 类名只留最后一级包名和类名（全名在悬停提示里），标识用等宽小块，其余照字。 */
		function CardValue({ text, code }) {
			if (text === "" || text === undefined) return null;
			const java = JAVA_CLASS.exec(text);
			if (java) {
				const parts = java[1].split(".").filter(Boolean);
				return h(
					"span",
					{ className: "cw-code", title: text },
					h("i", null, `${parts.length > 1 ? "…" : ""}${parts.at(-1)}.`),
					h("b", null, java[2]),
				);
			}
			if (code || IDENTIFIER_VALUE.test(text)) return h("span", { className: "cw-code" }, text);
			return h("span", null, text);
		}

		/** 「save（操作）」拆成「save」和一个小标签「操作」。 */
		function CardKey({ text, code, first }) {
			if (text === "" || WHOLE_MARK.test(text)) return null;
			const scoped = SCOPED.exec(text);
			const name = scoped ? scoped[1] : text;
			return h(
				"span",
				{ className: first ? "cw-key cw-key-main" : "cw-key" },
				h(CardValue, { text: name, code }),
				scoped ? h("small", { className: "cw-scope" }, scoped[2]) : null,
			);
		}

		/** 改动清单：一处一行，左边一个色标，值那一栏按新增 / 删除 / 修改分别画。 */
		function DiffTable({ table }) {
			let previous = null;
			return h(
				"div",
				{ className: "cw-diff", role: "list" },
				...table.rows.map((row, index) => {
					const op = OP[row.op] ?? OP.change;
					const head = row.keys[0] ?? "";
					const ditto = table.group && index > 0 && head === previous;
					previous = head;
					const value =
						row.op === "add" || row.op === "set"
							? h("span", { className: "cw-new" }, h(CardValue, { text: row.new }))
							: row.op === "remove"
								? h("s", { className: "cw-old" }, h(CardValue, { text: row.old }))
								: row.op === "same"
									? h("span", { className: "cw-same" }, h(CardValue, { text: row.new }))
									: h(
											React.Fragment,
											null,
											PLACEHOLDER_VALUE.test(row.old)
												? h("span", { className: "cw-same" }, row.old)
												: h("s", { className: "cw-old" }, h(CardValue, { text: row.old })),
											h("span", { className: "cw-arrow", "aria-hidden": true }, "→"),
											h("span", { className: "cw-new" }, h(CardValue, { text: row.new })),
										);
					return h(
						"div",
						{ key: index, className: "cw-row", role: "listitem", "data-op": row.op, style: tone(op.color) },
						h("span", { className: "cw-mark", title: op.text }, op.mark),
						h(
							"span",
							{ className: "cw-target" },
							ditto
								? h("span", { className: "cw-ditto", "aria-hidden": true }, "└")
								: h(CardKey, { text: head, code: table.code[0], first: true }),
							...row.keys
								.slice(1)
								.map((key, at) => h(CardKey, { key: at, text: key, code: table.code[at + 1] })),
						),
						h("span", { className: "cw-value" }, value),
					);
				}),
			);
		}

		/** 没有原值、新值两列的表（造数、新增规则、映射说明）：照表格画，连续相同的第一列只写一次。 */
		function GridTable({ table }) {
			let previous = null;
			return h(
				"div",
				{ className: "cw-grid-wrap" },
				h(
					"table",
					{ className: "cw-grid" },
					h(
						"thead",
						null,
						h("tr", null, ...table.columns.map((column, index) => h("th", { key: index }, column))),
					),
					h(
						"tbody",
						null,
						...table.rows.map((row, index) => {
							const head = row[0] ?? "";
							const ditto = table.group && index > 0 && head === previous;
							previous = head;
							return h(
								"tr",
								{ key: index, "data-ditto": ditto ? "" : undefined },
								...table.columns.map((_column, at) =>
									h(
										"td",
										{ key: at },
										at === 0 && ditto ? "" : h(CardValue, { text: row[at] ?? "", code: table.code[at] }),
									),
								),
							);
						}),
					),
				),
			);
		}

		/** 一条影响里的长名单（「派生布局 31 张跟着变：a、b、c…」）先只露三个，点开看全。 */
		function ImpactItem({ text }) {
			const [open, setOpen] = React.useState(false);
			const at = text.lastIndexOf("：");
			const items = at < 0 ? [] : text.slice(at + 1).split("、");
			if (items.length <= 4 || open) return h("span", null, text);
			return h(
				"span",
				null,
				`${text.slice(0, at + 1)}${items.slice(0, 3).join("、")} 等 ${items.length} 个 `,
				h("button", { type: "button", className: "cw-link", onClick: () => setOpen(true) }, "展开"),
			);
		}

		function useQuestionCard(pending) {
			const subscribe = React.useCallback(
				(listener) => (typeof pending.subscribe === "function" ? pending.subscribe(listener) : () => {}),
				[pending],
			);
			const read = React.useCallback(
				() => (typeof pending.getSnapshot === "function" ? pending.getSnapshot() : null),
				[pending],
			);
			return React.useSyncExternalStore(subscribe, read, read);
		}

		/**
		 * 确认卡片：
		 *   ● 写元数据 · 单据布局                             测试环境 · 等你确认  ×
		 *   收样确认  zlgd_syqr_jj  布局
		 *   收样确认保存成功即反写委托单收样日期
		 *   改动 2 处   +1 新增  −1 删除
		 *   + save 操作  插件   …opplugin.SampleReceiptAuditOpPlugin
		 *   − audit 操作 插件   …opplugin.SampleReceiptAuditOpPlugin
		 *   影响 …   撤回 …   范围 3 个对象 ▸
		 *   ✎ 说明                                        ( 不写 ) ( 写入 )
		 */
		function WriteCard({ matched }) {
			const { pending, question, view } = matched;
			const card = useQuestionCard(pending);
			const options = Array.isArray(question.options) ? question.options : [];
			const approve = question.intent?.approve ?? options[0]?.label ?? "写入";
			const reject = question.intent?.reject ?? options[1]?.label ?? "不写";
			const review = Array.isArray(pending.review) ? pending.review : undefined;
			const recorded = review?.find((item) => item.id === question.id);
			const [busy, setBusy] = React.useState(null);
			const [error, setError] = React.useState("");
			const [note, setNote] = React.useState("");
			const [noteOpen, setNoteOpen] = React.useState(false);
			const [scopeOpen, setScopeOpen] = React.useState(false);
			const noteRef = React.useRef(null);
			// 界面重连过、提交那一下没送到：放开按钮再点一次
			React.useEffect(() => {
				if (busy !== null && card?.state === "continued") {
					setBusy(null);
					setError("连接换过一次，刚才那一下没送到，再点一次");
				}
			}, [card?.state]);
			React.useEffect(() => {
				if (noteOpen) noteRef.current?.focus();
			}, [noteOpen]);
			const canAnswer = review === undefined && card?.channel !== "none" && busy === null;
			const send = (kind) => {
				if (!canAnswer) return;
				const item = { id: question.id, selected: [kind === "approve" ? approve : reject] };
				if (kind === "reject" && note.trim() !== "") item.custom = note.trim();
				setBusy(kind);
				setError("");
				pending.answer({ answers: [item] }).catch((reason) => {
					setBusy(null);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const pickOther = (index, other) => {
				const line = `第 ${index + 1} 条改成：${other}`;
				setNote((text) => (text.includes(line) ? text : text.trim() === "" ? line : `${text.trim()}\n${line}`));
				setNoteOpen(true);
			};
			const approved = recorded?.selected?.includes(approve) === true;
			const state =
				recorded !== undefined
					? approved
						? { tag: "ok", text: "已确认写入" }
						: { tag: "skip", text: "没写" }
					: busy === "approve"
						? { tag: "run", text: "写入中" }
						: busy === "reject"
							? { tag: "run", text: "正在退回" }
							: card?.channel === "none"
								? { tag: "idle", text: "这张确认单已经答过" }
								: { tag: "ask", text: "等你确认" };
			const counts = view.counts ?? {};
			const countChips = ["add", "remove", "change", "set"]
				.filter((op) => (counts[op] ?? 0) > 0)
				.map((op) =>
					h(
						"span",
						{ key: op, className: "cw-count", style: tone(OP[op].color) },
						`${OP[op].mark}${counts[op]} ${OP[op].text}`,
					),
				);
			const total = ["add", "remove", "change", "set"].reduce((sum, op) => sum + (counts[op] ?? 0), 0);
			const object = view.object;
			const facts = [...(view.impact.length > 0 ? [["影响", view.impact]] : []), ["撤回", [view.undo]]];
			return h(
				"div",
				{ className: "cw-root", "data-cosmic-write-card": "" },
				h(
					"section",
					{
						className: "cw-card",
						"aria-label": `${question.header ?? "写元数据"}：${view.kind}`,
						"aria-busy": busy !== null,
					},
					h(
						"header",
						{ className: "cw-strip" },
						h(Tag, { kind: state.tag }),
						h(
							"span",
							{ className: "cw-strip-title" },
							h("b", null, question.header ?? "写元数据"),
							` · ${view.kind}`,
						),
						h("span", { className: "cw-strip-rule", "aria-hidden": true }),
						h("span", { className: "cw-strip-state" }, `测试环境 · ${state.text}`),
						typeof pending.dismiss === "function"
							? h(
									"button",
									{
										type: "button",
										className: "cjvm-close",
										title: "收起（在对话里点这次调用可以再打开）",
										"aria-label": "收起",
										onClick: () => void pending.dismiss().catch(() => {}),
									},
									h(CloseIcon),
								)
							: null,
					),
					h(
						"div",
						{ className: "cw-body", tabIndex: 0 },
						h(
							"div",
							{ className: "cw-title" },
							object
								? h(
										React.Fragment,
										null,
										h("b", null, object.name),
										object.id !== object.name ? h("span", { className: "cw-code" }, object.id) : null,
										h("small", { className: "cw-scope" }, object.label),
									)
								: h("b", null, view.kind),
						),
						h("p", { className: "cw-purpose" }, view.purpose),
						view.head.length > 0
							? h(
									"dl",
									{ className: "cw-head" },
									...view.head.flatMap((line, index) => [
										h("dt", { key: `t${index}` }, line.label),
										h(
											"dd",
											{ key: `d${index}` },
											...line.values.map((value, at) => h(CardValue, { key: at, text: value })),
										),
									]),
								)
							: null,
						h(
							"div",
							{ className: "cw-summary" },
							h("b", null, total > 0 ? `改动 ${total} 处` : view.summary || view.kind),
							...countChips,
						),
						...view.tables.map((table, index) =>
							table.type === "diff" ? h(DiffTable, { key: index, table }) : h(GridTable, { key: index, table }),
						),
						view.note ? h("p", { className: "cw-note" }, h("b", null, "注意"), view.note) : null,
						view.decisions.length > 0
							? h(
									"div",
									{ className: "cw-decisions" },
									h(
										"div",
										{ className: "cw-section-title" },
										`AI 替你定的 ${view.decisions.length} 处做法`,
										h("small", null, "需求没说；要另一种就点它，不写并告诉 AI"),
									),
									...view.decisions.map((decision, index) =>
										h(
											"div",
											{ key: index, className: "cw-decision" },
											h(
												"span",
												{ className: "cw-choice", "data-picked": "" },
												h("i", null, "●"),
												decision.chose,
											),
											h(
												"button",
												{
													type: "button",
													className: "cw-choice",
													disabled: !canAnswer,
													onClick: () => pickOther(index, decision.other),
												},
												h("i", null, "○"),
												decision.other,
											),
										),
									),
								)
							: null,
						h(
							"dl",
							{ className: "cw-facts" },
							...facts.flatMap(([label, lines]) => [
								h("dt", { key: `t${label}` }, label),
								h(
									"dd",
									{ key: `d${label}` },
									...lines.map((line, at) => h("div", { key: at }, h(ImpactItem, { text: line }))),
								),
							]),
							h("dt", { key: "tscope" }, "范围"),
							h(
								"dd",
								{ key: "dscope" },
								h(
									"button",
									{
										type: "button",
										className: "cw-link",
										"aria-expanded": scopeOpen,
										onClick: () => setScopeOpen((open) => !open),
									},
									`${view.targetCount} 个对象，范围外的会被拦下 ${scopeOpen ? "▾" : "▸"}`,
								),
								scopeOpen
									? h(
											"ul",
											{ className: "cw-scope-list" },
											...view.targets.map((target, index) =>
												h(
													"li",
													{ key: index },
													h(CardValue, { text: target.group, code: !target.group.endsWith(":") }),
													...target.items.map((item, at) =>
														h(CardValue, { key: at, text: item, code: true }),
													),
												),
											),
										)
									: null,
							),
						),
					),
					recorded !== undefined && !approved && recorded.custom
						? h("p", { className: "cw-said" }, h("b", null, "你说"), recorded.custom)
						: null,
					noteOpen && review === undefined
						? h("textarea", {
								ref: noteRef,
								className: "cw-input",
								rows: 2,
								value: note,
								disabled: busy !== null,
								placeholder: "不写的话，告诉 AI 要怎么改（会随「不写」一起发给它）",
								onChange: (event) => setNote(event.target.value),
							})
						: null,
					error ? h("p", { className: "cw-error" }, error) : null,
					review === undefined
						? h(
								"footer",
								{ className: "cw-actions" },
								h(
									"button",
									{
										type: "button",
										className: "cw-link",
										disabled: busy !== null,
										"aria-expanded": noteOpen,
										onClick: () => setNoteOpen((open) => !open),
									},
									noteOpen ? "✎ 收起说明" : "✎ 要改的话写一句",
								),
								h("span", { className: "cw-actions-gap" }),
								h(
									"button",
									{
										type: "button",
										className: "cjvm-btn",
										"data-kind": "danger",
										disabled: !canAnswer,
										onClick: () => send("reject"),
									},
									note.trim() === "" ? reject : `${reject}，按说明改`,
								),
								h(
									"button",
									{
										type: "button",
										className: "cjvm-btn cw-approve",
										"data-kind": "primary",
										disabled: !canAnswer,
										onClick: () => send("approve"),
									},
									`${approve}测试环境`,
								),
							)
						: null,
				),
			);
		}

		// ── 新会话首页上敲的命令的结果 ──
		// dsh 把命令结果画在对话流里，可没发过第一句话的会话一直停在首页、不画对话流：
		// 在首页敲 /cosmic-env、/cosmic-login 这些，命令在宿主跑完了，界面上什么都看不见。
		// 这里接 dsh 的 command/executed（本窗口提交的命令跑完时发），在输入框正上方补一张结果卡片；
		// 会话发过话以后对话流里有同一条结果，卡片就不画了。
		/** 最近一条跑完的命令：{ sessionId, name, result }，result 是 dsh 的 CommandResult（kind、text）。 */
		const commandShared = createShared(null);

		/** 这个会话还停在首页：没发过话、没在跑。 */
		const onHome = (session) =>
			session !== undefined &&
			session !== null &&
			session.blank === true &&
			session.running !== true &&
			session.promptAttempted !== true;

		function CommandResultDock({ session }) {
			const last = commandShared.use();
			ensureStyle();
			if (last === null || !onHome(session) || last.sessionId !== session.sessionId) return null;
			const failed = last.result?.kind === "error";
			const text = typeof last.result?.text === "string" ? last.result.text.trim() : "";
			return h(
				"section",
				{
					className: "cc-card",
					role: "status",
					"data-cosmic-command-result": failed ? "error" : "success",
					style: tone(failed ? C("bad") : C("ready")),
				},
				h(
					"div",
					{ className: "cc-head" },
					h("span", { className: "cc-name" }, `/${last.name}`),
					h("span", { className: "cc-state" }, failed ? "没做成" : "完成"),
					h("span", { className: "cc-gap" }),
					h(
						"button",
						{
							type: "button",
							className: "cc-close",
							"aria-label": "关掉",
							onClick: () => commandShared.set(null),
						},
						"×",
					),
				),
				text === "" ? null : h("pre", { className: "cc-text" }, text),
			);
		}

		// ── 输入框里 @ 引用单据、表单、布局、分录、字段 ──
		// 宿主半边在 src/dsh/mention.ts，路径和那边的 MENTION_PATH 一致（test/dsh/mention.test.ts 核对）。
		// 每敲一个字问一次候选；选中插成一枚引用，发送时换成「它在元数据里的准确位置」那一段交给模型。
		// 单据、表单那一行按 Tab（或行尾箭头）往里钻，列它的分录和字段。
		const MENTION_ROUTE = "api/fast-ai-cosmic.mention";
		const MENTION_SOURCE = "cosmic";
		// 发出去的那段包在这个标签里；历史消息里靠它画回成一枚引用，和 src/kernel/impact/mention.ts 的 MENTION_TAG 一致
		const MENTION_BLOCK = /<cosmic-ref id="([^"]*)" label="([^"]*)">\n([\s\S]*?)\n<\/cosmic-ref>/g;
		const unattr = (text) =>
			text
				.replace(/&lt;/g, "<")
				.replace(/&quot;/g, '"')
				.replace(/&amp;/g, "&");

		const mentionSource = {
			trigger: "@",
			name: MENTION_SOURCE,
			order: -1,
			showGroupTitle: false,
			async candidates(session, { query, signal }) {
				if (!query || query.startsWith('"') || query.includes("/")) return [];
				const url = `${MENTION_ROUTE}?session=${encodeURIComponent(session.sessionId)}&q=${encodeURIComponent(query)}`;
				const response = await fetch(url, { cache: "no-store", signal });
				if (!response.ok) return [];
				const value = await response.json().catch(() => ({ items: [] }));
				return (value.items ?? []).map((item) => ({
					name: item.label,
					description: item.hint,
					section: `苍穹${item.section}`,
					value: JSON.stringify({ id: item.id, label: item.label, drill: item.drill }),
					...(item.drill ? { drill: true } : {}),
				}));
			},
			// 发送时（codec）拿不到会话，会话编号就写进引用里：「会话#编号」，复制出去只带编号
			onPick({ candidate, action, session }) {
				const value = JSON.parse(candidate.value ?? "{}");
				if (!value.id) return undefined;
				if (action === "drill" && value.drill) return { text: `@${value.id}.`, continue: true };
				return {
					insert: {
						source: MENTION_SOURCE,
						ref: `${session.sessionId}#${value.id}`,
						label: value.label,
						clipboardText: value.id,
					},
				};
			},
			codec: {
				clipboardText: (ref) => ref.slice(ref.indexOf("#") + 1),
				// 换不成就不发：宁可让人看到「发不出去」，也不把一个光秃秃的编号当成已核对过的位置发给模型
				async serialize(ref, signal) {
					const at = ref.indexOf("#");
					const response = await fetch(MENTION_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ session: ref.slice(0, at), id: ref.slice(at + 1) }),
						signal,
					});
					const value = await response.json().catch(() => ({}));
					if (!response.ok || typeof value.text !== "string") throw new Error(value.error || `引用 ${ref} 没换成`);
					return value.text;
				},
			},
		};

		const cosmicRefRule = {
			id: "cosmic-ref",
			order: 20,
			match(text, from) {
				MENTION_BLOCK.lastIndex = from;
				const hit = MENTION_BLOCK.exec(text);
				if (hit === null) return undefined;
				return {
					id: "cosmic-ref",
					start: hit.index,
					end: hit.index + hit[0].length,
					data: { id: unattr(hit[1]), label: unattr(hit[2]), body: hit[3] },
				};
			},
		};

		function CosmicRefNode({ node, interactive }) {
			const [open, setOpen] = React.useState(false);
			const { label, body } = node.data;
			return h(
				"span",
				{ className: "cref" },
				h(
					"button",
					{
						type: "button",
						className: "cref-chip",
						title: body,
						"aria-expanded": open,
						disabled: !interactive,
						onClick: () => setOpen((was) => !was),
					},
					`@${label}`,
				),
				open ? h("span", { className: "cref-body", role: "note" }, body) : null,
			);
		}

		return {
			inject: ["slots", "theme"],
			apply(ctx) {
				ctx.effect(() => ctx.theme.overrideTokens("fast-ai-cosmic", TOKENS));
				ctx.effect(() => ensureStyle());
				ctx.on("command/executed", (sessionId, name, result) => {
					commandShared.set({ sessionId, name, result });
				});
				// 输入框正上方那一栏：新会话首页上敲的命令跑完，结果画在这里
				ctx.slots.inject("conversation.input.dock", () =>
					ctx.slots.register(
						{ name: "conversation.input.dock", id: "cosmic-command-result", order: 100 },
						CommandResultDock,
					),
				);
				ctx.slots.inject("sidebar.brand.mark", () =>
					ctx.slots.inject("sidebar.brand.name", function* () {
						yield ctx.slots.register({ name: "sidebar.brand.mark" }, Mark);
						yield ctx.slots.register({ name: "sidebar.brand.name" }, Name);
					}),
				);
				ctx.slots.inject("conversation.hero.brand.mark", () =>
					ctx.slots.register({ name: "conversation.hero.brand.mark" }, HeroMark),
				);
				ctx.slots.inject("conversation.hero.frame", () =>
					ctx.slots.register({ name: "conversation.hero.frame", id: "cosmic-wall" }, HeroFrame),
				);
				// pi-ai 那一族的每张卡片都会收到；组件自己只在 openai-codex 那张上画
				ctx.slots.inject("settings.models.provider-card", () =>
					ctx.slots.register({ name: "settings.models.provider-card", key: "llm-pi-ai" }, CodexLoginCard),
				);
				// 输入框左边那一排：空会话（首页还没发第一句）也有，进到会话就能看到 JVM 起到哪了
				ctx.slots.inject("conversation.input.left", () =>
					ctx.slots.register({ name: "conversation.input.left", id: "cosmic-jvm", order: 100 }, JvmChip),
				);
				ctx.slots.inject("conversation.input.left", () =>
					ctx.slots.register({ name: "conversation.input.left", id: "cosmic-cache", order: 110 }, CacheChip),
				);
				// 输入框那一栏按优先级从小到大问谁来接管；dsh 的提问卡是 0，这里排在它前面，只认领写入确认
				ctx.slots.inject("conversation.composer", () =>
					ctx.slots.register(
						{
							name: "conversation.composer",
							priority: -20,
							select: ({ pendingInteraction }) => writeCardOf(pendingInteraction),
						},
						WriteCard,
					),
				);
				// @ 引用：输入框候选，和历史消息里那一段画回成一枚引用。老版本 dsh 没有这两个服务就不挂
				ctx.inject(["inputTriggers"], (sub) => {
					sub.effect(() => sub.inputTriggers.registerSource(mentionSource));
				});
				ctx.inject(["uiConversation", "slots"], (sub) => {
					sub.effect(() => sub.uiConversation.userText.register(cosmicRefRule));
					sub.slots.inject("conversation.user.text.node", () =>
						sub.slots.register(
							{ name: "conversation.user.text.node", key: "cosmic-ref", priority: 100 },
							CosmicRefNode,
						),
					);
				});
			},
		};
	},
});
