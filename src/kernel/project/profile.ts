import type { RuntimeKey } from "../../runtime/runtime-key.ts";
import type { KernelContext } from "../context.ts";

export interface ProjectProfileReport {
	file: string;
	at: string;
	changed: boolean;
}

export interface ProjectProfileEnvironment {
	tenantId: string;
	accountId: string;
	accountNumber: string;
	accounts: number;
	db: string;
	isv: string;
	userName: string;
	metaCount: number;
}

const quote = (value: unknown): string => `'${String(value).split("'").join("''")}'`;
const scalar = (value: string | number | null): string => (value === null ? "null" : quote(value));
const array = (values: readonly string[]): string => `[${values.map(quote).join(", ")}]`;

function environmentBlock(environment: ProjectProfileEnvironment): string[] {
	return [
		"env:",
		`  tenant_id: ${quote(environment.tenantId)}`,
		`  account_id: ${quote(environment.accountId)}`,
		`  account_number: ${quote(environment.accountNumber)}`,
		`  accounts: ${String(environment.accounts)}`,
		`  db: ${quote(environment.db)}`,
		`  isv: ${quote(environment.isv)}`,
		`  user_name: ${quote(environment.userName)}`,
		`  meta_count: ${String(environment.metaCount)}`,
	];
}

function storedEnvironmentBlock(text: string): string[] | null {
	const marker = text.indexOf("\nenv:");
	if (marker < 0) return null;
	const block = text
		.slice(marker + 1)
		.trimEnd()
		.split("\n");
	return block[0] === "env:" && block.slice(1).every((line) => line.startsWith("  ")) ? block : null;
}

/** Opening preserves a prior live fingerprint; a valid EnvDiag record replaces it. */
export function writeProjectProfile(
	ctx: KernelContext,
	key: RuntimeKey,
	environment?: ProjectProfileEnvironment,
): ProjectProfileReport {
	const at = new Date(ctx.ports.clock.now()).toISOString();
	const file = `${ctx.layout.cosmicDir}/project.yaml`;
	const source = (field: string): string => ctx.config.sources[field]?.source ?? "(缺失)";
	const previousText = ctx.ports.fs.read(file);
	const envLines =
		environment === undefined
			? (storedEnvironmentBlock(previousText) ?? ["env: null"])
			: environmentBlock(environment);
	const text = [
		"protocol: 2",
		"kind: ProjectProfile",
		`at: ${quote(at)}`,
		"project:",
		`  root: ${quote(ctx.projectRoot.replace(/\\/g, "/"))}`,
		`  isv: ${scalar(ctx.config.isv)}`,
		`  cosmic_version: ${scalar(key.parts.cosmicRuntime.version)}`,
		`  cosmic_home: ${scalar(ctx.config.cosmicHome)}`,
		`  debug_module: ${scalar(ctx.config.debugModule)}`,
		`  code_modules: ${array(ctx.config.codeModules)}`,
		`  modules: ${array(ctx.config.auto.modules)}`,
		`  app: ${scalar(ctx.config.appClass && ctx.config.appMethod ? `${ctx.config.appClass}#${ctx.config.appMethod}` : null)}`,
		"  knowledge: true",
		"runtime:",
		`  tenant: ${scalar(ctx.config.tenant)}`,
		`  account: ${scalar(ctx.config.account)}`,
		`  user: ${scalar(ctx.config.user)}`,
		`  debug_port: ${ctx.config.debugPort}`,
		`  probe_server_port: ${ctx.config.probeServerPort}`,
		"sources:",
		...[
			"isv",
			"cosmicHome",
			"debugModule",
			"codeModules",
			"appClass",
			"appMethod",
			"tenant",
			"account",
			"user",
			"debugPort",
			"probeServerPort",
		].map((field) => `  ${field}: ${quote(source(field))}`),
		...envLines,
		"",
	].join("\n");
	const previous = previousText.replace(/^at:.*$/m, "at: '<ignored>'");
	const current = text.replace(/^at:.*$/m, "at: '<ignored>'");
	if (previous !== "" && previous === current) {
		const previousAt = previousText.match(/^at: *'([^']+)'/m)?.[1] ?? at;
		return { file, at: previousAt, changed: false };
	}
	ctx.ports.fs.mkdirp(ctx.layout.cosmicDir);
	ctx.ports.fs.write(file, text);
	return { file, at, changed: previous !== "" && previous !== current };
}
