import { scanAdHocProbe } from "../kernel/policy/probe-scan.ts";

export interface ReferenceCapabilityIssue {
	line: number;
	rule: string;
	detail: string;
}

/** Targeted drift checks, not a general natural-language capability verifier. */
export function scanReferenceCapabilities(text: string): ReferenceCapabilityIssue[] {
	const issues: ReferenceCapabilityIssue[] = [];
	text = text.replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/scratchpad[\\/]/.test(lines[i] ?? "")) {
			issues.push({
				line: i + 1,
				rule: "legacy-scratchpad",
				detail: "临时探针用工程内 .cosmic-ai/probes/；要反复筛的输出存 .cosmic-ai/scratch/",
			});
		}
	}
	// Paragraphs keep wrapped recommendations together without borrowing a warning
	// from a different paragraph. Published-probe API documentation remains valid.
	const paragraphs = [...text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)];
	for (const paragraph of paragraphs) {
		const body = paragraph[0];
		const adHoc = /一次性(?:写)?探针|临时(?:写)?探针|现写一个/.test(body);
		if (!adHoc) continue;
		const line = text.slice(0, paragraph.index).split("\n").length;
		const prohibition = /只准读|只读|不准写|禁止|不能|不支持|没有.*通道|不可执行/.test(body);
		const recommendation = /(?:仍然写|另写|现写一个)|一次性写探针|(?:一次性|临时)探针里调/.test(body);
		const applyWrite = /APPLY\s*=\s*1/.test(body) && /写|落库|保存/.test(body);
		if (!prohibition && (recommendation || applyWrite)) {
			issues.push({
				line,
				rule: "ad-hoc-write-guidance",
				detail: "临时探针只准读；写入必须使用已发布探针，缺失能力须明确说明",
			});
		}
		// Scan code only when explicitly presented as an ad-hoc example. The real
		// policy blanks Java comments/literals and checks receiver-scoped APIs too.
		if (!prohibition) {
			for (const hit of scanAdHocProbe(body)) {
				issues.push({ line: line + hit.line - 1, rule: "ad-hoc-forbidden-api", detail: `${hit.what}：${hit.why}` });
			}
		}
	}
	for (const block of text.matchAll(/```java[^\n]*\n([\s\S]*?)```/g)) {
		const before = text.slice(0, block.index);
		const context =
			before
				.split(/\n\s*\n/)
				.filter((part) => part.trim())
				.at(-1) ?? "";
		if (!/(?:一次性|临时)(?:写)?探针/.test(context) || /禁止|不能|不可执行/.test(context)) continue;
		const codeLine = before.split("\n").length + 1;
		for (const hit of scanAdHocProbe(block[1] ?? "")) {
			issues.push({
				line: codeLine + hit.line - 1,
				rule: "ad-hoc-forbidden-api",
				detail: `${hit.what}：${hit.why}`,
			});
		}
	}
	return issues;
}
