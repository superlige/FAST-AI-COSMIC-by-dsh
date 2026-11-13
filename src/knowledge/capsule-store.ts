import type { KnowledgeCapsule } from "./capsule.ts";

export const CAPSULE_DELIVERY_SCHEMA = "cosmic.knowledge-capsules/2";

export interface CapsuleDeliveryEntry {
	digest: string;
	subject: string;
	kind: KnowledgeCapsule["kind"];
	runtimeKeyId: string;
	sourceRefs: string[];
	deliveredAt: string;
}

interface CapsuleDeliveryFile {
	schema: typeof CAPSULE_DELIVERY_SCHEMA;
	runtimeKeyId: string;
	entries: Record<string, CapsuleDeliveryEntry>;
}

export interface CapsuleDeliveryFsPort {
	read(path: string): string;
	write(path: string, content: string): void;
}

export interface CapsuleDeliveryStore {
	file: string;
	read(): Record<string, CapsuleDeliveryEntry>;
	record(capsules: readonly KnowledgeCapsule[]): CapsuleDeliveryEntry[];
}

export function capsuleDeliveryStore(input: {
	fs: CapsuleDeliveryFsPort;
	file: string;
	runtimeKeyId: string;
	now(): string;
}): CapsuleDeliveryStore {
	const load = (): Record<string, CapsuleDeliveryEntry> => {
		const text = input.fs.read(input.file);
		if (text === "") return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return {};
		}
		if (typeof parsed !== "object" || parsed === null) return {};
		const file = parsed as Partial<CapsuleDeliveryFile>;
		if (
			file.schema !== CAPSULE_DELIVERY_SCHEMA ||
			file.runtimeKeyId !== input.runtimeKeyId ||
			typeof file.entries !== "object" ||
			file.entries === null
		) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(file.entries).filter((entry): entry is [string, CapsuleDeliveryEntry] => {
				const value = entry[1] as Partial<CapsuleDeliveryEntry>;
				return (
					value.digest === entry[0] &&
					typeof value.subject === "string" &&
					(value.kind === "plugin" || value.kind === "probe-api" || value.kind === "run-adapter") &&
					value.runtimeKeyId === input.runtimeKeyId &&
					Array.isArray(value.sourceRefs) &&
					value.sourceRefs.every((source) => typeof source === "string") &&
					typeof value.deliveredAt === "string"
				);
			}),
		);
	};

	return {
		file: input.file,
		read: load,
		record(capsules) {
			const entries = load();
			const deliveredAt = input.now();
			const recorded = capsules.map(
				(capsule): CapsuleDeliveryEntry => ({
					digest: capsule.digest,
					subject: capsule.subject,
					kind: capsule.kind,
					runtimeKeyId: input.runtimeKeyId,
					sourceRefs: [...capsule.sourceRefs],
					deliveredAt,
				}),
			);
			for (const entry of recorded) entries[entry.digest] = entry;
			const file: CapsuleDeliveryFile = {
				schema: CAPSULE_DELIVERY_SCHEMA,
				runtimeKeyId: input.runtimeKeyId,
				entries,
			};
			input.fs.write(input.file, `${JSON.stringify(file, null, 2)}\n`);
			return recorded;
		},
	};
}
