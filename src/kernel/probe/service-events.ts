import type { KernelContext } from "../context.ts";
import type { LocalServiceKind } from "./health.ts";

type Listener = (kind?: LocalServiceKind) => void;
const listeners = new Map<string, Set<Listener>>();
function key(ctx: KernelContext): string {
	return `${ctx.projectRoot}\n${ctx.runtimeKeyId}`;
}

export function watchService(ctx: KernelContext, listener: Listener): () => void {
	const id = key(ctx);
	const group = listeners.get(id) ?? new Set<Listener>();
	group.add(listener);
	listeners.set(id, group);
	return () => {
		group.delete(listener);
		if (group.size === 0) listeners.delete(id);
	};
}

export function serviceChanged(ctx: KernelContext, kind?: LocalServiceKind): void {
	for (const listener of listeners.get(key(ctx)) ?? []) {
		try {
			listener(kind);
		} catch {
			/* 状态栏不能影响业务执行。 */
		}
	}
}

export async function serviceTransition<T>(
	ctx: KernelContext,
	kind: LocalServiceKind,
	work: () => Promise<T>,
): Promise<T> {
	serviceChanged(ctx, kind);
	try {
		return await work();
	} finally {
		serviceChanged(ctx);
	}
}
