// fast-ai-cosmic 在桌面和网页界面里的样子：和 pi 版终端首页同一套视觉——青绿色阶、等宽字、方块大字、
// 「[ OK ]」方括号状态、树线和「❯」提示符——和 dsh 原版拉开。
// 浏览器端插件，dsh 的模块加载器直接执行这个文件，不经编译，所以写成普通 JS。
// 名字和标语跟 src/brand.ts 一致（test/dsh/brand.test.ts 核对）；配色取自 pi 版 src/agent/ui/palette.ts。
//
// 改样子的三种办法，按稳到不稳排，能用前面的就不用后面的：
//   1. 主题变量（ctx.theme.overrideTokens）：dsh 的颜色、字体、圆角全是变量，深浅两套各给一个值。
//      背景、文字、侧栏、输入框都引用同一条灰阶 neutral-bluish，把这条灰阶整体染成青黑，全界面一起换色调；
//      品牌蓝 deepseek-* 换成青绿色阶，状态色换成 pi 的就绪绿、执行蓝、警告琥珀、失败红。
//   2. 插槽：侧栏标志和名字、首页品牌位（方块大字和名牌）、首页背景、输入框左边的 JVM 小标签。
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

		// ── 配色：和 pi 版首页、底栏同一套（pi 版 palette.ts），深浅两套 ──
		const PALETTES = {
			dark: {
				accent: [138, 190, 183],
				hi: [228, 255, 250],
				glow: [112, 226, 208],
				deep: [32, 60, 57],
				line: [56, 92, 87],
				label: [112, 132, 129],
				ready: [134, 214, 127],
				run: [110, 168, 254],
				warn: [222, 186, 104],
				bad: [226, 112, 100],
			},
			light: {
				accent: [90, 128, 128],
				hi: [20, 64, 60],
				glow: [32, 128, 118],
				deep: [170, 205, 200],
				line: [160, 190, 186],
				label: [108, 122, 120],
				ready: [46, 128, 56],
				run: [38, 96, 196],
				warn: [154, 115, 38],
				bad: [170, 85, 85],
			},
		};
		const rgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(", ")})`;
		const rgba = (c, a) => `rgba(${c.map((v) => Math.round(v)).join(", ")}, ${a})`;
		const pair = (light, dark) => ({ light, dark });
		const same = (value) => ({ light: value, dark: value });
		const L = PALETTES.light;
		const D = PALETTES.dark;

		/**
		 * dsh 的灰阶（design-platform.css 里的原值）染成青灰：明度不动，只加色相。
		 * 亮的那头加一点点、中间几乎不加、最暗那头加得多一点，暗底看上去是终端那种青黑，不是发绿。
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
		const tealGray = (gray) => {
			const light = Math.min(99, (gray / 255) * 100);
			const sat = light >= 96 ? 30 : light >= 80 ? 14 : light >= 45 ? 8 : light >= 20 ? 14 : 24;
			return `hsl(174 ${sat}% ${light.toFixed(1)}%)`;
		};
		/** dsh 的品牌蓝 deepseek-* 换成青绿色阶：400 是 pi 的亮青、500 是浅色主题的亮青、800 是 pi 的深青。 */
		const TEAL_SCALE = {
			50: [234, 247, 245],
			100: [214, 240, 236],
			200: [188, 230, 224],
			300: [150, 215, 206],
			400: D.glow,
			450: [72, 190, 174],
			500: L.glow,
			600: [28, 108, 100],
			"700-delete": [24, 88, 82],
			800: D.deep,
			900: [24, 44, 42],
		};
		/**
		 * 正文、代码都用等宽字：pi 版是终端，整屏一种字。中文落到雅黑 / 苹方。
		 * 改的是 dsh 的「内置字体」那一层，用户在设置里自己选的字体照样排在前面。
		 */
		const MONO =
			"'JetBrains Mono', 'Cascadia Mono', 'Cascadia Code', 'SF Mono', Consolas, Menlo, " +
			"'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif";

		const TOKENS = {};
		// 我们自己的几样颜色也走主题变量：深浅切换时 dsh 一并换，样式表里直接 var(--cosmic-*)。
		for (const key of Object.keys(D)) TOKENS[`--cosmic-${key}`] = pair(rgb(L[key]), rgb(D[key]));
		for (const [scale, steps] of Object.entries(GRAY_SCALES))
			for (const [step, gray] of Object.entries(steps))
				TOKENS[`--dsw-static-${scale}-${step}`] = same(tealGray(gray));
		for (const [step, color] of Object.entries(TEAL_SCALE))
			TOKENS[`--dsw-static-deepseek-${step}`] = same(rgb(color));
		Object.assign(TOKENS, {
			"--dsh-font-family-text-default": same(MONO),
			"--dsh-font-family-code-default": same(MONO),
			"--dsw-font-family-brand": same(MONO),
			// 终端是方的：圆角收到 dsh 原版的三分之一左右
			"--dsw-radius-xs": same("2px"),
			"--dsw-radius-sm": same("3px"),
			"--dsw-radius-md": same("5px"),
			"--dsw-radius-lg": same("6px"),
			"--dsw-radius-xl": same("8px"),
			"--dsw-radius-panel": same("10px"),
			"--dsw-alias-brand-primary": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-button-primary-hover": pair(rgb([26, 104, 96]), rgb([150, 236, 222])),
			"--dsw-alias-state-business-primary": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-state-business-tertiary": pair(rgb([222, 240, 237]), rgb(D.deep)),
			"--dsw-alias-state-success-primary": pair(rgb(L.ready), rgb(D.ready)),
			"--dsw-alias-state-warn-primary": pair(rgb(L.warn), rgb(D.warn)),
			"--dsw-alias-state-error-primary": pair(rgb(L.bad), rgb(D.bad)),
			"--dsw-alias-link": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-alias-button-info-fill": pair(rgb(L.glow), rgb([64, 150, 140])),
			"--dsw-alias-button-info-hover": pair(rgb([58, 150, 140]), rgb(D.glow)),
			"--dsw-alias-toast-action": pair(rgb(L.glow), rgb(D.glow)),
			"--dsw-specific-sidebar-nav-item-active-accent": pair(rgb([222, 240, 237]), rgb(D.deep)),
			"--dsw-focus-ring-color": pair(rgb(L.glow), rgb(D.glow)),
			// 分隔线、悬停底色原来是纯黑 / 纯白的透明度，换成青色的：线条读起来是 pi 那种青线
			"--dsw-alias-border-l1": pair(rgba(L.hi, 0.07), rgba(D.glow, 0.08)),
			"--dsw-alias-border-l2": pair(rgba(L.hi, 0.13), rgba(D.glow, 0.14)),
			"--dsw-alias-border-l2-darkmode-thin": pair(rgba(L.hi, 0.12), rgba(D.glow, 0.09)),
			"--dsw-alias-border-l3": pair(rgba(L.hi, 0.17), rgba(D.glow, 0.19)),
			"--dsw-alias-border-l4": pair(rgba(L.hi, 0.22), rgba(D.glow, 0.25)),
			"--dsw-alias-interactive-bg-hover": pair(rgba(L.glow, 0.07), rgba(D.glow, 0.08)),
			"--dsw-alias-interactive-bg-active": pair(rgba(L.glow, 0.12), rgba(D.glow, 0.14)),
			"--dsw-alias-interactive-bg-hover-accent": pair(rgba(L.glow, 0.16), rgba(D.glow, 0.22)),
			"--dsw-alias-bg-document-selection": pair(rgba(L.glow, 0.25), rgba(D.glow, 0.3)),
		});
		const C = (key) => `var(--cosmic-${key})`;
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

		/** 侧栏标志：一个方框里的提示符和光标，和 pi 版输入框前的「❯」同一个意思。 */
		function Mark({ size = 24 }) {
			return h(
				"svg",
				{ viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": true, style: { display: "block" } },
				h("rect", {
					x: 2,
					y: 3,
					width: 20,
					height: 18,
					rx: 2.5,
					fill: tint(C("glow"), 12),
					stroke: C("glow"),
					strokeWidth: 1.6,
				}),
				h("path", {
					d: "M7 9l3.5 3L7 15",
					fill: "none",
					stroke: C("glow"),
					strokeWidth: 2,
					strokeLinecap: "square",
				}),
				h("rect", { x: 12.5, y: 13.6, width: 5, height: 1.8, fill: C("hi") }),
			);
		}

		/** 侧栏名字：方块大字缩成一行——COSMIC 粗体，小字标拉开字距跟在后面。 */
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
		// 进到一个开发会话就发一次 ensure：宿主这时认工程、在后台起 JVM；之后照下面的节奏问状态。
		// 排障会话宿主答 tracked=false，这里什么都不画。
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
		// 状态色和 pi 版底栏一样：就绪绿、执行蓝、准备中亮青、警告琥珀、失败红、闲着灰青
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
		function jvmChip(view) {
			const boot = view.boot;
			const live = view.live;
			const name = view.project?.name;
			if (boot && !boot.done) {
				const step = boot.steps.find((one) => one.state === "run");
				return { tone: "busy", text: `苍穹 JVM ${step ? step.label : "准备中"}… ${span(boot.seconds)}` };
			}
			if (boot?.phase === "no-project") return { tone: "idle", text: "不是苍穹工程" };
			if (boot?.phase === "config") return { tone: "warn", text: "苍穹工程配置不全" };
			if (!live) {
				if (boot?.phase === "failed") return { tone: "bad", text: "苍穹 JVM 没起成" };
				return { tone: "idle", text: "苍穹 JVM" };
			}
			const since = live.startedAt ? ` · ${clockShort(live.startedAt)} 起` : "";
			switch (live.kind) {
				case "ready":
				case "pending-sync":
					return boot?.phase === "degraded"
						? { tone: "warn", text: `苍穹 JVM 已起，环境有问题${since}` }
						: { tone: "ok", text: `本地苍穹 就绪 · ${name}${since}` };
				case "executing":
					return { tone: "run", text: `本地苍穹 执行中 · ${name}${since}` };
				case "starting":
				case "warming":
				case "syncing":
				case "restarting":
				case "stopping":
				case "checking":
					return { tone: "busy", text: `苍穹 JVM ${LIVE_TEXT[live.kind]}…` };
				case "stopped":
					if (boot?.phase === "failed") return { tone: "bad", text: "苍穹 JVM 没起成" };
					if (boot?.phase === "not-built") return { tone: "warn", text: "工程还没构建，JVM 没起" };
					return { tone: "idle", text: "苍穹 JVM 没在跑" };
				default:
					return { tone: "warn", text: `苍穹 JVM ${LIVE_TEXT[live.kind] ?? live.kind}` };
			}
		}

		// ── 开机状态：JVM 小标签（会话里）报给首页大字（首页拿不到会话）──
		// 和 pi 版首页同一个意思：loading 开机还在走，大字暗着呼吸；ready 全部就绪，点火、名牌写「就绪」；
		// down 没就绪也不在走（失败、环境异常、没在跑），暗着不动；null 不是苍穹会话，大字照常亮着。
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
		const bootListeners = new Set();
		let bootValue = null;
		function publishBoot(value) {
			if (value === bootValue) return;
			bootValue = value;
			for (const listener of bootListeners) listener(value);
		}
		function useBootState() {
			const [value, setValue] = React.useState(bootValue);
			React.useEffect(() => {
				bootListeners.add(setValue);
				setValue(bootValue);
				return () => {
					bootListeners.delete(setValue);
				};
			}, []);
			return value;
		}

		// ── 样式表：挂在 <head> 上一份，类名带 cx- / cjvm- 前缀 ──
		const LINE = "var(--dsw-alias-border-l2)";
		const LAYER = "var(--dsw-alias-bg-layer-2)";
		const LABEL2 = "var(--dsw-alias-label-secondary)";
		const LABEL3 = "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))";
		const HOVER = "var(--dsw-alias-interactive-bg-hover)";
		const MONO_FONT = "var(--ds-font-family-code)";
		const COSMIC_CSS = `
