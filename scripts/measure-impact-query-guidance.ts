/**
 * 只读重放字段查询：记录同一份索引上的报错、重查指引和已查到的读写数。
 * 不开工程、不连环境、不重建索引。
 * node --experimental-strip-types scripts/measure-impact-query-guidance.ts <工程目录> <查询词...>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { queryImpact } from "../src/kernel/commands/impact.ts";
import type { KernelContext } from "../src/kernel/context.ts";
import type { ImpactIndex } from "../src/kernel/impact/model.ts";

const [project, ...terms] = process.argv.slice(2);
if (!project || terms.length === 0) {
	throw new Error("用法：measure-impact-query-guidance.ts <工程目录> <查询词...>");
}
const work = join(resolve(project), ".cosmic-ai", "work");
const file = join(work, "impact.json");
const source = readFileSync(file, "utf8");
const index = JSON.parse(source) as ImpactIndex;
// queryImpact 只读这些上下文；不提供写入、进程或网络入口。
const ctx = {
	config: { isv: "" },
	layout: { impactIndex: file, impactWork: join(work, "impact") },
	ports: { fs: { exists: existsSync, read: (path: string) => readFileSync(path, "utf8") }, clock: { now: Date.now } },
	runtimeKeyId: index.runtimeKeyId ?? "",
} as KernelContext;
const rows = terms.map((term) => {
	const result = queryImpact(ctx, { terms: [term], dynamic: true });
	if (!result.ok) {
		return { term, ok: false, code: result.error.code, message: result.error.message, remedy: result.error.remedy };
	}
	return {
		term,
		ok: true,
		targets: result.value.targets,
		readWriteSites: result.value.traces.reduce(
			(sum, trace) => sum + trace.groups.reduce((n, group) => n + group.sites.length, 0),
			0,
		),
	};
});
console.log(
	JSON.stringify(
		{
			file,
			sha256: createHash("sha256").update(source).digest("hex"),
			at: index.at,
			metadata: index.meta !== null,
			rows,
		},
		null,
		2,
	),
);
