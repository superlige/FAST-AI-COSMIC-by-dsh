/**
 * 测量脚本读 dsh 会话：解压、换成 pi 的记录形状，内置工具换成 pi 的名字，宿主插进来的上下文不当成人说的话。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { listSessionFiles, readSessionRecords } from "../../scripts/session-reader.mjs";

const dir = mkdtempSync(join(tmpdir(), "cosmic-session-reader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const events = [
	{ type: "session", version: 4, id: "session-a", createdAt: 1_000, cwd: "D:demo" },
	{ type: "request/header", seq: 1, time: 1_001, data: { header: { config: { provider: "p", model: "m" } } } },
	{
		type: "user/message",
		seq: 2,
		time: 1_002,
		data: { content: [{ type: "text", text: "改一下" }], source: { kind: "user" } },
	},
	{
		type: "user/message",
		seq: 3,
		time: 1_003,
		data: {
			content: [{ type: "text", text: "<system-reminder>技能清单</system-reminder>" }],
			source: { kind: "skill-catalog" },
		},
	},
	{
		type: "assistant/message",
		seq: 4,
		time: 1_010,
		data: {
			message: {
				role: "assistant",
				content: [
					{ type: "reasoning", text: "想一想" },
					{ type: "tool-call", id: "c1", name: "pwsh", arguments: '{"command":"ls"}' },
					{ type: "tool-call", id: "c2", name: "read", arguments: '{"file_path":"D:/demo/A.java"}' },
					{
						type: "tool-call",
						id: "c3",
						name: "apply_patch",
						arguments: JSON.stringify({
							input: ["*** Begin Patch", "*** Update File: D:/demo/B.java", "*** End Patch"].join("\n"),
						}),
					},
					{ type: "tool-call", id: "c4", name: "cosmic_run", arguments: '{"argv":["op","demo_bill","save"]}' },
				],
				source: { kind: "model", provider: "p", model: "m", replayState: { response: { stopReason: "toolUse" } } },
			},
			usage: { inputTokens: 10, outputTokens: 2, totalTokens: 112, cacheReadTokens: 100 },
		},
	},
	{ type: "tool/call", seq: 5, time: 1_011, data: { callId: "c1", name: "pwsh" } },
	{
		type: "tool/result",
		seq: 6,
		time: 1_012,
		data: {
			message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "A.java" }], isError: false },
		},
	},
	{ type: "compaction/summary", seq: 7, time: 1_020, data: {} },
	{ type: "step/end", seq: 8, time: 1_021, data: {} },
];

const sessionDir = join(dir, "session-a");
mkdirSync(sessionDir);
writeFileSync(
	join(sessionDir, "session.v4.jsonl.zstd"),
	zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n{"broken`)),
);

describe("读 dsh 会话", () => {
	const { records, broken, format } = readSessionRecords(sessionDir);

	it("给会话目录就行，解压后换成 pi 的记录；写到一半的末行数出来", () => {
		expect(format).toBe("dsh");
		expect(broken).toBe(1);
		expect(records.map((record) => record.type)).toEqual([
			"session",
			"model_change",
			"message",
			"custom_message",
			"message",
			"message",
			"compaction",
		]);
	});

	it("只有人说的才是 user；宿主插的上下文是 custom_message", () => {
		const users = records.filter((record) => record.message?.role === "user");
		expect(users).toHaveLength(1);
		expect(records[3]).toMatchObject({ type: "custom_message", customType: "dsh:skill-catalog" });
	});

	it("模型那一轮：思考、工具调用换成 pi 的名字和参数，用量换成 pi 的字段", () => {
		const assistant = records.find((record) => record.message?.role === "assistant")?.message;
		expect(assistant.content.map((part: { type: string; name?: string }) => part.name ?? part.type)).toEqual([
			"thinking",
			"bash",
			"read",
			"edit",
			"cosmic_run",
		]);
		expect(assistant.content[2].arguments.path).toBe("D:/demo/A.java");
		expect(assistant.content[3].arguments.path).toBe("D:/demo/B.java");
		expect(assistant.content[4].arguments).toEqual({ argv: ["op", "demo_bill", "save"] });
		expect(assistant.usage).toMatchObject({ input: 10, output: 2, cacheRead: 100, cacheWrite: 0, totalTokens: 112 });
		expect(assistant.stopReason).toBe("toolUse");
	});

	it("工具返回按调用编号找回工具名（也换成 pi 的）", () => {
		const result = records.find((record) => record.message?.role === "toolResult")?.message;
		expect(result).toMatchObject({ toolCallId: "c1", toolName: "bash", isError: false });
	});

	it("目录里按会话列出来", () => {
		const listed = listSessionFiles(dir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.file.endsWith("session.v4.jsonl.zstd")).toBe(true);
	});
});
