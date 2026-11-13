/**
 * Real JDK probing and classpath collection (S3, closing two S2 open issues).
 *
 * S2 defined JdkProbe and the classpath fingerprint contract but shipped only
 * the interfaces: producing the values needs a real JDK and a real Gradle build.
 * Both producers live here, and both go through the kernel's ports so a test can
 * supply the answers without a JDK on the machine.
 */

import { statSync } from "node:fs";
import { baseChildEnv, type KernelContext } from "../kernel/context.ts";
import type { ProcessPort } from "../kernel/ports.ts";
import type { JdkProbe } from "./fingerprint.ts";

/** `java -version` writes to stderr on JDK 8. Both streams are read for later JDKs. */
const VERSION_RE = /version "([^"]+)"/;

export interface JavaVersionInfo {
	version: string;
	build: string | null;
}

export function parseJavaVersion(banner: string): JavaVersionInfo | null {
	const text = banner.replace(/\r\n/g, "\n");
	const version = VERSION_RE.exec(text)?.[1];
	if (version === undefined) return null;
	// The second line carries the runtime/build identity. Two JDK 8 builds emit
	// different bytecode details, so it is part of the fingerprint, not decoration.
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const build = lines.slice(1).join(" ").trim();
	return { version, build: build === "" ? null : build };
}

/**
 * Interrogates the JDK at a given home. When javaHome is empty the `java` on
 * PATH is used, and the answer describes THAT jdk -- reporting a version for a
 * home that was never asked would make the fingerprint a lie.
 */
export function nodeJdkProbe(proc: ProcessPort, env: Record<string, string>, cwd: string): JdkProbe {
	let failure: string | null = null;
	return {
		async describe(javaHome: string) {
			failure = null;
			const command = javaHome === "" ? "java" : `${javaHome.replace(/[\\/]+$/, "")}/bin/java`;
			const result = await proc.runAsync({ command, args: ["-version"], cwd, env });
			if (result.spawnError !== null) {
				failure = `启动失败：${result.spawnError}`;
				return null;
			}
			const banner = `${result.stderr}\n${result.stdout}`;
			const info = parseJavaVersion(banner);
			if (info === null) {
				// 例：内存不够时 JVM 起不来，java 自己会说 "Could not reserve enough space for object heap"
				const said = banner
					.replace(/\r\n/g, "\n")
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "")
					.slice(0, 3)
					.join(" | ");
				failure = `退出码 ${String(result.status ?? "无")}${said === "" ? "，没有输出" : `：${said}`}`;
			}
			return info;
		},
		lastFailure: () => failure,
	};
}

/**
 * 同一个 java 问过一次就记住答案。
 *
 * 每次工具调用都要重新打开工程、算一遍运行时身份，原来每次都跑一次 `java -version`，也就是每次多起一个 JVM。
 * 内存紧的时候这个 JVM 起不来，整条工具调用就报「问不出 JDK 版本」——哪怕前一次调用刚问过、JDK 一点没变
 * （真机 2026-09-26、09-27 两次：会话中途连续五六次，模型只能停工）。
 * 记忆按 java 可执行文件的路径、修改时间和大小认：JDK 重装、换了一份，这三样会变，照旧重新问。
 * 找不到可执行文件（走 PATH、路径不存在）时不记，每次照问。记忆由调用方持有（kernel adapter 一个会话一份），
 * 不放模块全局。
 */
export type JdkMemory = Map<string, JavaVersionInfo>;

export function rememberingJdkProbe(
	probe: JdkProbe,
	memory: JdkMemory,
	stampOf: (javaHome: string) => string | null,
): JdkProbe {
	return {
		async describe(javaHome: string) {
			const stamp = stampOf(javaHome);
			const known = stamp === null ? undefined : memory.get(stamp);
			if (known !== undefined) return known;
			const info = await probe.describe(javaHome);
			if (info !== null && stamp !== null) memory.set(stamp, info);
			return info;
		},
		lastFailure: () => probe.lastFailure?.() ?? null,
	};
}

/** java 可执行文件的「路径|修改时间|大小」；找不到就是 null。 */
export function javaExecutableStamp(javaHome: string): string | null {
	if (javaHome === "") return null;
	const home = javaHome.replace(/[\\/]+$/, "");
	for (const name of ["java.exe", "java"]) {
		const path = `${home}/bin/${name}`;
		try {
			const stat = statSync(path);
			if (stat.isFile()) return `${path}|${String(stat.mtimeMs)}|${String(stat.size)}`;
		} catch {
			// 这个名字不在，试下一个
		}
	}
	return null;
}

export function jdkProbeFor(ctx: KernelContext): JdkProbe {
	return nodeJdkProbe(ctx.ports.proc, baseChildEnv(ctx), ctx.projectRoot);
}

/**
 * Classpath entries the project's own build produced.
 *
 * The javac argfile is the artifact of record: it is what every compile in this
 * kernel actually uses, so fingerprinting anything else would fingerprint
 * something no compile depends on. Order is preserved -- Cosmic resolves
 * duplicate classes first-on-path, so two orderings load different classes and a
 * set comparison would call them equivalent.
 */
export function classpathFromArgfile(text: string): string[] {
	const match = /-cp\s+"([^"]*)"|-cp\s+(\S+)/.exec(text);
	const raw = match?.[1] ?? match?.[2] ?? "";
	if (raw === "") return [];
	// A Windows classpath is ";"-separated and its entries contain "D:" drive
	// colons, so the separator is chosen by what the string actually contains
	// rather than by the host platform -- an argfile can be read on either.
	const parts = raw.includes(";") ? raw.split(";") : raw.split(":");
	return parts.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

export function readClasspath(ctx: KernelContext): string[] {
	return classpathFromArgfile(ctx.ports.fs.read(ctx.layout.javacArgs));
}
