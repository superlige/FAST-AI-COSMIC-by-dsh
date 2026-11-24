/**
 * 只给命令内部用的已发布探针：命令替模型调、解析它们的 JSON 旁路，模型自己调用拿不到有用的东西。
 *
 * 系统提示的探针名单不列它们（`src/agent/prompt/probe-policy.ts`），和 `cosmic_run` 各子命令背后的探针同一个处理。
 * S42 批 4.3：真机 58 份会话里模型直接调 `EntityFieldIndexProbe` 0 次；`MustInputProbe` 是从退役的
 * `FieldTypeProbe` 搬出来的必录字段旁路，只有 `cosmic_run` 的冷启动前核对用。
 */

/** `cosmic_run` 冷启动前核对必录字段（`run.ts` 的 `noteMustInput`）。 */
export const MUST_INPUT_PROBE = "MustInputProbe";

/** 重建代码关系表时收字段归属（`impact.ts`）。 */
export const FIELD_INDEX_PROBE = "EntityFieldIndexProbe";

/** 代码关系表元数据快照的变化清单：建快照时记基线，之后比出变了的行（`impact.ts`）。 */
export const META_CHANGE_PROBE = "MetaChangeProbe";

/** 生产排障比对元数据时取测试环境这一侧的原文（`prod/meta.ts`）。 */
export const META_ROWS_PROBE = "MetaRowsProbe";

/** 输入框 `@` 引用的表单目录：全库表单设计的编号、中文名、模型类型（`mention.ts`）。 */
export const FORM_CATALOG_PROBE = "FormCatalogProbe";

export const COMMAND_ONLY_PROBES: readonly string[] = [
	MUST_INPUT_PROBE,
	FIELD_INDEX_PROBE,
	META_CHANGE_PROBE,
	META_ROWS_PROBE,
	FORM_CATALOG_PROBE,
];
