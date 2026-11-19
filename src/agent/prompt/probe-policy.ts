/**
 * The probe-policy section of the system prompt.
 *
 * What this text is for, and what it is not for. It is not the boundary -- the
 * boundary is `scanAdHocProbe`, which refuses the source before it reaches a
 * JVM, and IsvGuard, which refuses a write inside one. The prompt exists so the
 * model knows which released probe to reach for, and that ad-hoc probes are
 * read-only. Nothing load-bearing goes in this file.
 *
 * 临时探针禁用清单不再逐条写在这里（S44 批 4.2，用户 2026-10-05 定）。原来按 `WRITE_APIS`、
 * `READ_ONLY_TYPES` 生成全表，每轮常驻约 2 KB；而被拒时 `PROBE_WRITES_REFUSED` 在编译之前
 * 逐条给出行号、原因和该换哪个已发布探针，同一份内容写在两处。这里只留一句红线，说清哪几类会被拒。
 * 那一句是类别概括，不是第二份清单：加了新禁用项不用改它，除非多出一个新类别。
 *
 * 「临时探针自动核对 API」那段也移走了：同样的话在 `cosmic_probe` 的工具说明里，
 * 那里才是问探针怎么用时会看的地方。
 */

import { COMMAND_ONLY_PROBES } from "../../kernel/commands/internal-probes.ts";
import { RUN_KINDS, RUN_PROBES } from "../../knowledge/run-adapter.ts";

/**
 * `cosmic_run` 各子命令背后的探针不列进「按类名调用」（S40）。
 *
 * 它们的入口是 `cosmic_run`：预检、编译、把断言记成验证记录都在那一层。直接当探针调，这些全跳过，
 * 跑出来的 PASS 交付也不认。以前列在这里，58 份真机会话里有 17 次绕过 `cosmic_run` 直接调（FormSim 13、OpSandbox 4）。
 * 命令替模型调、解析 JSON 旁路的探针同样不列（S42 4.3，见 `internal-probes.ts`）。
 */
const RUN_ONLY = new Set<string>([...RUN_KINDS.map((kind) => RUN_PROBES[kind]), ...COMMAND_ONLY_PROBES]);

export interface ProbePolicyPromptInput {
	/** Released probe class names, from the kernel context. */
	released: readonly string[];
	/**
	 * Required input names per probe, for the ones that declare any.
	 *
	 * The list used to be 44 bare class names, and a probe's parameters are
	 * written down nowhere else the model can reach: not in the tool schema, not
	 * in the knowledge base. A real session spent its turns opening probe sources
	 * in the release cache to find out that `AddFieldProbe` wants ADD_ENTITY /
	 * ADD_KEY / ADD_NAME / ADD_TYPE -- a shared-metadata write probe, which is the
	 * worst possible place to be guessing. Required names only: the optional ones
	 * outnumber them several times over and would cost more budget than they save.
	 *
	 * Null when the caller has not recorded them; the list then renders as it
	 * always did.
	 */
	inputs?: Readonly<Record<string, readonly string[]>> | null;
}

/**
 * The gate that is not about probes: the repeat gate is per-tool, not per-probe.
 *
 * The output budget used to be described here too, with "grep the spill file"
 * as the way to see the cut. Since S37 2-A.2 every cut return says what was cut
 * and how to pick it back through the same tool, so the standing paragraph went.
 */
function generalGates(): string[] {
	return ["**同一个失败最多两次。** 同一工具连续两次以同一错误码失败，第三次调用会被拒。"];
}

export function probePolicyPrompt(input: ProbePolicyPromptInput): string {
	const direct = input.released.filter((name) => !RUN_ONLY.has(name));
	const listed = direct
		.map((name) => {
			const required = input.inputs?.[name] ?? [];
			return required.length === 0 ? name : `${name}(${required.join(" ")})`;
		})
		.join(" ");
	return [
		"## 探针（probe）",
		"",
		"探针分两类，能做的事不同：",
		"",
		`**已发布探针**：按类名调用，共 ${String(direct.length)} 个，经过审核；改元数据、BOTP 规则、打印模板，落业务数据，都用它们。`,
		"元数据写入过 IsvGuard，检查 ISV、`<isv>_` 前缀和本次已确认的写入目标。",
		`可用（括号里是 req("…") 声明的必填入参，按这个顺序绑位置参数）：`,
		listed,
		"",
		"**临时探针**：写在 `.cosmic-ai/probes/` 下，用工程根相对路径调用（如 `.cosmic-ai/probes/OneOff.java`），入口是 `public static void run()`，用来查东西。",
		"业务源码目录（如 `src/main/java`）里的会被拒：那里的文件算业务源码，会进编译和交付。",
		"临时探针没人审过，只准读：写元数据、规则、打印模板和业务数据，开事务、跨节点调用和发消息，反射、动态类加载、脚本引擎、子进程、裸 JDBC、写文件、连网，" +
			"都在编译之前被拒，拒绝信息逐条给出行号、原因和该换哪个已发布探针。",
		"",
		// 原来写的是「由用户决定是否新增一个已发布探针」：那是对做这个产品的人说的话，
		// 用它的人听了只会收到一份「建议补通道」的报告，手上的需求停在那里（docs/S55-new-metadata-by-user.md）。
		"已发布探针做不到、临时探针又不准做的事由用户来做：告诉用户这一步要他做什么、做成什么样，其余的照常做。",
		"",
		"## 工具规矩",
		"",
		...generalGates(),
	].join("\n");
}
