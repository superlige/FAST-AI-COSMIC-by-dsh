/**
 * 发给模型的固定文字，一处拼出来：每个模式的常驻系统提示（最坏情况）、每轮现算那段（最坏情况）、挂上的每个产品工具的说明和参数说明。
 *
 * 量大小（`scripts/measure-dsh-prompt.ts`）、导出给人审读（`scripts/dump-prompt-text.ts`）、查同一句写两处
 * （`scripts/prompt-duplicates.ts`）、查历史沿革（`test/agent/prompt-hygiene.test.ts`）都从这里取，
 * 和插件入口 `apply` 挂的是同一份工具规格（`cosmicToolSpecs`）。
 */

import { cosmicSystemPrompt, STANDING_ROOT_MAX, standingContext } from "../agent/prompt/system-prompt.ts";
import { type CosmicMode, toolsForMode } from "../agent/state/prod-state.ts";
import { COSMIC_TOOL_NAMES } from "../agent/tools/names.ts";
import { type CosmicToolSpec, toDshSchema } from "./define.ts";
import { CosmicHost } from "./host.ts";
import type { CosmicKernel } from "./kernel.ts";
import { releasedProbes } from "./probes.ts";
import { factsTool } from "./tools/facts.ts";
import { knowledgeTool } from "./tools/knowledge.ts";
import { metaTool } from "./tools/meta.ts";
import { probeTool } from "./tools/probe.ts";
import { type AskInCall, prodTool } from "./tools/prod.ts";
import { projectTools } from "./tools/project.ts";
import { runTool } from "./tools/run.ts";
import type { Confirm } from "./write.ts";

/** 全部 12 个产品工具的规格；挂哪几个由模式定（`toolsForMode`）。 */
export function cosmicToolSpecs(host: CosmicHost, confirm: Confirm, askInCall?: AskInCall): CosmicToolSpec<never>[] {
	return [
		...projectTools(host),
		knowledgeTool(host),
		probeTool(host, confirm),
		runTool(host),
		metaTool(host, confirm),
		factsTool(),
		prodTool(host, askInCall),
	] as unknown as CosmicToolSpec<never>[];
}

/** 某个模式下挂上的工具规格；只取文字用，不碰内核。 */
export function mountedToolSpecs(mode: CosmicMode): CosmicToolSpec<never>[] {
	const host = new CosmicHost(mode, {} as CosmicKernel);
	const mounted = new Set(toolsForMode(mode, COSMIC_TOOL_NAMES));
	return cosmicToolSpecs(host, async () => ({ kind: "approved" })).filter((spec) => mounted.has(spec.name));
}

export interface FixedTextPiece {
	/** 在哪：「dev 系统提示」「cosmic_run 说明」「cosmic_run.argv 参数」。 */
	where: string;
	text: string;
}

/** 参数说明逐个摊开，嵌套的对象、数组、并集也算。 */
function parameterTexts(prefix: string, schema: unknown, out: FixedTextPiece[]): void {
	if (schema === null || typeof schema !== "object") return;
	const node = schema as Record<string, unknown>;
	if (typeof node.description === "string") out.push({ where: `${prefix} 参数`, text: node.description });
	const properties = node.properties as Record<string, unknown> | undefined;
	if (properties !== undefined)
		for (const [key, child] of Object.entries(properties)) parameterTexts(`${prefix}.${key}`, child, out);
	if (node.items !== undefined) parameterTexts(`${prefix}[]`, node.items, out);
	for (const key of ["oneOf", "anyOf"]) {
		const members = node[key];
		if (Array.isArray(members)) for (const member of members) parameterTexts(prefix, member, out);
	}
}

/** 一个模式下发给模型的全部固定文字。系统提示取最坏情况：技能文档整体没装上、每轮那段每行都在。 */
export function fixedTextPieces(mode: CosmicMode): FixedTextPiece[] {
	const probes = releasedProbes();
	const pieces: FixedTextPiece[] = [
		{
			where: `${mode} 系统提示`,
			text: cosmicSystemPrompt({
				releasedProbes: probes.names,
				probeInputs: probes.inputs,
				referenceSkills: { ok: false, reason: "KNOWLEDGE_UNAVAILABLE" },
				mode,
			}),
		},
		{
			where: `${mode} 每轮状态`,
			text: standingContext({
				projectRoot: "R".repeat(STANDING_ROOT_MAX),
				javaEdited: 1,
				compiledFresh: false,
				lastReport: "R".repeat(STANDING_ROOT_MAX),
			}),
		},
	];
	for (const spec of mountedToolSpecs(mode)) {
		pieces.push({ where: `${spec.name} 说明`, text: spec.description });
		parameterTexts(spec.name, toDshSchema(spec.parameters), pieces);
	}
	return pieces;
}

/** 两个模式合起来（同一个工具在两个模式里说明一样，按出处去重）。 */
export function allFixedTextPieces(): FixedTextPiece[] {
	const seen = new Set<string>();
	const out: FixedTextPiece[] = [];
	for (const mode of ["dev", "prod"] as const) {
		for (const piece of fixedTextPieces(mode)) {
			const key = `${piece.where}\u0000${piece.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(piece);
		}
	}
	return out;
}

/** 句子大于这么多 UTF-8 字节才算重复（和会话尺子的重复口径同一条线）。 */
export const DUPLICATE_MIN_BYTES = 40;

export interface DuplicateSentence {
	sentence: string;
	places: string[];
}

/**
 * 同一句写在两处以上的地方：按「。」「；」和换行切句。同一句写两处，改一处忘一处就成了两种说法，模型每轮也多读一遍。
 * 只比同一个模式里的（两个模式本来就各发一份系统提示，模型一次只看到一份）。
 */
export function duplicateSentences(
	pieces: readonly FixedTextPiece[],
	minBytes = DUPLICATE_MIN_BYTES,
): DuplicateSentence[] {
	const seen = new Map<string, Set<string>>();
	for (const piece of pieces) {
		for (const raw of piece.text.split(/[。；\n]/)) {
			const sentence = raw.trim();
			if (Buffer.byteLength(sentence, "utf8") <= minBytes) continue;
			const places = seen.get(sentence) ?? new Set<string>();
			places.add(piece.where);
			seen.set(sentence, places);
		}
	}
	return [...seen.entries()]
		.filter(([, places]) => places.size > 1)
		.map(([sentence, places]) => ({ sentence, places: [...places] }));
}

export interface FixedTextBytes {
	/** 常驻系统提示加每轮状态，最坏情况。 */
	systemWorstBytes: number;
	/** 挂上的工具：说明加参数（换成 dsh 认的 JSON Schema 之后）。 */
	toolBytes: number;
}

/** 一个模式下每次请求都带的固定文字有多少 UTF-8 字节。 */
export function fixedTextBytes(mode: CosmicMode): FixedTextBytes {
	const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
	const system = fixedTextPieces(mode)
		.filter((piece) => piece.where === `${mode} 系统提示` || piece.where === `${mode} 每轮状态`)
		.reduce((sum, piece) => sum + bytes(piece.text), 0);
	const tools = mountedToolSpecs(mode).reduce(
		(sum, spec) => sum + bytes(spec.description) + bytes(JSON.stringify(toDshSchema(spec.parameters))),
		0,
	);
	return { systemWorstBytes: system, toolBytes: tools };
}
