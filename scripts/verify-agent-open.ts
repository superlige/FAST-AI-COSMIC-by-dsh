#!/usr/bin/env node --experimental-strip-types
/** Fixed, read-only S4 verification for the production agent/kernel adapter. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("用法: verify-agent-open.ts <projectRoot>");
	process.exit(2);
}

const kernel = createKernelAdapter({
	agentConfigDir: process.env.COSMIC_AGENT_DIR ?? join(tmpdir(), "cosmic-agent"),
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(tmpdir(), "cosmic-cache"),
	agentVersion: "0.0.0-s4",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}

const summary = opened.value.summary;
// S4.4: the lock view is read-only; recovery is never invoked from this script.
const lock = await kernel.inspectWriteLock(opened.value.handle);
if (!lock.ok) {
	console.error(JSON.stringify(lock.error.toJSON()));
	process.exit(1);
}
const freshness = await kernel.freshness(opened.value.handle);
if (!freshness.ok) {
	console.error(JSON.stringify(freshness.error.toJSON()));
	process.exit(1);
}
console.log(
	JSON.stringify({
		ok: true,
		projectRoot: summary.root,
		runtimeKeyId: summary.runtimeKeyId,
		releasedProbes: summary.releasedProbes.length,
		cache: summary.cache,
		release: summary.release,
		freshness: {
			fresh: freshness.value.fresh,
			sourceCount: freshness.value.sourceCount,
			staleCount: freshness.value.staleFiles.length,
		},
		writeLock: {
			present: lock.value.present,
			recoverable: lock.value.recoverable,
			ownerLive: lock.value.ownerLive,
			corrupt: lock.value.corrupt,
		},
	}),
);
