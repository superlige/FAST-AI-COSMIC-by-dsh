/**
 * `doctor` -- what this project is configured as, and where each value came from (S5.1).
 *
 * The frozen doctor is the command you run first on a new machine, and its whole
 * value is the right-hand column: not "isv = zlgd" but "isv = zlgd, and it came
 * from auto-detection rather than from your config.json". A wrong value that the
 * user believes they set is the failure this command exists to catch.
 *
 * Three properties are preserved from the frozen version and each one is a rule,
 * not an accident:
 *
 *   1. **doctor never refuses to run.** It is the command for the situation where
 *      the config does NOT work, so it must not require a working config. It
 *      therefore does not go through openProject: no RuntimeKey, no JDK probe, no
 *      Cosmic JAR scan, none of which can succeed on a half-configured project.
 *   2. **Missing is reported, never guessed.** Unresolved project dependencies
 *      are listed as unresolved. The symptom of a missing module ("fast says the
 *      class does not exist") points nowhere near the config, and a guessed
 *      module name turns that into a wrong answer that looks right.
 *   3. **It stays offline.** No environment is contacted; the frozen implementation
 *      is explicit that making doctor need a live connection would break it
 *      exactly when it is needed most.
 *
 * One D13 change: the knowledge section no longer says "not configured -> fast
 * will refuse to compile plugin code". The knowledge base ships with the product,
 * so the section reports which source is in force and at what version, and an
 * unusable override is reported as a degradation rather than as an absence.
 *
 * `--write` remains deliberately absent. S6 resolved ProjectProfile ownership:
 * opening a project now writes the profile automatically, while doctor stays an
 * offline diagnostic and does not become a second profile collector.
 */

import type { KnowledgeSourceStatus } from "../../knowledge/source.ts";
import { describeKnowledgeSource } from "../../knowledge/source.ts";
import type { ConfigSource, KernelConfig } from "../config/load-config.ts";
import { missingRequired, sourceOf } from "../config/load-config.ts";
import { type KnowledgeSourceLine, sourceLine } from "./knowledge.ts";

export interface DoctorRow {
	field: string;
	/** Null when absent; rendered as "(缺失)" and never as an empty string. */
	value: string | null;
	source: ConfigSource;
	/**
	 * Environment variable name for env-sourced fields; the file path for the two
	 * config.json layers -- with a per-project file in play, "config.json" alone no
	 * longer identifies where a value came from; the resolution note for cosmicHome.
	 */
	via: string;
}

export interface DoctorReport {
	projectRoot: string;
	/** The machine-wide file (`<COSMIC_AGENT_DIR>/config.json`). */
	configFile: string;
	configExists: boolean;
	/**
	 * `<工程>/.cosmic-ai/config.json` -- the per-project layer, which wins over the
	 * machine-wide one. Reported whether it exists or not: on a machine with
	 * several Cosmic projects, "this project has no file of its own, so it is
	 * running on the machine-wide values" is exactly the fact that goes unnoticed.
	 */
	projectConfigFile: string;
	projectConfigExists: boolean;
	/** config.json JSON syntax error, reported rather than thrown: doctor must still print the rest. */
	parseError: string | null;
	/** Which of the two files failed to parse. Null when both parsed. */
	parseErrorFile: string | null;
	rows: DoctorRow[];
	modules: {
		/** Modules found in settings.gradle. */
		declared: string[];
		codeModules: string[];
		/** Project dependencies whose accessor did not match any include(). Never guessed at. */
		unresolvedDeps: string[];
	};
	/** Set when config.json's cosmicHome disagrees with the project's own systemProp. Project wins. */
	cosmicHomeConflict: { projectValue: string; agentValue: string } | null;
	knowledge: {
		source: KnowledgeSourceLine | null;
		/** Human-readable source description; empty when no knowledge source was supplied. */
		lines: string[];
	};
	missingRequired: { field: string; why: string }[];
	/** True when nothing blocks build / fast / probe. Knowledge state never blocks. */
	ok: boolean;
	nextActions: string[];
}

