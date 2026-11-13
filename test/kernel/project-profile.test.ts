import { describe, expect, it } from "vitest";
import { writeProjectProfile } from "../../src/kernel/project/profile.ts";
import type { RuntimeKey } from "../../src/runtime/runtime-key.ts";
import { makeContext } from "./fake-context.ts";

describe("ProjectProfile", () => {
	it("writes the opened runtime facts without changing the project.yaml shape", () => {
		const fake = makeContext();
		const key = { parts: { cosmicRuntime: { version: "8.0" } } } as unknown as RuntimeKey;
		const report = writeProjectProfile(fake.ctx, key);
		const text = fake.fs.read(report.file);
		expect(text).toContain("kind: ProjectProfile");
		expect(text).toContain("cosmic_version: '8.0'");
		expect(text).toContain("env: null");
	});

	it("writes a valid EnvDiag fingerprint idempotently and preserves it on reopen", () => {
		const fake = makeContext();
		const key = { parts: { cosmicRuntime: { version: "8.0" } } } as unknown as RuntimeKey;
		const environment = {
			tenantId: "ierp",
			accountId: "1",
			accountNumber: "zlgd",
			accounts: 2,
			db: "db:3306/meta",
			isv: "zlgd",
			userName: "李工",
			metaCount: 42,
		};
		const first = writeProjectProfile(fake.ctx, key, environment);
		expect(fake.fs.read(first.file)).toContain("account_number: 'zlgd'");
		expect(writeProjectProfile(fake.ctx, key, environment).changed).toBe(false);
		writeProjectProfile(fake.ctx, key);
		expect(fake.fs.read(first.file)).toContain("user_name: '李工'");
	});
});
