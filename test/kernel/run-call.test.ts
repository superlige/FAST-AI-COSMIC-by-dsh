/**
 * run call：直接调本工程一个类的方法（S24 批 B）。
 *
 * 真机来源：2026-09-17 打印需求那次会话，为了验一个合并方法手写探针造打印数据行，方法名猜错 4 次，
 * 跑出来 11 条通过的断言交付检查也不认。这里测的是起 JVM 之前内核能判的那一半：
 * 参数形状、类在不在本工程、方法名拼没拼错、方法走得到的代码里有没有回滚撤不回的动作，以及断言结果进验证记录。
 */

import { describe, expect, it } from "vitest";
import { planRun, prepareRun, prepareRunInvocation, run } from "../../src/kernel/commands/run.ts";
import { callReach, locateCallClass, parseCallTarget } from "../../src/kernel/policy/call-reach.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const PRINT = "zlgd.zljy.printplugin.MetallographicBilingualPrintPlugin";

/** 一个只有源码的工程：路径按包名摆。 */
function project(files: Record<string, string>): FakeContext {
	const fake = makeContext({ config: { codeModules: ["demo-biz"] }, probes: ["CallSim"] });
	const dirs = fake.ctx.layout.moduleDirs[0];
	for (const [fqn, source] of Object.entries(files)) {
		const rel = fqn.replace(/\./g, "/");
		fake.fs.put(`${dirs?.src}/${rel}.java`, source, 1);
		// 编译过的：不然 run 会先被「源码比 .class 新」拦下
		fake.fs.put(`${dirs?.out}/${rel}.class`, "class", 2);
	}
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/CallSim.java`, "public class CallSim {}");
	return fake;
}

const PRINT_SOURCE = `package zlgd.zljy.printplugin;
import zlgd.zljy.printplugin.support.Pivot;
import zlgd.common.Remote;
public class MetallographicBilingualPrintPlugin extends AbstractPrintPlugin {
	@Override
	public void afterLoadData(AfterLoadDataEvent evt) {
		Remote.push(evt);
		collapse(null, null);
	}
	public static List<DataRowSet> collapse(List<DataRowSet> entries, List<String> items) {
		// HttpClient 写在注释里不算
		String note = "sendMessage 写在字符串里也不算";
		return merge(Pivot.text(entries), items);
	}
	private static List<DataRowSet> merge(Object rows, List<String> items) {
		if (rows == null) { return null; }
		return new ArrayList<>();
	}
}`;

const PIVOT_SOURCE = `package zlgd.zljy.printplugin.support;
public class Pivot {
	public static Object text(Object rows) { return rows; }
}`;

const REMOTE_SOURCE = `package zlgd.common;
public class Remote {
	public static void push(Object x) { new HttpClient().post(x); }
}`;

describe("run call 的参数形状：起 JVM 之前就判", () => {
	it("真提交、走常驻进程（S27）；--args 原样交给探针，没给就是 []", () => {
		const planned = planRun([
			"call",
			`${PRINT}#collapse`,
			"--args",
			'[[{"zlgd_bz_jx":""}],["显微组织"]]',
			"--expect",
			"[0].zlgd_bz_jx=/",
			"--expect",
			"size=1",
		]);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		expect(planned.value.probe).toBe("CallSim");
		expect(planned.value.cold).toBe(false);
		expect(planned.value.env).toEqual({
			CALL_TARGET: `${PRINT}#collapse`,
			CALL_ARGS: '[[{"zlgd_bz_jx":""}],["显微组织"]]',
			CALL_EXPECT: "[0].zlgd_bz_jx=/;size=1",
		});
		const bare = planRun(["call", "Foo#bar"]);
		expect(bare.ok && bare.value.env.CALL_ARGS).toBe("[]");
	});

	it("目标不是 类#方法、--args 不是 JSON 数组、断言形状不对、多出位置参数：一次说全", () => {
		const prepared = prepareRun(
			["call", "Foo.bar", "extra", "--args", "{bad", "--expect", "=1", "--expect", "[0].x=1"],
			"runtime-1",
		);
		expect(prepared.plan).toBeNull();
		const text = prepared.blockers.map((blocker) => blocker.message).join("\n");
		expect(prepared.blockers).toHaveLength(4);
		expect(text).toContain("类名#方法名");
		expect(text).toContain("多出了：extra");
		expect(text).toContain("不是合法 JSON");
		expect(text).toContain("--expect 写法不对：=1");

		const notArray = prepareRun(["call", "Foo#bar", "--args", '{"a":1}'], "runtime-1");
		expect(notArray.blockers[0]?.message).toContain("要是 JSON 数组");
	});

	it("认得的断言写法：返回值路径、$、size、args[i]、error", () => {
		for (const good of [
			"$=1",
			"[0].zlgd_bz_jx=/",
			"size=2",
			"args[0][1].x~=甲",
			"error=",
			"error~=不能为空",
			"a.b[2].c=x",
		]) {
			expect(planRun(["call", "Foo#bar", "--expect", good]).ok, good).toBe(true);
		}
	});

	it("别的子命令的参数不收：--set / --pk 被当场拒并说谁读它", () => {
		const prepared = prepareRun(["call", "Foo#bar", "--pk", "1"], "runtime-1");
		expect(prepared.blockers[0]?.message).toBe("run call 不读 --pk");
	});

	it("目标写法解析：全类名、简单类名、带参数类型", () => {
		expect(parseCallTarget("a.b.Foo#bar")).toEqual({ cls: "a.b.Foo", method: "bar", signature: null });
		expect(parseCallTarget("Foo#bar(List, Map)")).toEqual({ cls: "Foo", method: "bar", signature: ["List", "Map"] });
		expect(parseCallTarget("Foo#bar()")).toEqual({ cls: "Foo", method: "bar", signature: [] });
		expect(parseCallTarget("Foo.bar")).toBeNull();
		expect(parseCallTarget("#bar")).toBeNull();
	});
});

