/**
 * 给人看的整份，给模型的摘要（S44 批 4.1）。
 *
 * 确认单、真写入结果、交付回执是给人看的单子：逐元素的改动、整份确认单、几十个写入对象。
 * 人在确认框、界面展开和回执文件里看整份；模型接下来要做的只是「执行下一项」「回读」「交付」，
 * 整份再送它一遍，后面每一轮都要多读一遍（10-04 一次确认单返回 17.9 KB，交付回执 22.8 KB）。
 *
 * 做法是通用的：结果对象上挂一个 `modelView`，里面写「发给模型时这几个字段换成什么」，
 * 值为 null 就是这个字段不发。发给模型前 `applyModelView` 逐层换掉；`details` 不动，
 * 界面、回执文件、审计读的都是整份。哪个字段是给人看的，由产出它的那段代码决定，这里不登记名单。
 */

export { targetsSummary } from "../../kernel/policy/write-targets.ts";

export const MODEL_VIEW = "modelView";

/** 在结果上挂「给模型的那一份」。同名字段换掉；null 表示不发这个字段。 */
export function withModelView<T extends Record<string, unknown>>(value: T, view: Record<string, unknown>): T {
	return { ...value, [MODEL_VIEW]: view };
}

/** 发给模型的那一份：逐层把挂了 `modelView` 的对象换成摘要，`modelView` 自己不发。 */
export function applyModelView(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(applyModelView);
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	const view = record[MODEL_VIEW];
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		if (key === MODEL_VIEW) continue;
		out[key] = applyModelView(child);
	}
	if (typeof view === "object" && view !== null && !Array.isArray(view)) {
		for (const [key, replacement] of Object.entries(view as Record<string, unknown>)) {
			if (replacement === null) delete out[key];
			else out[key] = replacement;
		}
	}
	return out;
}

/**
 * 真写入之后，探针结构化记录里的逐项改动折成条数。
 *
 * 写入探针在预演和真写入时都打一遍逐项改动（`<类>-change`），落库后回读对不上的打成 `<类>-readback`。
 * 真写入时逐项改动预演里已经给过、确认单上用户也看过；模型要知道的是改了几处、回读有没有对不上。
 * 对不上的那几条原样留着。没有可折的就返回 null。
 */
export function appliedRecordsView(json: unknown): Record<string, unknown> | null {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
	const bag = json as Record<string, unknown>;
	const records = bag.records;
	if (!Array.isArray(records)) return null;
	const kindOf = (record: unknown): string =>
		typeof record === "object" && record !== null ? String((record as Record<string, unknown>).t ?? "") : "";
	const changes = new Map<string, number>();
	for (const record of records) {
		const kind = kindOf(record);
		if (kind.endsWith("-change")) changes.set(kind, (changes.get(kind) ?? 0) + 1);
	}
	if (changes.size === 0) return null;
	const kept = records.filter((record) => !kindOf(record).endsWith("-change"));
	const summaries = [...changes.entries()].map(([kind, count]) => {
		const family = kind.slice(0, -"-change".length);
		const mismatched = kept.filter((record) => kindOf(record) === `${family}-readback`).length;
		return {
			t: `${kind}-count`,
			count,
			readback:
				mismatched === 0
					? "回读没有报对不上的（回读那一行见输出）"
					: `回读有 ${String(mismatched)} 处对不上，见 ${family}-readback`,
			note: "逐项改动在预演和确认单上给过，这里只给条数",
		};
	});
	return { ...bag, records: [...summaries, ...kept] };
}
