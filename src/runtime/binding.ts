/**
 * Single-project binding guard (D10). v1 allows one cosmic process to serve one
 * project, but a second project must be DETECTED AND REFUSED rather than
 * silently served: quietly switching would compile against one project and run
 * against another, and the resulting error names a business class, not the mixup.
 *
 * This is an object the caller holds, not a module global -- a module global is
 * exactly the frozen-CLI pattern D9 removes, and it would make the guard
 * untestable and un-resettable across sessions.
 */
import { KernelError } from "../kernel/errors.ts";
import { describeDiff, diffRuntimeKey, type RuntimeKey } from "./runtime-key.ts";

export class RuntimeBinding {
	#bound: RuntimeKey | null = null;

	get current(): RuntimeKey | null {
		return this.#bound;
	}

	/**
	 * Binds this process to a RuntimeKey, or throws when it is already bound to a
	 * different one. Re-binding the identical key is a no-op so that repeated
	 * commands in one session are free.
	 */
	bind(key: RuntimeKey): RuntimeKey {
		const bound = this.#bound;
		if (bound === null) {
			this.#bound = key;
			return key;
		}
		if (bound.id === key.id) return bound;

		const diff = diffRuntimeKey(bound.parts, key.parts);
		throw new KernelError("RUNTIME_KEY_MISMATCH", "该 cosmic 进程已绑定另一个运行时，拒绝串用。", {
			detail: {
				boundKeyId: bound.id,
				boundProjectRoot: bound.parts.project.root,
				requestedKeyId: key.id,
				requestedProjectRoot: key.parts.project.root,
				changed: diff.changed,
				reason: describeDiff(diff),
			},
			remedy:
				bound.parts.project.root === key.parts.project.root
					? "同一工程但运行时指纹已变（见 changed）：重启 cosmic 以绑定新的运行时。"
					: "一个 cosmic 进程只服务一个工程：为另一个工程另起一个 cosmic。",
		});
	}

	/** Releases the binding. Called when the owning session ends and its JVM is reclaimed. */
	release(): void {
		this.#bound = null;
	}
}
