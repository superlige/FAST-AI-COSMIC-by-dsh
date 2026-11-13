import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("纠错后的完整条件不会再次被引号校验拒绝", () => {
	const source = readFileSync("resources/probes/DataQueryProbe.java", "utf8");
	const start = source.indexOf("    private static boolean quoting(");
	const method = source.slice(start, source.indexOf("    /** 要打印的字段", start));
	const dir = mkdtempSync(join(tmpdir(), "query-correction-"));
	try {
		writeFileSync(
			join(dir, "QueryCorrection.java"),
			`
import java.util.*;
public class QueryCorrection {
${method}
 public static void main(String[] args) {
  String expected = "01012611040002,01012611040003,01012611040004";
  for (String op : new String[]{"in", "not in"}) {
   for (String raw : new String[]{
     "('01012611040002','01012611040003','01012611040004')",
     "'01012611040002','01012611040003','01012611040004'",
     "(01012611040002,01012611040003,01012611040004)"}) {
    List<String> errors = new ArrayList<String>();
    if (!quoting("billno", op, raw, errors)) throw new AssertionError(raw);
    String message = errors.get(0);
    String prefix = "写成「billno " + op + " ";
    int offset = message.indexOf(prefix);
    if (offset < 0) throw new AssertionError(message);
    String suggested = message.substring(offset + prefix.length(), message.indexOf("」", offset));
    if (!expected.equals(suggested)) throw new AssertionError(message);
    if (quoting("billno", op, suggested, new ArrayList<String>())) throw new AssertionError(message);
   }
  }
  for (String op : new String[]{"=", "like", "in"}) {
   List<String> errors = new ArrayList<String>();
   if (!quoting("billno", op, "'0001'", errors)) throw new AssertionError(op);
   if (!errors.get(0).contains("写成「billno " + op + " 0001」")) throw new AssertionError(errors);
   if (quoting("billno", op, "0001", new ArrayList<String>())) throw new AssertionError(op);
  }
 }
}
`,
		);
		const compiled = spawnSync("javac", ["-encoding", "UTF-8", join(dir, "QueryCorrection.java")], {
			encoding: "utf8",
		});
		expect(compiled.status, compiled.stderr).toBe(0);
		const run = spawnSync("java", ["-cp", dir, "QueryCorrection"], { encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);
