export interface SessionRecords {
	records: Record<string, any>[];
	broken: number;
	format: "pi" | "dsh";
}
export function resolveSessionFile(path: string): string;
export function isSessionFile(name: string): boolean;
export function listSessionFiles(dir: string): { name: string; file: string }[];
export function readSessionText(file: string): string;
export function piToolCall(name: string, args: unknown): { name: string; arguments: Record<string, unknown> };
export function dshToPiRecords(events: readonly Record<string, any>[]): Record<string, any>[];
export function readSessionRecords(file: string): SessionRecords;