const FIELDS = [
	"isv",
	"tenant",
	"account",
	"user",
	"debugModule",
	"codeModules",
	"appClass",
	"appMethod",
	"cosmicHome",
	"knowledgeRoot",
	"debugPort",
	"probeServerPort",
	"jrebel",
	"dbLink",
] as const;

function fieldValue(config: KernelConfig, field: (typeof FIELDS)[number]): string | null {
	if (field === "codeModules") return config.codeModules.length > 0 ? config.codeModules.join(", ") : null;
	const value = config[field];
	if (value === null || value === undefined || value === "") return null;
	return String(value);
}

export interface DoctorInput {
	config: KernelConfig;
	/** Null when the knowledge snapshot could not be loaded at all; that fact is then reported. */
	knowledge: KnowledgeSourceStatus | null;
}

export function doctor(input: DoctorInput): DoctorReport {
	const { config, knowledge } = input;
	const missing = missingRequired(config);
	const rows: DoctorRow[] = FIELDS.map((field) => {
		const origin = sourceOf(config, field);
		return { field, value: fieldValue(config, field), source: origin.source, via: origin.via };
	});

	const nextActions: string[] = [];
	if (config.parseError !== null) {
		nextActions.push(`修好 ${config.parseErrorFile ?? config.configFile} 的 JSON 语法后重跑 doctor。`);
	}
	if (missing.length > 0) {
		// The project file, not the machine-wide one: account / user / isv belong to
		// ONE project, and a machine that holds several would otherwise get project
		// A's account silently applied to project B.
		nextActions.push(
			`补齐 ${missing.map((item) => item.field).join("、")}，写在 ${config.projectConfigFile}` +
				`（工程级，只对这个工程生效）；跨工程通用的才写全局 ${config.configFile}。`,
		);
	}
	if (config.auto.unresolvedDeps.length > 0) {
		nextActions.push(
			`有 ${config.auto.unresolvedDeps.length} 处工程依赖认不出模块名，用 extraCodeModules 在 config.json 里补上。`,
		);
	}
	if (config.cosmicHomeResolution.conflict !== null) {
		nextActions.push(
			`${sourceOf(config, "cosmicHome").via || "config.json"} 的 cosmicHome 与工程 gradle.properties 不一致；` +
				"本次以工程值为准，改配置或改工程二选一。",
		);
	}
	// L1 insertion point 4 (S7.4). doctor is the command for "the knowledge source
	// is unavailable", so it is the one place that can say how to fix it -- and it
	// still must not fail, which is why this is a next action and not an error.
	if (knowledge === null) {
		nextActions.push(
			"知识库内嵌快照不可用：官方指南、场景表和 API 正文这一层现在整体缺失。" +
				"发行物要与 cosmic-kb.pack 同目录；开发树里跑 npm run build 重新生成。" +
				"命令、探针和编译不受影响，缺的是「该怎么写」的依据。",
		);
	}
	if (knowledge !== null && knowledge.overrideProblem !== null) {
		nextActions.push(
			"配置的知识库覆盖没生效，已回退到内嵌快照；按上面的原因改 knowledgeRoot，或删掉它以显式使用内嵌快照。",
		);
	}
	if (nextActions.length === 0)
		nextActions.push("配置齐了。下一步：cosmic_open_project 识别运行时，然后 cosmic_probe EnvDiagProbe。");

	return {
		projectRoot: config.root,
		configFile: config.configFile,
		configExists: config.configExists,
		projectConfigFile: config.projectConfigFile,
		projectConfigExists: config.projectConfigExists,
		parseError: config.parseError,
		parseErrorFile: config.parseErrorFile,
		rows,
		modules: {
			declared: [...config.auto.modules],
			codeModules: [...config.codeModules],
			unresolvedDeps: [...config.auto.unresolvedDeps],
		},
		cosmicHomeConflict: config.cosmicHomeResolution.conflict,
		knowledge: {
			source: knowledge === null ? null : sourceLine(knowledge),
			lines:
				knowledge === null
					? ["知识库：内嵌快照不可用（发行物缺 cosmic-kb.pack，或未在开发树里生成）"]
					: describeKnowledgeSource(knowledge),
		},
		missingRequired: missing,
		ok: config.parseError === null && missing.length === 0,
		nextActions,
	};
}
