import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { KernelContext } from "../context.ts";
import { type NearbyExample, type NearbyExamples, nearbyExamples } from "../nearby-examples.ts";
import { outlineJava } from "./java-outline.ts";
import type { ImpactIndex, Target } from "./model.ts";

/** Registration comes from the index; line positions always come from the current source. */
export function eventExamples(
	ctx: KernelContext,
	index: ImpactIndex,
	targets: Target[],
	event: string,
): NearbyExamples {
	const target = targets.map((item) => item.value).join(",");
	const selected = new Set(targets.filter((item) => item.kind === "class").map((item) => item.value));
	// A layout's plugins are the ones registered on it.
	for (const item of targets)
		if (item.kind === "layout")
			for (const cls of index.classes)
				if (cls.bindings.some((b) => (b.kind ?? "form") === "form" && b.numbers.includes(item.value)))
					selected.add(cls.class);
	const entities = new Set(targets.filter((item) => item.kind === "entity").map((item) => item.value));
	const sites = new Set<string>();
	for (const cls of index.classes)
		if (selected.has(cls.class))
			for (const binding of cls.bindings) {
				if (binding.enabled) sites.add(`${binding.entity}:${binding.kind ?? cls.pluginType ?? ""}`);
			}
	const candidates: NearbyExample[] = [];
	const gaps = new Set<string>();
	if (!/^[A-Za-z_$][\w$]*$/.test(event)) return nearbyExamples(target, target, [], "事件方法名格式不正确");
	if (!index.meta) gaps.add("缺少插件登记数据");
	if (index.runtimeKeyId !== ctx.runtimeKeyId) gaps.add("登记数据与当前环境身份未确认一致");
	if (!sites.size && !entities.size) gaps.add("目标没有可用的单据登记，请用单据标识限定");
	const selectedFiles = index.classes
		.filter((cls) => selected.has(cls.class) && cls.file)
		.map((cls) => cls.file as string);
	const proximity = (file: string | null): number => {
		if (!file) return 0;
		const parts = file.replaceAll("\\", "/").split("/");
		return Math.max(
			0,
			...selectedFiles.map((selectedFile) => {
				const targetParts = selectedFile.replaceAll("\\", "/").split("/");
				let same = 0;
				while (same < parts.length - 1 && same < targetParts.length - 1 && parts[same] === targetParts[same])
					same++;
				return same;
			}),
		);
	};
	let read = 0;
	for (const cls of [...index.classes].sort(
		(a, b) => proximity(b.file) - proximity(a.file) || a.class.localeCompare(b.class),
	)) {
		if (selected.has(cls.class)) continue;
		const bindings = cls.bindings.filter(
			(binding) =>
				binding.enabled &&
				(entities.has(binding.entity) || sites.has(`${binding.entity}:${binding.kind ?? cls.pluginType ?? ""}`)),
		);
		if (!bindings.length) continue;
		if (!cls.file) {
			gaps.add("部分登记插件没有本地源码");
			continue;
		}
		const file = resolve(ctx.projectRoot, cls.file);
		const within = relative(ctx.projectRoot, file);
		if (isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\")) {
			gaps.add("部分源码位于工程外，未读取");
			continue;
		}
		if (++read > 64) {
			gaps.add("超过 64 个候选文件，其余未读取");
			break;
		}
		const source = ctx.ports.fs.read(file);
		if (!source || Buffer.byteLength(source, "utf8") > 512_000) {
			gaps.add("部分源码缺失或超过读取上限");
			continue;
		}
		const outline = outlineJava(source);
		if (!outline) {
			gaps.add("部分源码未能可靠定位方法");
			continue;
		}
		// Nested and unrelated top-level classes must not be attributed to the registered plugin.
		const simple = cls.class.split(".").at(-1);
		const owner = outline.types.find(
			(type) => type.label.startsWith(`class ${simple} `) || type.label === `class ${simple}`,
		);
		if (!owner) {
			gaps.add("源码中未找到登记类");
			continue;
		}
		for (const method of outline.methods) {
			if (!method.label.startsWith(`${event}(`) || method.from < owner.from || method.to > owner.to) continue;
			candidates.push({
				reference: `${cls.file}:${method.from}`,
				reason: "同单据、同名事件方法（需核对参数签名）",
				configuration: {
					class: cls.class,
					event,
					signature: method.label,
					from: method.from,
					to: method.to,
					bindings,
					sourceSha256: createHash("sha256").update(source).digest("hex"),
					indexAt: index.meta?.at ?? null,
				},
			});
		}
	}
	return nearbyExamples(
		target,
		[...new Set([...entities, ...[...sites].map((site) => site.split(":")[0])])].join(","),
		candidates,
		[...gaps].join("；"),
	);
}
