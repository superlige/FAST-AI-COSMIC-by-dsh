/**
 * 下推断言 `message=` 要拿到平台逐单报的原因，不能只读总提示。
 *
 * 真机：同一张委托重复下推，平台拒了，日志里逐单写着「已有下游【…】存在，请勿重复下推」，
 * 总提示却是 null；探针只把总提示交给断言，`message=` 记成 actual=null，一条真被拦住的反例记成 FAIL，
 * 还顶掉了同一场景首次下推的 PASS。
 *
 * 拼提示的共用类要连平台才编得过，这里用两个同名桩类代替平台的转换结果，本机有 javac 时当场编译跑一遍；
 * 再查源码：下推探针交给断言的、造数探针报的原因，都走这一个出口。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probePath = (name: string): string =>
	fileURLToPath(new URL(`../../resources/probes/${name}.java`, import.meta.url));
const source = (name: string): string => readFileSync(probePath(name), "utf8").replace(/\r\n/g, "\n");

const STUB_RESULT = `package kd.bos.entity.botp.runtime;
import java.util.List;
public class ConvertOperationResult {
    private final String message;
    private final List<SourceBillReport> reports;
    public ConvertOperationResult(String message, List<SourceBillReport> reports) { this.message = message; this.reports = reports; }
    public String getMessage() { return message; }
    public List<SourceBillReport> getBillReports() { return reports; }
}
`;

const STUB_REPORT = `package kd.bos.entity.botp.runtime;
import java.util.List;
public class SourceBillReport {
    private final String billNo;
    private final Object billId;
    private final List<String> fails;
    public SourceBillReport(String billNo, Object billId, List<String> fails) { this.billNo = billNo; this.billId = billId; this.fails = fails; }
    public String getBillNo() { return billNo; }
    public Object getBillId() { return billId; }
    public List<String> getFailMessages() { return fails; }
}
`;

const MAIN = `import java.io.FileOutputStream;
import java.io.PrintStream;
import java.util.Arrays;
import java.util.Collections;
import kd.bos.entity.botp.runtime.ConvertOperationResult;
import kd.bos.entity.botp.runtime.SourceBillReport;

public class MessageMain {
    public static void main(String[] a) throws Exception {
        PrintStream out = new PrintStream(new FileOutputStream(a[0]), true, "UTF-8");
        out.println("A|" + ConvertMessage.of(new ConvertOperationResult(null, Arrays.asList(
                new SourceBillReport("DEMO-0002", 2L, Arrays.asList("已有下游【demo_target】存在，请勿重复下推"))))));
        out.println("B|" + ConvertMessage.of(new ConvertOperationResult("下推失败", Arrays.asList(
                new SourceBillReport(null, 7L, Arrays.asList("不符合转换规则的数据筛选条件", "第二条")),
                new SourceBillReport("DEMO-0003", 3L, Collections.<String>emptyList())))));
        out.println("C|" + ConvertMessage.of(new ConvertOperationResult(null, null)));
    }
}
`;

describe("下推提示：总提示加逐单原因，日志和断言同一份", () => {
	const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
	it.skipIf(javac.status !== 0)("总提示是 null 时断言照样拿到逐单原因，并带上是哪张源单", () => {
		const dir = mkdtempSync(join(tmpdir(), "push-message-"));
		try {
			const stubs = join(dir, "kd", "bos", "entity", "botp", "runtime");
			mkdirSync(stubs, { recursive: true });
			writeFileSync(join(stubs, "ConvertOperationResult.java"), STUB_RESULT);
			writeFileSync(join(stubs, "SourceBillReport.java"), STUB_REPORT);
			writeFileSync(join(dir, "MessageMain.java"), MAIN);
			const compiled = spawnSync(
				"javac",
				[
					"-encoding",
					"UTF-8",
					"-d",
					dir,
					join(dir, "MessageMain.java"),
					join(stubs, "ConvertOperationResult.java"),
					join(stubs, "SourceBillReport.java"),
					probePath("ConvertMessage"),
				],
				{ encoding: "utf8" },
			);
			expect(compiled.stderr).toBe("");
			const out = join(dir, "out.txt");
			spawnSync("java", ["-cp", dir, "MessageMain", out], { encoding: "utf8" });
			const lines = readFileSync(out, "utf8").replace(/\r\n/g, "\n").split("\n");
			expect(lines[0]).toBe("A|源单 DEMO-0002：已有下游【demo_target】存在，请勿重复下推");
			expect(lines[1]).toBe("B|下推失败；源单 pk=7：不符合转换规则的数据筛选条件；第二条");
			expect(lines[2]).toBe("C|");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("下推探针交给断言的是拼好的提示，不是平台的总提示", () => {
		const push = source("PushSim");
		expect(push).toContain("String message = ConvertMessage.of(result);");
		expect(push).toContain("ExpectSpec.converted(success, message, bills, spec);");
		expect(push).not.toContain("result.getMessage()");
	});

	it("造数探针报下推失败原因也走同一个出口", () => {
		const seed = source("DataSeedProbe");
		expect(seed).toContain("ConvertMessage.of(pushed)");
		expect(seed).not.toContain("pushed.getMessage()");
	});
});
