/**
 * Does a plugin reach a call the transaction cannot take back (attachment,
 * micro-service, message, HTTP, socket) through the project's own utility
 * classes?
 *
 * The side-effect note used to read only the plugin's own source file, so a
 * plugin that calls `DateUtils.getYearRestDay` -- which three calls down opens an
 * HTTP connection to a holiday API -- was reported as having no side effect. On
 * the real project that was two scheduled tasks. The walk goes DOWN the call
 * edges method by method from the plugin's own methods; per class it would claim
 * every effect any method of a utility class has, and `DateUtils` has forty
 * methods of which one goes out.
 */

import type { ImpactIndex, SrcEdge } from "./model.ts";
import { shortMethod } from "./model.ts";

const MAX_DEPTH = 12;

export interface EffectReach {
	/** API families reached, e.g. `HttpURLConnection`. */
	effects: string[];
	/** The first path found, `Plugin#execute → Util#getHolidaysFromApi`. */
	via: string;
}

export function effectReacher(index: ImpactIndex): (cls: string) => EffectReach | null {
	const effectsAt = new Map<string, Set<string>>();
	for (const row of index.effects ?? []) {
		if (!row.inMethod) continue;
		const set = effectsAt.get(row.inMethod) ?? new Set<string>();
		set.add(row.effect);
		effectsAt.set(row.inMethod, set);
	}
	const callees = new Map<string, SrcEdge[]>();
	const starts = new Map<string, Set<string>>();
	for (const edge of index.edges ?? []) {
		const list = callees.get(edge.from);
		if (list) list.push(edge);
		else callees.set(edge.from, [edge]);
		const own = starts.get(edge.fromClass) ?? new Set<string>();
		own.add(edge.from);
		starts.set(edge.fromClass, own);
	}
	return (cls: string): EffectReach | null => {
		if (effectsAt.size === 0) return null;
		const parent = new Map<string, string>();
		const seen = new Set<string>(starts.get(cls) ?? []);
		let frontier = [...seen];
		const found = new Set<string>();
		let first: string | null = null;
		for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth++) {
			const next: string[] = [];
			for (const at of frontier) {
				for (const edge of callees.get(at) ?? []) {
					if (seen.has(edge.to)) continue;
					seen.add(edge.to);
					parent.set(edge.to, at);
					next.push(edge.to);
					const hit = edge.toClass === cls ? undefined : effectsAt.get(edge.to);
					if (!hit) continue;
					for (const effect of hit) found.add(effect);
					first ??= edge.to;
				}
			}
			frontier = next;
		}
		if (first === null) return null;
		const path: string[] = [];
		for (let cur: string | undefined = first; cur !== undefined; cur = parent.get(cur))
			path.unshift(shortMethod(cur));
		return { effects: [...found].sort(), via: path.join(" → ") };
	};
}
