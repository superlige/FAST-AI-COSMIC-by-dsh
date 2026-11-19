import { probeRequiredNames } from "../kernel/commands/probe.ts";
import { EMBEDDED_RESOURCES } from "../resources/embedded.generated.ts";
import { releasedProbeNames } from "../runtime/resources.ts";

/** 已发布探针和它们的必填入参：随产物内置，不用开工程就知道，系统提示从第一轮起就不变。 */
export function releasedProbes(): { names: string[]; inputs: Record<string, string[]> } {
	const names = releasedProbeNames(EMBEDDED_RESOURCES);
	const inputs: Record<string, string[]> = {};
	for (const resource of EMBEDDED_RESOURCES) {
		const match = /^probes\/([A-Za-z][A-Za-z0-9_]*)\.java$/.exec(resource.relativePath);
		if (match === null || !names.includes(match[1] as string)) continue;
		const required = probeRequiredNames(resource.content);
		if (required.length > 0) inputs[match[1] as string] = required;
	}
	return { names, inputs };
}
