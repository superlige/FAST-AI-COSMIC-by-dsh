/**
 * `.cosmic-ai/` 的目录表：会话目录跟会话走、草稿几天没改就删、备份一直留、表外的不删只报；
 * 本机输出位置由工具定；文件工具只能写草稿、临时探针和会话目录。
 */
import { describe, expect, it } from "vitest";
import { kernelLayout } from "../../src/kernel/layout.ts";
import {
	DRAFT_MAX_AGE_MS,
	inventoryCosmicDir,
	inventoryLines,
	LEDGER_MAX_AGE_MS,
	modelMayWrite,
	SESSION_IDLE_MS,
	SWEEP_INTERVAL_MS,
	sweepCosmicDir,
	touchSession,
} from "../../src/kernel/project/cosmic-dirs.ts";
import {
	placedNote,
	placeOutput,
	placeProbeOutputs,
	resolveInputDir,
	stampOf,
} from "../../src/kernel/project/output-paths.ts";
import { MemoryFs } from "./fake-context.ts";

const ROOT = "D:/proj";
const C = `${ROOT}/.cosmic-ai`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23, 6, 0, 0);
const norm = (path: string) => path.replace(/\\/g, "/");

function layoutFor(sessionId?: string) {
	return kernelLayout({
		root: ROOT,
		...(sessionId === undefined ? {} : { sessionId }),
		cacheRoot: "D:/cache/k",
		runtimeKeyId: "k",
		resourcesDir: "D:/cache/k/res",
		codeModules: [],
	});
}

describe("清理：照目录表", () => {
	it("别的会话停了 3 天以上整个删；本会话、最近还在用的会话不删", () => {
		const fs = new MemoryFs();
		fs.put(`${C}/sessions/old/out/a.out`, "x", NOW - 10 * DAY);
		fs.put(`${C}/sessions/old/.alive`, "", NOW - SESSION_IDLE_MS - 1000);
		fs.put(`${C}/sessions/recent/out/a.out`, "x", NOW - 10 * DAY);
		fs.put(`${C}/sessions/recent/.alive`, "", NOW - DAY);
		fs.put(`${C}/sessions/mine/out/a.out`, "x", NOW - 30 * DAY);
		const result = sweepCosmicDir(layoutFor("mine"), fs, NOW);
		expect(result.sessions).toEqual(["old"]);
		expect(fs.exists(`${C}/sessions/old`)).toBe(false);
		expect(fs.exists(`${C}/sessions/recent/out/a.out`)).toBe(true);
		expect(fs.exists(`${C}/sessions/mine/out/a.out`)).toBe(true);
	});

	it("草稿、临时探针 3 天没改就删；新的留着", () => {
		const fs = new MemoryFs();
		fs.put(`${C}/scratch/old.py`, "x", NOW - DRAFT_MAX_AGE_MS - 1000);
		fs.put(`${C}/scratch/sub/new.txt`, "x", NOW - 1000);
		fs.put(`${C}/probes/OldProbe.java`, "x", NOW - 5 * DAY);
		fs.put(`${C}/probes/NewProbe.java`, "x", NOW - 1000);
		expect(sweepCosmicDir(layoutFor("s"), fs, NOW).drafts).toBe(2);
		expect(fs.exists(`${C}/scratch/old.py`)).toBe(false);
		expect(fs.exists(`${C}/scratch/sub/new.txt`)).toBe(true);
		expect(fs.exists(`${C}/probes/NewProbe.java`)).toBe(true);
	});

	it("老位置的过程文件按草稿的期限清（pi 版迁移期间还在写，不整个删）；按运行时记的账 30 天", () => {
		const fs = new MemoryFs();
		fs.put(`${C}/work/out/old.out`, "x", NOW - 5 * DAY);
		fs.put(`${C}/work/out/new.out`, "x", NOW - 1000);
		fs.put(`${C}/evidence/assertions/AE-1.json`, "x", NOW - 5 * DAY);
		fs.put(`${C}/work/prod/sql/old.tsv`, "x", NOW - 5 * DAY);
		fs.put(`${C}/work/noise/k-old.json`, "x", NOW - LEDGER_MAX_AGE_MS - 1000);
		fs.put(`${C}/work/noise/k-new.json`, "x", NOW - 5 * DAY);
		const result = sweepCosmicDir(layoutFor("s"), fs, NOW);
		expect(result.legacy).toBe(3);
		expect(result.ledgers).toBe(1);
		expect(fs.exists(`${C}/work/out/new.out`)).toBe(true);
		expect(fs.exists(`${C}/evidence/assertions`)).toBe(false);
		expect(fs.exists(`${C}/work/noise/k-new.json`)).toBe(true);
	});

	it("一直留的不碰：备份、诊断报告、流水账、关系表、写锁、表外的东西", () => {
		const fs = new MemoryFs();
		const keep = [
			`${C}/evidence/backups/20260101-000000-ptpl-a/a.json`,
			`${C}/evidence/diagnosis/r.md`,
			`${C}/evidence/prod-audit.jsonl`,
			`${C}/work/impact.json`,
			`${C}/work/write.lock`,
			`${C}/backups/人放的/a.xml`,
			`${C}/work/fatigue-before/a.xml`,
		];
		for (const file of keep) fs.put(file, "x", NOW - 365 * DAY);
		sweepCosmicDir(layoutFor("s"), fs, NOW);
		for (const file of keep) expect(fs.exists(file)).toBe(true);
	});

	it("完成情况底账的老位置搬进各自的会话目录，不删", () => {
		const fs = new MemoryFs();
		fs.put(`${C}/evidence/sessions/session-1.json`, '{"startedAt":"x"}', NOW - DAY);
		expect(sweepCosmicDir(layoutFor("s"), fs, NOW).journalsMoved).toBe(1);
		expect(fs.read(`${C}/sessions/session-1/journal.json`)).toBe('{"startedAt":"x"}');
		expect(fs.exists(`${C}/evidence/sessions`)).toBe(false);
	});

	it("一小时内清过就不再扫；记号文件每十分钟最多写一次", () => {
		const fs = new MemoryFs();
		const layout = layoutFor("s");
		expect(sweepCosmicDir(layout, fs, NOW).skipped).toBe(false);
		fs.put(`${C}/scratch/old.py`, "x", NOW - 5 * DAY);
		expect(sweepCosmicDir(layout, fs, NOW + SWEEP_INTERVAL_MS - 1000).skipped).toBe(true);
		expect(fs.exists(`${C}/scratch/old.py`)).toBe(true);
		touchSession(layout, fs, NOW);
		const first = fs.mtimeMs(`${C}/sessions/s/.alive`);
		touchSession(layout, fs, NOW + 1000);
		expect(fs.mtimeMs(`${C}/sessions/s/.alive`)).toBe(first);
	});
});

