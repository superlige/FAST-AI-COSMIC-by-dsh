/**
 * 工程这一组：打开工程、lint、编译、体检与修理、本机运行环境、影响面反查。
 */

import { Type } from "typebox";
import { styleBlockers } from "../../agent/tools/style-check.ts";
import type { ImpactRequest } from "../../kernel/commands/impact.ts";
import type { CosmicToolSpec } from "../define.ts";
import { AGENT_GATE_CODE, type CallContext, type CosmicHost, now } from "../host.ts";
import { renderSuccess } from "../result.ts";

const DOCTOR_ACTIONS = ["check", "rebuild", "index", "reindex", "lock"] as const;

const RUNTIME_ACTIONS = [
	"probe-status",
	"probe-start",
	"probe-stop",
	"probe-restart",
	"node-status",
	"node-start",
	"node-logs",
	"node-stop",
	"deploy",
] as const;

/** 前缀名对到内核的哪个动作。probe-* 和 node-* 不对称是有意的：两边能做的事本来就不一样。 */
const PROBE_SERVER_BY_RUNTIME_ACTION = {
	"probe-status": "status",
	"probe-start": "start",
	"probe-stop": "stop",
	"probe-restart": "restart",
} as const;
const NODE_BY_RUNTIME_ACTION = {
	"node-status": "status",
	"node-start": "start",
	"node-logs": "logs",
	"node-stop": "stop",
} as const;

