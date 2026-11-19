/**
 * BotpRuleSyncProbe 改字段映射：取源字段、公式、基础资料常量、清掉映射四种写法。
 *
 * 平台的取值方式枚举是 FieldConvertType{SourceField, Formula, ByCondition, CONSTANT}，规则 XML 里
 * 常量存成 `<ConvertType>CONSTANT</ConvertType>`。探针原来按 "Constant" 认常量，认不出，
 * 改前是常量的映射在确认单上显示成「源字段」或「未映射」。
 *
 * 解析入参的那段只用 java.util，抠出来本机有 javac 时当场编译跑；其余要连平台，查源码。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const java = readFileSync(new URL("../../resources/probes/BotpRuleSyncProbe.java", import.meta.url), "utf8").replace(
	/\r\n/g,
	"\n",
);

/** 从 `start` 所在行起，按花括号配对截出一整段。 */
function block(start: string): string {
	const at = java.indexOf(start);
	if (at < 0) throw new Error(`源码里没有 ${start}`);
	const open = java.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < java.length; i++) {
		if (java[i] === "{") depth++;
		if (java[i] === "}") depth--;
		if (depth === 0) return java.slice(java.lastIndexOf("\n", at) + 1, i + 1);
	}
	throw new Error(`${start} 的花括号没配上`);
}

const MAIN = (mapping: string, parse: string) => `import java.io.FileOutputStream;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class ParseMain {
${mapping}
${parse}
    public static void main(String[] a) throws Exception {
        PrintStream out = new PrintStream(new FileOutputStream(a[0]), true, "UTF-8");
        for (int i = 1; i < a.length; i++) {
            try {
                StringBuilder sb = new StringBuilder();
                for (Mapping m : parseFieldMap(a[i])) {
                    sb.append(m.target).append('|').append(m.kind).append('|').append(m.value).append(';');
                }
                out.println("OK " + sb);
            } catch (IllegalArgumentException e) {
                out.println("ERR " + e.getMessage());
            }
        }
    }
}
`;

