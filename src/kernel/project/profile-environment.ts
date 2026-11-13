import type { ProbeOutcome } from "../commands/probe.ts";
import type { ProjectProfileEnvironment } from "./profile.ts";

function nonBlank(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function finiteNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Only a successful, complete EnvDiag record is eligible for ProjectProfile persistence. */
export function profileEnvironmentFrom(outcome: ProbeOutcome): ProjectProfileEnvironment | null {
	if (outcome.exitCode !== 0) return null;
	const record = outcome.json.records.find((item) => item.t === "profile-env");
	if (record === undefined) return null;
	const tenantId = nonBlank(record, "tenant_id");
	const accountId = nonBlank(record, "account_id");
	const accountNumber = nonBlank(record, "account_number");
	const db = nonBlank(record, "db");
	const isv = nonBlank(record, "isv");
	const userName = nonBlank(record, "user_name");
	const accounts = finiteNumber(record, "accounts");
	const metaCount = finiteNumber(record, "meta_count");
	if (
		tenantId === null ||
		accountId === null ||
		accountNumber === null ||
		db === null ||
		isv === null ||
		userName === null ||
		accounts === null ||
		metaCount === null
	)
		return null;
	return { tenantId, accountId, accountNumber, accounts, db, isv, userName, metaCount };
}