::selection { background: ${tint(C("glow"), 30)}; }

/* ── dsh 自己的几处：只挂在它写死的 data-* 属性上 ── */
/* 输入框：方的、平的，左边一道亮青的竖线，像 pi 版输入框前那根「│」；打字时边框亮起来 */
html body [data-composer-card] {
  box-shadow: none;
  border: 1px solid ${LINE};
  background-image: linear-gradient(90deg, ${C("glow")} 0 2px, transparent 2px);
}
html body [data-composer-card]:focus-within { border-color: ${tint(C("glow"), 55)}; }
/* 用户发的话：左边一道青线，底色淡青 */
html body [data-message-bubble] {
  border-left: 2px solid ${C("glow")};
  background: ${tint(C("glow"), 8)};
}

/* 首页：品牌位里是我们的名牌时，名牌独占一行，dsh 那行标题藏起来（名牌里写着副标题） */
div:has(> span [data-cosmic-hero]) { flex-direction: column; row-gap: 0; }
div:has(> span [data-cosmic-hero]) > span:not(:has([data-cosmic-hero])) { display: none; }

/* ── 侧栏名字 ── */
.cx-name { display: inline-flex; align-items: baseline; gap: 8px; font-family: ${MONO_FONT}; white-space: nowrap; }
.cx-name > b { font-weight: 700; letter-spacing: 0.08em; color: var(--dsw-alias-label-primary); }
.cx-name > small { font-size: 10px; letter-spacing: 0.12em; color: ${C("glow")}; }