export function projectTools(host: CosmicHost): CosmicToolSpec<never>[] {
	const done = (call: CallContext, value: unknown): string[] => {
		host.succeeded(call);
		return renderSuccess(call.session, call.tool, value);
	};

	const openProject: CosmicToolSpec<{ projectRoot?: string }> = {
		name: "cosmic_open_project",
		description:
			"识别苍穹工程、用户 JDK/运行时和运行时标识（RuntimeKey），重建过期的影响面索引。" +
			"要工程的工具会自动打开会话工作目录里的工程；要换一个工程、或怀疑运行时变了，才需要调它。换工程后之前的编译和验证作废。",
		parameters: Type.Object({
			projectRoot: Type.Optional(Type.String({ description: "苍穹工程的绝对路径；不给就是会话工作目录" })),
		}),
		async execute(args, call) {
			const session = call.session;
			const root = args.projectRoot ?? (await call.cwd());
			const opened = host.unwrap(call, await host.kernel.open(root, { rescanRuntime: true }), args);
			const summary = opened.summary;
			const previous = session.project;
			const changed =
				previous !== undefined &&
				(previous.root !== summary.root || previous.runtimeKeyId !== summary.runtimeKeyId);
			if (changed) {
				session.freshness = undefined;
				session.compiledAt = undefined;
			}
			session.project = { root: summary.root, runtimeKeyId: summary.runtimeKeyId, handle: opened.handle, summary };
			// 打开工程之后模型多半马上要查影响面，这里等索引跟上（只在源码变过时重建，约十秒）。
			const index = await host.kernel.refreshIndex?.(opened.handle);
			const notes = [
				...summary.notes,
				...(changed && previous !== undefined
					? [
							previous.root !== summary.root
								? `换了工程（原来是 ${previous.root}），之前的编译和验证作废。`
								: `运行时身份变了（${previous.runtimeKeyId} → ${summary.runtimeKeyId}），之前的编译和验证作废。`,
						]
					: []),
			];
			return done(call, { ...summary, notes, ...(index === undefined ? {} : { index }) });
		},
	};

	const lint: CosmicToolSpec<{ sources: string[] }> = {
		name: "cosmic_lint",
		description:
			"用用户当前的苍穹 JAR 编译目标源码、不留 class，返回结构化诊断。只查 API 用法对不对时用；cosmic_fast 已经包含同样的检查。",
		parameters: Type.Object({
			sources: Type.Array(Type.String(), { minItems: 1, description: "源码路径、类名或短名" }),
		}),
		async execute(args, call) {
			const project = await host.project(call, args);
			const value = host.unwrap(call, await host.kernel.lint(project.handle, args.sources), args);
			return done(call, await host.budget(call, project.handle, value));
		},
	};

	const fast: CosmicToolSpec<{ sources?: string[] }> = {
		name: "cosmic_fast",
		description:
			"用用户当前的 JDK 和苍穹 JAR 编译改过的源码：先做 lint 前检，再按模块增量编译；目标是插件时自动核对并附上对应的知识卡片。" +
			"编完后，常驻 JVM 下次用之前会把变了的类热替换进去；加字段、加非 private 方法这类结构变化换不进去，才重启。",
		parameters: Type.Object({
			sources: Type.Optional(
				Type.Array(Type.String(), { description: "源码路径、类名或短名；不给就编所有陈旧源码" }),
			),
		}),
		async execute(args, call) {
			const session = call.session;
			const project = await host.project(call, args);
			const result = await host.kernel.fast(project.handle, args.sources ?? [], {
				// 「本次会话改的」只认文件工具记下的文件：按修改时间判，会把用户同时在 IDE 里改的也算进来。
				writtenFiles: [...session.files],
				styleGate: (files) => styleBlockers(session.style, project.root, files),
			});
			if (!result.ok) {
				session.compiles.push({ at: now(), ok: false, fresh: false, files: 0 });
				session.save(project.root);
				throw host.fail(call, result.error.toJSON(), args);
			}
			const report = result.value;
			session.factsRevision += 1;
			session.compiledAt = now();
			session.freshness = report.freshness.fresh ? report.freshness : undefined;
			session.compiles.push({ at: now(), ok: true, fresh: report.freshness.fresh, files: report.files.length });
			session.save(project.root);
			return done(call, report);
		},
	};

	const doctor: CosmicToolSpec<{
		action?: (typeof DOCTOR_ACTIONS)[number];
		projectRoot?: string;
		modules?: string[];
		force?: boolean;
		srcOnly?: boolean;
		token?: string;
	}> = {
		name: "cosmic_doctor",
		description:
			"工程体检与产物修复。check（默认）是只读的：工程配置的每一项值、它的出处、缺什么、知识库来源与版本，不连环境、不需要完整配置。" +
			"另外四个动作是别的工具报错时才用得上的修理口：rebuild 重建 pathing jar 与 javac argfile（产物「在但不对」时要 force=true，" +
			"陈旧 classpath 报出来的是业务类的 NoClassDefFoundError，指不到这里）、index 看影响面索引本身、" +
			"reindex 重建（平时自动跟上；srcOnly 只建代码部分约 10 秒，否则约 5 分钟）、" +
			"lock 查工程写锁（给 token 才回收崩溃残留的锁，并作废本次 class 新鲜度证据）。",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					DOCTOR_ACTIONS.map((action) => Type.Literal(action)),
					{ description: "check（默认） | rebuild | index | reindex | lock" },
				),
			),
			projectRoot: Type.Optional(
				Type.String({ description: "check：苍穹工程绝对路径；不给就用会话工作目录里的工程" }),
			),
			modules: Type.Optional(
				Type.Array(Type.String(), {
					description: "rebuild：只 build 这些代码模块；pathing jar 仍会编齐所有模块的 classes",
				}),
			),
			force: Type.Optional(Type.Boolean({ description: "rebuild：产物已存在也重新构建" })),
			srcOnly: Type.Optional(Type.Boolean({ description: "reindex：只重建静态侧，沿用上次的元数据侧，不连环境" })),
			token: Type.Optional(Type.String({ description: "lock：锁上的 token；不给就是只读查看，不做任何清理" })),
		}),
		async execute(args, call) {
			const action = args.action ?? "check";
			if (action === "check") {
				// 体检就是为打不开的工程准备的：不经打开工程那一步。
				const root = args.projectRoot ?? call.session.project?.root ?? (await call.cwd());
				return done(call, host.unwrap(call, await host.kernel.doctor(root), args));
			}
			const project = await host.project(call, args);
			if (action === "rebuild") {
				const report = host.unwrap(
					call,
					await host.kernel.build(
						project.handle,
						{
							...(args.modules === undefined ? {} : { modules: args.modules }),
							...(args.force === undefined ? {} : { force: args.force }),
						},
						call.signal,
					),
					args,
				);
				return done(call, report);
			}
			if (action === "index" || action === "reindex") {
				const request: ImpactRequest =
					action === "index"
						? { action: "status" }
						: { action: "build", ...(args.srcOnly === undefined ? {} : { srcOnly: args.srcOnly }) };
				const report = host.unwrap(call, await host.kernel.impact(project.handle, request), args);
				return done(call, await host.budget(call, project.handle, report));
			}
			if (args.token === undefined || args.token === "") {
				return done(call, host.unwrap(call, await host.kernel.inspectWriteLock(project.handle), args));
			}
			const recovered = host.unwrap(call, await host.kernel.recoverWriteLock(project.handle, args.token), args);
			// 回收的锁说明有一次写到一半被打断：它要证明的事没被证明，编译新鲜度一并作废。
			call.session.freshness = undefined;
			return done(call, recovered);
		},
	};

	const runtime: CosmicToolSpec<{
		action: (typeof RUNTIME_ACTIONS)[number];
		lines?: number;
		modules?: string[];
	}> = {
		name: "cosmic_runtime",
		description:
			"本机苍穹运行环境的两个进程，和改变它们装载内容的一个动作。常驻探针 JVM 由探针和 run 按需自动拉起，平时不用管；" +
			"调试节点不在编译和验证的路上；deploy 把 jar 装进运行时要三四分钟，验插件逻辑用 cosmic_fast 加 cosmic_run。",
		parameters: Type.Object({
			action: Type.Union(
				RUNTIME_ACTIONS.map((action) => Type.Literal(action)),
				{
					description:
						"probe-status | probe-start | probe-stop | probe-restart（常驻探针 JVM）；" +
						"node-status | node-start | node-logs | node-stop（调试节点）；deploy（装 jar 到运行时）",
				},
			),
			lines: Type.Optional(Type.Number({ description: "node-logs 取多少行，默认 40" })),
			modules: Type.Optional(Type.Array(Type.String(), { description: "deploy：只部这些代码模块；不给就是全部" })),
		}),
		async execute(args, call) {
			const project = await host.project(call, args);
			if (args.action === "deploy") {
				if (call.session.compiledAt === undefined) {
					throw host.fail(
						call,
						{
							code: AGENT_GATE_CODE,
							message: "本会话还没编译成功过，没有东西可部署",
							detail: { action: "deploy" },
							remedy:
								"要验插件逻辑用 cosmic_fast（编译几秒，常驻 JVM 多半热替换）加 cosmic_run，不经过节点。真要把 jar 装到运行时，" +
								"先改代码并 cosmic_fast 编译成功，再回来 deploy。probe-* 和 node-* 两组不受这条限制。",
						},
						args,
					);
				}
				const report = host.unwrap(
					call,
					await host.kernel.deploy(project.handle, {
						...(args.modules === undefined ? {} : { modules: args.modules }),
					}),
					args,
				);
				// 部署换掉了常驻 JVM 装载的 jar，之前记的新鲜度说的是一个已经不存在的运行时。
				call.session.freshness = undefined;
				return done(call, report);
			}
			if (args.action in PROBE_SERVER_BY_RUNTIME_ACTION) {
				const action = PROBE_SERVER_BY_RUNTIME_ACTION[args.action as keyof typeof PROBE_SERVER_BY_RUNTIME_ACTION];
				return done(call, host.unwrap(call, await host.kernel.probeServer(project.handle, action), args));
			}
			const action = NODE_BY_RUNTIME_ACTION[args.action as keyof typeof NODE_BY_RUNTIME_ACTION] ?? "status";
			const report = host.unwrap(
				call,
				await host.kernel.node(project.handle, action, {
					...(args.lines === undefined ? {} : { lines: args.lines }),
				}),
				args,
			);
			return done(call, await host.budget(call, project.handle, report));
		},
	};

	const impact: CosmicToolSpec<{ terms: string[]; dynamic?: boolean; event?: string }> = {
		name: "cosmic_impact",
		description:
			"影响面反查（线上元数据和本地 Java，其他文件自己读）。字段列读写处（类#方法:行）和挂载插件调用路径；" +
			"类、单据、布局、打印模板、调度任务、开放接口、转换规则、工作流列挂载、读写、同字段写入者和牵连对象。" +
			"动手前先查一遍，把牵动的单据和元数据对象转述给用户；用户只说了中文名也可以直接查。索引状态/重建：cosmic_doctor action=index/reindex。",
		parameters: Type.Object({
			terms: Type.Array(Type.String(), {
				minItems: 1,
				description:
					"类名、源文件路径、单据实体或布局标识、元数据编号或中文名。字段：单写字段查同名读写；限定写「单据实体.字段」或「单据实体.分录.字段」（子分录继续加层）；首段必须是整张单据的实体标识，「分录.字段」缺单据。",
			}),
			dynamic: Type.Optional(
				Type.Boolean({ description: "列全：读的单据、调用链、读写处、认不出名字、按名字猜的都列" }),
			),
			event: Type.Optional(
				Type.String({ description: "按同单据、同名事件查插件源码位置，仅供定位，如 beforeDoOperation" }),
			),
		}),
		async execute(args, call) {
			const project = await host.project(call, args);
			const request: ImpactRequest = { action: "query", terms: args.terms };
			if (args.dynamic !== undefined) request.dynamic = args.dynamic;
			if (args.event !== undefined) request.event = args.event;
			const report = host.unwrap(call, await host.kernel.impact(project.handle, request), args);
			return done(call, await host.budget(call, project.handle, report));
		},
	};

	return [openProject, lint, fast, doctor, runtime, impact] as CosmicToolSpec<never>[];
}