describe("清点：表里逐项报数，表外逐项列", () => {
	it("0 也报；表外的不删，列出来", () => {
		const fs = new MemoryFs();
		fs.put(`${C}/sessions/s/out/a.out`, "x");
		fs.put(`${C}/wtd_nos.txt`, "x");
		fs.put(`${C}/work/org-audit/a.json`, "x");
		fs.put(`${C}/evidence/ptpl-before/a.zip`, "x");
		const { rows, unknown } = inventoryCosmicDir(C, fs);
		expect(rows.find((row) => row.path === "sessions/")?.files).toBe(1);
		expect(rows.find((row) => row.path === "evidence/backups/")?.files).toBe(0);
		expect(unknown.map((row) => row.path).sort()).toEqual([
			"evidence/ptpl-before/",
			"work/org-audit/",
			"wtd_nos.txt",
		]);
		const lines = inventoryLines(C, fs);
		expect(lines).toContain("表外的东西：3 项（不是 cosmic 按表写的，不自动删，要不要留请用户定）");
		expect(lines.at(-1)).toBe("还没清理过");
	});
});

describe("文件工具能往 .cosmic-ai 哪里写", () => {
	it("草稿、临时探针、会话目录可以；工具自己写的地方不行；.cosmic-ai 外不管", () => {
		expect(modelMayWrite(`${C}/scratch/a.py`)).toBe(true);
		expect(modelMayWrite(`${C}\\probes\\OneOff.java`)).toBe(true);
		expect(modelMayWrite(`${C}/sessions/s/exports/cand/a.meta.json`)).toBe(true);
		expect(modelMayWrite(`${C}/evidence/backups/x/a.xml`)).toBe(false);
		expect(modelMayWrite(`${C}/work/a.javap.txt`)).toBe(false);
		expect(modelMayWrite(`${C}/config.json`)).toBe(false);
		expect(modelMayWrite(`${C}/backup/a.xml`)).toBe(false);
		expect(modelMayWrite(`${ROOT}/code/src/A.java`)).toBe(true);
	});
});

