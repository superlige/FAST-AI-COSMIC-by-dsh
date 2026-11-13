/**
 * The resident probe JVM's line protocol (S3.3).
 *
 * Request: one keyword line, then `key=value` lines, then END.
 * Response: `RESULT <status> <exitCode>` then the probe's output.
 *
 * Two properties matter and both are enforced here rather than by convention:
 *
 *   1. The protocol carries no command. A request names a probe source file and
 *      a class; there is no field in which an arbitrary command string could
 *      travel, so a worker on the other end has nothing to execute (D1, S3.3).
 *   2. The environment forwarded to the JVM is an explicit list, not the agent's
 *      process.env. The frozen driver forwarded every variable it had so the
 *      cold and hot paths would behave identically; keeping that in a resident
 *      agent would hand the JVM whatever credentials the agent process holds.
 *      Both paths here use the same composed overlay, so they stay identical
 *      without the leak.
 */

export type ProbeStatus = "OK" | "ERR" | "TIMEOUT" | "STALE" | "BUSY" | "COMPILE_FAIL";

export interface ProbeRequest {
	/** Absolute path of the probe source. */
	src: string;
	/** Class name; probes have no package, so it equals the file's base name. */
	cls: string;
	/** Exactly the variables the probe should see. Values may contain newlines. */
	env: Readonly<Record<string, string>>;
	/** Internal upper bound for a reviewed long-running probe. Never exposed in a tool schema. */
	timeoutMs?: number;
	/**
	 * `-Dk=v` for this one request: the confirmed write targets of a metadata APPLY
	 * (S27 1.14). The server sets them before the run and clears them after, and
	 * accepts only the keys it knows, so this is not a way to reconfigure the JVM.
	 */
	props?: readonly string[];
}

export interface ProbeResponse {
	status: ProbeStatus;
	exitCode: number;
	body: string;
}

/** Encodes a PROBE request. Values are base64 because they may contain newlines. */
export function encodeProbeRequest(request: ProbeRequest): string[] {
	const lines = ["PROBE", `src=${request.src}`, `class=${request.cls}`];
	const account = request.env.COSMIC_ACCOUNT;
	const user = request.env.COSMIC_USER;
	if (account) lines.push(`account=${account}`);
	if (user) lines.push(`user=${user}`);
	if (request.timeoutMs !== undefined) lines.push(`timeoutMs=${String(request.timeoutMs)}`);
	for (const [key, value] of Object.entries(request.env)) {
		lines.push(`env=${key}=${Buffer.from(value, "utf8").toString("base64")}`);
	}
	for (const prop of request.props ?? []) {
		const match = /^-D([^=]+)=(.*)$/s.exec(prop);
		if (match !== null) lines.push(`prop=${match[1]}=${Buffer.from(match[2] ?? "", "utf8").toString("base64")}`);
	}
	lines.push("END");
	return lines;
}

export const PING_REQUEST = ["PING"] as const;
export const SHUTDOWN_REQUEST = ["SHUTDOWN"] as const;
/** 把业务类目录里变了的类换进常驻 JVM（S27 3.1）。不带参数：换哪些由宿主自己比对目录决定。 */
export const SYNC_REQUEST = ["SYNC"] as const;

const RESULT_HEAD = /^RESULT (\w+) (-?\d+)$/;

/**
 * Parses a reply. An unrecognised head is an error rather than a best-effort
 * parse: a garbled reply usually means the JVM died mid-answer, and treating its
 * partial output as a probe result reports a failed run as a successful one.
 */
export function decodeResponse(text: string): { ok: true; value: ProbeResponse } | { ok: false; why: string } {
	const newline = text.indexOf("\n");
	const head = (newline < 0 ? text : text.slice(0, newline)).trim();
	const match = RESULT_HEAD.exec(head);
	if (!match) return { ok: false, why: `返回不认识：${head.slice(0, 80) || "(空)"}` };
	const status = match[1] as string;
	const known: ProbeStatus[] = ["OK", "ERR", "TIMEOUT", "STALE", "BUSY", "COMPILE_FAIL"];
	return {
		ok: true,
		value: {
			status: (known as string[]).includes(status) ? (status as ProbeStatus) : "ERR",
			exitCode: Number(match[2]),
			body: newline < 0 ? "" : text.slice(newline + 1),
		},
	};
}
