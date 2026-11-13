/**
 * 探针输出里提到的本工程类，标出源码在不在这个工程里（S38）。
 *
 * 平台上的登记记的是类名：接口登记的实现类、单据上绑的插件、转换规则的插件。登记还在、代码早删了，
 * 或者代码在另一个工程里，探针照样把类名打出来，看输出的人分不出来。S37 需求 1 复测里，
 * 一条接口登记指向的类在工程里已经不存在，模型为确认这件事 find、grep、翻运行日志和 git 历史，
 * 一次十几个调用（批 6），另一次照着那条登记重写了一遍（批 8）。
 *
 * 所以在所有探针共用的收尾处统一对一遍，不给某一个探针单独加：只看探针自己打的 `[PROBE]` 行
 * （日志和异常栈里的类名不算，那是运行时真加载过的），只认本工程源码顶层包下的全名
 * （`zlgd.` 这类；`kd.` 开头的平台类不管），按包名拼出 `<模块>/src/main/java/.../X.java` 看在不在。
 * 说的是「本工程源码里没有」，不是「类不存在」：真机登记的实现类 79 个，65 个的源码在别的工程或 jar 里。
 */

/** `a.b.Outer` / `a.b.Outer$Inner`：小写包段加一个大写开头的类名。 */
const FQCN = /\b([a-z][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*\.[A-Z][A-Za-z0-9_]*)(?:\$[A-Za-z0-9_$]*)?/g;

/** 列出的类最多这么多个，多了只报个数。 */
const LIST = 8;

export interface OwnClassLocator {
	/** 本工程源码的顶层包名，`zlgd` 这种。 */
	roots: readonly string[];
	/** 全名 → 相对工程根的源码路径；本工程源码里没有就是 null。 */
	locate: (fqcn: string) => string | null;
}

export function ownClassNote(output: string, locator: OwnClassLocator): string | null {
	if (locator.roots.length === 0) return null;
	const roots = new Set(locator.roots);
	const seen = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		if (!line.startsWith("[PROBE]")) continue;
		for (const match of line.matchAll(FQCN)) {
			const fqcn = match[1] as string;
			if (roots.has(fqcn.split(".")[0] as string)) seen.add(fqcn);
		}
	}
	if (seen.size === 0) return null;
	const found: string[] = [];
	const missing: string[] = [];
	for (const fqcn of seen) {
		const path = locator.locate(fqcn);
		if (path === null) missing.push(fqcn);
		else found.push(`${fqcn} → ${path}`);
	}
	const parts: string[] = [];
	if (missing.length > 0) parts.push(`本工程源码里没有：${clip(missing)}`);
	if (found.length > 0) parts.push(`在工程里：${clip(found)}`);
	return `输出里的本工程类——${parts.join("；")}`;
}

function clip(items: readonly string[]): string {
	return items.length <= LIST ? items.join("、") : `${items.slice(0, LIST).join("、")} 等 ${String(items.length)} 个`;
}
