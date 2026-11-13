import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type FastProgress, fast } from "../../src/kernel/commands/fast.ts";
import type { KnowledgeAdvice } from "../../src/knowledge/plugin-gate.ts";
import { addSource, fakeArgfile, makeContext } from "./fake-context.ts";

/** A verdict that refuses, in the shape both lint and fast read. */
function refusing(base: string): KnowledgeAdvice {
	return {
		hints: [],
		capsules: [],
		gate: {
			allowed: false,
			reason: "capsule-unavailable",
			blocked: [{ base, pluginType: null, file: "A.java", tier: "direct", via: [], remedy: "修复知识包" }],
			capsules: [],
			lines: ["目标 Capsule 无法生成"],
		},
	};
}

/** The passing counterpart, in the same shape. */
function allowed(): KnowledgeAdvice {
	return {
		hints: [],
		capsules: [],
		gate: { allowed: true, reason: "no-families", blocked: [], capsules: [], lines: [] },
	};
}

/**
 * A javac that writes classes: the real compile (not the -implicit:none pre-flight)
 * puts a newer .class beside every source it was handed, so freshness moves.
 * `override` answers first; null falls through to the default.
 */
function writesClasses(
	fake: ReturnType<typeof makeContext>,
	override: (spec: { args: readonly string[] }) => { status: number; stderr?: string } | null = () => null,
): void {
	fake.proc.handler = (spec) => {
		const forced = override(spec);
		if (forced !== null) return forced;
		if (spec.command.includes("javac") && !spec.args.includes("-implicit:none")) {
			const src = spec.args[spec.args.indexOf("-sourcepath") + 1] ?? "";
			const out = spec.args[spec.args.indexOf("-d") + 1] ?? "";
			for (const file of spec.args.filter((arg) => arg.endsWith(".java"))) {
				const rel = file.replace(/\\/g, "/").slice(src.replace(/\\/g, "/").length);
				fake.fs.put(`${out.replace(/\\/g, "/")}${rel.replace(/\.java$/, ".class")}`, "class");
			}
		}
		return { status: 0 };
	};
}

