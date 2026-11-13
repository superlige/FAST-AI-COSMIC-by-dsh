/**
 * Which bill one field read / write is on, from where its object came from
 * (S17 batch 2).
 *
 * Field keys are unique only within one bill, and 37% of the keys this project
 * names sit on two or more. The old test was per class: the bills the class ever
 * touched, intersected with the bills carrying the key -- a guess by name, and a
 * wrong one whenever a class touches two bills with the same key, or an operation
 * plugin loads bill B and writes into it.
 *
 * The static side now records each site's object origin inside its method
 * (`SrcRef.obj`): the plugin's own bill (`getModel()`, `e.getDataEntities()`), a
 * bill loaded or created by name, a parameter, a member, a field value of
 * another object. A parameter is followed to every call site (`SrcCall.args`),
 * layer by layer, until it is recognised or breaks; the answer says which layer
 * and why. Nothing is guessed here: an origin that is not recognised comes back
 * as `guess` with the reason, and the caller decides what to do with a name match.
 */

import type { ImpactIndex, IndexLookup, SrcCall, SrcRef } from "./model.ts";
import { rebaseOrigin, shortMethod, simpleName } from "./model.ts";

const MAX_LAYERS = 8;

export type Attribution =
	/** The object is one of these bills, settled from its origin. `how` says how, for the reader. */
	| { kind: "bill"; bills: string[]; how: string }
	/** The object is the value of reference field `field` on another object (base data, not that bill). */
	| { kind: "prop"; field: string; why: string }
	/** The origin was not recognised; `why` says where it broke. */
	| { kind: "guess"; why: string };

/** One step of a call path, caller first: `method` calls the next step (or the site's method) at `line`. */
export interface PathStep {
	method: string;
	line: number | null;
}

export interface Attributor {
	/** From the site's origin; a parameter is followed to every call site. */
	site: (site: SrcRef) => Attribution;
	/**
	 * Along one call path down to the site: a parameter is rebased call by call on
	 * exactly these calls, so a helper reached from a plugin on bill A and one on
	 * bill B says A on the first path and B on the second.
	 */
	along: (site: SrcRef, path: readonly PathStep[]) => Attribution;
}

const PARAM = /^(bill)?param:\d+$/;
/** Still waiting on a caller: a parameter, or a field value read off a parameter. */
export const awaitsCaller = (origin: string): boolean =>
	PARAM.test(origin) || /^prop:[^/]*\/(bill)?param:\d+$/.test(origin);