describe("本机输出位置由工具定", () => {
	const layout = layoutFor("s1");
	const backups = `${C}/evidence/backups`;
	const exports = `${C}/sessions/s1/exports`;

	it("备份：每次一个带时间的新目录，给的目录只取最后一段当名字", () => {
		const stamp = stampOf(NOW);
		expect(norm(placeOutput(layout, "backup", null, "ptpl-t", NOW))).toBe(`${backups}/${stamp}-ptpl-t`);
		expect(norm(placeOutput(layout, "backup", ".cosmic-ai/evidence/meta-backup/改前", "x", NOW))).toBe(
			`${backups}/${stamp}-改前`,
		);
		expect(norm(placeOutput(layout, "backup", "outputs/before", "x", NOW))).toBe(`${backups}/${stamp}-before`);
		// 已经在备份目录里的原样用（照返回的路径再调）
		expect(norm(placeOutput(layout, "backup", `${backups}/20260101-000000-a`, "x", NOW))).toBe(
			`${backups}/20260101-000000-a`,
		);
	});

	it("导出：进本会话目录，同名就是同一份", () => {
		expect(norm(placeOutput(layout, "export", "tpl_dump", "x", NOW))).toBe(`${exports}/tpl_dump`);
		expect(norm(placeOutput(layout, "export", ".cosmic-ai/work/tpl_dump", "x", NOW))).toBe(`${exports}/tpl_dump`);
		expect(norm(placeOutput(layout, "export", `${exports}/tpl_dump`, "x", NOW))).toBe(`${exports}/tpl_dump`);
		expect(norm(placeOutput(layout, "export", null, "ptpl-t", NOW))).toBe(`${exports}/ptpl-t`);
	});

	it("探针不给输出目录也不会写到工程根下的 outputs/：导出、备份、工作流两种动作各去各的地方", () => {
		const out = (cls: string, env: Record<string, string>, key: string) =>
			norm(placeProbeOutputs(layout, cls, false, env, NOW).env[key] ?? "");
		expect(out("PrintTplJsonProbe", { TPL_NUMBER: "t" }, "OUT_DIR")).toBe(`${exports}/ptpl-t`);
		expect(out("PrintTplBackupProbe", { TPL_NUMBER: "t" }, "BACKUP_DIR")).toContain(`${backups}/`);
		expect(out("WfModelProbe", { WF_ACTION: "dump", WF_MODEL: "m" }, "WF_OUT")).toBe(`${exports}/wf-m`);
		expect(out("WfModelProbe", { WF_ACTION: "backup" }, "WF_OUT")).toContain(`${backups}/`);
		expect(placeProbeOutputs(layout, "WfModelProbe", false, { WF_ACTION: "list" }, NOW).placed).toEqual([]);
		expect(
			out("BotpRuleSyncProbe", { SYNC_BACKUP_ONLY: "1", SYNC_BACKUP: "outputs/botp-before" }, "SYNC_BACKUP"),
		).toBe(`${backups}/${stampOf(NOW)}-botp-before`);
		// 临时探针的入参不碰
		expect(placeProbeOutputs(layout, "PrintTplJsonProbe", true, { TPL_NUMBER: "t" }, NOW).placed).toEqual([]);
	});

	it("告诉模型落在哪：相对工程根，给了没用的说一声", () => {
		const placed = placeProbeOutputs(
			layout,
			"PrintTplJsonProbe",
			false,
			{ TPL_NUMBER: "t", OUT_DIR: "outputs/a" },
			NOW,
		);
		expect(placedNote(layout, placed.placed)).toContain(
			"OUT_DIR → .cosmic-ai/sessions/s1/exports/a（给的 outputs/a 没用）",
		);
	});

	it("要读的目录：照给的找，找不到按名字到本会话导出、备份（最新那份）里找", () => {
		const fs = new MemoryFs();
		fs.put(`${exports}/tpl_dump/t.meta.json`, "{}");
		fs.put(`${backups}/20261101-000000-botp-before/a.xml`, "x");
		fs.put(`${backups}/20261120-000000-botp-before/a.xml`, "x");
		expect(norm(resolveInputDir(layout, fs, "tpl_dump"))).toBe(`${exports}/tpl_dump`);
		expect(norm(resolveInputDir(layout, fs, "outputs/botp-before"))).toBe(`${backups}/20261120-000000-botp-before`);
		expect(norm(resolveInputDir(layout, fs, "nowhere"))).toBe(`${ROOT}/nowhere`);
	});
});