/* ── 首页名牌：方块大字 + 名牌 + 装饰代码，左边一根竖线 ── */
@keyframes cx-breath { 0%, 100% { color: color-mix(in srgb, ${C("accent")} 20%, ${C("deep")}); }
  50% { color: color-mix(in srgb, ${C("accent")} 62%, ${C("deep")}); } }
@keyframes cx-ignite { 0% { color: color-mix(in srgb, ${C("accent")} 36%, ${C("deep")}); }
  1% { color: ${C("hi")}; text-shadow: 0 0 8px ${tint(C("glow"), 70)}; } 100% { color: ${C("accent")}; text-shadow: none; } }
@keyframes cx-ignite-shade { 0% { color: ${C("deep")}; } 1% { color: ${C("glow")}; } 100% { color: ${C("label")}; } }
@keyframes cx-reveal { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
@keyframes cx-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes cx-beam { 0% { left: -6ch; opacity: 1; } 16% { left: 100%; opacity: 1; } 16.5%, 100% { left: 100%; opacity: 0; } }
.cx-hero { position: relative; display: flex; align-items: center; gap: 28px; padding: 14px 4px 18px 18px;
  border-left: 1px solid ${C("line")}; font-family: ${MONO_FONT}; color: var(--dsw-alias-label-primary);
  text-align: left; user-select: none; }
.cx-logo { display: block; flex: none; overflow: visible; color: ${C("accent")}; }
.cx-logo .s { fill: currentColor; color: ${C("accent")}; shape-rendering: crispEdges; }
.cx-logo .d { fill: none; stroke: currentColor; stroke-width: 1; color: ${C("label")}; }
.cx-logo .n { fill: currentColor; font-family: ${MONO_FONT}; font-size: 12px; color: color-mix(in srgb, ${C("glow")} 45%, ${C("deep")}); }
.cx-logo[data-boot="loading"] .s { animation: cx-breath 2.6s ease-in-out infinite; animation-delay: calc(var(--x) * 20ms - 2.6s); }
.cx-logo[data-boot="loading"] .d, .cx-logo[data-boot="down"] .d { color: ${C("deep")}; }
.cx-logo[data-boot="down"] .s { color: color-mix(in srgb, ${C("accent")} 36%, ${C("deep")}); }
.cx-logo[data-ignite] .s { animation: cx-ignite 0.45s ease-out both; animation-delay: calc(var(--x) * 14ms); }
.cx-logo[data-ignite] .d { animation: cx-ignite-shade 0.9s ease-out both; animation-delay: calc(var(--x) * 14ms); }
.cx-plate { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 13px; line-height: 18px; }
.cx-plate > * { animation: cx-reveal 0.4s ease-out both; }
.cx-plate > :nth-child(2) { animation-delay: 0.08s; }
.cx-plate > :nth-child(3) { animation-delay: 0.16s; }
.cx-plate > :nth-child(4) { animation-delay: 0.24s; }
.cx-tag { font-weight: 700; letter-spacing: 0.04em; color: ${C("accent")}; white-space: nowrap; }
.cx-sub { color: var(--dsw-alias-label-primary); white-space: nowrap; }
.cx-status { min-height: 18px; white-space: nowrap; color: ${LABEL2}; }
.cx-status > b { color: ${C("ready")}; font-weight: 700; }
.cx-tagline { white-space: nowrap; color: var(--dsw-alias-label-primary); }
.cx-tagline > i { font-style: normal; font-weight: 700; color: ${C("accent")}; }
.cx-tagline > b { font-weight: 700; color: ${C("hi")}; }
.cx-cursor { display: inline-block; margin-left: 1px; color: ${C("glow")}; animation: cx-blink 1.06s step-end 4; animation-fill-mode: forwards; }
.cx-code { margin: 0; padding-left: 10px; border-left: 1px solid ${C("line")}; font-family: ${MONO_FONT}; font-size: 11.5px;
  line-height: 15px; white-space: pre; color: color-mix(in srgb, ${C("accent")} 80%, ${C("deep")}); }
.cx-code-line { position: relative; overflow: hidden; }
.cx-code-line::after { content: ""; position: absolute; top: 0; bottom: 0; width: 6ch; left: -6ch; opacity: 0; pointer-events: none;
  background: linear-gradient(90deg, transparent, ${tint(C("glow"), 22)}, transparent);
  animation: cx-beam 4.32s linear infinite; animation-delay: calc(var(--i) * 0.72s); }
.cx-code .k { color: ${C("glow")}; }
.cx-code .c { color: ${C("line")}; }
@media (max-width: 1180px) { .cx-code { display: none; } }
@media (max-width: 760px) { .cx-hero { flex-direction: column; align-items: flex-start; gap: 12px; } .cx-logo { width: 240px; height: auto; } }
@media (prefers-reduced-motion: reduce) {
  .cx-logo .s, .cx-logo .d, .cx-plate > *, .cx-cursor, .cx-code-line::after { animation: none !important; }
}
/* 首页背景：淡淡一层点阵，靠上居中、往外渐隐，像终端的底 */
.cx-backdrop { position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: radial-gradient(${tint(C("glow"), 22)} 1px, transparent 1.2px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse 60% 55% at 50% 38%, #000 0%, transparent 75%);
  mask-image: radial-gradient(ellipse 60% 55% at 50% 38%, #000 0%, transparent 75%); }

/* ── 方括号状态标签：[ OK ] [ ⠹⠼ ] [WARN] [FAIL] [ -- ]，和 pi 版首页、底栏同一种话 ── */
.cx-tag6 { display: inline-flex; flex: none; font-family: ${MONO_FONT}; white-space: pre; font-weight: 700; color: var(--cx-tone); }
.cx-tag6 > i { font-style: normal; font-weight: 400; color: ${C("line")}; }
.cx-tag6 > span { display: inline-block; width: 4ch; text-align: center; }

/* ── JVM 小标签和详情面板 ── */
.cjvm-chip { display: inline-flex; align-items: center; gap: 7px; max-width: 360px; height: 26px; padding: 0 10px 0 8px;
  border-radius: var(--dsw-radius-sm); border: 1px solid ${LINE}; background: ${tint("var(--cx-tone)", 6)};
  color: ${LABEL2}; font-family: ${MONO_FONT}; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
  transition: background-color .15s, border-color .15s, color .15s; }
.cjvm-chip:hover, .cjvm-chip[aria-expanded="true"] { background: ${tint("var(--cx-tone)", 14)};
  border-color: ${tint("var(--cx-tone)", 45)}; color: var(--dsw-alias-label-primary); }
.cjvm-chip-text { overflow: hidden; text-overflow: ellipsis; }
.cjvm-panel { z-index: 1000; width: min(460px, calc(100vw - 16px)); max-height: min(74vh, 640px); overflow-y: auto;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none); --dsw-elevation-stroke-color: ${LINE};
  box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, 0.28)); border-left: 2px solid var(--cx-tone);
  color: var(--dsw-alias-label-primary); font-family: ${MONO_FONT}; font-size: 12.5px; line-height: 18px; cursor: default; }
.cjvm-head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 4px 14px; }
.cjvm-brand { font-weight: 700; letter-spacing: 0.04em; color: ${C("accent")}; white-space: nowrap; }
.cjvm-rule { flex: 1; min-width: 16px; height: 1px; background: ${C("line")}; }
.cjvm-state { white-space: nowrap; color: var(--cx-tone); font-weight: 700; }
.cjvm-close { flex: none; width: 24px; height: 24px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: ${LABEL2}; cursor: pointer; display: grid; place-items: center; }
.cjvm-close:hover { background: ${HOVER}; color: var(--dsw-alias-label-primary); }
.cjvm-sub { padding: 0 14px 10px; font-size: 12px; color: ${LABEL2}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjvm-sub > b { color: var(--dsw-alias-label-primary); font-weight: 500; }
.cjvm-section { display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; border-top: 1px dashed ${LINE}; }
.cjvm-section-title { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: ${C("accent")}; font-weight: 700; }
.cjvm-section-title > small { font-size: 11.5px; font-weight: 400; color: ${LABEL3}; }
.cjvm-stats { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; }
.cjvm-stats > span { color: ${LABEL3}; white-space: nowrap; }
.cjvm-stats > span > b { margin-left: 6px; color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.cjvm-tree { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cjvm-row { display: flex; align-items: baseline; gap: 8px; min-height: 22px; font-size: 12px; }
.cjvm-branch { flex: none; color: ${C("line")}; white-space: pre; }
.cjvm-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjvm-row[data-state="wait"] .cjvm-row-label, .cjvm-row[data-state="skip"] .cjvm-row-label { color: ${LABEL3}; }
.cjvm-row[data-state="run"] .cjvm-row-label { color: ${C("glow")}; }
.cjvm-row[data-state="fail"] .cjvm-row-label { color: ${C("bad")}; font-weight: 700; }
.cjvm-row-label > small { margin-left: 8px; font-size: 11.5px; color: ${LABEL3}; }
.cjvm-row-time { flex: none; color: ${LABEL3}; font-variant-numeric: tabular-nums; }
.cjvm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 0; font-size: 12px; }
.cjvm-kv dt { color: ${LABEL3}; white-space: nowrap; }
.cjvm-kv dt::before { content: "├─ "; color: ${C("line")}; }
.cjvm-kv dt:last-of-type::before { content: "└─ "; }
.cjvm-kv dd { margin: 0; min-width: 0; word-break: break-all; }
.cjvm-bar { height: 3px; overflow: hidden; background: ${LAYER}; }
.cjvm-bar > span { display: block; height: 100%; background: ${C("glow")}; transition: width .4s ease; }
.cjvm-alert { padding: 6px 10px; border-left: 2px solid var(--cx-tone); background: ${tint("var(--cx-tone)", 9)};
  font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.cjvm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px dashed ${LINE}; }
.cjvm-actions > .cjvm-note { flex: 1 1 100%; }
.cjvm-btn { height: 26px; padding: 0 12px; border-radius: var(--dsw-radius-sm); border: 1px solid ${LINE}; background: transparent;
  color: var(--dsw-alias-label-primary); font-family: ${MONO_FONT}; font-size: 12px; cursor: pointer;
  transition: background-color .15s, color .15s, border-color .15s; }
.cjvm-btn::before { content: "["; margin-right: 6px; color: ${C("line")}; }
.cjvm-btn::after { content: "]"; margin-left: 6px; color: ${C("line")}; }
.cjvm-btn:hover:not(:disabled) { background: ${HOVER}; border-color: ${tint(C("glow"), 40)}; }
.cjvm-btn[data-kind="primary"] { border-color: ${tint(C("glow"), 55)}; color: ${C("glow")}; font-weight: 700; }
.cjvm-btn[data-kind="danger"]:hover:not(:disabled) { color: ${C("bad")}; border-color: ${tint(C("bad"), 45)}; background: ${tint(C("bad"), 8)}; }
.cjvm-btn[data-size="sm"] { height: 22px; padding: 0 8px; font-size: 11.5px; }
.cjvm-btn[data-size="sm"]::before, .cjvm-btn[data-size="sm"]::after { content: none; }
.cjvm-btn:disabled { opacity: .45; cursor: default; }
.cjvm-procs { display: flex; flex-direction: column; gap: 4px; }
.cjvm-proc { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid transparent; background: ${LAYER}; }
.cjvm-proc[data-mine] { border-color: ${tint(C("glow"), 35)}; background: ${tint(C("glow"), 6)}; }
.cjvm-proc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cjvm-proc-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
.cjvm-proc-name > b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjvm-mine { flex: none; padding: 0 5px; font-size: 10.5px; line-height: 16px; color: ${C("glow")}; border: 1px solid ${tint(C("glow"), 45)}; }
.cjvm-proc-meta { display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 11.5px; color: ${LABEL2}; font-variant-numeric: tabular-nums; }
.cjvm-note { margin: 0; font-size: 11.5px; color: ${LABEL3}; }

/* ── 写元数据确认卡片：占输入框那一栏，宽度跟对话一致 ── */
.cw-root { display: flex; flex-direction: column; align-items: center;
  padding: 8px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 12px; }
.cw-card { width: 100%; max-width: var(--dsh-chat-content-width, 820px); overflow: hidden;
  border: 1px solid ${LINE}; border-left: 2px solid ${C("warn")}; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary); font-family: ${MONO_FONT}; font-size: 12.5px; line-height: 19px; }
.cw-strip { display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px;
  background: ${tint(C("warn"), 9)}; border-bottom: 1px solid ${tint(C("warn"), 22)}; }
.cw-strip-title { white-space: nowrap; color: ${LABEL2}; }
.cw-strip-title > b { color: ${C("warn")}; font-weight: 700; letter-spacing: 0.04em; }
.cw-strip-rule { flex: 1; min-width: 12px; height: 1px; background: ${tint(C("warn"), 28)}; }
.cw-strip-state { white-space: nowrap; font-size: 12px; color: ${LABEL2}; }
.cw-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 12px 14px;
  max-height: min(56vh, 480px); overflow-y: auto; outline: none; }
