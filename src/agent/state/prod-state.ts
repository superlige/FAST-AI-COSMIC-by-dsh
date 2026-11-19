/**
 * 开发模式和生产只读排障模式：哪种模式挂哪些工具、哪些调用要拒，和排障时攒下的证据编号。
 *
 * 模式只有人能定：桌面版和网页版在新建会话时选预设，命令行用 `--profile cosmic` / `--profile cosmic-prod`。
 * 会话里不切，模型的任何调用都改不了它。证据只由 cosmic_prod 的真实结果写入。
 */
import { isDataWriter } from "../../kernel/policy/write-plan.ts";
import type { ProdEvidence } from "../../kernel/prod/report.ts";

export type CosmicMode = "dev" | "prod";

export interface ProdState {
	evidence: ProdEvidence[];
	/** 最近一份诊断报告的文件 */
	lastReport?: string;
}

export function initialProdState(): ProdState {
	return { evidence: [] };
}

export function nextEvidenceId(state: ProdState): string {
	const max = state.evidence.reduce((n, e) => Math.max(n, Number.parseInt(e.id.slice(1), 10) || 0), 0);
	return `E${String(max + 1)}`;
}

export function withEvidence(state: ProdState, evidence: Omit<ProdEvidence, "id">): { state: ProdState; id: string } {
	const id = nextEvidenceId(state);
	return { state: { ...state, evidence: [...state.evidence, { id, ...evidence }] }, id };
}

/** 排障模式下不挂的产品工具：它们编译改动、在测试环境真跑业务。 */
export const PROD_MODE_REFUSED_TOOLS: ReadonlySet<string> = new Set(["cosmic_fast", "cosmic_run"]);

/**
 * 每种模式挂给模型的产品工具。开发模式不带 cosmic_prod；排障模式不带改东西的工具。
 * 藏起来的工具在这个模式下本来就没有这能力，工具说明的体积也按模式算。
 */
export function toolsForMode(mode: CosmicMode, all: readonly string[]): string[] {
	return all.filter((name) => (mode === "dev" ? name !== "cosmic_prod" : !PROD_MODE_REFUSED_TOOLS.has(name)));
}

/** cosmic_runtime 里会改运行环境的动作 */
export const PROD_MODE_REFUSED_RUNTIME_ACTIONS: ReadonlySet<string> = new Set(["deploy", "node-start", "node-stop"]);

export const PROD_MODE_REMEDY =
	"这是生产只读排障会话：全程只读，不改代码、不写测试库和元数据、不部署。查明原因后用 cosmic_prod action=report 出诊断报告；" +
	"要修请用户新开一个开发会话，带上报告路径。";

export const PROD_MODE_REFUSED_CODE = "PROD_MODE_READ_ONLY";

export interface ModeRefusal {
	code: typeof PROD_MODE_REFUSED_CODE;
	message: string;
	remedy: string;
}

/**
 * 这个调用在排障模式下能不能做。纯函数：只看这一次的工具名和输入。
 * 开发模式不挂 cosmic_prod，所以开发模式没有要拒的。
 * `isMetaWrite` 由调用方传入（cosmic_meta 的写动作判定在 kernel/meta/parse.ts），这里不重复一份规则。
 */
export function modeRefusal(
	mode: CosmicMode,
	tool: string,
	input: unknown,
	isMetaWrite: (argv: readonly string[]) => boolean,
): ModeRefusal | null {
	if (mode === "dev") return null;
	const params = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const refuse = (what: string): ModeRefusal => ({
		code: PROD_MODE_REFUSED_CODE,
		message: `生产排障会话不能${what}`,
		remedy: PROD_MODE_REMEDY,
	});
	if (PROD_MODE_REFUSED_TOOLS.has(tool)) return refuse(tool === "cosmic_fast" ? "编译改动" : "在测试环境真跑业务");
	if (tool === "cosmic_runtime" && PROD_MODE_REFUSED_RUNTIME_ACTIONS.has(String(params.action ?? "")))
		return refuse("部署或启停调试节点");
	if (tool === "cosmic_meta" && Array.isArray(params.argv) && isMetaWrite(params.argv.map(String)))
		return refuse("写元数据");
	if (tool === "cosmic_probe") {
		const env = (typeof params.env === "object" && params.env !== null ? params.env : {}) as Record<string, unknown>;
		// 造数、改数探针不带 APPLY 也默认落库（dataWriteOverlay），按探针名拦，只放行 PREVIEW=1 的回滚预演。
		const name = String(params.name ?? "");
		if (isDataWriter(name) && String(env.PREVIEW ?? "") !== "1") return refuse("造数据、改数据");
		if (String(env.APPLY ?? "") === "1") return refuse("用探针写测试环境");
	}
	return null;
}

/** 排障模式下，文件工具能不能改这个文件：工程里的文件不能改，.cosmic-ai 下自己的东西可以 */
export function prodModeBlocksFileWrite(file: string, projectRoot: string | undefined): boolean {
	if (projectRoot === undefined) return false;
	const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const root = norm(projectRoot);
	const target = norm(file);
	if (target !== root && !target.startsWith(`${root}/`)) return false;
	return !target.startsWith(`${root}/.cosmic-ai/`);
}
