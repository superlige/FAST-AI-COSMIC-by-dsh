/**
 * 把一份 JSON 文字排成能按行读的样子（S37 2-A.3）。
 *
 * 为什么：`ptpl dump` 以前写出的设计数据、多语言映射都是一整行，250 KB 一行。模型 grep 它，
 * 一命中就是整份文件；只好改用 python 一层层解析（09-22 第三份样本 34 次）。
 * 文件本身分行了，grep、`raw` 取回、普通 diff 就都能用，用不着再告诉模型"去用某某工具"。
 *
 * 规则只有一条，和 Prettier 的思路一样——**放得下一行就一行，放不下再拆开**：
 *
 *   - 一个值连同它前面的缩进和键，紧凑写法不超过 {@link JSON_LAYOUT_WIDTH} 个字符，就整个写在一行；
 *   - 放不下的对象、数组，每个成员单独一行，缩进一个制表符，再对每个成员套同一条规则；
 *   - 一个字符串本身就超宽时没法拆，照原样占一行（真机导出里这种行是长公式，几百字节）。
 *
 * 所以多语言映射是一条一行（`"<控件id>.text":{"zh_CN":"设备型号"}`，grep 值就能看到是哪个控件），
 * 设计数据是一个属性一行、边框这类小对象一行。宽度取 200：pi 的 grep 工具超过 500 字符就截行。
 *
 * 只改空白，不碰值：字符串的转义、数字的写法（`16.0` 不会变成 `16`）原样保留，键的顺序不动。
 * 同一份数据排出来永远一样，所以同一模板导出两次，普通 diff 只出真改动。
 *
 * `resources/probes/JsonLayout.java` 是同一条规则的 Java 版（探针写文件用），
 * 两边拿 `test/fixtures/json-layout.*` 对齐；改一边不改另一边，测试会红。
 */

/** 一行最多放多少字符（按 UTF-16 码元数，和 Java `String.length()` 同一口径）。 */
export const JSON_LAYOUT_WIDTH = 200;

type Node = { scalar: string } | { members: { key: string | null; value: Node; flat: string }[]; open: string };

/**
 * 排版。输入不是合法 JSON 时原样返回——排版只是为了好读，不能因此丢一个字节。
 * 结果末尾带一个换行。
 */
export function layoutJson(text: string): string {
	let tree: Node;
	try {
		tree = new Reader(text).document();
	} catch {
		return text;
	}
	return `${lay(tree, flat(tree), 0, 0)}\n`;
}

function flat(node: Node): string {
	if ("scalar" in node) return node.scalar;
	const close = node.open === "{" ? "}" : "]";
	return `${node.open}${node.members.map((m) => (m.key === null ? m.flat : `${m.key}:${m.flat}`)).join(",")}${close}`;
}

function lay(node: Node, compact: string, depth: number, prefix: number): string {
	if ("scalar" in node || node.members.length === 0 || depth + prefix + compact.length <= JSON_LAYOUT_WIDTH)
		return compact;
	const inner = "\t".repeat(depth + 1);
	const rows = node.members.map((m) =>
		m.key === null
			? `${inner}${lay(m.value, m.flat, depth + 1, 0)}`
			: `${inner}${m.key}:${lay(m.value, m.flat, depth + 1, m.key.length + 1)}`,
	);
	return `${node.open}\n${rows.join(",\n")}\n${"\t".repeat(depth)}${node.open === "{" ? "}" : "]"}`;
}

class Reader {
	private i = 0;
	private readonly s: string;
	constructor(s: string) {
		this.s = s;
	}

	document(): Node {
		const value = this.value();
		this.space();
		if (this.i !== this.s.length) throw new Error("尾部还有内容");
		return value;
	}

	private space(): void {
		while (this.i < this.s.length && " \t\r\n".includes(this.s[this.i] as string)) this.i++;
	}

	private value(): Node {
		this.space();
		const ch = this.s[this.i];
		if (ch === "{" || ch === "[") return this.container(ch);
		if (ch === '"') return { scalar: this.string() };
		const start = this.i;
		while (this.i < this.s.length && !",]}: \t\r\n".includes(this.s[this.i] as string)) this.i++;
		if (this.i === start) throw new Error(`第 ${start} 个字符不是值`);
		return { scalar: this.s.slice(start, this.i) };
	}

	private container(open: "{" | "["): Node {
		const close = open === "{" ? "}" : "]";
		this.i++;
		const members: { key: string | null; value: Node; flat: string }[] = [];
		this.space();
		if (this.s[this.i] === close) {
			this.i++;
			return { members, open };
		}
		for (;;) {
			let key: string | null = null;
			if (open === "{") {
				this.space();
				if (this.s[this.i] !== '"') throw new Error(`第 ${this.i} 个字符应是键`);
				key = this.string();
				this.space();
				if (this.s[this.i] !== ":") throw new Error(`第 ${this.i} 个字符应是冒号`);
				this.i++;
			}
			const value = this.value();
			members.push({ key, value, flat: flat(value) });
			this.space();
			const next = this.s[this.i];
			this.i++;
			if (next === ",") continue;
			if (next === close) return { members, open };
			throw new Error(`第 ${this.i - 1} 个字符应是逗号或 ${close}`);
		}
	}

	private string(): string {
		const start = this.i;
		this.i++;
		while (this.i < this.s.length && this.s[this.i] !== '"') this.i += this.s[this.i] === "\\" ? 2 : 1;
		if (this.i >= this.s.length) throw new Error("字符串没有收尾");
		this.i++;
		return this.s.slice(start, this.i);
	}
}
