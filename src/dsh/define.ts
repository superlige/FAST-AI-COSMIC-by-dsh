/**
 * 产品工具的定义方式：参数用 typebox 写，发给 dsh 时换成 dsh 认的 JSON Schema 子集，执行前按原 schema 自己校验。
 *
 * dsh 只认 type（单个）/oneOf/properties/required/additionalProperties（布尔）/items/enum/const 和几个注解；
 * `patternProperties`、`minItems`、`type: [a, b]`、`anyOf` 这些一出现就注册失败。
 * 换法：键值表 → `additionalProperties: true`；多类型 → oneOf；常量的并集 → enum；长度、范围这类约束去掉。
 * 去掉的约束不会丢：执行前用 typebox 按完整 schema 校验，不合格的在进内核前被拒，并逐条说清哪里不对。
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { CosmicToolName } from "../agent/tools/names.ts";
import type { CallContext } from "./host.ts";
import { refused } from "./result.ts";

export interface CosmicToolSpec<P = Record<string, unknown>> {
	name: CosmicToolName;
	description: string;
	parameters: TSchema;
	/** 不经执行前门槛（模式、重复失败）的调用：问用法、从上次输出里按行取回。 */
	ungated?: (args: P) => boolean;
	/** 返回发给模型的几块文字；失败时抛 `CosmicToolFailure`。 */
	execute(args: P, call: CallContext): Promise<string[]>;
}

type JsonRecord = Record<string, unknown>;

const KEEP = new Set(["type", "properties", "required", "items", "enum", "const", "description", "title", "default"]);

/** 一个 typebox schema 换成 dsh 认的子集。 */
export function toDshSchema(schema: unknown): JsonRecord {
	const node = JSON.parse(JSON.stringify(schema)) as JsonRecord;
	return convert(node);
}

function convert(node: JsonRecord): JsonRecord {
	const out: JsonRecord = {};
	const annotations = (): JsonRecord => {
		const kept: JsonRecord = {};
		for (const key of ["description", "title"]) if (node[key] !== undefined) kept[key] = node[key];
		return kept;
	};
	if (Array.isArray(node.type)) {
		const types = node.type as string[];
		return { ...annotations(), oneOf: types.map((type) => ({ type })) };
	}
	const union = (node.anyOf ?? node.oneOf) as JsonRecord[] | undefined;
	if (Array.isArray(union)) {
		const consts = union.map((member) => member.const);
		if (consts.every((value) => value !== undefined)) {
			const type = typeof consts[0] === "number" ? "number" : typeof consts[0] === "boolean" ? "boolean" : "string";
			return { ...annotations(), type, enum: consts };
		}
		return { ...annotations(), oneOf: union.map(convert) };
	}
	for (const [key, value] of Object.entries(node)) {
		if (!KEEP.has(key)) continue;
		if (key === "properties" && typeof value === "object" && value !== null) {
			out.properties = Object.fromEntries(
				Object.entries(value as Record<string, JsonRecord>).map(([name, child]) => [name, convert(child)]),
			);
		} else if (key === "items" && typeof value === "object" && value !== null && !Array.isArray(value)) {
			out.items = convert(value as JsonRecord);
		} else {
			out[key] = value;
		}
	}
	if (node.patternProperties !== undefined) out.additionalProperties = true;
	else if (typeof node.additionalProperties === "boolean") out.additionalProperties = node.additionalProperties;
	return out;
}

/** 执行前按完整 schema 校验；不合格就拒，逐条说哪里不对。 */
export function checkArgs<P>(spec: CosmicToolSpec<P>, args: unknown): P {
	if (Value.Check(spec.parameters, args)) return args as P;
	const problems = [...Value.Errors(spec.parameters, args)]
		.slice(0, 8)
		.map((error) => `${error.instancePath === "" ? "（整体）" : error.instancePath}：${error.message}`);
	throw refused({
		code: `${spec.name.replace(/^cosmic_/, "").toUpperCase()}_ARGS_INVALID`,
		message: `${spec.name} 的参数不合格`,
		detail: { problems },
		remedy: "按工具说明里的参数表改正这几处再调用。",
	});
}
