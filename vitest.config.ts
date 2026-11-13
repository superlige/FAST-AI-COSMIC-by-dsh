import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		// Each test file registers/unregisters the faux provider; isolate per file.
		pool: "forks",
	},
});
