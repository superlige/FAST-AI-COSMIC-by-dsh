import { describe, expect, it } from "vitest";
import {
	OUTLINE_MIN_BYTES,
	outlineInsteadOfRead,
	outlineJava,
	renderOutline,
} from "../../src/agent/tools/java-outline.ts";

/** 一份带各种容易数错大括号写法的插件：注释、字符串、字符里的括号，匿名类、lambda、嵌套类型。 */
const PLUGIN = [
	"package zlgd.demo;", // 1
	"", // 2
	"import java.util.*;", // 3
	"", // 4
	"/** 注释里的 { 不算 } */", // 5
	"public class DemoPlugin extends AbstractBillPlugIn implements Cloneable {", // 6
	'    private static final String ENTRY = "zlgd_entry";', // 7
	'    private static final String TIP = "保存前 { 校验 }";', // 8
	'    private static final Set<String> KEYS = new HashSet<>(Arrays.asList("zlgd_a", "zlgd_b"));', // 9
	"    private final Runnable hook = new Runnable() {", // 10
	"        public void run() { }", // 11
	"    };", // 12
	"    static {", // 13
	"        init();", // 14
	"    }", // 15
	"", // 16
	"    @Override", // 17
	"    public void registerListener(EventObject e) {", // 18
	'        String brace = "}"; // 行尾注释 {', // 19
	"        char open = '{';", // 20
	"        list.forEach(item -> { item.run(); });", // 21
	"        getModel().getEntryEntity(ENTRY);", // 22
	"    }", // 23
	"", // 24
	'    @SuppressWarnings("unchecked")', // 25
	"    private <T> List<T> load(Map<String, List<T>> rows, int size) throws KDException {", // 26
	'        if (rows.containsKey("zlgd_qty")) {', // 27
	'            return rows.get("zlgd_qty");', // 28
	"        }", // 29
	"        return null;", // 30
	"    }", // 31
	"", // 32
	"    static class Row {", // 33
	"        int value() {", // 34
	"            return ENTRY.length();", // 35
	"        }", // 36
	"    }", // 37
	"}", // 38
	"",
].join("\n");

describe("Java 提纲", () => {
	it("方法、类型、常量的行号和源码对得上", () => {
		const outline = outlineJava(PLUGIN);
		expect(outline).not.toBeNull();
		if (outline === null) return;
		expect(outline.types).toEqual([
			{ from: 6, to: 38, label: "class DemoPlugin extends AbstractBillPlugIn implements Cloneable" },
			{ from: 33, to: 37, label: "class DemoPlugin.Row" },
		]);
		expect(outline.methods).toEqual([
			{ from: 13, to: 15, label: "静态初始化块" },
			// 方法从注解那一行起，带 offset 读的时候注解一起给到。
			{ from: 17, to: 23, label: "registerListener(EventObject e)" },
			{ from: 25, to: 31, label: "load(Map<String, List<T>> rows, int size)" },
			{ from: 34, to: 36, label: "DemoPlugin.Row.value()" },
		]);
		// 匿名类里的 run() 属于字段初始化，不当成员方法。
		expect(outline.methods.map((method) => method.label)).not.toContain("run()");
		expect(outline.constants).toEqual([
			{ line: 7, name: "ENTRY", value: "zlgd_entry", literals: 1 },
			{ line: 8, name: "TIP", value: "保存前 { 校验 }", literals: 1 },
			{ line: 9, name: "KEYS", value: null, literals: 2 },
		]);
	});

	it("编码 → 行号：直接写的和经常量引用的都算上", () => {
		const outline = outlineJava(PLUGIN);
		const codes = new Map(outline?.codes.map((row) => [row.code, row]));
		// 第 7 行声明，第 22、35 行经常量用到。
		expect(codes.get("zlgd_entry")).toEqual({ code: "zlgd_entry", lines: [7, 22, 35], via: ["ENTRY"] });
		expect(codes.get("zlgd_qty")?.lines).toEqual([27, 28]);
		expect(codes.get("zlgd_a")?.lines).toEqual([9]);
		// 中文提示、带空格的字符串不是编码。
		expect([...codes.keys()].some((code) => code.includes("校验"))).toBe(false);
	});

	it("常量用到哪几行只认完整的、前面不是点的标识符", () => {
		const source = [
			"public class DemoCon {", // 1
			'    public static final String KEY = "demo_key";', // 2
			'    public static final String $CODE = "demo_code";', // 3
			"    void use() {", // 4
			"        get(KEY);", // 5 算
			"        get(Other.KEY);", // 6 前面是点，不算
			"        get(KEY_NAME);", // 7 更长的名字，不算
			"        get(MY_KEY);", // 8 不算
			"        get(a$KEY);", // 9 前面接着 $，不算
			"        get(中KEY);", // 10 前面是中文（不在 \\w 里），算
			"        get($CODE); get(x.$CODE);", // 11 前一个算
			"        // KEY 在注释里", // 12 注释，不算
			'        get("KEY");', // 13 字符串里，不算
			"    }",
			"}",
			"",
		].join("\n");
		const codes = new Map(outlineJava(source)?.codes.map((row) => [row.code, row]));
		expect(codes.get("demo_key")?.lines).toEqual([2, 5, 10]);
		expect(codes.get("demo_code")?.lines).toEqual([3, 11]);
	});

	it("提纲文字：给读法、编码表，值是编码的常量不重复列", () => {
		const outline = outlineJava(PLUGIN);
		if (outline === null) throw new Error("解析失败");
		const text = renderOutline("src/DemoPlugin.java", outline, 30_000);
		expect(text).toContain("src/DemoPlugin.java：39 行、29.3 KiB。这次先给提纲，没有给正文。");
		expect(text).toContain("offset=17, limit=7");
		expect(text).toContain("再整份读一次这个文件就给");
		expect(text).toContain("  第 17–23 行 registerListener(EventObject e)");
		expect(text).toContain("  zlgd_entry：第 7、22、35 行（经常量 ENTRY）");
		expect(text).toContain('  第 8 行 TIP = "保存前 { 校验 }"');
		expect(text).toContain("  第 9 行 KEYS（2 个字符串）");
		expect(text).not.toContain('ENTRY = "zlgd_entry"');
	});

	it("没把握就返回 null：括号不配对、注释或字符串没闭合、没有类型", () => {
		expect(outlineJava(PLUGIN.replace("    }\n\n    @Override", "\n\n    @Override"))).toBeNull();
		expect(outlineJava(`${PLUGIN}\n}`)).toBeNull();
		expect(outlineJava(PLUGIN.replace("/** 注释里的 { 不算 } */", "/** 没闭合"))).toBeNull();
		expect(outlineJava(PLUGIN.replace('"}"; // 行尾注释 {', '"}; // 行尾注释 {'))).toBeNull();
		expect(outlineJava("// 只有注释\n".repeat(50))).toBeNull();
	});
});

