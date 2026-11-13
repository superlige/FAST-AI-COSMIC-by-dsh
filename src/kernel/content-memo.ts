import { createHash } from "node:crypto";

/**
 * 按「文件 + 内容」记住一次计算的结果：同一个文件内容没变，下次直接给上次算的。
 *
 * 写法检查的常量表、读插件类时附的类索引，都要把全工程几百个 Java 文件挨个拆一遍，
 * 而且隔一分钟就重建一次（让模型这一分钟新写的类能进来）。一分钟里真正变了的通常只有一两个文件，
 * 别的每次重拆都是白干——而这些是在读文件、写文件之后同步做的，拆的那段时间界面跟着冻住。
 * 现在重建照旧每个文件都读，只是内容指纹相同就不再拆；结果和重拆逐字一样。
 *
 * 记的是内容的指纹，不是原文，几百个文件也只占几十 KB。结果会被多次重建共用，调用方不能改它。
 */
export function contentMemo<T>(compute: (file: string, text: string) => T): (file: string, text: string) => T {
	const memo = new Map<string, { digest: string; value: T }>();
	return (file, text) => {
		const digest = createHash("sha1").update(text).digest("base64");
		const hit = memo.get(file);
		if (hit !== undefined && hit.digest === digest) return hit.value;
		const value = compute(file, text);
		memo.set(file, { digest, value });
		return value;
	};
}
