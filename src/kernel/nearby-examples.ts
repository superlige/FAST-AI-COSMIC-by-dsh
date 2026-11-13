/** Shared wire contract with the Java probe helper NearbyExamples. */
export interface NearbyExample {
	reference: string;
	reason: string;
	configuration: Record<string, unknown>;
}

export interface NearbyExamples {
	t: "nearby-examples";
	target: string;
	scope: string;
	status: "found" | "none" | "partial";
	message: string;
	items: NearbyExample[];
	omitted: number;
}

export function nearbyExamples(
	target: string,
	scope: string,
	candidates: NearbyExample[],
	unavailable = "",
): NearbyExamples {
	const seen = new Set([target]);
	const unique = candidates.filter((item) => {
		if (seen.has(item.reference)) return false;
		seen.add(item.reference);
		return true;
	});
	return {
		t: "nearby-examples",
		target,
		scope,
		status: unavailable ? "partial" : unique.length ? "found" : "none",
		message: unavailable || (unique.length ? "同一对象上的现成样板，需按当前需求核对" : "没有现成样板"),
		items: unique.slice(0, 3),
		omitted: Math.max(0, unique.length - 3),
	};
}
