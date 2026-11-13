import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 编译并运行实际 Java 解析方法，同时回放修复前的行为。
const source = readFileSync(new URL("../resources/probes/ListSim.java", import.meta.url), "utf8");
const methods = source.slice(
	source.indexOf("    static List<Object> values("),
	source.indexOf("    static String prop("),
);
const directory = mkdtempSync(join(tmpdir(), "cosmic-filter-"));
try {
	for (const baseline of [true, false]) {
		const body = baseline ? methods.replace(/ {8}if \(raw.matches\("-\?0.*?\n {8}}\n/s, "") : methods;
		const java = `import java.util.*;
public class FilterValues {
${body}
public static void main(String[] args) {
String[] inputs = {"04022611040002", "00", "001", "-001", "0", "123", "-123", "true", "ABC", "999999999999999999999"};
int passed = 0;
for (String input : inputs) {
Object actual = scalar(input);
boolean numeric = input.equals("0") || input.equals("123") || input.equals("-123");
boolean ok = numeric ? actual instanceof Long : input.equals("true") ? actual instanceof Boolean : actual instanceof String && input.equals(actual);
if (ok) passed++;
System.out.println(input + " -> " + actual + " (" + actual.getClass().getSimpleName() + ") " + ok);
}
boolean multi = values("04022611040002,001,123").equals(Arrays.<Object>asList("04022611040002", "001", Long.valueOf(123)));
if (multi) passed++;
System.out.println("passed=" + passed + "/11");
if (passed != ${baseline ? 6 : 11}) throw new AssertionError(passed);
}}
`;
		writeFileSync(join(directory, "FilterValues.java"), java);
		execFileSync("javac", ["-encoding", "UTF-8", join(directory, "FilterValues.java")]);
		console.log(baseline ? "修复前" : "修复后");
		console.log(execFileSync("java", ["-cp", directory, "FilterValues"], { encoding: "utf8" }));
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