describe("S3.1 fast pipeline", () => {
	it("refuses while another window owns the project write lock", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		fake.proc.livePids.add(777);
		fake.fs.write(
			fake.ctx.layout.projectWriteLock,
			JSON.stringify({
				version: 1,
				token: "other",
				pid: 777,
				runtimeKeyId: "other-runtime",
				operation: "fast",
				acquiredAt: "2026-09-02T00:00:00.000Z",
			}),
		);
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROJECT_WRITE_LOCKED");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("reports nothing to do rather than running a compile", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java", { compiled: true });
		const result = await fast(fake.ctx, []);
		expect(result.ok && result.value.nothingToDo).toBe(true);
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("按段报出自己走到哪了，Gradle 那段只在真要跑 Gradle 时报", async () => {
		// 这几段加起来可以是几分钟，而在此之前界面上从头到尾只有「fast 开始了」一句。
		// 段名和模块序号是等待的刻度：没有刻度的等待和死机分不出来。
		const unbuilt = makeContext({ unbuilt: true });
		addSource(unbuilt, "demo-biz", "A.java");
		const cold: FastProgress[] = [];
		expect((await fast(unbuilt.ctx, [], { onProgress: (stage) => cold.push(stage) })).ok).toBe(true);
		expect(cold).toEqual([
			{ stage: "building-artifacts" },
			{ stage: "preflight", files: 1 },
			{ stage: "compiling", module: "demo-biz", index: 1, total: 1, files: 1 },
		]);

		// 产物齐全时 ensureBuilt 只是一次 exists 检查。报一个瞬间就过去的段名，
		// 只会让进度行闪一下，所以那一段不报。
		const built = makeContext();
		addSource(built, "demo-biz", "A.java");
		const warm: FastProgress[] = [];
		expect((await fast(built.ctx, [], { onProgress: (stage) => warm.push(stage) })).ok).toBe(true);
		expect(warm.map((stage) => stage.stage)).toEqual(["preflight", "compiling"]);
	});

	it("runs the Capsule/risk gate before any Gradle work, not after", async () => {
		// A gate that makes you wait two minutes before saying no gets routed around
		// the second time, so its position in the sequence is the design.
		const fake = makeContext({ unbuilt: true });
		addSource(fake, "demo-biz", "A.java");
		const result = await fast(fake.ctx, [], { knowledgeGate: () => refusing("AbstractBillPlugIn") });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("KNOWLEDGE_GATE_UNSATISFIED");
			expect(result.error.detail.stage).toBe("gate");
		}
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("does not make a sweep answer the knowledge gate for files it did not touch", async () => {
		// The half-hour this rule was written for: one print plugin was edited, and
		// getting a fresh classpath to verify it required walking the six-step flow
		// for a tree-list plugin and a convert plugin left half-compiled by an
		// earlier session. Compiling somebody else's stale source is not the act
		// this gate is about.
		const fake = makeContext();
		const inherited = addSource(fake, "demo-biz", "Inherited.java");
		const mine = addSource(fake, "demo-biz", "Mine.java");
		const sessionStart = (fake.fs.mtimeMs(inherited) as number) + 1;
		fake.fs.put(mine, "class X {}", sessionStart + 1);

		const judged: string[][] = [];
		const result = await fast(fake.ctx, [], {
			authoredSince: sessionStart,
			knowledgeGate: (files) => {
				judged.push([...files]);
				return {
					hints: [],
					capsules: [],
					gate: { allowed: true, reason: "no-families", blocked: [], capsules: [], lines: [] },
				};
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(judged.map((batch) => batch.map((file) => file.replace(/\\/g, "/")))).toEqual([[mine]]);
		// Compiled all the same -- the point was a fresh classpath -- and said so.
		expect(result.value.files).toHaveLength(2);
		expect(result.value.authoredFiles.map((file) => file.replace(/\\/g, "/"))).toEqual([
			"demo-biz/src/main/java/Mine.java",
		]);
		expect(result.value.inheritedStale.map((file) => file.replace(/\\/g, "/"))).toEqual([
			"demo-biz/src/main/java/Inherited.java",
		]);
		expect(result.value.notes.some((note) => note.includes("不是本次会话写的"))).toBe(true);
	});

	it("still refuses a sweep when the family this session edited has no deterministic Capsule", async () => {
		// The narrowing must not become a way out of the gate: the file this session
		// touched is judged whether or not it was named.
		const fake = makeContext({ unbuilt: true });
		const inherited = addSource(fake, "demo-biz", "Inherited.java");
		const mine = addSource(fake, "demo-biz", "Mine.java");
		const sessionStart = (fake.fs.mtimeMs(inherited) as number) + 1;
		fake.fs.put(mine, "class X {}", sessionStart + 1);

		const result = await fast(fake.ctx, [], {
			authoredSince: sessionStart,
			knowledgeGate: (files) => (files.length > 0 ? refusing("AbstractBillPlugIn") : allowed()),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("KNOWLEDGE_GATE_UNSATISFIED");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("judges every named file, however old it is", async () => {
		// `fast sources=X` is a claim about X. Narrowing that would let the gate be
		// stepped around by naming the file instead of sweeping.
		const fake = makeContext({ unbuilt: true });
		const old = addSource(fake, "demo-biz", "Old.java");
		const result = await fast(fake.ctx, ["Old"], {
			authoredSince: (fake.fs.mtimeMs(old) as number) + 1000,
			knowledgeGate: () => refusing("AbstractBillPlugIn"),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("KNOWLEDGE_GATE_UNSATISFIED");
	});

	it("says why a named compile leaves the project stale, instead of returning a silent success", async () => {
		// 一次真实会话在这里空转了一整轮：`fast sources=[我改的两个类]` 成功、诊断为空，
		// 而阶段一动不动 —— 推进要的是**整个工程**新鲜，工程里还躺着别人的陈旧源码。
		// 那次返回里没有一个字说得出这一点。
		const fake = makeContext();
		addSource(fake, "demo-biz", "Mine.java");
		addSource(fake, "demo-biz", "Somebody.java");
		const result = await fast(fake.ctx, ["Mine"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.freshness.fresh).toBe(false);
		const note = result.value.notes.find((one) => one.includes("工程还不新鲜"));
		expect(note).toBeDefined();
		// 差的是谁，和跑什么把它们编掉 —— 缺任何一半这条 note 都只是复述失败。
		expect(note).toContain("Somebody.java");
		expect(note).toContain("不带 sources");
	});

	it("compiles the stale sources left from before the session in the same call (S24 D1)", async () => {
		// 2026-09-17：点名编完那个打印插件，返回说「工程还不新鲜，不带 sources 再跑一次」，
		// 模型照做，16 秒后第二次 fast 编了 5 个早于会话的文件。第二次什么都没多判：
		// 早于会话的文件在 sweep 里本来就不过知识门禁。那一来一回可以不要。
		const fake = makeContext();
		writesClasses(fake);
		const inherited = addSource(fake, "demo-biz", "Somebody.java");
		const sessionStart = (fake.fs.mtimeMs(inherited) as number) + 1;
		addSource(fake, "demo-biz", "Mine.java");
		const judged: string[][] = [];
		const result = await fast(fake.ctx, ["Mine"], {
			authoredSince: sessionStart,
			knowledgeGate: (files) => {
				judged.push(files.map((file) => file.replace(/\\/g, "/")));
				return allowed();
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.freshness.fresh).toBe(true);
		// 门禁只判点名的那个；补编的照 sweep 的规矩不判。
		expect(judged).toEqual([[expect.stringMatching(/Mine\.java$/)]]);
		expect(result.value.inheritedStale.map((file) => file.replace(/\\/g, "/"))).toEqual([
			"demo-biz/src/main/java/Somebody.java",
		]);
		expect(result.value.authoredFiles.map((file) => file.replace(/\\/g, "/"))).toEqual([
			"demo-biz/src/main/java/Mine.java",
		]);
		expect(result.value.files).toHaveLength(2);
		expect(result.value.notes.some((note) => note.includes("顺带补编了 1 个"))).toBe(true);
		expect(result.value.notes.some((note) => note.includes("工程还不新鲜"))).toBe(false);
	});

	it("does not follow up when a leftover stale source was touched during this session", async () => {
		// 本次会话改过、却没点名的文件是这次的活，得过知识门禁；补编不跑门禁，所以不碰它，照旧说清。
		const fake = makeContext();
		writesClasses(fake);
		const sessionStart = 1;
		addSource(fake, "demo-biz", "Mine.java");
		addSource(fake, "demo-biz", "AlsoMine.java");
		const result = await fast(fake.ctx, ["Mine"], { authoredSince: sessionStart });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.freshness.fresh).toBe(false);
		expect(result.value.files).toHaveLength(1);
		expect(result.value.notes.find((note) => note.includes("工程还不新鲜"))).toContain("AlsoMine.java");
	});

	describe("本次会话改的只认编辑工具写过的（S37 2-D.1）", () => {
		// 09-22 第三份样本：模型只写了两个文件，用户同时在 IDE 里改着另外两个。按修改时间判，
		// 第 71 次不点名编译把用户那两个算成「本次会话改的」，进了交付清单（回执写「改过的文件 4 个」），
		// 预检要模型给它们也跑验证。
		function session() {
			const fake = makeContext();
			writesClasses(fake);
			const sessionStart = 1;
			const mine = addSource(fake, "demo-biz", "Mine.java");
			const users = addSource(fake, "demo-biz", "UsersIdeEdit.java");
			return { fake, sessionStart, mine, users };
		}

		it("不点名编译：用户同时改的文件照编，但不算本次改的、不过知识门禁", async () => {
			const { fake, sessionStart, mine } = session();
			const judged: string[][] = [];
			const result = await fast(fake.ctx, [], {
				authoredSince: sessionStart,
				writtenFiles: [mine.replace(/\//g, "\\")],
				knowledgeGate: (files) => {
					judged.push(files.map((file) => file.replace(/\\/g, "/")));
					return allowed();
				},
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.files).toHaveLength(2);
			expect(result.value.freshness.fresh).toBe(true);
			expect(result.value.authoredFiles.map((file) => file.replace(/\\/g, "/"))).toEqual([
				"demo-biz/src/main/java/Mine.java",
			]);
			expect(result.value.inheritedStale.map((file) => file.replace(/\\/g, "/"))).toEqual([
				"demo-biz/src/main/java/UsersIdeEdit.java",
			]);
			expect(judged).toEqual([[expect.stringMatching(/Mine\.java$/)]]);
		});

		it("点名编译：剩下的是用户同时改的文件，同一次调用顺带编掉，不再叫模型再跑一次", async () => {
			// 09-22 第 70 次：点名编完自己的两个，返回说「工程还不新鲜……不带 sources 再跑一次」，第 71 次照做
			const { fake, sessionStart, mine } = session();
			const result = await fast(fake.ctx, ["Mine"], { authoredSince: sessionStart, writtenFiles: [mine] });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.freshness.fresh).toBe(true);
			expect(result.value.authoredFiles.map((file) => file.replace(/\\/g, "/"))).toEqual([
				"demo-biz/src/main/java/Mine.java",
			]);
			expect(result.value.notes.some((note) => note.includes("顺带补编了 1 个不是本次会话写的"))).toBe(true);
			expect(result.value.notes.some((note) => note.includes("不带 sources"))).toBe(false);
		});

		it("点名的文件在会话开始后改过就算本次的，哪怕编辑工具没记（用 bash 写的）", async () => {
			const { fake, sessionStart } = session();
			const result = await fast(fake.ctx, ["UsersIdeEdit"], { authoredSince: sessionStart, writtenFiles: [] });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.authoredFiles.map((file) => file.replace(/\\/g, "/"))).toEqual([
				"demo-biz/src/main/java/UsersIdeEdit.java",
			]);
		});
	});

	it("refuses with javac's candidate signature, not just the headline (真机 2026-10-09)", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "demo/mes/Caller.java");
		const javac = readFileSync(
			fileURLToPath(new URL("../fixtures/javac-jdk8-zh-generic.txt", import.meta.url)),
			"utf8",
		).replace("D:\\proj\\zlgd-hhx\\src\\main\\java", "D:/proj/demo-biz/src/main/java");
		writesClasses(fake, (spec) => (spec.args.includes("-implicit:none") ? { status: 1, stderr: javac } : null));
		const result = await fast(fake.ctx, ["Caller"]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.detail.stage).toBe("preflight");
		const findings = (result.error.detail.findings as string[]).join("\n");
		expect(findings).toContain("找不到合适的方法");
		expect(findings).toContain("buildJSON(String,List<List<Object>>)");
	});

	it("keeps the named compile when the follow-up on somebody else's files fails", async () => {
		const fake = makeContext();
		const inherited = addSource(fake, "demo-biz", "Broken.java");
		const sessionStart = (fake.fs.mtimeMs(inherited) as number) + 1;
		addSource(fake, "demo-biz", "Mine.java");
		writesClasses(fake, (spec) =>
			spec.args.includes("-implicit:none") && spec.args.some((arg) => arg.endsWith("Broken.java"))
				? { status: 1, stderr: "D:/proj/Broken.java:3: 错误: 找不到符号\n  符号:   类 QFiltr\n  位置: 类 Broken" }
				: null,
		);
		const result = await fast(fake.ctx, ["Mine"], { authoredSince: sessionStart });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.freshness.fresh).toBe(false);
		expect(result.value.inheritedStale).toEqual([]);
		const note = result.value.notes.find((one) => one.includes("顺带补编"));
		expect(note).toContain("Broken.java");
		expect(note).toContain("前置体检没过");
		// 再跑一次不带 sources 的只会撞同一个错，不再这么劝。
		expect(result.value.notes.some((one) => one.includes("不带 sources"))).toBe(false);
	});

	it("reports a missing Capsule source as an install-health degradation", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.notes.some((note) => note.includes("插件知识卡片（Capsule）来源不可用"))).toBe(true);
		expect(result.value.notes.some((note) => note.includes("本次没有附卡片，编译照常"))).toBe(true);
		expect(result.value).not.toHaveProperty("relatedTasks");
	});

	it("stops at the pre-flight check and never reaches the real compile", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		fake.proc.handler = (spec) => {
			if (spec.args.includes("-implicit:none")) {
				return {
					status: 1,
					stderr: ["D:/proj/A.java:3: 错误: 找不到符号", "  符号:   类 QFiltr", "  位置: 类 A"].join("\n"),
				};
			}
			return { status: 0 };
		};
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.stage).toBe("preflight");
			expect(result.error.detail.findings).toHaveLength(1);
		}
		// One javac run: the pre-flight. The real compile must not have happened.
		expect(fake.proc.runsOf("javac")).toHaveLength(1);
	});

	it("skips the pre-flight for files that are already stamped clean", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		await fast(fake.ctx, []);
		const before = fake.proc.runsOf("javac").length;
		const again = await fast(fake.ctx, []);
		expect(again.ok && again.value.preflight.skippedBecauseStamped).toBe(true);
		// Only the real compile ran the second time.
		expect(fake.proc.runsOf("javac").length - before).toBe(1);
	});

	it("compiles each module separately with its own -d and -sourcepath", async () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz", "demo-shared"] } });
		addSource(fake, "demo-biz", "A.java");
		addSource(fake, "demo-shared", "B.java");
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.compiled).toHaveLength(2);
		const compiles = fake.proc
			.runsOf("javac")
			.filter((run) => run.args.includes("-Xdiags:verbose") && !run.args.includes("-implicit:none"));
		expect(compiles).toHaveLength(2);
		for (const run of compiles) {
			const outIndex = run.args.indexOf("-d");
			// Mixing modules would write classes into the wrong output tree.
			expect(run.args[outIndex + 1]).toMatch(/demo-(biz|shared)/);
		}
	});

	it("explains a compile failure as a knock-on effect of a changed signature", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		fake.proc.handler = (spec) => {
			if (spec.args.includes("-implicit:none")) return { status: 0 };
			return { status: 1, stderr: "D:/proj/Other.java:9: 错误: 找不到符号\n" };
		};
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.stage).toBe("compile");
			// The pre-flight uses -implicit:none and only sees the named files, so this
			// failure class is invisible to it and the message has to say so.
			expect(String(result.error.detail.hint)).toContain("改了签名");
		}
	});

	it("marks the resident JVM instead of restarting it, so N compiles cost one restart", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		// Faithful lifecycle: after SHUTDOWN nothing answers until a new JVM starts.
		let down = false;
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SHUTDOWN") {
				down = true;
				return { ok: true, text: "RESULT OK 0\n" };
			}
			if (down && fake.proc.detached.length === 0) return { ok: false, why: "ECONNREFUSED" };
			return { ok: true, text: "RESULT OK 0\nup\n" };
		};
		fake.proc.handler = (spec) =>
			spec.command === "where" ? { status: 0, stdout: "C:/jdk/bin/javac.exe" } : { status: 0 };
		fake.fs.put("C:/jdk/lib/tools.jar", "tools");
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 999,
				keyId: fake.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(999);
		const result = await fast(fake.ctx, []);
		// Deferred, not skipped: the marker is what stops a probe from using the JVM
		// that still holds the pre-compile classes. Compiling twice must not restart
		// twice, and must not leave the second compile unmarked either.
		expect(result.ok && result.value.residentJvm).toBe("restart-deferred");
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(true);
		expect(down).toBe(false);
		const again = await fast(fake.ctx, ["A"]);
		expect(again.ok && again.value.residentJvm).toBe("restart-deferred");
		expect(fake.proc.detached).toHaveLength(0);
	});

	it("leaves another RuntimeKey's JVM alone instead of restarting it", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\nup\n" });
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 999, keyId: "someone-else", port: 1, startedAt: "" }),
		);
		fake.proc.livePids.add(999);
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.residentJvm).toBe("not-running");
		expect(result.value.notes.some((note) => note.includes("属于别的 RuntimeKey"))).toBe(true);
		expect(fake.proc.killed).toHaveLength(0);
	});

	it("builds the artifacts first when they are missing", async () => {
		const fake = makeContext({ unbuilt: true });
		addSource(fake, "demo-biz", "A.java");
		fake.proc.handler = (spec) => {
			// A real gradle run leaves the artifacts behind, so later ensureBuilt calls
			// are existence checks rather than repeat builds.
			if (spec.args.some((arg) => arg.includes("cosmicPathingJar"))) {
				fake.fs.put(fake.ctx.layout.pathingJar, "jar");
				fake.fs.put(fake.ctx.layout.javacArgs, fakeArgfile(fake.ctx.layout));
			}
			return { status: 0 };
		};
		await fast(fake.ctx, []);
		const gradle = fake.proc.runs.filter((run) => run.command.includes("gradlew"));
		expect(gradle).toHaveLength(2);
		// --module narrows :module:build only; the pathing jar always covers every
		// code module, since one missing module is a NoClassDefFoundError.
		expect(gradle[1]?.args.some((arg) => arg.includes("cosmicPathingJar"))).toBe(true);
	});

	it("reports a Gradle failure as a value, not by exiting the process", async () => {
		const fake = makeContext({ unbuilt: true });
		addSource(fake, "demo-biz", "A.java");
		fake.proc.handler = (spec) => (spec.command.includes("gradlew") ? { status: 1, stderr: "boom" } : { status: 0 });
		const result = await fast(fake.ctx, []);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("BUILD_FAILED");
	});
});