describe("整份读换成提纲", () => {
	/** 把样例插件的方法体撑到超过阈值。 */
	const filler = Array.from(
		{ length: 400 },
		(_, i) => `        getModel().setValue("zlgd_f${String(i % 7)}", ${String(i)}); // 填充 ${"x".repeat(20)}`,
	).join("\n");
	const big = PLUGIN.replace("        getModel().getEntryEntity(ENTRY);", filler);
	const base = { path: "src/DemoPlugin.java", file: "D:/p/src/DemoPlugin.java", key: "d:/p/src/demoplugin.java" };

	it("大文件第一次整份读给提纲，第二次整份读照常给全文", () => {
		expect(Buffer.byteLength(big)).toBeGreaterThan(OUTLINE_MIN_BYTES);
		const outlined = new Set<string>();
		const first = outlineInsteadOfRead({ ...base, outlined, readText: () => big });
		expect(first).toContain("这次先给提纲");
		expect(first).toContain("zlgd_f3：第");
		expect(outlined.has(base.key)).toBe(true);
		expect(outlineInsteadOfRead({ ...base, outlined, readText: () => big })).toBeNull();
	});

	it("带了行号范围、小文件、不是 Java、读不到文件，都照常给", () => {
		const read = (overrides: Partial<Parameters<typeof outlineInsteadOfRead>[0]>) =>
			outlineInsteadOfRead({ ...base, outlined: new Set(), readText: () => big, ...overrides });
		expect(read({ offset: 1 })).toBeNull();
		expect(read({ limit: 200 })).toBeNull();
		expect(read({ readText: () => PLUGIN })).toBeNull();
		expect(read({ file: "D:/p/src/notes.md" })).toBeNull();
		expect(
			read({
				readText: () => {
					throw new Error("ENOENT");
				},
			}),
		).toBeNull();
	});

	it("编码很多时截到 60 条并说出剩下多少", () => {
		const constants = [
			"public class Con {",
			...Array.from({ length: 900 }, (_, i) => `  String K${String(i)} = "zlgd_k${String(i)}";`),
			"}",
		].join("\n");
		expect(Buffer.byteLength(constants)).toBeGreaterThan(OUTLINE_MIN_BYTES);
		const text = outlineInsteadOfRead({ ...base, outlined: new Set(), readText: () => constants });
		expect(text).toContain("另有 840 个编码没列出");
	});

	it("提纲超过原文一半就不换", () => {
		// 方法多、参数长、方法体短：120 条方法行就超过原文一半。
		const params = Array.from({ length: 8 }, (_, i) => `String argument${String(i)}`).join(", ");
		const methods = Array.from({ length: 135 }, (_, i) => `  void m${String(i)}(${params}) {}`);
		const dense = ["public class T {", ...methods, "}"].join("\n");
		expect(Buffer.byteLength(dense)).toBeGreaterThan(OUTLINE_MIN_BYTES);
		expect(outlineInsteadOfRead({ ...base, outlined: new Set(), readText: () => dense })).toBeNull();
	});
});
