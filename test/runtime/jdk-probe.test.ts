import { describe, expect, it } from "vitest";
import { fingerprintClasspath, fingerprintJdk } from "../../src/runtime/fingerprint.ts";
import { classpathFromArgfile, nodeJdkProbe, parseJavaVersion } from "../../src/runtime/jdk-probe.ts";
import { FakeProcess } from "../kernel/fake-context.ts";

// Verbatim from JDK 1.8.0_191 on the verification machine.
const JDK8_BANNER = [
	'java version "1.8.0_191"',
	"Java(TM) SE Runtime Environment (build 1.8.0_191-b12)",
	"Java HotSpot(TM) 64-Bit Server VM (build 25.191-b12, mixed mode)",
].join("\n");

describe("S3 JDK probing (closes an S2 open issue)", () => {
	it("reads version and build from the real JDK 8 banner", async () => {
		const info = parseJavaVersion(JDK8_BANNER);
		expect(info?.version).toBe("1.8.0_191");
		// Two JDK 8 builds emit different bytecode details, so the build line is part
		// of the identity rather than decoration.
		expect(info?.build).toContain("25.191-b12");
	});

	it("handles the newer banner shape too", async () => {
		expect(parseJavaVersion('openjdk version "17.0.9" 2023-10-17')?.version).toBe("17.0.9");
		expect(parseJavaVersion("not a java banner")).toBeNull();
	});

	it("asks the JDK at the home it was given, not whatever is on PATH", async () => {
		const proc = new FakeProcess();
		proc.handler = () => ({ status: 0, stderr: JDK8_BANNER });
		const probe = nodeJdkProbe(proc, {}, "D:/proj");
		expect((await probe.describe("D:/jdk8"))?.version).toBe("1.8.0_191");
		expect(proc.runs[0]?.command).toBe("D:/jdk8/bin/java");
		await probe.describe("");
		expect(proc.runs[1]?.command).toBe("java");
	});

	it("produces a fingerprint that changes when the same home is repointed", async () => {
		const first = await fingerprintJdk("D:/jdk", { describe: async () => ({ version: "1.8.0_191", build: "b12" }) });
		const second = await fingerprintJdk("D:/jdk", { describe: async () => ({ version: "1.8.0_412", build: "b08" }) });
		expect(first?.hash).not.toBe(second?.hash);
	});
});

describe("S3 classpath collection (closes an S2 open issue)", () => {
	it("reads the quoted Windows classpath out of a real argfile line", async () => {
		const argfile =
			'-cp "D:/proj/build/classes;D:/cosmic/lib/bos-core-8.0.jar;D:/cosmic/lib/abi-ai-8.0.jar"\n-encoding UTF-8\n';
		expect(classpathFromArgfile(argfile)).toEqual([
			"D:/proj/build/classes",
			"D:/cosmic/lib/bos-core-8.0.jar",
			"D:/cosmic/lib/abi-ai-8.0.jar",
		]);
	});

	it("does not split a Windows drive colon", async () => {
		expect(classpathFromArgfile('-cp "D:/a.jar;E:/b.jar"')).toHaveLength(2);
	});

	it("reads a POSIX classpath too", async () => {
		expect(classpathFromArgfile('-cp "/opt/a.jar:/opt/b.jar"')).toEqual(["/opt/a.jar", "/opt/b.jar"]);
	});

	it("returns nothing when the argfile has not been produced yet", async () => {
		expect(classpathFromArgfile("")).toEqual([]);
		expect(classpathFromArgfile("-encoding UTF-8")).toEqual([]);
	});

	it("treats reordering as a different runtime, because Cosmic resolves first-on-path", async () => {
		const a = fingerprintClasspath(["a.jar", "b.jar"]);
		const b = fingerprintClasspath(["b.jar", "a.jar"]);
		expect(a.entryCount).toBe(b.entryCount);
		expect(a.hash).not.toBe(b.hash);
	});
});
