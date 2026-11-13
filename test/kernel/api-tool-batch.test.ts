import { beforeEach, describe, expect, it } from "vitest";
import { forgetReflectionAnswers, reflectBatch } from "../../src/kernel/api-tool.ts";
import { parseSuggest } from "../../src/kernel/diag/javac.ts";
import { makeContext } from "./fake-context.ts";

/**
 * S63：`suggest` 每次另起一个 Java 进程。临时探针每跑一次都先把它用到的类和方法问一遍，
 * 源码没改也照问（真机 2026-10-11：5 次临时探针各多等 1.9 秒，头一回 10.9 秒）。
 * 问过的答案按「问的是什么」记在进程里，一批里没问过的才发给小工具。
 */
describe("reflectBatch 问过的不再问（S63）", () => {
	beforeEach(() => forgetReflectionAnswers());

	function tool() {
		const fake = makeContext();
		const { fs, proc, ctx } = fake;
		fs.write(ctx.layout.apiToolSrc, "class ApiTool {}");
		fs.write(`${ctx.layout.toolClasses}/ApiTool.class`, "compiled");
		fs.write(ctx.layout.pathingJar, "jar");
		fs.write(ctx.layout.javacArgs, "-cp x");
		const asked: string[][] = [];
		proc.handler = (spec) => {
			if (spec.command !== "java") return { status: 0 };
			const queryFile = spec.args[spec.args.indexOf("suggest") + 1] as string;
			const lines = fs.read(queryFile).split("\n").filter(Boolean);
			asked.push(lines);
			// 每条查询一段：首行「@@ 编号」，其后是候选；查不到就只有那一行。
			const stdout = lines
				.map((line) => {
					const [id, kind, owner, member] = line.split("\t");
					return member === "gone"
						? `@@ ${String(id)}\r\n`
						: `@@ ${String(id)}\r\n  ${String(kind)} ${String(owner)}.${String(member)}\r\n`;
				})
				.join("");
			return { status: 0, stdout };
		};
		return { ...fake, asked };
	}
	const query = (id: string, member: string, arity = 1) => `${id}\tmethod\tkd.bos.Helper\t${member}\t${String(arity)}`;

	it("同一批原样再问一遍不起进程，答案一字不差", async () => {
		const t = tool();
		const text = [query("u0", "load"), query("u1", "gone")].join("\n");
		const first = await reflectBatch(t.ctx, text);
		const second = await reflectBatch(t.ctx, text);
		expect(t.asked).toHaveLength(1);
		expect(second).toBe(first);
		const answers = parseSuggest(first as string);
		expect(answers.get("u0")).toEqual(["  method kd.bos.Helper.load"]);
		// 查不到也是答案：有这一段、段里是空的，调用方据此说「查无此名」
		expect(answers.get("u1")).toEqual([]);
	});

	it("改了一处调用只问新出现的那条；编号换了位置也认得出问过的", async () => {
		const t = tool();
		await reflectBatch(t.ctx, [query("u0", "load"), query("u1", "save")].join("\n"));
		const out = await reflectBatch(
			t.ctx,
			[query("u0", "save"), query("u1", "query", 3), query("u2", "load")].join("\n"),
		);
		expect(t.asked).toHaveLength(2);
		expect(t.asked[1]).toEqual([query("u1", "query", 3)]);
		const answers = parseSuggest(out as string);
		expect(answers.get("u0")).toEqual(["  method kd.bos.Helper.save"]);
		expect(answers.get("u1")).toEqual(["  method kd.bos.Helper.query"]);
		expect(answers.get("u2")).toEqual(["  method kd.bos.Helper.load"]);
	});

	it("参数个数不同是另一个问题", async () => {
		const t = tool();
		await reflectBatch(t.ctx, query("u0", "load", 1));
		await reflectBatch(t.ctx, query("u0", "load", 2));
		expect(t.asked).toHaveLength(2);
	});

	it("类路径换了（工程重新构建）就从头再问", async () => {
		const t = tool();
		await reflectBatch(t.ctx, query("u0", "load"));
		t.clock.advance(60_000);
		t.fs.write(t.ctx.layout.javacArgs, "-cp y");
		await reflectBatch(t.ctx, query("u0", "load"));
		expect(t.asked).toHaveLength(2);
	});

	it("小工具跑不了时照旧答 null，不把这次记成问过", async () => {
		const t = tool();
		const working = t.proc.handler;
		t.proc.handler = (spec, index) => (spec.command === "java" ? { status: 1 } : working(spec, index));
		expect(await reflectBatch(t.ctx, query("u0", "load"))).toBeNull();
		t.proc.handler = working;
		expect(parseSuggest((await reflectBatch(t.ctx, query("u0", "load"))) as string).get("u0")).toHaveLength(1);
	});
});