describe("run call 读源码的前检", () => {
	it("类不在本工程源码里：拦下，并给名字相近的", () => {
		const fake = project({ [PRINT]: PRINT_SOURCE });
		const prepared = prepareRunInvocation(fake.ctx, [
			"call",
			"zlgd.zljy.printplugin.MetallographicBilingualPrintPlugn#collapse",
		]);
		expect(prepared.plan).toBeNull();
		expect(prepared.blockers[0]?.message).toContain("本工程源码里没有类");
		expect(prepared.blockers[0]?.remedy).toContain(PRINT);

		const platform = prepareRunInvocation(fake.ctx, ["call", "kd.bos.servicehelper.QueryServiceHelper#query"]);
		expect(platform.blockers[0]?.remedy).toContain("只调本工程源码里的类");
	});

	it("简单类名：唯一就认，重名就要全类名；认出来的全类名交给探针", () => {
		const fake = project({
			[PRINT]: PRINT_SOURCE,
			"zlgd.other.Pivot": PIVOT_SOURCE,
			"zlgd.zljy.printplugin.support.Pivot": PIVOT_SOURCE,
		});
		const unique = prepareRunInvocation(fake.ctx, ["call", "MetallographicBilingualPrintPlugin#collapse"]);
		expect(unique.blockers).toEqual([]);
		expect(unique.plan?.env.CALL_CLASS).toBe(PRINT);
		const twice = prepareRunInvocation(fake.ctx, ["call", "Pivot#text"]);
		expect(twice.blockers[0]?.message).toContain("不止一个");
		expect(twice.blockers[0]?.remedy).toContain("zlgd.other.Pivot");
		// 内部类落到外层类的文件上
		expect(locateCallClass(fake.ctx, `${PRINT}$Collector`).state).toBe("found");
	});

	it("方法名拼错：按本类声明的方法给候选；认不出又不像拼错的交给探针按反射判", () => {
		const fake = project({ [PRINT]: PRINT_SOURCE, "zlgd.zljy.printplugin.support.Pivot": PIVOT_SOURCE });
		const typo = prepareRunInvocation(fake.ctx, ["call", `${PRINT}#colapse`]);
		expect(typo.blockers[0]?.message).toContain("里没有方法 colapse");
		expect(typo.blockers[0]?.remedy).toContain("collapse");
		// 继承来的方法（父类在 jar 里）源码里看不到：不拦
		expect(prepareRunInvocation(fake.ctx, ["call", `${PRINT}#execute`]).blockers).toEqual([]);
	});

	it("只按被调方法走到的代码判：同一个类里别的方法调接口，不提这个纯计算方法", () => {
		const fake = project({
			[PRINT]: PRINT_SOURCE,
			"zlgd.zljy.printplugin.support.Pivot": PIVOT_SOURCE,
			"zlgd.common.Remote": REMOTE_SOURCE,
		});
		const pure = prepareRunInvocation(fake.ctx, ["call", `${PRINT}#collapse`]);
		expect(pure.blockers).toEqual([]);
		expect(pure.warnings.join("\n")).not.toContain("HttpClient");
		// 注释、字符串里的关键字不算；本类 merge、引用到的 Pivot 都走到了
		const reach = callReach(
			fake.ctx,
			{
				fqn: PRINT,
				simple: "MetallographicBilingualPrintPlugin",
				pkg: "zlgd.zljy.printplugin",
				file: `${fake.ctx.layout.moduleDirs[0]?.src}/${PRINT.replace(/\./g, "/")}.java`,
			},
			"collapse",
		);
		expect(reach.methodFound).toBe(true);
		expect(reach.visited).toBe(2);

		// S27：测试环境放开了外部接口，照跑，只提醒会真的发出去，并说清是从哪条引用链走到的。
		const event = prepareRunInvocation(fake.ctx, ["call", `${PRINT}#afterLoadData`]);
		expect(event.blockers).toEqual([]);
		expect(event.plan?.env.CALL_CLASS).toBe(PRINT);
		const note = event.warnings.join("\n");
		expect(note).toContain("HttpClient");
		expect(note).toContain("MetallographicBilingualPrintPlugin → Remote");
		expect(note).toContain("会真的发出去");
	});

	it("另开事务、调起别的操作：S27 起都真提交，不拦也不再单列", () => {
		const fake = project({
			"zlgd.task.FeedBackTask": `package zlgd.task;
public class FeedBackTask extends AbstractTask {
	public void execute(RequestContext rc, Map<String, Object> map) {
		try (TXHandle h = TX.requiresNew()) { save(); }
	}
	private void save() {}
}`,
			"zlgd.task.PushTask": `package zlgd.task;
public class PushTask extends AbstractTask {
	public void execute(RequestContext rc, Map<String, Object> map) {
		OperationServiceHelper.executeOperate("audit", "zlgd_bill", rows, null);
	}
}`,
		});
		const escaped = prepareRunInvocation(fake.ctx, ["call", "zlgd.task.FeedBackTask#execute"]);
		expect(escaped.blockers).toEqual([]);
		expect(escaped.warnings).toEqual([]);
		const cascade = prepareRunInvocation(fake.ctx, ["call", "zlgd.task.PushTask#execute"]);
		expect(cascade.blockers).toEqual([]);
		expect(cascade.warnings).toEqual([]);
	});

	it("方法调到的本类方法没声明（在父类里）：父类是本工程的类就按整个文件查", () => {
		const fake = project({
			"zlgd.task.BaseTask": `package zlgd.task;
public class BaseTask { protected void notify(Object x) { MessagePublisher.send(x); } }`,
			"zlgd.task.ChildTask": `package zlgd.task;
public class ChildTask extends BaseTask {
	public void run() { notify(1); }
}`,
		});
		const prepared = prepareRunInvocation(fake.ctx, ["call", "zlgd.task.ChildTask#run"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.warnings.join("\n")).toContain("MessagePublisher");
		expect(prepared.warnings.join("\n")).toContain("BaseTask（父类）");
	});
});

describe("run call 的结果进验证记录", () => {
	it("断言全过留一条 PASS，命令原样记下；本工程包前缀交给探针", async () => {
		const fake = project({ [PRINT]: PRINT_SOURCE, "zlgd.zljy.printplugin.support.Pivot": PIVOT_SOURCE });
		fake.proc.handler = () => ({
			status: 0,
			stdout:
				'[PROBE-JSON] {"t":"assert","kind":"call","target":"[0].zlgd_bz_jx","expect":"/","actual":"/","pass":true}\n[PROBE-OK]\n',
		});
		const argv = ["call", `${PRINT}#collapse`, "--args", '[[{"zlgd_bz_jx":""}],[]]', "--expect", "[0].zlgd_bz_jx=/"];
		const result = await run(fake.ctx, argv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const java = fake.proc.runsOf("java")[0];
		expect(java?.env.CALL_CLASS).toBe(PRINT);
		expect(java?.env.CALL_ARGS).toBe('[[{"zlgd_bz_jx":""}],[]]');
		// 加载不到时探针拿它分清「没编译」和「类路径不对」。
		expect(java?.env.CALL_CLASS_DIRS).toBe(fake.ctx.layout.moduleDirs[0]?.out);
		expect(result.value.evidence.filed[0]).toMatchObject({ result: "PASS", argv });
		// 这份输出里没有平台 SQL 日志：写没写库确认不了，记录里不写
		expect(result.value.evidence.filed[0]?.writtenTables).toBeUndefined();
	});

	it("验证记录照完整日志里的写库语句记下写了哪些表；只读的方法调用记成空", async () => {
		const fake = project({ [PRINT]: PRINT_SOURCE, "zlgd.zljy.printplugin.support.Pivot": PIVOT_SOURCE });
		const sql = (statement: string) => `INFO DB : ----sql@secd->secd#con1----\n#cost:1ms\n${statement}\n`;
		const pass =
			'[PROBE-JSON] {"t":"assert","kind":"call","target":"[0].zlgd_bz_jx","expect":"/","actual":"/","pass":true}\n';
		const argv = ["call", `${PRINT}#collapse`, "--args", "[[],[]]", "--expect", "[0].zlgd_bz_jx=/"];
		fake.proc.handler = () => ({
			status: 0,
			stdout: `${sql("/*ORM*/ SELECT FId FROM tk_zlgd_bill")}${pass}[PROBE-OK]\n`,
		});
		const read = await run(fake.ctx, argv);
		if (!read.ok) throw new Error("expected a run");
		expect(read.value.evidence.filed[0]?.writtenTables).toEqual([]);
		fake.proc.handler = () => ({
			status: 0,
			stdout: `${sql("/*ORM*/ DELETE FROM tk_zlgd_bill WHERE FId = ?")}${pass}[PROBE-OK]\n`,
		});
		const wrote = await run(fake.ctx, [...argv.slice(0, 3), "[[1],[]]", ...argv.slice(4)]);
		if (!wrote.ok) throw new Error("expected a run");
		expect(wrote.value.evidence.filed[0]?.writtenTables).toEqual(["tk_zlgd_bill"]);
	});

	it("探针说输入不成立（参数造不出来）：不留记录，改对再跑", async () => {
		const fake = project({ [PRINT]: PRINT_SOURCE, "zlgd.zljy.printplugin.support.Pivot": PIVOT_SOURCE });
		fake.proc.handler = (spec) => ({
			status: spec.command === "java" ? 1 : 0,
			stdout:
				'[PROBE-JSON] {"t":"input-invalid","kind":"call-args","target":"参数1（List<DataRowSet>）[0]","why":"要对象，给的是字符串"}\n',
		});
		const result = await run(fake.ctx, ["call", `${PRINT}#collapse`, "--args", '[["x"],[]]', "--expect", "size=1"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.evidence.filed).toEqual([]);
		expect(result.value.evidence.notes.join()).toContain("输入不成立");
	});
});