export function attributor(index: ImpactIndex, lk: IndexLookup, snapshot: string): Attributor {
	const callsTo = new Map<string, SrcCall[]>();
	const callsAt = new Map<string, SrcCall[]>();
	for (const call of index.callArgs ?? []) {
		const list = callsTo.get(call.to);
		if (list) list.push(call);
		else callsTo.set(call.to, [call]);
		const key = `${call.from} ${call.to}`;
		const at = callsAt.get(key);
		if (at) at.push(call);
		else callsAt.set(key, [call]);
	}
	const containers = new Set((index.fields ?? []).filter((row) => row.kind === "container").map((row) => row.key));
	const cache = new Map<string, Attribution>();

	const ownBills = (cls: string): Attribution => {
		const bills = [...new Set((lk.byClass.get(cls)?.bindings ?? []).map((b) => b.entity).filter(Boolean))];
		if (bills.length > 0) return { kind: "bill", bills, how: `${simpleName(cls)} 挂的单` };
		if (!index.meta)
			return { kind: "guess", why: `对象是 ${simpleName(cls)} 自己的单，没有元数据快照，不知道它挂在哪` };
		return { kind: "guess", why: `对象是 ${simpleName(cls)} 自己的单，它没挂在任何单据上（${snapshot}）` };
	};

	// Cached at every layer: one helper is reached from many sites. A result cut short by a
	// cycle could in theory be reused on another path; cycles in call-argument chains are rare.
	const resolve = (origin: string, cls: string, method: string | null, layer: number, seen: Set<string>) => {
		const key = `${origin}|${cls}|${method ?? ""}`;
		const hit = cache.get(key);
		if (hit) return hit;
		const out = compute(origin, cls, method, layer, seen);
		cache.set(key, out);
		return out;
	};

	const compute = (
		origin: string,
		cls: string,
		method: string | null,
		layer: number,
		seen: Set<string>,
	): Attribution => {
		if (origin === "own") return ownBills(cls);
		if (origin.startsWith("bill:")) {
			const bill = origin.slice("bill:".length);
			return { kind: "bill", bills: [bill], how: `按名字加载 ${bill}` };
		}
		if (origin.startsWith("ext:")) {
			const key = origin.slice("ext:".length);
			return lk.byEntity.has(key) || lk.fieldEntities.has(key)
				? { kind: "bill", bills: [key], how: `转换目标单 ${key}` }
				: { kind: "guess", why: `对象是转换目标单上 ${key} 的数据，认不出是哪张单` };
		}
		if (origin.startsWith("prop:")) {
			const slash = origin.indexOf("/");
			const field = origin.slice("prop:".length, slash < 0 ? undefined : slash);
			// `get("entryentity")` takes an entry: still the bill the outer object is on.
			if (containers.has(field) && slash >= 0) return resolve(origin.slice(slash + 1), cls, method, layer, seen);
			if (field === "?") return { kind: "guess", why: "对象是另一个数据包上按变量取的值" };
			return { kind: "prop", field, why: `对象是字段 ${field} 引用的基础资料，不是单据本身` };
		}
		if (origin.startsWith("member:")) {
			return { kind: "guess", why: `对象来自成员变量 ${origin.slice("member:".length)}` };
		}
		if (origin.startsWith("ret:")) {
			return { kind: "guess", why: `对象来自 ${origin.slice("ret:".length)} 的返回值，返回处来源不一或认不出` };
		}
		if (PARAM.test(origin)) return viaCallers(origin, cls, method, layer, seen);
		if (origin.startsWith("?:")) return { kind: "guess", why: `对象${whyText(origin.slice(2))}` };
		return { kind: "guess", why: `对象来源没记（${origin}）` };
	};

	const viaCallers = (
		origin: string,
		cls: string,
		method: string | null,
		layer: number,
		seen: Set<string>,
	): Attribution => {
		const n = origin.replace(/^\D+/, "");
		const what = origin.startsWith("bill") ? `单据标识是参数 ${n}` : `对象是参数 ${n}`;
		if (!method) return { kind: "guess", why: `${what}，不在方法里` };
		if (layer >= MAX_LAYERS) return { kind: "guess", why: `${what}，往上追了 ${MAX_LAYERS} 层还没认出，停了` };
		if (seen.has(method)) return { kind: "guess", why: `${what}，调用绕圈` };
		const callers = callsTo.get(method) ?? [];
		if (callers.length === 0) {
			return {
				kind: "guess",
				why: `${what}，表里没有 ${shortMethod(method)} 的调用处（经接口、反射、平台回调的看不到）`,
			};
		}
		const next = new Set([...seen, method]);
		const bills = new Set<string>();
		let how: string | null = null;
		let broke: string | null = null;
		for (const call of callers) {
			const at = `${shortMethod(call.from)}:${call.line}`;
			const got = resolve(rebaseOrigin(origin, call, cls), call.fromClass, call.from, layer + 1, next);
			if (got.kind === "bill") {
				for (const bill of got.bills) bills.add(bill);
				how ??= `经 ${at} 传入，${got.how}`;
			} else {
				broke ??= `追到 ${at}：${got.why}`;
			}
		}
		if (bills.size > 0) return { kind: "bill", bills: [...bills], how: how as string };
		return { kind: "guess", why: `${what}，${broke}` };
	};

	const site = (ref: SrcRef): Attribution => {
		if (!ref.obj) return { kind: "guess", why: "表里没记对象来源，重建后才有" };
		return resolve(ref.obj, ref.class, ref.inMethod ?? null, 0, new Set());
	};

	const along = (ref: SrcRef, path: readonly PathStep[]): Attribution => {
		let origin = ref.obj;
		let method = ref.inMethod ?? null;
		if (!origin || !method || !awaitsCaller(origin) || path.length === 0) return site(ref);
		let cls = ref.class;
		let at: string | null = null;
		for (let k = path.length - 1; k >= 0 && awaitsCaller(origin); k--) {
			const step = path[k] as PathStep;
			const calls = callsAt.get(`${step.method} ${method}`) ?? [];
			const call = calls.find((c) => c.line === step.line) ?? calls[0];
			const where = `${shortMethod(step.method).split("#")[1]}:${step.line ?? "?"}`;
			if (!call) return { kind: "guess", why: `对象是参数，表里没记 ${where} 调用时传了什么` };
			origin = rebaseOrigin(origin, call, cls);
			at = where;
			method = step.method;
			cls = call.fromClass;
		}
		const got = resolve(origin, cls, method, 0, new Set());
		if (at === null) return got;
		if (got.kind === "bill") return { ...got, how: `${got.how}，在 ${at} 认出` };
		return { ...got, why: `对象是参数，追到 ${at}：${got.why}` };
	};

	return { site, along };
}

/** The static side's reasons are terse (`来自 Stream#flatMap`, `lambda 参数`); make them read as a sentence. */
function whyText(reason: string): string {
	if (reason.startsWith("来自") || reason.startsWith("是")) return reason;
	if (reason.startsWith("new ")) return `来自 ${reason}`;
	if (reason === "lambda 参数") return "是 lambda 参数，认不出它遍历的是什么";
	if (reason === "null") return "只赋过 null";
	return `：${reason}`;
}
