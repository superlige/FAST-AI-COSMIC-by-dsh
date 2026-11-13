#!/usr/bin/env node --experimental-strip-types
/**
 * S3 real-environment verification harness.
 *
 * This is a developer/verification entry point, NOT a model-facing surface. It
 * exists because S3's completion condition is "fast -> probe compiles and runs
 * against the user's real Cosmic JARs", and that cannot be proved by unit tests
 * with faked ports. It takes a fixed set of named steps -- there is no way to
 * pass it a command to run (D1).
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-real-env.ts <projectRoot> <step> [args]
 *
 * Steps: open | lint <file> | fast [files...] | probe <name> [KEY=VALUE|位置参数...] | stop
 *        | run <argv...>
 *        | impact [src-only]
 *        | meta <argv...> | meta-apply <targets> <argv...>
 *        | node <start|status|logs|stop> | deploy [modules...]
 *
 * The last three were added by S5.4. `meta` takes the frozen argv shape and is
 * parsed by parseMeta, not by a shell -- there is still no way to hand this
 * script a command line to execute (D1). `meta-apply` exists so the write
 * channel can be exercised on a real environment, and it is NOT a way around
 * the gate: the grant it passes may only narrow what the project's DRAFT.md
 * already confirms, so a write the user never recorded with `spec target` is
 * still refused before the JVM starts.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy } from "../src/kernel/commands/deploy.ts";
import { fast } from "../src/kernel/commands/fast.ts";
import { impact } from "../src/kernel/commands/impact.ts";
import { lint } from "../src/kernel/commands/lint.ts";
import { meta } from "../src/kernel/commands/meta.ts";
import { NODE_ACTIONS, type NodeAction, node } from "../src/kernel/commands/node.ts";
import { probe } from "../src/kernel/commands/probe.ts";
import { run } from "../src/kernel/commands/run.ts";
import { resolveSources } from "../src/kernel/commands/sources.ts";
import { KernelError } from "../src/kernel/errors.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const AGENT_VERSION = "0.0.0-s3";

function fail(error: unknown): never {
	if (error instanceof KernelError) {
		console.error(`[${error.code}] ${error.message}`);
		if (error.remedy) console.error(`  → ${error.remedy}`);
		for (const [key, value] of Object.entries(error.detail)) {
			console.error(`  ${key}: ${Array.isArray(value) ? `\n    ${value.join("\n    ")}` : String(value)}`);
		}
		process.exitCode = 1;
		process.exit(1);
	}
	throw error;
}

async function main(): Promise<void> {
	const [root, step, ...rest] = process.argv.slice(2);
	if (!root || !step) {
		console.error("用法: verify-real-env.ts <projectRoot> <open|lint|fast|probe|stop> [args]");
		process.exit(2);
	}

	// The agent's own config lives outside both the project and the cosmic repo:
	// customer config and credentials must never land in cosmic/ (hard boundary).
	const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(tmpdir(), "cosmic-agent");
	const cacheRoot = process.env.COSMIC_CACHE_ROOT ?? join(tmpdir(), "cosmic-cache");
	mkdirSync(agentConfigDir, { recursive: true });
	mkdirSync(cacheRoot, { recursive: true });

	const opened = await openProject({
		projectRoot: root,
		agentConfigDir,
		cacheRoot,
		agentVersion: AGENT_VERSION,
		resources: EMBEDDED_RESOURCES,
	}).catch(fail);

	const { ctx, key } = opened;
	console.log(`RuntimeKey  ${key.id}`);
	console.log(`  project   ${ctx.projectRoot}  isv=${ctx.config.isv}  modules=${ctx.config.codeModules.join(",")}`);
	console.log(`  jdk       ${key.parts.jdk.version}  (${key.parts.jdk.home || "PATH"})`);
	console.log(
		`  cosmic    ${key.parts.cosmicRuntime.version ?? "(未采到)"}  ${key.parts.cosmicRuntime.jarCount} 个 JAR`,
	);
	console.log(`  classpath ${key.parts.classpath.entryCount} 条`);
	console.log(`  cache     ${opened.cache.state}（${opened.cache.reason}）`);
	console.log(
		`  资源      释放 ${opened.release.released} / 复用 ${opened.release.reused} / 修复 ${opened.release.repaired}`,
	);
	for (const note of opened.notes) console.log(`  note      ${note}`);

	if (step === "open") return;

	if (step === "lint") {
		const files = resolveSources(ctx, rest);
		if (!files.ok) fail(files.error);
		const report = lint(ctx, files.value);
		if (!report.ok) fail(report.error);
		console.log(
			`\nlint ${report.value.files.length} 个文件，${report.value.seconds}s，${report.value.findings.length} 个问题`,
		);
		for (const finding of report.value.findings) {
			const where = finding.lines.join("、");
			console.log(`[LINT] ${finding.file}:${where} ${finding.what}${finding.hint ? ` → ${finding.hint}` : ""}`);
			for (const extra of finding.extra.slice(0, 3)) console.log(`[LINT]     候选 ${extra}`);
		}
		if (report.value.suggestionsUnavailable) console.log("[LINT] 反查不可用，本次没有近似名建议");
		process.exitCode = report.value.findings.length > 0 ? 1 : 0;
		return;
	}

	if (step === "fast") {
		const result = await fast(ctx, rest);
		if (!result.ok) fail(result.error);
		const value = result.value;
		if (value.nothingToDo) {
			console.log("\n没有待编译的改动（源文件都不比 .class 新）");
			return;
		}
		console.log(
			`\nfast ${value.files.length} 个文件；前置体检 ${value.preflight.ran ? `${value.preflight.seconds}s` : value.preflight.skippedBecauseStamped ? "跳过（刚体检干净）" : "未跑"}`,
		);
		for (const compiled of value.compiled) {
			console.log(
				`  OK  ${compiled.module}  ${compiled.fileCount} 个文件  ${compiled.seconds}s  -> ${compiled.outDir}`,
			);
		}
		console.log(`  常驻 JVM: ${value.residentJvm}`);
		for (const note of value.notes) console.log(`  note ${note}`);
		return;
	}

	if (step === "probe") {
		// `KEY=VALUE` 的给 env，其余按 req 声明顺序当位置参数。探针的可选入参（META_FILTER、
		// QUERY_WHERE、RULE_TAG…）只能由 env 给，没有这一条就只能验必填入参那几个分支——
		// 2026-09-14 真机验收时为此临时另写了一个跑探针的脚本。入参仍是结构化的
		// 「探针名 + 变量」，不是一行给它执行的命令（D1 没有松动）。
		const [name, ...args] = rest;
		const env: Record<string, string> = {};
		const positional: string[] = [];
		for (const arg of args) {
			const at = arg.indexOf("=");
			if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, at))) env[arg.slice(0, at)] = arg.slice(at + 1);
			else positional.push(arg);
		}
		const result = await probe(ctx, name ?? "TemplateProbe", { positional, env });
		if (!result.ok) fail(result.error);
		const value = result.value;
		console.log(
			`\nprobe ${value.probe} 走${value.path === "hot" ? "常驻" : "冷进程"}${value.coldReason ? `（${value.coldReason}）` : ""}，退出码 ${value.exitCode}`,
		);
		for (const note of value.notes) console.log(`  note ${note}`);
		console.log(
			value.output
				.split("\n")
				.filter((line) => /\[PROBE/.test(line))
				.join("\n") || value.output.split("\n").slice(-25).join("\n"),
		);
		process.exitCode = value.exitCode;
		return;
	}

	if (step === "run") {
		// S27 批 1.7：真提交走常驻进程，要在真机上量「提交后同一进程读到新值」和每次多久。
		// 入参是 run 的冻结 argv，由 parseRunArgs 解析，不是一行给 shell 执行的命令（D1）。
		const started = Date.now();
		const result = await run(ctx, rest, {
			onProgress: (stage) => console.log(`  [+${((Date.now() - started) / 1000).toFixed(1)}s] ${stage}`),
		});
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		if (!result.ok) fail(result.error);
		const value = result.value;
		console.log(
			`\nrun ${value.kind} ${value.target} 走${value.path === "hot" ? "常驻" : "冷进程"}${value.coldReason ? `（${value.coldReason}）` : ""}，退出码 ${value.exitCode}，${seconds}s`,
		);
		for (const note of value.notes) console.log(`  note ${note}`);
		console.log(value.output.split("\n").slice(-40).join("\n"));
		process.exitCode = value.exitCode;
		return;
	}

	if (step === "meta" || step === "meta-apply") {
		// meta-apply <目标,…> <argv…>. The grant may only NARROW what the project's
		// DRAFT.md already confirmed, so this step cannot authorise a write on the
		// user's behalf -- with no `spec target` record it is refused outright,
		// exactly as the frozen driver refuses it.
		const applying = step === "meta-apply";
		const grant = applying ? (rest.shift() ?? "").split(",").filter((t) => t !== "") : [];
		const result = await meta(ctx, rest, applying ? { apply: true, writeTargets: grant } : {});
		if (!result.ok) fail(result.error);
		const value = result.value;
		console.log(
			`\nmeta ${value.family ?? "(help)"} ${value.action ?? ""}  写通道=${value.writes}  dryRun=${value.dryRun}`,
		);
		if (value.probe) {
			console.log(
				`  探针 ${value.probe.probe} 走${value.probe.path === "hot" ? "常驻" : "冷进程"}${value.probe.coldReason ? `（${value.probe.coldReason}）` : ""}，退出码 ${value.probe.exitCode}`,
			);
		}
		if (value.diff) {
			console.log(
				`  diff ${value.diff.mode}  成对 ${value.diff.both.length}  只在A ${value.diff.onlyA.length}  只在B ${value.diff.onlyB.length}  差异 ${value.diff.changes}`,
			);
		}
		for (const note of value.notes) console.log(`  note ${note}`);
		console.log(value.text);
		process.exitCode = value.probe ? value.probe.exitCode : 0;
		return;
	}

	if (step === "node") {
		const action = (rest[0] ?? "status") as NodeAction;
		if (!NODE_ACTIONS.includes(action)) {
			console.error(`node 的动作只有 ${NODE_ACTIONS.join(" / ")}，给的是「${action}」`);
			process.exit(2);
		}
		const lines = rest[1] === undefined ? undefined : Number(rest[1]);
		const result = await node(ctx, action, lines === undefined ? {} : { lines });
		if (!result.ok) fail(result.error);
		const value = result.value;
		console.log(
			`\nnode ${value.action}  pid=${value.pid ?? "(无)"}  存活=${value.alive}  端口=${value.port}(${value.portOpen ? "通" : "不通"})  归属=${value.ownership}`,
		);
		if (value.waitedSeconds !== undefined) console.log(`  等了 ${value.waitedSeconds}s`);
		if (value.stopped !== undefined) console.log(`  stop 结果 ${value.stopped}`);
		console.log(`  URL ${value.url}`);
		console.log(`  日志 ${value.logFile}`);
		for (const note of value.notes) console.log(`  note ${note}`);
		if (value.log) console.log(value.log);
		return;
	}

	if (step === "deploy") {
		const result = await deploy(ctx, rest.length > 0 ? { modules: rest } : {});
		if (!result.ok) fail(result.error);
		const value = result.value;
		console.log(`\ndeploy ${value.modules.join(",")}${value.scoped ? "（指定）" : "（全部）"}  ${value.seconds}s`);
		console.log(`  lib/cus  ${value.libCus ?? "(未知)"}`);
		console.log(`  常驻 JVM ${value.resident}`);
		for (const note of value.notes) console.log(`  note ${note}`);
		console.log(value.out.split("\n").slice(-15).join("\n"));
		return;
	}

	if (step === "impact") {
		// 只有 build 一个动作走这里：查询用 cosmic_impact，不需要真机。build 的元数据侧
		// 要连环境扫七处注册位置，约 290 秒，这是单元测试永远证不了的那一半。
		// `src-only` 明确写出来，因为它**沿用上一次的元数据侧**——真机上那份缓存一度是
		// 保留编号之前写的，沿用它会让产出物通道静默为空。
		const srcOnly = rest[0] === "src-only";
		const result = await impact(ctx, { action: "build", ...(srcOnly ? { srcOnly: true } : {}) });
		if (!result.ok) fail(result.error);
		const value = result.value;
		if (value.action !== "build") throw new Error("impact build 没有返回 build 报文");
		console.log(`\nimpact build  元数据侧=${value.metadata ? "跑了" : "没跑"}  → ${value.file}`);
		console.log(value.text);
		for (const note of value.notes) console.log(`  note ${note}`);
		return;
	}

	if (step === "stop") {
		const stopped = await stopServer(ctx);
		console.log(`\n常驻 JVM: ${stopped.how}${stopped.pid ? ` pid=${stopped.pid}` : ""}`);
		return;
	}

	console.error(`未知步骤：${step}`);
	process.exit(2);
}

await main();