/* 正文限高后整体滚动，里面的块不许被压扁（表格会被压得只剩表头） */
.cw-body > * { flex-shrink: 0; }
.cw-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.cw-title > b { font-size: 15px; font-weight: 700; color: var(--dsw-alias-label-primary); font-family: var(--dsh-font-family-text-default, inherit); }
.cw-purpose { display: flex; gap: 8px; margin: -4px 0 0; color: var(--dsw-alias-label-primary); }
.cw-purpose > i { font-style: normal; font-weight: 700; color: ${C("glow")}; }
.cw-code { display: inline; padding: 0 4px; border-radius: var(--dsw-radius-xs); background: ${LAYER};
  font-family: ${MONO_FONT}; font-size: 12px; color: ${LABEL2}; word-break: break-all; }
.cw-code > i { font-style: normal; color: ${LABEL3}; }
.cw-code > b { font-weight: 600; color: var(--dsw-alias-label-primary); }
.cw-scope { flex: none; padding: 0 5px; border: 1px solid ${LINE}; font-size: 10.5px; line-height: 16px; color: ${LABEL3}; white-space: nowrap; }
.cw-head { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 12px; }
.cw-head dt { color: ${LABEL3}; }
.cw-head dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.cw-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding-top: 8px; border-top: 1px dashed ${LINE}; }
.cw-summary > b { color: ${C("accent")}; font-weight: 700; }
.cw-count { padding: 0 6px; font-size: 11.5px; line-height: 18px; font-weight: 700; color: var(--cx-tone);
  background: ${tint("var(--cx-tone)", 12)}; border: 1px solid ${tint("var(--cx-tone)", 35)}; }
