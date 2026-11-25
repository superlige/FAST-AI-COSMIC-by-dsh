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
			// 首页壁纸：底色上四团柔和的光（青绿、靛紫、粉、杏），深色版压暗、收饱和
			"--cosmic-wall-base": pair("#eef2fb", "#07080f"),
			"--cosmic-wall-a": pair("rgba(72, 206, 190, 0.5)", "rgba(0, 150, 138, 0.42)"),
			"--cosmic-wall-b": pair("rgba(146, 128, 255, 0.5)", "rgba(112, 70, 255, 0.48)"),
			"--cosmic-wall-c": pair("rgba(255, 150, 200, 0.42)", "rgba(214, 40, 140, 0.32)"),
			"--cosmic-wall-d": pair("rgba(255, 196, 140, 0.45)", "rgba(255, 120, 60, 0.2)"),
			// 首页小组件：壁纸上的一层轻玻璃
			"--cosmic-widget-bg": pair("rgba(255, 255, 255, 0.55)", "rgba(28, 28, 34, 0.5)"),
			"--cosmic-widget-rim": pair("rgba(255, 255, 255, 0.75)", "rgba(255, 255, 255, 0.1)"),
			"--cosmic-widget-shadow": pair("0 6px 24px rgba(20, 30, 80, 0.08)", "0 6px 24px rgba(0, 0, 0, 0.35)"),
			// pi 版的品牌青绿（src/agent/ui/palette.ts 那一套）：首页方块大字、状态卡、名牌。浅色取深一档，白底上读得清
			"--cosmic-pi-accent": pair("rgb(90, 128, 128)", "rgb(138, 190, 183)"),
			"--cosmic-pi-glow": pair("rgb(32, 128, 118)", "rgb(112, 226, 208)"),
			"--cosmic-pi-hi": pair("rgb(20, 64, 60)", "rgb(228, 255, 250)"),
			"--cosmic-pi-line": pair("rgb(160, 190, 186)", "rgb(56, 92, 87)"),
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

		// ── 标志：pi 版的方块字 + iOS 图标 ──
		// 深色圆角方块里一个 pi 版方块字的「C」：青绿渐变的实心格、细线阴影（字形和首页大字同一套），
		// 底上淡淡几道扫描线、字后面一团青绿的光。高光只在上下两条边，外沿一圈很淡的暗边（iOS 图标规范）。
		// 安装包图标（scripts/package-desktop.mjs 的 MARK）画的是同一个图形，改这里要一起改那边。
		/** 圆角取边长的 22.37%，iOS 图标那条连续曲线在网页上的近似。 */
		const ICON_RX = 5.37;
		const SCANLINES = Array.from({ length: 14 }, (_unused, at) => +(2.2 + at * 1.5).toFixed(1));
		/** 方块字「C」（格宽 1、高 2，8×12）：实心格并成三块，阴影一笔画完。 */
		const ICON_C_BLOCKS = "M1 0h6v2h-6zM0 2h2v6h-2zM1 8h6v2h-6z";
		const ICON_C_SHADE = "M7 1H7.5V3H2.5V8M.5 8V9H1M7 9H7.5V11H1.5V10";

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
					h("radialGradient", { id: `${id}-bloom`, cx: "50%", cy: "50%", r: "46%" }, [
						stop("0", "#70E2D0", 0.36),
						stop("1", "#70E2D0", 0),
					]),
					h("linearGradient", { id: `${id}-ink`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
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
				h(
					"g",
					{ transform: "translate(7 4.5) scale(1.35)" },
					h("path", {
						d: ICON_C_SHADE,
						fill: "none",
						stroke: "#70E2D0",
						strokeOpacity: 0.45,
						strokeWidth: 0.24,
						strokeLinecap: "square",
					}),
					h("path", { d: ICON_C_BLOCKS, fill: ref("ink") }),
				),
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
		// 按列分组，每列带上它的列号和一点抖动：开场的逐列解码、开机时的呼吸波、就绪点火都按列错开。
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
		/** 阴影一格的折线，平移到 (x, y) 那一格。 */
		function shadeAt(char, x, y) {
			return SHADE_PATHS[char].replace(/([MHV])([\d.]+)(?: ([\d.]+))?/g, (_whole, op, a, b) => {
				if (op === "H") return `H${+a + x}`;
				if (op === "V") return `V${+a + y}`;
				return `M${+a + x} ${+b + y}`;
			});
		}
		/** 固定的伪随机（0～1）：解码的乱码、每列的抖动每次都一样，不闪来闪去。 */
		function hash01(a, b) {
			let n = Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(b + 7, 0x165667b1);
			n ^= n >>> 15;
			n = Math.imul(n, 0x2c1b3c6d);
			n ^= n >>> 12;
			return (n >>> 0) / 4294967296;
		}
		/** 解码时这一列多久锁定成真字（毫秒）：从左往右扫，带一点抖动。 */
		const lockMs = (x) => Math.round(140 + x * 22 + hash01(x, 2) * 140);
		const WORDMARK = (() => {
			const columns = [];
			let left = 0;
			for (const letter of PRODUCT_LOGO_MARK) {
				const rows = WORD_GLYPHS[letter];
				if (!rows) continue;
				rows.forEach((row, y) => {
					[...row].forEach((char, dx) => {
						const x = left + dx;
						columns[x] ??= { x, blocks: "", shades: "", noise: "" };
						if (char === "█") columns[x].blocks += `M${x} ${y * 2}h1v2h-1z`;
						else if (SHADE_PATHS[char]) columns[x].shades += shadeAt(char, x, y * 2);
					});
				});
				left += rows[0].length;
			}
			// 解码时的乱码：每列随机几格画成小一号的块，锁定前一明一暗
			for (const column of columns)
				for (let y = 0; y < 6; y += 1)
					if (hash01(column.x, y + 11) < 0.42) column.noise += `M${column.x + 0.15} ${y * 2 + 0.35}h.7v1.3h-.7z`;
			return { width: left, columns: columns.filter(Boolean) };
		})();
		const WORDMARK_BLOCKS = WORDMARK.columns.map((column) => column.blocks).join("");
		/** 故障闪一下的那两条：第几行、往哪边错一格、多久闪一次。 */
		const GLITCH_BANDS = [
			{ row: 1, shift: 1 },
			{ row: 3, shift: -1 },
		];

		/**
		 * 方块字本体（pi 版首页的大字）。开场逐列解码：先是乱码一明一暗，到点锁定成实心格、闪一下白再落成青绿，
		 * 阴影随后淡入；定下来以后隔一阵有一行错开一格闪一下（pi 版的故障闪），一道光不时扫过。
		 * 开机还在走时整块暗着、从左往右一波波呼吸；就绪那一刻从左到右点火。这些都在样式表里，按 data-* 切。
		 */
		function Wordmark({ height = 72 }) {
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
						h("stop", { offset: 0, style: { stopColor: "var(--cosmic-pi-glow)" } }),
						h("stop", { offset: 1, style: { stopColor: "var(--cosmic-pi-accent)" } }),
					),
					h(
						"linearGradient",
						{ id: `${id}-beam`, x1: 0, y1: 0, x2: 1, y2: 0 },
						stop("0", "#ffffff", 0),
						stop("0.5", "#ffffff", 0.85),
						stop("1", "#ffffff", 0),
					),
					h("mask", { id: `${id}-cells` }, h("path", { d: WORDMARK_BLOCKS, fill: "#ffffff" })),
					// 故障闪的那一瞬，原地那一行挖掉，换成错开一格的那一份
					h(
						"mask",
						{ id: `${id}-hole`, maskUnits: "userSpaceOnUse", x: -2, y: -2, width: width + 4, height: 17 },
						h("rect", { x: -2, y: -2, width: width + 4, height: 17, fill: "#ffffff" }),
						...GLITCH_BANDS.map((band, at) =>
							h("rect", {
								key: at,
								className: `cx-wm-hole cx-wm-g${at}`,
								x: -2,
								y: band.row * 2,
								width: width + 4,
								height: 2,
								fill: "#000000",
							}),
						),
					),
					...GLITCH_BANDS.map((band, at) =>
						h(
							"clipPath",
							{ key: at, id: `${id}-band${at}` },
							h("rect", { x: -2, y: band.row * 2, width: width + 4, height: 2 }),
						),
					),
				),
				h(
					"g",
					{ mask: `url(#${id}-hole)` },
					h(
						"g",
						{ id: `${id}-body` },
						...WORDMARK.columns.map((column) =>
							h(
								"g",
								{ key: column.x, style: { "--x": column.x, "--t": `${lockMs(column.x)}ms` } },
								h("path", { className: "cx-wm-noise", d: column.noise }),
								h("path", { className: "cx-wm-shade", d: column.shades }),
								h("path", { className: "cx-wm-blocks", d: column.blocks, fill: `url(#${id}-ink)` }),
							),
						),
					),
				),
				...GLITCH_BANDS.map((band, at) =>
					h(
						"g",
						{ key: at, className: `cx-wm-glitch cx-wm-g${at}`, clipPath: `url(#${id}-band${at})` },
						h("use", { href: `#${id}-body`, transform: `translate(${band.shift} 0)` }),
					),
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
							"浏览器未自动打开时，",
							h("a", { href: view.url, target: "_blank", rel: "noreferrer" }, "点击此处打开登录页"),
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
							h("span", { style: muted }, `${view.question.message}（浏览器登录完成后未自动返回时填写）`),
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
						`登录失败：${view.error}`,
					),
				);
			} else if (view.phase === "cancelled") {
				rows.push(h("p", { key: "x", style: muted }, "登录已取消。"));
			}

			const status = view.signedIn ? "已登录 ChatGPT 账号" : "未登录 ChatGPT 账号，无法使用 Codex 模型";
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
				failure === null ? null : h("p", { style: muted }, `上一步提交失败：${failure}`),
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
			stopped: "未运行",
			stopping: "停止中",
			starting: "启动中",
			warming: "预热中",
			ready: "就绪",
			executing: "执行探针中",
			"pending-sync": "就绪（待加载新代码）",
			syncing: "同步代码中",
			"restart-needed": "需重启以加载新代码",
			restarting: "重启中",
			unresponsive: "进程存在，心跳无响应",
			unhealthy: "运行异常",
			foreign: "端口被其他 JVM 占用",
			checking: "检查中",
		};
		const MACHINE_STATE = {
			ready: "空闲",
			executing: "执行中",
			starting: "启动中",
			warming: "预热中",
			syncing: "同步代码中",
			unhealthy: "运行异常",
			unresponsive: "心跳无响应",
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
			if (boot?.phase === "no-project") return say("idle", "非苍穹工程", "当前工作区不是苍穹工程");
			if (boot?.phase === "config") return say("warn", "待配置", "苍穹工程配置不完整");
			if (!live) {
				if (boot?.phase === "failed") return say("bad", "JVM 启动失败", "苍穹 JVM 启动失败");
				return say("idle", "JVM", "苍穹 JVM");
			}
			const since = live.startedAt ? ` · ${clockShort(live.startedAt)} 启动` : "";
			switch (live.kind) {
				case "ready":
				case "pending-sync":
					return boot?.phase === "degraded"
						? say("warn", "JVM 环境异常", `苍穹 JVM 已启动，环境异常${since}`)
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
					if (boot?.phase === "failed") return say("bad", "JVM 启动失败", "苍穹 JVM 启动失败");
					if (boot?.phase === "not-built") return say("warn", "工程未构建", "工程尚未构建，JVM 未启动");
					return say("idle", "JVM 未运行", "苍穹 JVM 未运行");
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
		/** 首页状态卡要的（jvmHome 的样子）；首页拿不到会话，由输入框里的 JVM 小标签报过来。 */
		const jvmShared = createShared(null);
		/** 输入框的动作（dsh 给会话插槽的 inputActions）：首页应用图标用它填起手句。 */
		const composerShared = createShared(null);
		/**
		 * 首页状态卡要的样子。stage 是卡片画哪一种：
		 *   boot 开机还在走（或 JVM 在重启、同步这类）；ready 就绪；run 正在跑探针；
		 *   config 配置不全、等人填（missing 是缺的那几项）；warn 起了但有问题、工程没构建；bad 没起成；
		 *   down 没在跑、不是苍穹工程。首页拿不到会话（没选工作区）时整个是 null，卡片画等选工作区。
		 * headline 是 JVM 那头的大字，note 是它下面那行小字；steps 是开机六步（名字、状态）。
		 */
		function jvmHome(view, open) {
			const chip = jvmChip(view);
			const boot = view.boot;
			const live = view.live;
			const steps = (boot?.steps ?? []).map(({ key, label, state }) => ({ key, label, state }));
			const base = {
				tone: chip.tone,
				steps,
				project: view.project ?? null,
				folder: view.folder ?? null,
				missing: [],
				open,
			};
			if (boot && !boot.done) {
				const done = steps.filter((step) => step.state === "ok" || step.state === "skip").length;
				const at = Math.min(done + 1, steps.length);
				const step = steps.find((one) => one.state === "run");
				return {
					...base,
					stage: "boot",
					headline: "启动中",
					note: `${step ? `${step.label} · ` : ""}${at}/${steps.length}`,
				};
			}
			if (boot?.phase === "config")
				return {
					...base,
					stage: "config",
					missing: boot.missing ?? [],
					headline: "待配置",
					note: "完成工程配置后自动启动",
				};
			if (boot?.phase === "no-project")
				return { ...base, stage: "down", headline: "非苍穹工程", note: "请切换到苍穹工程所在的工作区" };
			if (chip.tone === "ok")
				return {
					...base,
					stage: "ready",
					headline: "就绪",
					note: live?.startedAt ? `${clockShort(live.startedAt)} 启动` : "",
				};
			if (chip.tone === "run") return { ...base, stage: "run", headline: "执行中", note: "正在执行探针" };
			const headline = chip.short.replace(/^JVM\s*/, "").replace(/…$/, "") || "未运行";
			// JVM 在重启、同步、预热这类：没有这一趟的步骤可列，线上的光跑满全程
			if (chip.tone === "busy") return { ...base, steps: [], stage: "boot", headline, note: "" };
			const stage = chip.tone === "bad" ? "bad" : chip.tone === "warn" ? "warn" : "down";
			return { ...base, stage, headline, note: stage === "down" ? "点击启动" : "点击查看原因" };
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

/* ── 首页：pi 版的品牌（方块大字、名牌、青绿）放进 iOS 的玻璃卡片里；下面两张状态卡、一排应用图标 ── */
@keyframes cx-zoom { from { opacity: 0; transform: scale(1.08); } to { opacity: 1; transform: none; } }
@keyframes cx-rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes cx-fade { from { opacity: 0; } }
@keyframes cx-turn { to { transform: rotate(360deg); } }
@keyframes cx-pop { 40% { transform: scale(1.16); } }
@keyframes cx-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
/* 方块字：锁定前是乱码一明一暗；到点锁定，闪一下白再落成青绿 */
@keyframes cx-noise { 0% { opacity: 0; } 12% { opacity: .5; } 26% { opacity: .2; } 40% { opacity: .6; } 55% { opacity: .25; } 70% { opacity: .55; } 85% { opacity: .3; } 100% { opacity: 0; } }
@keyframes cx-lock { from { opacity: 1; filter: brightness(2.6); } to { opacity: 1; filter: none; } }
@keyframes cx-gone { from, to { opacity: 0; } }
/* 开机还在走：暗着呼吸，波从左往右差着半拍 */
@keyframes cx-breath { 0%, 100% { opacity: .3; } 50% { opacity: .8; } }
/* 就绪点火：每列闪一下白 */
@keyframes cx-ignite { 30% { filter: brightness(2.6); } }
/* 一道光从左扫到右（只照在实心格上）；平时那一遍放在长周期的开头 */
@keyframes cx-beam { from { transform: translateX(-10px); } to { transform: translateX(56px); } }
@keyframes cx-beam-idle { 0% { transform: translateX(-10px); } 14%, 100% { transform: translateX(56px); } }
/* 故障闪：一个周期里只亮一小下（约 150ms），这一行错开一格 */
@keyframes cx-glitch { 0%, 66% { opacity: 0; } 66.1%, 70% { opacity: 1; } 70.1%, 100% { opacity: 0; } }
/* 光标：闪两下就收（输入框里也有光标，一直闪着人分不清往哪打字） */
@keyframes cx-caret { 0%, 49.9% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes cx-braille { 0% { content: "⠋"; } 10% { content: "⠙"; } 20% { content: "⠹"; } 30% { content: "⠸"; } 40% { content: "⠼"; }
  50% { content: "⠴"; } 60% { content: "⠦"; } 70% { content: "⠧"; } 80% { content: "⠇"; } 90% { content: "⠏"; } }
/* 状态卡 */
@keyframes cx-core { 0%, 100% { box-shadow: 0 0 10px 0 ${tint("var(--cx-tone)", 55)}, inset 0 0 0 1px ${tint("var(--cx-tone)", 50)}; }
  50% { box-shadow: 0 0 24px 4px ${tint("var(--cx-tone)", 45)}, inset 0 0 0 1px ${tint("var(--cx-tone)", 80)}; } }
@keyframes cx-ping { from { box-shadow: 0 0 0 0 ${tint("var(--cx-tone)", 60)}; } to { box-shadow: 0 0 0 8px transparent; } }
@keyframes cx-wait { 0%, 55%, 100% { opacity: .35; } 22% { opacity: 1; background-color: ${tint("var(--cx-tone)", 60)}; } }
@keyframes cx-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.cx-home { container-type: inline-size; display: flex; flex-direction: column; gap: 22px; width: 100%; padding-bottom: 12px; text-align: left;
  font-size: 13px; line-height: 18px; font-weight: 400; color: ${LABEL1}; user-select: none; }
.cx-widgets { display: flex; flex-direction: column; gap: 14px; }
/* 小组件：壁纸上的一层轻玻璃，圆角 24；彼此不叠 */
.cx-widget { position: relative; display: flex; min-width: 0; box-sizing: border-box;
  margin: 0; padding: 16px 18px; border: 0; border-radius: 24px; background: var(--cosmic-widget-bg);
  backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8);
  box-shadow: var(--cosmic-widget-shadow), inset 0 0 0 0.5px var(--cosmic-widget-rim);
  color: ${LABEL1}; font: inherit; text-align: left; overflow: hidden; }
/* 高光细边（参考 Liquid Glass 的镜面边）：一层 1px 的渐变环，左上、右下角最亮 */
.cx-widget::before, .cx-app-icon::before { content: ""; position: absolute; inset: 0; padding: 1px; border-radius: inherit; pointer-events: none;
  background: linear-gradient(135deg, var(--cosmic-rim-hot), var(--cosmic-rim-cool) 28%, transparent 50%, var(--cosmic-rim-cool) 72%, var(--cosmic-rim-hot));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
button.cx-widget { cursor: pointer; transition: transform .35s ${SNAPPY}; }
button.cx-widget:hover { transform: scale(1.015); }
button.cx-widget:active { transform: scale(.98); }
button.cx-widget:focus-visible { outline: none; box-shadow: 0 0 0 3px ${tint(C("glow"), 60)}, var(--cosmic-widget-shadow); }

/* 品牌卡：左边方块大字，右边 pi 版的名牌（字标、副标题、提示符标语、就绪） */
.cx-w-brand { align-items: center; gap: 28px; padding: 22px 26px; }
.cx-wm { flex: none; display: block; max-width: 100%; height: auto; overflow: visible; }
.cx-wm-shade { fill: none; stroke: var(--cosmic-pi-line); stroke-width: .22; stroke-linecap: square; }
/* 格子对齐到整像素画：缩放到小数像素时相邻两格之间不露缝（叠一点也不行，变暗时叠的地方会深一道） */
.cx-wm-blocks, .cx-wm-noise { shape-rendering: crispEdges; }
.cx-wm-noise { fill: var(--cosmic-pi-glow); opacity: 0; }
.cx-wm-beam { transform: translateX(-10px); }
.cx-wm-hole, .cx-wm-glitch { opacity: 0; }
.cx-wm-glitch { filter: brightness(1.5); }
.cx-plate { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; padding-left: 22px; border-left: 1px solid var(--cosmic-pi-line); }
.cx-plate-tag { font-size: 11px; line-height: 14px; font-weight: 700; letter-spacing: .08em; color: var(--cosmic-pi-glow); white-space: nowrap; }
.cx-plate-sub { font-size: 15px; line-height: 20px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx-plate-line { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; line-height: 18px; color: ${LABEL2}; white-space: nowrap; }
.cx-plate-line > i { font-style: normal; font-weight: 700; color: var(--cosmic-pi-glow); }
.cx-plate-line > b { font-weight: 600; color: var(--cosmic-pi-hi); }
.cx-caret { flex: none; width: 7px; height: 15px; margin-left: -2px; border-radius: 1.5px; background: var(--cosmic-pi-glow); opacity: 0;
  box-shadow: 0 0 8px ${tint("var(--cosmic-pi-glow)", 55)}; animation: cx-caret 1.06s 1.3s steps(1) 2 both; }
.cx-plate-ready { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: ${LABEL2}; animation: cx-rise .45s ${SNAPPY} both; }
.cx-plate-ready > b { font-weight: 600; color: ${C("ready")}; }

/* 品牌卡下面并排两张：左边苍穹 JVM（开机动画、就绪），右边工程信息；配色是 pi 的青绿，好坏用系统绿、红 */
.cx-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.cx-card-title { font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: .04em; color: ${LABEL2}; white-space: nowrap; }
/* 图块和侧栏标志一个做法：深色圆角方块、青绿的图形、背后一团光 */
.cx-jvm-core, .cx-proj-tile { position: relative; flex: none; display: grid; place-items: center; box-sizing: border-box; overflow: hidden;
  border-radius: 22.37%; color: #70E2D0;
  background: radial-gradient(circle at 50% 50%, rgba(112, 226, 208, .22), transparent 62%), linear-gradient(#2B2F33, #121518 60%, #090B0C);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18), inset 0 0 0 0.5px rgba(255, 255, 255, .12); }
.cx-proj-tile::after { content: ""; position: absolute; inset: -20%; transform: translateX(-80%);
  background: linear-gradient(110deg, transparent 40%, rgba(255, 255, 255, .18) 50%, transparent 60%); animation: cx-sheen 7s 1.5s ${GENTLE} infinite; }
@keyframes cx-sheen { 0% { transform: translateX(-80%); } 22%, 100% { transform: translateX(80%); } }

/* JVM 卡：上面核心 + 状态大字，中间开机六格，下面一行这一步的名字或启动时刻 */
.cx-jvm { flex-direction: column; gap: 14px; padding: 18px 20px; }
.cx-jvm-top { display: flex; align-items: center; gap: 14px; min-width: 0; }
.cx-jvm-core { width: 52px; height: 52px; color: var(--cx-tone); transition: color .4s ${GENTLE}; }
.cx-jvm-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cx-jvm-state { font-size: 20px; line-height: 26px; font-weight: 700; color: var(--cx-tone); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  animation: cx-rise .4s ${SNAPPY} both; }
.cx-jvm[data-stage="down"] .cx-jvm-state, .cx-jvm[data-stage="idle"] .cx-jvm-state { color: ${LABEL2}; }
.cx-jvm-note { min-height: 16px; font-size: 12px; line-height: 16px; color: ${LABEL2}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  animation: cx-rise .4s ${SNAPPY} both; }
/* 核心：就绪时一呼一吸地亮，执行中呼吸加快；开机时图形换成 pi 的盲文转圈，外面一圈光绕着转；等的时候外圈虚线慢转 */
.cx-jvm[data-stage="ready"] .cx-jvm-core { animation: cx-core 2.8s ease-in-out infinite; }
.cx-jvm[data-stage="run"] .cx-jvm-core { animation: cx-core 1.2s ease-in-out infinite; }
.cx-jvm[data-stage="down"] .cx-jvm-core, .cx-jvm[data-stage="idle"] .cx-jvm-core, .cx-jvm[data-stage="config"] .cx-jvm-core { color: rgba(235, 235, 245, .45); }
.cx-jvm[data-stage="boot"] .cx-jvm-core > svg { display: none; }
.cx-jvm[data-stage="boot"] .cx-jvm-core::after { content: "⠋"; font-size: 28px; line-height: 1; color: var(--cx-tone);
  text-shadow: 0 0 10px ${tint("var(--cx-tone)", 70)}; animation: cx-braille .8s linear infinite; }
.cx-jvm[data-stage="boot"] .cx-jvm-core::before { content: ""; position: absolute; inset: 0; border-radius: inherit;
  background: conic-gradient(from 0deg, transparent 0 70%, ${tint("var(--cx-tone)", 70)} 100%); animation: cx-turn 1.4s linear infinite;
  -webkit-mask: radial-gradient(circle, transparent 56%, #000 58%); mask: radial-gradient(circle, transparent 56%, #000 58%); }
.cx-jvm[data-stage="idle"] .cx-jvm-core::before, .cx-jvm[data-stage="config"] .cx-jvm-core::before { content: ""; position: absolute; inset: 5px;
  border-radius: 50%; border: 1.5px dashed ${tint("var(--cx-tone)", 75)}; animation: cx-turn 10s linear infinite; }
/* 开机六格（pi 的实心格）：做完的实心青绿，正在走的那格闪着状态色的光，出错的那格往外泛红圈，没轮到的空心 */
.cx-jvm-bar { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 5px; height: 8px; }
.cx-jvm-seg { position: relative; border-radius: 2px; overflow: hidden; background: ${tint("var(--cosmic-pi-line)", 70)};
  transition: background-color .35s ${GENTLE}; }
.cx-jvm-seg[data-s="done"] { background: var(--cx-done, var(--cx-tone)); }
.cx-jvm[data-stage="boot"], .cx-jvm[data-stage="bad"], .cx-jvm[data-stage="warn"] { --cx-done: var(--cosmic-pi-accent); }
.cx-jvm[data-stage="ready"] .cx-jvm-seg[data-s="done"], .cx-jvm[data-stage="run"] .cx-jvm-seg[data-s="done"] { box-shadow: 0 0 6px ${tint("var(--cx-tone)", 60)}; }
.cx-jvm-seg[data-s="now"] { background: ${tint("var(--cx-tone)", 35)}; }
.cx-jvm-seg[data-s="now"]::after, .cx-jvm-bar[data-sweep]::after { content: ""; position: absolute; inset: 0; width: 60%;
  background: linear-gradient(90deg, transparent, var(--cx-tone), transparent); animation: cx-slide 1.2s cubic-bezier(.45, 0, .55, 1) infinite; }
.cx-jvm-bar[data-sweep]::after { width: 30%; border-radius: 2px; }
@keyframes cx-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.cx-jvm-seg[data-s="fail"] { background: var(--cx-tone); animation: cx-ping 1.3s ease-out infinite; }
.cx-jvm[data-stage="idle"] .cx-jvm-seg, .cx-jvm[data-stage="config"] .cx-jvm-seg { animation: cx-wait 2.6s calc(var(--i) * .22s) ease-in-out infinite; }
/* 就绪：六格从左到右亮一遍 */
.cx-jvm[data-stage="ready"] .cx-jvm-seg { animation: cx-lit .5s calc(var(--i) * 60ms) ${GENTLE} both; }
@keyframes cx-lit { from { filter: brightness(2.2); transform: scaleY(1.6); } }

/* 工程卡：标题一行，下面两行两列：工程、ISV、账套、用户 */
.cx-proj { flex-direction: column; gap: 14px; padding: 18px 20px; }
.cx-proj-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cx-proj-tile { width: 30px; height: 30px; }
.cx-proj-tile > svg { width: 17px; height: 17px; }
.cx-proj-tile[data-empty] { background: none; box-shadow: none; color: ${LABEL3}; border: 1.5px dashed ${LABEL3}; animation: cx-breathe 2.4s ease-in-out infinite; }
.cx-proj-tile[data-empty]::after { content: none; }
.cx-proj-ask { margin-left: auto; padding: 2px 9px; border-radius: 999px; font-size: 12px; line-height: 16px; font-weight: 600; white-space: nowrap;
  color: var(--cosmic-pi-glow); background: ${tint("var(--cosmic-pi-glow)", 14)}; }
.cx-proj-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 16px; }
.cx-proj-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cx-proj-label { font-size: 11px; line-height: 14px; color: ${LABEL2}; }
.cx-proj-value { min-width: 0; font-size: 14px; line-height: 20px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx-proj-value[data-wait] { align-self: flex-start; padding: 0 8px; border-radius: 6px; font-weight: 500; color: ${LABEL3};
  background: linear-gradient(90deg, ${C("fill-4")} 0%, ${tint("var(--cosmic-pi-glow)", 22)} 50%, ${C("fill-4")} 100%); background-size: 200% 100%;
  animation: cx-shimmer 1.8s linear infinite; }

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

/* 开场：卡片和图标从稍大处收拢、淡入；方块字逐列解码（乱码 → 锁定闪白 → 青绿），阴影随后淡入，名牌最后一行行出来 */
.cx-home:not([data-settled]) .cx-widget { animation: cx-zoom .6s ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-row > .cx-widget { animation-delay: .08s; }
.cx-home:not([data-settled]) .cx-row > .cx-widget + .cx-widget { animation-delay: .14s; }
.cx-home:not([data-settled]) .cx-app { animation: cx-zoom .55s calc(.16s + var(--cx-i) * 40ms) ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-wm-noise { animation: cx-noise var(--t) steps(1) both; }
.cx-home:not([data-settled]) .cx-wm-blocks { animation: cx-lock .45s var(--t) both, cx-gone var(--t) linear; }
.cx-home:not([data-settled]) .cx-wm-shade { animation: cx-fade .3s calc(var(--t) + .15s) both; }
.cx-home:not([data-settled]) .cx-wm-beam { animation: cx-beam .9s 1.2s ${GENTLE} both; }
.cx-home:not([data-settled]) .cx-plate > * { animation: cx-rise .45s calc(.7s + var(--k, 0) * 90ms) ${SNAPPY} both; }
/* 定下来以后：隔一阵扫一遍光，两行轮流故障闪 */
.cx-home[data-settled]:not([data-boot="loading"]):not([data-boot="down"]) .cx-wm-beam { animation: cx-beam-idle 9s 2s ${GENTLE} infinite; }
.cx-home[data-settled]:not([data-boot="loading"]):not([data-boot="down"]) .cx-wm-g0 { animation: cx-glitch 3.4s 1s steps(1) infinite; }
.cx-home[data-settled]:not([data-boot="loading"]):not([data-boot="down"]) .cx-wm-g1 { animation: cx-glitch 5.3s 2.7s steps(1) infinite; }
/* 跟着开机走：还在走时整块暗着、从左往右一波波呼吸；没就绪也不在走就暗着不动 */
.cx-home[data-settled][data-boot="loading"] .cx-wm-blocks { animation: cx-breath 2.6s calc(var(--x) * 19ms) ease-in-out infinite; }
.cx-home[data-settled][data-boot="loading"] .cx-wm-shade { opacity: .5; }
.cx-home[data-boot="down"] .cx-wm-blocks { opacity: .36; }
.cx-home[data-boot="down"] .cx-wm-shade { opacity: .4; }
/* 就绪那一刻：从左到右点火、光扫一遍，JVM 的核跳一下 */
.cx-home[data-ignite] .cx-wm-blocks { animation: cx-ignite .7s calc(var(--x) * 14ms) ${GENTLE} both; }
.cx-home[data-ignite] .cx-wm-beam { animation: cx-beam .7s ${GENTLE}; }
.cx-home[data-ignite] .cx-jvm-core { animation: cx-pop .5s ${SNAPPY}; }
@container (max-width: 620px) {
  .cx-w-brand { flex-direction: column; align-items: flex-start; gap: 14px; }
  .cx-plate { padding-left: 0; border-left: 0; }
  .cx-row { grid-template-columns: minmax(0, 1fr); }
  .cx-apps { column-gap: 20px; }
}
/* 窗口矮：卡片收紧；再矮就只留品牌卡和图标，JVM 状态在输入框的小标签里也看得到 */
@media (max-height: 760px) {
  .cx-w-brand { padding: 16px 20px; }
  .cx-jvm, .cx-proj { gap: 10px; padding: 14px 16px; }
  .cx-jvm-core { width: 40px; height: 40px; }
}
@media (max-height: 620px) {
  .cx-row { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .cx-home, .cx-home *, .cx-home *::before, .cx-home *::after, .cx-wall, .cx-wall::before, .cx-wall::after, .cx-dot, .cjvm-panel, .cw-card { animation: none !important; }
  .cx-home .cx-caret { opacity: 0; }
  .cjvm-btn, .cjvm-chip, .cx-app-icon, .cx-widget, .cx-jvm-seg { transition: none; }
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

		const projectName = (root) => (root ? root.replace(/\\/g, "/").split("/").filter(Boolean).pop() : "未识别的工程");
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
							: "未识别工程";

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
										? h("small", null, "已跳过")
										: step.state === "wait" && boot.done
											? h("small", null, "未执行")
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
						? h("p", { key: "none", className: "cjvm-note" }, "本机暂无 cosmic 启动的 JVM")
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
					? h("p", { key: "partial", className: "cjvm-note" }, "未能读取进程清单，仅列出有心跳响应的 JVM")
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
					project ? ["工程 ", h("b", { key: "n" }, project.name)] : "当前会话的工作目录未识别为苍穹工程",
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
					setMessage(`发送失败：${String(error?.message ?? error)}`);
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
					setMessage(`发送失败：${String(error?.message ?? error)}`);
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
						title: `${chip.text}（点击查看详情）`,
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
		//   │ ╭ 品牌卡 ───────────────────────────────────────────╮ │
		//   │ │ ██████╗ ██████╗ …（pi 版方块大字）  │ F A S T · A I       │ │
		//   │ │                                     │ 金蝶云·苍穹开发智能体 │ │
		//   │ │                                     │ ❯ 构建，在真实环境中验证│ │
		//   │ ╰───────────────────────────────────────────────────╯ │
		//   │ ╭ JVM 卡 ─────────────────╮ ╭ 工程卡 ────────────────╮ │
		//   │ │ (核) 苍穹 JVM · 启动中   │ │ 工程 …       ISV …      │ │
		//   │ │ ■■▌□□□  编译探针宿主 3/6 │ │ 账套 …       用户 …     │ │
		//   │ ╰─────────────────────────╯ ╰────────────────────────╯ │
		//   │            ▢写插件   ▢查元数据   ▢排查问题   ▢真跑业务     │
		//   │ ╭──────────── 输入框（玻璃，当 Dock）────────────╮      │
		//   └──────────────────────────────────────────────────────┘
		//
		// 壁纸挂在 conversation.hero.frame（只在首页铺），卡片和图标挂在品牌位（dsh 首页标题那一行，名牌独占一行）。
		// 卡片浮在壁纸上，用一层轻玻璃；它们之间不叠玻璃。两张状态卡的数据来自输入框里的 JVM 小标签（首页拿不到会话），
		// 点 JVM 卡打开小标签的详情面板（配置不全时两张卡都改成把 /cosmic-env 填进输入框）。应用图标点一下把一句起手的话填进输入框。
		// 动画全在样式表里（transform / opacity / filter），这里只按时机切几个 data-* 属性；文字只留状态词和这一步的名字。
		const INTRO_MS = 2200;
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
				starter: "查询这张单据的字段和元数据：",
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
				starter: "在测试环境中实际运行一遍：",
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

		// ── 首页两张状态卡：左边苍穹 JVM（开机动画，起好了写「就绪」），右边工程（工程、ISV、账套、用户）──
		//   ╭ JVM ─────────────────────╮  ╭ 工程 ───────────────────────╮
		//   │ (核)  苍穹 JVM            │  │ [□] 工程信息                  │
		//   │       启动中              │  │ 工程 demo_proj   ISV  demox    │
		//   │ ▮▮▮▯▯▯  编译探针宿主 3/6   │  │ 账套 demo_acct   用户 demo_user │
		//   ╰──────────────────────────╯  ╰─────────────────────────────╯
		// JVM 卡下面那一排六格是开机的真实六步（JVM 小标签报过来的，不是装饰）：做完的实心，正在走的那格闪光，
		// 出错的那格标红；就绪后六格全亮、核心一呼一吸。没选工作区、配置不全时是等的样子：外圈虚线慢转、格子挨个轻亮。
		// 配置不全（账套、用户还没选）时点任一张卡把 /cosmic-env 填进输入框，向导填完宿主自己重走一趟。
		const BOOT_SEGMENTS = 6;
		const STATION_STATE = { ok: "done", skip: "done", run: "now", fail: "fail", wait: "wait" };
		const ASK_USER = ["account", "user"];

		function glyph(size, ...shapes) {
			return h(
				"svg",
				{
					viewBox: "0 0 24 24",
					width: size,
					height: size,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
				},
				...shapes,
			);
		}
		const FOLDER = () =>
			glyph(
				22,
				h("path", {
					key: "a",
					d: "M3 7.5a2 2 0 0 1 2-2h4.2l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
				}),
			);
		const ENGINE = () =>
			glyph(
				24,
				h("rect", { key: "a", x: 6, y: 6, width: 12, height: 12, rx: 2.5 }),
				h("path", { key: "b", d: "M10 2.5v3M14 2.5v3M10 18.5v3M14 18.5v3M2.5 10h3M2.5 14h3M18.5 10h3M18.5 14h3" }),
			);

		/** 两张卡共用的判断：处在哪一段、缺哪几项、点了做什么。jvm 是 jvmHome 的样子，没有就是还没选工作区。 */
		function homeStateOf(jvm) {
			const stage = jvm ? jvm.stage : "idle";
			const missing = jvm?.missing ?? [];
			const askUser = stage === "config" && missing.some((field) => ASK_USER.includes(field));
			return { stage, missing, askUser, waiting: stage === "idle" || stage === "config" };
		}

		/** 开机六格：每格的状态。就绪、执行中全亮；等的时候全是空格；重启、同步这类没有步骤可列，整排走一道光。 */
		function segmentsOf(jvm, stage) {
			const steps = jvm?.steps ?? [];
			const count = steps.length || BOOT_SEGMENTS;
			return Array.from({ length: count }, (_unused, index) => {
				const step = steps[index];
				let state = step ? (STATION_STATE[step.state] ?? "wait") : "wait";
				if (stage === "ready" || stage === "run") state = "done";
				if (stage === "idle" || stage === "config" || stage === "down") state = "wait";
				return { key: step?.key ?? String(index), label: step?.label ?? "", state };
			});
		}

		function JvmWidget({ jvm }) {
			const home = homeStateOf(jvm);
			const { stage } = home;
			const segments = segmentsOf(jvm, stage);
			const sweep = stage === "boot" && (jvm?.steps ?? []).length === 0;
			const headline = jvm?.headline ?? "未连接";
			const note =
				stage === "idle"
					? "请选择苍穹工程所在的工作区"
					: home.askUser
						? "选择账套和用户后自动启动"
						: (jvm?.note ?? "");
			const color = home.waiting ? "var(--cosmic-pi-glow)" : (TONE[jvm.tone] ?? TONE.idle);
			const act = home.askUser ? () => startWith("/cosmic-env") : stage === "idle" ? null : (jvm.open ?? null);
			const body = [
				h(
					"span",
					{ key: "top", className: "cx-jvm-top" },
					h("span", { className: "cx-jvm-core", "aria-hidden": true }, ENGINE()),
					h(
						"span",
						{ className: "cx-jvm-text" },
						h("span", { className: "cx-card-title" }, "苍穹 JVM"),
						h("span", { key: headline, className: "cx-jvm-state" }, headline),
					),
				),
				h(
					"span",
					{ key: "bar", className: "cx-jvm-bar", "data-sweep": sweep ? "" : undefined, "aria-hidden": true },
					...segments.map((segment, index) =>
						h("span", {
							key: segment.key,
							className: "cx-jvm-seg",
							"data-s": segment.state,
							style: { "--i": index },
							title: segment.label || undefined,
						}),
					),
				),
				h("span", { key: note, className: "cx-jvm-note" }, note),
			];
			const props = {
				className: "cx-widget cx-jvm",
				"data-stage": stage,
				style: tone(color),
				"aria-label": `苍穹 JVM：${headline}${note ? `，${note}` : ""}`,
			};
			if (!act) return h("div", props, ...body);
			return h(
				"button",
				{
					...props,
					type: "button",
					title: home.askUser ? "选择账套和用户（/cosmic-env）" : "查看苍穹 JVM 详情",
					onClick: act,
				},
				...body,
			);
		}

		/** 工程卡的一格：没选工作区、缺的那项是闪着浅光的占位；读不到的写「未配置」。 */
		function projectCellOf(home, project, field) {
			if (home.stage === "idle") return { wait: true, text: "待选择" };
			if (home.stage === "config" && home.missing.includes(field)) return { wait: true, text: "待选择" };
			const value = project?.[field] ?? null;
			return { wait: false, text: value ?? "未配置" };
		}

		function ProjectWidget({ jvm }) {
			const home = homeStateOf(jvm);
			const project = jvm?.project ?? null;
			const name = project?.name ?? jvm?.folder ?? null;
			const cells = [
				["工程", name === null ? { wait: true, text: "待选择" } : { wait: false, text: name }, project?.root],
				["ISV", projectCellOf(home, project, "isv")],
				["账套", projectCellOf(home, project, "account")],
				["用户", projectCellOf(home, project, "user")],
			];
			const body = [
				h(
					"span",
					{ key: "top", className: "cx-proj-top" },
					h("span", { className: "cx-proj-tile", "data-empty": jvm ? undefined : "" }, FOLDER()),
					h("span", { className: "cx-card-title" }, "工程信息"),
					home.askUser ? h("span", { className: "cx-proj-ask" }, "选择账套和用户") : null,
				),
				h(
					"span",
					{ key: "grid", className: "cx-proj-grid" },
					...cells.map(([label, cell, full]) =>
						h(
							"span",
							{ key: label, className: "cx-proj-cell", title: `${label}：${full ?? cell.text}` },
							h("span", { className: "cx-proj-label" }, label),
							h("span", { className: "cx-proj-value", "data-wait": cell.wait ? "" : undefined }, cell.text),
						),
					),
				),
			];
			const props = {
				className: "cx-widget cx-proj",
				"data-stage": home.stage,
				"aria-label": cells.map(([label, cell]) => `${label} ${cell.text}`).join("，"),
			};
			if (!home.askUser) return h("div", props, ...body);
			return h(
				"button",
				{
					...props,
					type: "button",
					title: "选择账套和用户（/cosmic-env）",
					onClick: () => startWith("/cosmic-env"),
				},
				...body,
			);
		}

		/** 标语拆成两截：逗号前是平常的字，逗号后是重点（pi 版首页那一行提示符就这么排）。 */
		const TAGLINE_CUT = PRODUCT_TAGLINE.indexOf("，") + 1;

		/** 首页：品牌卡（方块大字 + 名牌）占一整行，下面并排 JVM 卡和工程卡，再下面一排应用图标。只在首页（空会话）出现。 */
		function HeroMark() {
			ensureStyle();
			const still = React.useMemo(reducedMotion, []);
			const settled = useSettled(still);
			const boot = useBootState();
			const jvm = jvmShared.use();
			const ignite = useIgnite(boot);
			const plate = [
				h("span", { key: "tag", className: "cx-plate-tag" }, PRODUCT_LOGO_TAG),
				h("span", { key: "sub", className: "cx-plate-sub" }, PRODUCT_SUBTITLE),
				h(
					"span",
					{ key: "line", className: "cx-plate-line" },
					h("i", null, "❯"),
					h("span", null, PRODUCT_TAGLINE.slice(0, TAGLINE_CUT)),
					h("b", null, PRODUCT_TAGLINE.slice(TAGLINE_CUT)),
					h("span", { className: "cx-caret" }),
				),
			].map((item, index) => React.cloneElement(item, { style: { "--k": index } }));
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
						{ className: "cx-widget cx-w-brand", title: PRODUCT_LOGO_NAME },
						h(Wordmark, { height: 72 }),
						h("div", { className: "cx-plate" }, ...plate),
					),
					h("div", { className: "cx-row" }, h(JvmWidget, { jvm }), h(ProjectWidget, { jvm })),
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
					setError("连接已重建，上次操作未送达，请重试");
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
						: { tag: "skip", text: "未写入" }
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
										h("small", null, "需求未明确；如需其他做法，点击对应项，将不写入并告知 AI"),
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
					h("span", { className: "cc-state" }, failed ? "失败" : "完成"),
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
					if (!response.ok || typeof value.text !== "string")
						throw new Error(value.error || `引用 ${ref} 解析失败`);
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