describe("BotpRuleSyncProbe 字段映射", () => {
	const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
	it.skipIf(javac.status !== 0)("SYNC_FIELDMAP 四种取值逐项认出，写错的整串拒掉", () => {
		const dir = mkdtempSync(join(tmpdir(), "botp-fieldmap-"));
		try {
			writeFileSync(
				join(dir, "ParseMain.java"),
				MAIN(block("static final class Mapping"), block("static List<Mapping> parseFieldMap")),
			);
			const compiled = spawnSync("javac", ["-encoding", "UTF-8", "-d", dir, join(dir, "ParseMain.java")], {
				encoding: "utf8",
			});
			expect(compiled.stderr).toBe("");
			const out = join(dir, "out.txt");
			const inputs = [
				"demo_org=src:org;demo_dj=const:DJ01;demo_hj=demo_a + 1;demo_bz=clear;demo_x=formula:demo_b = 1",
				"demo_cust=src:demo_customer.name",
				"demo_a=src:org;demo_A=clear",
				"demo_a=",
				"demo_a=src:",
				"=demo_b",
				"demo_a",
			];
			const ran = spawnSync("java", ["-cp", dir, "ParseMain", out, ...inputs], { encoding: "utf8" });
			expect(ran.status, ran.stderr).toBe(0);
			expect(readFileSync(out, "utf8").replace(/\r\n/g, "\n").trim().split("\n")).toEqual([
				"OK demo_org|src|org;demo_dj|const|DJ01;demo_hj|formula|demo_a + 1;demo_bz|clear|;demo_x|formula|demo_b = 1;",
				"OK demo_cust|src|demo_customer.name;",
				"ERR SYNC_FIELDMAP 里目标字段 demo_A 给了两次",
				"ERR SYNC_FIELDMAP 里 demo_a 的取值是空的；要清掉映射写 demo_a=clear",
				"ERR SYNC_FIELDMAP 里 demo_a 的取值是空的；要清掉映射写 demo_a=clear",
				"ERR SYNC_FIELDMAP 的「=demo_b」要写成 目标字段=取值（取值：src:源字段 / const:基础资料id或编码 / clear / 公式）",
				"ERR SYNC_FIELDMAP 的「demo_a」要写成 目标字段=取值（取值：src:源字段 / const:基础资料id或编码 / clear / 公式）",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("取值方式按平台枚举的拼写认：常量是 CONSTANT，按条件取值单独认", () => {
		const describeFn = block("private static String describe(FieldMapItem fm)");
		expect(describeFn).toContain('"CONSTANT".equals(ct)');
		expect(describeFn).toContain('"ByCondition".equals(ct)');
		expect(describeFn).not.toContain('"Constant"');
		const apply = block("private static String applyFieldMap");
		for (const type of ['reset(item, "SourceField")', 'reset(item, "CONSTANT")', 'reset(item, "Formula")']) {
			expect(apply).toContain(type);
		}
	});

	it("换取值方式时四种取值全清；每条改完都过平台的映射校验，目标字段不在时先拦", () => {
		const reset = block("private static void reset(FieldMapItem item");
		for (const call of [
			'setSourceFieldKey("")',
			"setFormula(null)",
			"setConstant(null)",
			"setValByConditions(null)",
			"setValByCondiionsString(null)",
		]) {
			expect(reset).toContain(call);
		}
		const apply = block("private static String applyFieldMap");
		expect(apply).toContain("item.check(st, tt, el,");
		expect(apply.indexOf("RowDataModel.findProperty(tt, m.target)")).toBeLessThan(apply.indexOf("item.check("));
	});

	it("校验点用 (null, 名称) 造根：无参构造的 seqArray 是 null，check 里一建子节点就空指针", () => {
		// 苍穹 8.0 CheckPoint(parent, point) 第 37 行读 parent.getSeqArray().length；
		// 无参 CheckPoint() 不给 seqArray 赋值。真机上 FieldMapItem.check:427 因此抛 NullPointerException。
		expect(java).not.toMatch(/new CheckPoint\(\s*\)/);
		const apply = block("private static String applyFieldMap");
		expect(apply).toContain("new CheckPoint(null, m.target)");
		expect(apply).toContain("item.check(st, tt, el, root, result, mustInput)");
		// 平台校验自己出错时，异常里要说清规则、字段、哪一步
		expect(apply).toMatch(
			/catch \(RuntimeException e\)[\s\S]*el\.getId\(\)[\s\S]*m\.target[\s\S]*FieldMapItem\.check/,
		);
	});

	it("整批校验完才写第一条：校验不过时一条都不存", () => {
		const run = block("public static void run()");
		const abort = run.indexOf("校验不通过");
		const dryRunEnd = run.indexOf("dry-run 结束");
		const firstSave = run.indexOf("ConvertRuleWriter.save(");
		expect(abort).toBeGreaterThan(0);
		expect(abort).toBeLessThan(dryRunEnd);
		expect(dryRunEnd).toBeLessThan(firstSave);
		// 中止那一支在任何保存之前 return
		expect(run.slice(abort, dryRunEnd)).toContain("return;");
	});

	it.skipIf(javac.status !== 0)("SYNC_LINK 写成 源单实体->目标单实体，空串是不改，写错的在读库前拒掉", () => {
		const dir = mkdtempSync(join(tmpdir(), "botp-link-"));
		try {
			writeFileSync(
				join(dir, "LinkMain.java"),
				`import java.io.FileOutputStream;
import java.io.PrintStream;

public class LinkMain {
${block("static final class Link")}
    public static void main(String[] a) throws Exception {
        PrintStream out = new PrintStream(new FileOutputStream(a[0]), true, "UTF-8");
        for (int i = 1; i < a.length; i++) {
            try {
                Link l = Link.parse(a[i]);
                out.println(l == null ? "NONE" : "OK " + l.source + "|" + l.target);
            } catch (IllegalArgumentException e) {
                out.println("ERR " + e.getMessage());
            }
        }
    }
}
`,
			);
			const compiled = spawnSync("javac", ["-encoding", "UTF-8", "-d", dir, join(dir, "LinkMain.java")], {
				encoding: "utf8",
			});
			expect(compiled.stderr).toBe("");
			const out = join(dir, "out.txt");
			const inputs = ["entryentity->entryentity", " demo_bill -> entryentity ", " ", "entryentity", "a->", "a.b->c"];
			const ran = spawnSync("java", ["-cp", dir, "LinkMain", out, ...inputs], { encoding: "utf8" });
			expect(ran.status, ran.stderr).toBe(0);
			const hint = "SYNC_LINK 要写成 源单实体->目标单实体（表头写单据标识，分录写分录标识）";
			expect(readFileSync(out, "utf8").replace(/\r\n/g, "\n").trim().split("\n")).toEqual([
				"OK entryentity|entryentity",
				"OK demo_bill|entryentity",
				"NONE",
				`ERR ${hint}，收到「entryentity」`,
				`ERR ${hint}，收到「a->」`,
				`ERR ${hint}，收到「a.b->c」`,
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("建行层级：改完的规则过整条平台校验只拦新增的问题，丢了原有的上下游关联要拦，全在第一次保存之前", () => {
		const run = block("public static void run()");
		const before = run.indexOf("checkedBefore = link == null ? null : platformCheck(el)");
		const applied = run.indexOf("applyLink(h, el, link, st, tt, linkErrors)");
		const after = run.indexOf("!checkedBefore.contains(msg)");
		const firstSave = run.indexOf("ConvertRuleWriter.save(");
		expect(before).toBeGreaterThan(0);
		expect(before).toBeLessThan(applied);
		expect(applied).toBeLessThan(after);
		expect(after).toBeLessThan(firstSave);
		// 保存、清缓存之后再从库里读回来对
		expect(run.indexOf("readBackLink(changed, link)")).toBeGreaterThan(
			run.lastIndexOf("ConvertRuleWriter.clearCache("),
		);
		const applyLink = block("private static List<String> applyLink");
		expect(applyLink).toMatch(/linkedWas != null && linkedNow == null\)\s*\{\s*errors\.add/);
		// 判断关联配置和下推引擎同一套：关联配置项挂在建行实体下面，实体上真有那个关联属性
		const linkEntity = block("private static String linkEntity");
		expect(linkEntity).toContain("ConvertMetaServiceHelper.loadLinkSet(tt.getName())");
		expect(linkEntity).toContain("instanceof LinkEntryProp");
		// 关联子实体（*_lk）本身也是 EntryType，不能当建行实体
		expect(block("private static EntityType rowEntity")).toContain("!(e instanceof LinkEntryType)");
	});

	it("源字段和公式按每条规则自己的源单解析，不拿第一条规则的源单套全部", () => {
		const run = block("public static void run()");
		expect(run).toContain("typeOf(types, h.source)");
		expect(run).not.toContain("targets.get(0).source");
	});
});