/* 改动清单：一行一处，左边色标，整行淡淡的底色 */
.cw-diff { display: grid; grid-template-columns: 2ch minmax(0, max-content) minmax(0, 1fr); column-gap: 12px; margin-top: -4px; }
.cw-row { display: contents; }
.cw-row > * { padding: 5px 0; border-bottom: 1px solid ${tint(C("line"), 40)}; min-width: 0; }
.cw-row:last-child > * { border-bottom: 0; }
.cw-mark { display: grid; place-items: start center; font-weight: 700; color: var(--cx-tone);
  background: linear-gradient(90deg, var(--cx-tone) 0 2px, ${tint("var(--cx-tone)", 12)} 2px); }
.cw-target { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.cw-key { display: inline-flex; align-items: baseline; gap: 5px; color: ${LABEL2}; }
.cw-key-main { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cw-key-main > .cw-code { color: var(--dsw-alias-label-primary); }
.cw-ditto { padding-left: 1ch; color: ${C("line")}; }
.cw-value { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; word-break: break-word; }
.cw-old { color: ${LABEL3}; text-decoration-color: ${tint(C("bad"), 70)}; }
.cw-old .cw-code { color: ${LABEL3}; }
.cw-row[data-op="remove"] .cw-old { color: ${C("bad")}; }
.cw-new { color: ${C("ready")}; font-weight: 600; }
.cw-row[data-op="set"] .cw-new { color: ${C("run")}; }
.cw-new .cw-code { background: ${tint("var(--cx-tone)", 12)}; color: inherit; }
.cw-new .cw-code > b, .cw-new .cw-code > i { color: inherit; }
.cw-same { color: ${LABEL3}; }
.cw-arrow { color: ${C("warn")}; font-weight: 700; }
.cw-grid-wrap { overflow-x: auto; margin-top: -4px; }
.cw-grid { width: 100%; border-collapse: collapse; font-size: 12px; }
.cw-grid th { padding: 4px 10px 4px 0; text-align: left; font-weight: 400; color: ${LABEL3}; border-bottom: 1px solid ${LINE}; white-space: nowrap; }
.cw-grid td { padding: 4px 10px 4px 0; vertical-align: top; border-bottom: 1px solid ${tint(C("line"), 40)}; word-break: break-word; }
.cw-grid tr:not([data-ditto]) td { border-top: 1px solid ${tint(C("line"), 60)}; }
.cw-grid tbody tr:first-child td { border-top: 0; }
.cw-grid td:first-child { white-space: nowrap; }
.cw-note { display: flex; gap: 10px; margin: 0; padding: 6px 10px; border-left: 2px solid ${C("warn")}; background: ${tint(C("warn"), 9)}; }
.cw-note > b { flex: none; color: ${C("warn")}; }
.cw-decisions { display: flex; flex-direction: column; gap: 6px; }
.cw-section-title { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-weight: 700; color: ${C("accent")}; }
.cw-section-title > small { font-size: 11.5px; font-weight: 400; color: ${LABEL3}; }
.cw-decision { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-choice { display: inline-flex; gap: 6px; align-items: baseline; padding: 2px 10px; border: 1px solid ${LINE};
  background: transparent; color: ${LABEL2}; font: inherit; text-align: left; }
.cw-choice > i { font-style: normal; color: ${LABEL3}; }
.cw-choice[data-picked] { border-color: ${tint(C("glow"), 50)}; background: ${tint(C("glow"), 9)}; color: var(--dsw-alias-label-primary); }
.cw-choice[data-picked] > i { color: ${C("glow")}; }
button.cw-choice { cursor: pointer; }
button.cw-choice:hover:not(:disabled) { border-color: ${tint(C("warn"), 50)}; color: var(--dsw-alias-label-primary); }
.cw-facts { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 0; padding-top: 8px;
  border-top: 1px dashed ${LINE}; font-size: 12px; color: ${LABEL2}; }
.cw-facts dt { color: ${LABEL3}; white-space: nowrap; }
.cw-facts dt::before { content: "├─ "; color: ${C("line")}; }
.cw-facts dt:last-of-type::before { content: "└─ "; }
.cw-facts dd { margin: 0; min-width: 0; word-break: break-word; display: flex; flex-direction: column; gap: 1px; }
.cw-scope-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.cw-scope-list > li { display: flex; flex-wrap: wrap; gap: 4px; }
.cw-link { padding: 0; border: 0; background: none; font: inherit; color: ${C("accent")}; cursor: pointer; text-align: left; }
.cw-link:hover:not(:disabled) { color: ${C("glow")}; text-decoration: underline; }
.cw-link:disabled { opacity: .5; cursor: default; }
.cw-said { display: flex; gap: 10px; margin: 0; padding: 8px 16px; border-top: 1px dashed ${LINE}; }
.cw-said > b { color: ${LABEL3}; font-weight: 400; }
.cw-input { display: block; box-sizing: border-box; width: calc(100% - 28px); margin: 0 14px 4px; padding: 6px 10px; resize: vertical;
  border: 1px solid ${LINE}; border-radius: var(--dsw-radius-sm); background: ${LAYER}; color: var(--dsw-alias-label-primary);
  font: inherit; outline: none; }
.cw-input:focus { border-color: ${tint(C("glow"), 55)}; }
.cw-error { margin: 0; padding: 4px 16px; color: ${C("bad")}; font-size: 12px; }
.cw-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 9px 12px 9px 14px; border-top: 1px solid ${LINE}; background: ${LAYER}; }
.cw-actions-gap { flex: 1; }
.cjvm-btn.cw-approve { height: 30px; padding: 0 16px; background: ${tint(C("glow"), 14)}; }
.cjvm-btn.cw-approve:hover:not(:disabled) { background: ${tint(C("glow"), 24)}; }
.cw-actions > .cjvm-btn { height: 30px; }
@media (max-width: 640px) { .cw-strip-state { display: none; } .cw-diff { grid-template-columns: 2ch minmax(0, 1fr); }
  .cw-value { grid-column: 2; padding-top: 0; } .cw-row > .cw-target { border-bottom: 0; } }
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

		// ── 方括号状态标签 ──
		const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		/** 两格转圈（同一套帧错开三格并排），80 毫秒一帧，和 pi 版一个节奏。 */
		function Spinner() {
			const [frame, setFrame] = React.useState(0);
			React.useEffect(() => {
				const timer = setInterval(() => setFrame((n) => (n + 1) % SPINNER.length), 80);
				return () => clearInterval(timer);
			}, []);
			return `${SPINNER[frame]}${SPINNER[(frame + 3) % SPINNER.length]}`;
		}
		const TAG = {
			ok: { text: "OK", color: TONE.ok },
			run: { spin: true, color: TONE.run },
			busy: { spin: true, color: TONE.busy },
			warn: { text: "WARN", color: TONE.warn },
			bad: { text: "FAIL", color: TONE.bad },
			fail: { text: "FAIL", color: TONE.bad },
			skip: { text: "--", color: TONE.idle },
			idle: { text: "--", color: TONE.idle },
			wait: { text: "", color: TONE.idle },
			ask: { text: "WAIT", color: TONE.warn },
		};
		function Tag({ kind }) {
			const tag = TAG[kind] ?? TAG.idle;
			return h(
				"span",
				{ className: "cx-tag6", style: tone(tag.color), "aria-hidden": true },
				h("i", null, "["),
				h("span", null, tag.spin ? h(Spinner) : tag.text),
				h("i", null, "]"),
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
		 * 详情面板，照 pi 版输入框上方那棵开机树排：
		 *   FAST-AI-COSMIC ───────────── 就绪
		 *   ├─ [ OK ] 认工程                 3 秒
		 *   └─ [ ⠹⠼ ] 启动苍穹 JVM            6 秒
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
						...boot.steps.map((step, index) =>
							h(
								"li",
								{ key: step.key, className: "cjvm-row", "data-state": step.state },
								h("span", { className: "cjvm-branch" }, index === boot.steps.length - 1 ? "└─" : "├─"),
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

		function JvmChip({ sessionId }) {
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

			// 首页大字跟着这里的开机状态走；小标签卸掉（离开会话）就不再报
			React.useEffect(() => {
				publishBoot(bootStateOf(view));
			}, [view]);
			React.useEffect(() => () => publishBoot(null), []);

			const moving =
				view != null &&
				((view.boot && !view.boot.done) ||
					(view.live &&
						["starting", "warming", "syncing", "restarting", "stopping", "executing"].includes(view.live.kind)));
			React.useEffect(() => {
				void refresh(open);
				// 启动中一秒问一次；没登记上的：头半分钟两秒（会话刚建、宿主还没登记完），之后 15 秒（排障会话一直不登记）；
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
						title: "苍穹 JVM：点开看详情",
						style: tone(TONE[chip.tone]),
						onMouseDown: (event) => event.stopPropagation(),
						onClick: () => {
							setOpen((was) => !was);
							setMessage(null);
						},
					},
					h(Tag, { kind: chip.tone }),
					h("span", { className: "cjvm-chip-text" }, chip.text),
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

		// ── 首页名牌：照 pi 版首页（src/agent/ui/banner.ts）──
		//
		//   │  ██████╗ ██████╗ ███████╗███╗   ███╗██╗ ██████╗     F A S T · A I
		//   │ ██╔════╝██╔═══██╗██╔════╝████╗ ████║██║██╔════╝     金蝶云·苍穹开发智能体
		//   │ ██║     ██║   ██║███████╗██╔████╔██║██║██║          ● 就绪 · 开发 / 探查 / 排查
		//   │ ...                                                ❯ 构建，在真实环境中验证▌
		//
		// 开场：每一格先是乱跳的字符，从左往右一格格锁定成真字，锁定那一下闪白再退回本色；
		// 之后每隔三秒左右有一行的一小段闪成乱码、错开一格，0.15 秒复原。
		// 跟着开机走：开机还在走时大字暗着呼吸；全部就绪那一刻一道光从左扫到右，「● 就绪」跟着亮出来；
		// 没就绪也不在走就暗着不动。亮着只有一个意思——可以开工了。开机进度只在 JVM 小标签里报。
		const GLYPHS = {
			C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
			O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
			S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
			M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
			I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
		};
		const LOGO = Array.from({ length: 6 }, (_unused, row) =>
			[...PRODUCT_LOGO_MARK.toUpperCase()].map((char) => GLYPHS[char]?.[row] ?? " ").join(""),
		);
		const LOGO_WIDTH = Math.max(...LOGO.map((line) => [...line].length));
		const NOISE = "01<>/\\|=+*#%$&?!ABCDEF░▒▓";
		const DECODE_BASE_MS = 260;
		const JITTER_MS = 300;
		const FLASH_MS = 320;
		const APPEAR_MS = 260;
		const INTRO_MS = DECODE_BASE_MS + LOGO_WIDTH * 10 + JITTER_MS + FLASH_MS;
		const IGNITE_MS = 650 + 900;
		const READY_NOTE = " · 开发 / 探查 / 排查";
		const CODE = [
			[["c", "// FAST · AI"]],
			[
				["k", "class"],
				["", " Cosmic {"],
			],
			[
				["", "  "],
				["k", "void"],
				["", " build() {"],
			],
			[["", "    verify();"]],
			[["", "  }"]],
			[["", "}"]],
		];

		function hash(a, b, c) {
			let value =
				Math.imul(a | 0, 0x27d4eb2d) ^
				Math.imul((b | 0) + 0x165667b1, 0x85ebca6b) ^
				Math.imul((c | 0) + 0x7f4a7c15, 0xc2b2ae35);
			value ^= value >>> 15;
			value = Math.imul(value, 0x2c1b3c6d);
			value ^= value >>> 12;
			value = Math.imul(value, 0x297a2d39);
			value ^= value >>> 15;
			return (value >>> 0) / 4294967296;
		}
		const lockAt = (x, y) => DECODE_BASE_MS + x * 10 + hash(x, y, 2) * JITTER_MS;
		const noiseAt = (x, y, t) => NOISE[Math.floor(hash(x, y, Math.floor(t / 60) + 7) * NOISE.length)];
		const reducedMotion = () =>
			typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

		/** 开场解码的时钟：从挂上起数毫秒，放完就停，不再每帧重画。 */
		function useIntroClock(skip) {
			const [t, setT] = React.useState(skip ? INTRO_MS : 0);
			React.useEffect(() => {
				if (skip) return;
				let frame = 0;
				const start = performance.now();
				const tick = (at) => {
					const elapsed = at - start;
					setT(Math.min(elapsed, INTRO_MS));
					if (elapsed < INTRO_MS) frame = requestAnimationFrame(tick);
				};
				frame = requestAnimationFrame(tick);
				return () => cancelAnimationFrame(frame);
			}, [skip]);
			return t;
		}

		/** 故障闪一下：开场放完以后，每隔 2.2～3.8 秒挑一行，错开一格、一小段换成乱码，0.15 秒复原。 */
		function useGlitch(active) {
			const [glitch, setGlitch] = React.useState(null);
			React.useEffect(() => {
				if (!active) return;
				let timer = 0;
				let n = 0;
				const schedule = () => {
					timer = setTimeout(
						() => {
							n += 1;
							setGlitch({
								row: Math.floor(hash(n, 1, 3) * LOGO.length),
								from: 1 + Math.floor(hash(n, 2, 3) * (LOGO_WIDTH - 10)),
								length: 4 + Math.floor(hash(n, 3, 3) * 7),
								shift: hash(n, 4, 3) < 0.5 ? -1 : 1,
								seed: n,
							});
							timer = setTimeout(() => {
								setGlitch(null);
								schedule();
							}, 150);
						},
						2200 + hash(n, 9, 9) * 1600,
					);
				};
				schedule();
				return () => clearTimeout(timer);
			}, [active]);
			return glitch;
		}

		/** 就绪那一刻点火：只在亲眼看着它从「开机还在走」变成「就绪」时放，进来时已经就绪就不放。 */
		function useIgnite(boot) {
			const previous = React.useRef(boot);
			const [ignite, setIgnite] = React.useState(0);
			React.useEffect(() => {
				if (previous.current === "loading" && boot === "ready") setIgnite(Date.now());
				previous.current = boot;
			}, [boot]);
			const [, rerender] = React.useState(0);
			React.useEffect(() => {
				if (ignite === 0) return;
				const timer = setTimeout(() => rerender((n) => n + 1), IGNITE_MS + 50);
				return () => clearTimeout(timer);
			}, [ignite]);
			return ignite !== 0 && Date.now() - ignite < IGNITE_MS ? ignite : 0;
		}

		// 大字用 SVG 画，不用字：浏览器逐字排「█」时相邻两格之间会露一道细缝，双线框的样子也随字体变；
		// 终端里是一格一格无缝拼的。这里一格 CELL_W × CELL_H，「█」画成整格的矩形（左右各多出一点盖住缝），
		// 阴影的双线框按方向画两道线。
		const CELL_W = 7;
		const CELL_H = 14;
		const BOX_GAP = 1.6;
		/** 双线框的每个字从格子中心往哪几个方向出线：l 左、r 右、u 上、d 下。 */
		const BOX = { "═": "lr", "║": "ud", "╔": "rd", "╗": "ld", "╚": "ru", "╝": "lu" };
		function boxPath(ch, x0, y0) {
			const cx = x0 + CELL_W / 2;
			const cy = y0 + CELL_H / 2;
			const g = BOX_GAP;
			const right = x0 + CELL_W;
			const bottom = y0 + CELL_H;
			switch (BOX[ch]) {
				case "lr":
					return `M${x0} ${cy - g}H${right}M${x0} ${cy + g}H${right}`;
				case "ud":
					return `M${cx - g} ${y0}V${bottom}M${cx + g} ${y0}V${bottom}`;
				case "rd":
					return `M${right} ${cy - g}H${cx - g}V${bottom}M${right} ${cy + g}H${cx + g}V${bottom}`;
				case "ld":
					return `M${x0} ${cy - g}H${cx + g}V${bottom}M${x0} ${cy + g}H${cx - g}V${bottom}`;
				case "ru":
					return `M${cx - g} ${y0}V${cy + g}H${right}M${cx + g} ${y0}V${cy - g}H${right}`;
				case "lu":
					return `M${cx + g} ${y0}V${cy + g}H${x0}M${cx - g} ${y0}V${cy - g}H${x0}`;
				default:
					return "";
			}
		}

		/** 一行大字这一帧的样子：开场解码、锁定闪光、故障闪烁都在这里按格算。 */
		function logoCells(line, y, t, glitch) {
			const shift = glitch !== null && glitch.row === y ? glitch.shift : 0;
			const out = [];
			[...line].forEach((ch, column) => {
				if (ch === " ") return;
				const x = column + shift;
				if (x < 0) return;
				const solid = ch === "█";
				const x0 = x * CELL_W;
				const y0 = y * CELL_H;
				const key = `${y}-${column}`;
				let style = { "--x": column };
				let noise = null;
				if (t < INTRO_MS) {
					const lock = lockAt(column, y);
					if (t < lock) {
						if (t < hash(column, y, 1) * APPEAR_MS) return;
						noise = noiseAt(column, y, t);
					} else if (t - lock < FLASH_MS) {
						const k = 1 - (1 - (t - lock) / FLASH_MS) ** 3;
						const settle = solid ? C("accent") : C("label");
						style = { ...style, color: `color-mix(in srgb, ${settle} ${Math.round(k * 100)}%, ${C("hi")})` };
					}
				} else if (shift !== 0 && column >= glitch.from && column < glitch.from + glitch.length) {
					noise = noiseAt(column, y, glitch.seed * 97);
					style = { ...style, color: C("glow") };
				}
				if (noise !== null)
					out.push(
						h(
							"text",
							{ key, className: "n", style, x: x0 + CELL_W / 2, y: y0 + CELL_H * 0.78, textAnchor: "middle" },
							noise,
						),
					);
				else if (solid)
					out.push(
						h("rect", {
							key,
							className: "s",
							style,
							x: x0 - 0.3,
							y: y0 - 0.3,
							width: CELL_W + 0.6,
							height: CELL_H + 0.6,
						}),
					);
				else out.push(h("path", { key, className: "d", style, d: boxPath(ch, x0, y0) }));
			});
			return out;
		}

		/** 首页品牌位：方块大字 + 名牌 + 装饰代码。只在首页（空会话）出现。 */
		function HeroMark() {
			ensureStyle();
			const still = React.useMemo(reducedMotion, []);
			const t = useIntroClock(still);
			const glitch = useGlitch(!still && t >= INTRO_MS);
			const boot = useBootState();
			const ignite = useIgnite(boot);
			const settled = t >= INTRO_MS;
			// 「● 就绪」等光扫完才写，跟着整块那一下一起亮出来
			const showReady = boot === "ready" && (ignite === 0 || Date.now() - ignite >= 650);
			const [, tickAfterSweep] = React.useState(0);
			React.useEffect(() => {
				if (ignite === 0) return;
				const timer = setTimeout(() => tickAfterSweep((n) => n + 1), 660);
				return () => clearTimeout(timer);
			}, [ignite]);
			const cut = PRODUCT_TAGLINE.indexOf("，");
			const head = cut === -1 ? "" : PRODUCT_TAGLINE.slice(0, cut + 1);
			const tail = cut === -1 ? PRODUCT_TAGLINE : PRODUCT_TAGLINE.slice(cut + 1);
			return h(
				"div",
				{
					className: "cx-hero",
					"data-cosmic-hero": "",
					"aria-label": `${PRODUCT_LOGO_NAME} · ${PRODUCT_SUBTITLE}`,
				},
				h(
					"svg",
					{
						className: "cx-logo",
						"aria-hidden": true,
						viewBox: `-1 -1 ${LOGO_WIDTH * CELL_W + 2} ${LOGO.length * CELL_H + 2}`,
						width: LOGO_WIDTH * CELL_W + 2,
						height: LOGO.length * CELL_H + 2,
						"data-boot": settled && ignite === 0 ? (boot ?? undefined) : undefined,
						"data-ignite": ignite !== 0 ? "" : undefined,
						key: ignite,
					},
					...LOGO.flatMap((line, y) => logoCells(line, y, t, glitch)),
				),
				h(
					"div",
					{ className: "cx-plate" },
					h("div", { className: "cx-tag" }, PRODUCT_LOGO_TAG),
					h("div", { className: "cx-sub" }, PRODUCT_SUBTITLE),
					h("div", { className: "cx-status" }, showReady ? [h("b", { key: "r" }, "● 就绪"), READY_NOTE] : null),
					h(
						"div",
						{ className: "cx-tagline" },
						h("i", null, "❯ "),
						head,
						h("b", null, tail),
						settled && !still ? h("span", { className: "cx-cursor", "aria-hidden": true }, "▌") : null,
					),
				),
				h(
					"pre",
					{ className: "cx-code", "aria-hidden": true },
					...CODE.map((parts, index) =>
						h(
							"div",
							{ key: index, className: "cx-code-line", style: { "--i": index } },
							...parts.map(([kind, text], at) =>
								kind === "" ? text : h("span", { key: at, className: kind }, text),
							),
						),
					),
				),
			);
		}

		/** 首页背景层：淡淡一层点阵，画在会话内容之下；离开首页就不画。 */
		function HeroFrame({ hero, children }) {
			return h(
				"div",
				{ style: { display: "contents" } },
				hero ? h("div", { className: "cx-backdrop", "aria-hidden": true, "data-cosmic-backdrop": "" }) : null,
				children,
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
		 *   [ ⠹⠼ ] 写元数据 · 单据布局                       测试环境 · 等你确认  ×
		 *   收样确认  zlgd_syqr_jj  布局
		 *   ❯ 收样确认保存成功即反写委托单收样日期
		 *   改动 2 处   +1 新增  −1 删除
		 *   + save 操作  插件   …opplugin.SampleReceiptAuditOpPlugin
		 *   − audit 操作 插件   …opplugin.SampleReceiptAuditOpPlugin
		 *   ├─ 影响 …   └─ 撤回 …   写入范围 3 个对象 ▸
		 *   ✎ 说明                                         [不写] [写入]
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
						h("p", { className: "cw-purpose" }, h("i", { "aria-hidden": true }, "❯"), view.purpose),
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

		return {
			inject: ["slots", "theme"],
			apply(ctx) {
				ctx.effect(() => ctx.theme.overrideTokens("fast-ai-cosmic", TOKENS));
				ctx.effect(() => ensureStyle());
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
					ctx.slots.register({ name: "conversation.hero.frame", id: "cosmic-hero" }, HeroFrame),
				);
				// pi-ai 那一族的每张卡片都会收到；组件自己只在 openai-codex 那张上画
				ctx.slots.inject("settings.models.provider-card", () =>
					ctx.slots.register({ name: "settings.models.provider-card", key: "llm-pi-ai" }, CodexLoginCard),
				);
				// 输入框左边那一排：空会话（首页还没发第一句）也有，进到会话就能看到 JVM 起到哪了
				ctx.slots.inject("conversation.input.left", () =>
					ctx.slots.register({ name: "conversation.input.left", id: "cosmic-jvm", order: 100 }, JvmChip),
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
			},
		};
	},
});
