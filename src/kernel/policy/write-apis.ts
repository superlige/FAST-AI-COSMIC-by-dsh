/**
 * The write-API blacklist, and what an ad-hoc probe may not touch.
 *
 * Background. IsvGuard is the real gate on the shared Cosmic environment, but it
 * is called BY each probe -- code that never calls it is never checked. The 50
 * released probes are reviewed and do call it; ad-hoc Java does not exist yet at
 * review time, so it needs a different control.
 *
 * The control chosen here is capability, not review: an ad-hoc probe may READ
 * anything and WRITE nothing. That makes the diagnostic use case (which is the
 * reason to want ad-hoc probes at all) fully available, and takes the shared
 * environment out of reach without anyone having to audit the generated source.
 *
 * The write surface below was MEASURED, not guessed: every entry is an API the
 * released probes actually call to change something, found by reading them. The
 * families and their guard calls line up one-to-one with IsvGuard's own
 * assertOwn* methods, which is the cross-check that the list is complete for
 * everything the agent knows how to do today.
 *
 * What this does NOT cover, stated plainly because a whitelist's holes are
 * silent: an API nobody has used yet is not on the list. The list is therefore
 * paired with a second group -- the escape capabilities -- so that reaching an
 * unlisted API requires reflection, a classloader, a raw JDBC connection or a
 * subprocess, and all four of those are refused outright. A read-only diagnostic
 * probe needs none of them; the 22 released probes that DO use reflection are
 * reviewed code and are not scanned.
 */

export interface ForbiddenApi {
	/** Matched against source with comments and string literals blanked out. */
	pattern: RegExp;
	/** Shown to the caller: what was found. */
	what: string;
	/** Shown to the caller: why it is refused, and what to do instead. */
	why: string;
	/**
	 * A real call shape this rule must match. Every rule carries one so the S4.4
	 * matrix can prove no rule is unreachable: the frozen implementation shipped a
	 * javac pattern that could never fire and nobody noticed for months, and a
	 * silently dead rule here would be a write surface nobody is checking.
	 */
	sample: string;
}

/**
 * Group 1 -- the write surface. Each entry names a family that IsvGuard has a
 * judgement for, so "you may not write" and "here is who may" stay aligned.
 */
export const WRITE_APIS: readonly ForbiddenApi[] = [
	{
		pattern: /\bMetadataWriter\b/,
		what: "MetadataWriter",
		why: "实体/表单元数据写入，全租户共用；改字段、布局用已发布的 FormLayoutWriteProbe",
		sample: "Map<String,Object> r = new MetadataWriter(fm.getModelType()).save(em, fm);",
	},
	{
		pattern: /\bMetadataDao\s*\.\s*(rebuildRuntime\w*|save\w*|delete\w*|update\w*)/,
		what: "MetadataDao 的写/重建方法",
		why: "重建运行态元数据，全租户立刻可见；MetadataDao.readMeta / getIdByNumber 不在此列",
		sample: "MetadataDao.rebuildRuntimeMetaById(metaId);",
	},
	{
		pattern: /\bConvertRuleWriter\b/,
		what: "ConvertRuleWriter",
		why: "BOTP 转换规则写入；用已发布的 BotpRuleSyncProbe",
		sample: "Map<?,?> r = ConvertRuleWriter.save(meta);",
	},
	{
		// The call site is `service.updatePrintMeta(...)`: the mutating method name
		// is always on the call line, which is why this rule is a call shape.
		//
		// The CLASS name used to be an alternative here as well, and that was wrong.
		// PrintTplService is the read path for print templates as much as the write
		// path -- five of the six released print probes construct one and call
		// nothing but `getDesignMeta` / `getPrintMetadata` -- so matching the name
		// refused a read-only template audit with the reason "打印模板写入", which was
		// not a true statement about the code in front of it. A real session lost a
		// round of work to that and got out of it by writing a probe that was harder
		// to read rather than one that wrote less. The receiver is checked instead:
		// see READ_ONLY_TYPES below.
		pattern: /\.\s*(updatePrintMeta|beforeSave|migrate)\s*\(/,
		what: "PrintTplService",
		why: "打印模板写入；用已发布的 PrintTplWriteProbe",
		sample: "service.updatePrintMeta(metadata, json, lang);",
	},
	{
		pattern: /\bSaveServiceHelper\b/,
		what: "SaveServiceHelper",
		why: "业务数据落库；造数据用 DataSeedProbe，改数据用 DataUpdateProbe",
		sample: "SaveServiceHelper.save(new DynamicObject[]{row});",
	},
	{
		pattern: /\bDeleteServiceHelper\b/,
		what: "DeleteServiceHelper",
		why: "业务数据删除，诊断用不着",
		sample: "DeleteServiceHelper.delete(ENTITY, filters);",
	},
	{
		pattern: /\bOperationServiceHelper\b/,
		what: "OperationServiceHelper",
		why: "提交、审核等操作会落库并触发插件；模拟操作用已发布的 OpSandbox",
		sample: "r = OperationServiceHelper.executeOperate(op, entity, rows, opt);",
	},
	{
		pattern: /\bDB\s*\.\s*(update|execute\w*|insert\w*|delete\w*|batch\w*)/,
		what: "DB 的写方法",
		why: "裸 SQL 写入；DB.query / DB.queryDataSet 不在此列",
		sample: "DB.update(DBRoute.of(route), sql, params);",
	},
	{
		pattern: /\bORM\s*\.\s*create\s*\(\s*\)\s*\.\s*(insert|update|delete|save)\w*/,
		what: "ORM 的写方法",
		why: "ORM 直写。计数/查询（ORM.create().count 等）不在此列",
		sample: "ORM.create().insert(obj);",
	},
	{
		pattern: /\bTXHandle\b|\bTX\s*\.\s*(required|requiresNew)/,
		what: "显式事务",
		why: "只读诊断不需要开事务；开事务的目的通常是写",
		sample: "try (TXHandle tx = TX.required()) { }",
	},
	{
		// bos-designer-ai（平台自带的 AI 设计器服务，8.0.10 起）：这些类只有写入口，或者读写难分
		//（FormActionService 的导入、扩展、复制、移动；LockManager 抢设计器编辑锁；CopilotLLMService 连外部模型）。
		// 它们存元数据不经过 MetadataWriter 这个名字（MetadataUtil.saveAndLog、MetaOpsApplier.apply），
		// 上面那条拦不到。S42 批 0 发现时临时探针可以直接调 setProperties 改共享元数据。
		// 其中能读的几个类放在 READ_ONLY_TYPES，按方法放行。
		pattern:
			/\b(MetaOpsApplier|MetaPluginRegistrationService|LockManager|AppService|AppUnitService|CloudService|AppMenuService|FormActionService|FormDeleteService|FormTemplateService|ScriptCreationService|MetadataExecutionService|BillModelingService|BillScaffoldService|ModelingPlanService|ModifySessionService|ReportPropertyService|AIMetaBuilder|AiProjectDAO|CopilotLLMService|DeepSeekClient|DevportalApiService|PDMSaveApi|PDMSubmitApi|\w+ApiController)\b/,
		what: "平台 AI 设计器的写服务",
		why: "改元数据、应用、菜单、插件登记，存库不经过 MetadataWriter",
		sample: "MetaPluginRegistrationService.registerPlugin(param);",
	},
	{
		pattern: /\bDispatchService\b|\bMessagePublisher\b|\bMQFactory\b/,
		what: "微服务调用 / MQ 发布",
		why: "跨节点调用和消息会在别处写入，事后查不出来源",
		sample: "DispatchService.invoke(appId, service, method, args);",
	},
];

/**
 * Group 2 -- the escape capabilities.
 *
 * This group is what keeps group 1 from being a list of names to route around.
 * Without reflection, a classloader, a raw JDBC connection or a subprocess,
 * reaching a write API that group 1 missed requires naming it in source, where
 * group 1 sees it. With any of them, group 1 is decoration.
 */
export const ESCAPE_APIS: readonly ForbiddenApi[] = [
	{
		pattern:
			/\bClass\s*\.\s*forName\b|\bjava\.lang\.reflect\b|\bgetDeclaredMethod\b|\bgetMethod\b|\bsetAccessible\b|\bMethodHandles\b/,
		what: "反射",
		why: "反射能调到白名单没列出的任何写入口，白名单就失效了。已发布探针可以用反射——它们审过；临时探针不行",
		sample: "Class<?> c = Class.forName(name);",
	},
	{
		// Holding/inspecting a loader is read-only. Refuse construction, subclasses
		// and loading entry points (including method references), not getter names.
		pattern:
			/\b(?:new|extends)\s+(?:[\w$]+\.)*[\w$]*ClassLoader\b|\b\w*ClassLoader\s*::\s*new\b|\bURLClassLoader\s*(?:\.|::)\s*newInstance\b|\b(?:loadClass|findClass|defineClass)\b|\bUnsafe\b|\bjavax\.script\b|\bScriptEngine\b/,
		what: "动态类加载 / 脚本引擎",
		why: "动态装载或脚本执行会运行扫描看不见的代码。只查类和加载器可用 Foo.class、obj.getClass()、getClassLoader()；不要构造加载器或调用 loadClass / findClass / defineClass",
		sample: "URLClassLoader loader = new URLClassLoader(urls);",
	},
	{
		pattern: /\bProcessBuilder\b|\bRuntime\s*\.\s*getRuntime\s*\(\s*\)/,
		what: "子进程",
		why: "子进程会让待扫描代码在 cosmic Java 执行链内转去运行未扫描内容，因此临时探针不放行",
		sample: "new ProcessBuilder(exe, arg).start();",
	},
	{
		// java.sql also contains value/read types (Date, Timestamp, ResultSet,
		// SQLException). Refusing the package name made a pure date assertion look
		// like a raw connection. Match only capabilities that can acquire a
		// connection or execute SQL; wildcard imports stay closed.
		pattern:
			/\bjava\.sql\.\*|\bjava\.sql\.(?:Connection|Statement|PreparedStatement|CallableStatement|DriverManager)\b|\bjavax\.sql\.DataSource\b|\b(?:DriverManager|DataSource)\b|\b(?:getConnection|createStatement|prepareStatement|prepareCall)\s*\(/,
		what: "裸 JDBC 连接",
		why: "拿到 Connection 就能直接发 SQL，苍穹这一层的所有判据都不在路径上",
		sample: "Connection conn = DriverManager.getConnection(url, u, p);",
	},
	{
		pattern: /\bFileOutputStream\b|\bFileWriter\b|\bFiles\s*\.\s*(write|delete|move|copy|createFile)/,
		what: "文件写入",
		why: "探针跑在开发者机器上，写文件可以改工程源码、改配置、改缓存里的已发布探针",
		sample: "Files.write(path, bytes);",
	},
	{
		pattern: /\bnew\s+Socket\b|\bServerSocket\b|\bHttpURLConnection\b|\bHttpClient\b|\bopenConnection\s*\(/,
		what: "网络访问",
		why: "诊断探针没有理由自己连网；能连网就能把查到的数据送出去，也能触发别处的写",
		sample: "new Socket(host, port);",
	},
];

/**
 * Group 3 -- the types an ad-hoc probe may HOLD, but may only READ through.
 *
 * Groups 1 and 2 are name blacklists, and a name blacklist can only answer "does
 * this source mention X". For a class that exists in order to write, that is the
 * same question as "does this source write", which is why the blacklist works at
 * all. `PrintTplService` is where the two came apart: it is the only way to read
 * a print template's design metadata AND the only way to overwrite it. Refusing
 * the name refused the reads too, with a reason that was false about the code,
 * and the cost landed on the diagnostic use case that ad-hoc probes exist for.
 *
 * The carve-out is receiver-scoped, not line-scoped, and that is what keeps it
 * from being a hole. Every way to call a method on one of these types names the
 * type somewhere first -- a declaration, a parameter, a cast, a constructor, a
 * static call -- because reflection, dynamic loading and script engines are all
 * refused by group 2. So the scan collects the receivers by type and checks the
 * calls made through them: a method in `reads` passes, and anything else is a hit
 * naming the method it found. An UNKNOWN method is refused rather than allowed,
 * which is the direction a list like this has to fail in: a read method left off
 * costs one refusal that a line of code fixes, while a write method left on would
 * be a silent write to a shared environment.
 *
 * `reads` is measured the way group 1 was -- from the released probes that do the
 * reading -- plus the three Object methods that cannot mutate a receiver.
 */
export interface ReadOnlyType {
	/** Simple type name, as it is written in source. */
	type: string;
	/** Methods that only read. Anything else called through a receiver of this type is a hit. */
	reads: readonly string[];
	/** How the prompt names the reads when the list is too long to print; defaults to the first two. */
	readsHint?: string;
	/** Reported with the offending method appended, e.g. `PrintTplService.updatePrintMeta`. */
	what: string;
	why: string;
	/** A real read-only use the carve-out must let through. The matrix proves it does. */
	readSample: string;
	/** A real write through a receiver the carve-out must still catch. The matrix proves it does. */
	writeSample: string;
}

/** Methods every reference has, none of which can change the receiver. */
export const OBJECT_READS = ["toString", "hashCode", "equals"] as const;

export const READ_ONLY_TYPES: readonly ReadOnlyType[] = [
	{
		type: "PrintTplService",
		// PrintGridDumpProbe, PrintTplBackupProbe, PrintTplControlAssertProbe,
		// PrintTplDesignProbe and PrintTplJsonProbe between them call exactly these
		// two. PrintTplWriteProbe is the one that calls updatePrintMeta, and it is
		// released, reviewed and goes through IsvGuard.
		reads: ["getDesignMeta", "getPrintMetadata", ...OBJECT_READS],
		what: "PrintTplService",
		why: "打印模板写入。只读审计走 getDesignMeta / getPrintMetadata，拿到模板对象怎么读都行；要落模板用已发布的 PrintTplWriteProbe，它过 IsvGuard.assertOwnPrintTpl（连挂靠单据一起查）",
		readSample: "DesignMetadata dm = (DesignMetadata) new PrintTplService().getDesignMeta(tplId);",
		writeSample: "PrintTplService service = new PrintTplService();\nservice.updatePrintMeta(metadata, json, lang);",
	},
	{
		// The workflow facade is the same shape as PrintTplService, one class for both
		// directions: the queries a diagnosis needs (in flow? which node? who
		// approved?) sit next to completeTask, withdraw and abandon, which move a real
		// bill through its approval flow. It was on neither list, so an ad-hoc probe
		// could approve or terminate a flow while the prompt said ad-hoc probes only
		// read. `reads` is the method list reflected from the 8.0 JAR, keeping the
		// names that only query: get*/find*, the in/exists/can/is checks, and the one
		// batch query. Left off: the getters that run participant addressing or
		// pre-compute approval records (get*Addressing*, getAddressAndPreCompute,
		// get*PreComputor*, getNextUseableUserAndScope), whose side effects nobody
		// has measured, and the viewers that need a form view.
		type: "WorkflowServiceHelper",
		reads: [
			"inProcess",
			"existProcDefByEntityNumber",
			"canWithdraw",
			"canWithdrawByProcessInstanceId",
			"isUserBelongToRole",
			"batchGetApprovalRecordByBusinessKey",
			"findOperationLogByBusinessKey",
			"findOperationLogByProcInstId",
			"findTaskById",
			"findTaskByIds",
			"getActInstInfo",
			"getAllApprovalRecord",
			"getAllApprovalRecordInclCoordinate",
			"getAllOriginalApprovalRecord",
			"getAllProcInstPropertiesByBusKey",
			"getAllProcessCategory",
			"getApplyedProcess",
			"getApprovalRecordMeta",
			"getApprovalRecords",
			"getApproverByBusinessKey",
			"getApproversMapByBusinessKeys",
			"getArchiveRouteKeys",
			"getAuditAllowModifiedFields",
			"getAuditBillPageAttributeConfigs",
			"getAuditPointResultsByTaskId",
			"getAutoCoordinateUsers",
			"getBillPageAttributeConfig",
			"getBizProcessStatus",
			"getBusinessKeyByEntityNumberUIds",
			"getCommentForPrint",
			"getCommentForPrintByType",
			"getCommentsByTaskId",
			"getCurrentCallActivityMultiInstInfo",
			"getDeployModel",
			"getEnableProcessCount",
			"getEnabledProcDefByEntityNumber",
			"getEnabledProcesses",
			"getHandledTasksByUserId",
			"getInProcessApply",
			"getInProcessDataEntity",
			"getLastNodesComment",
			"getModelByAppId",
			"getModelByProcessCategoryId",
			"getNextMandatoryNodes",
			"getNextUserTaskNodeByBusinessKey",
			"getNextUserTaskNodeByModel",
			"getNodeParticipantScop",
			"getNodeProp",
			"getPageVariables",
			"getPrintCommentWithParam",
			"getPrintMetaEntityNumber",
			"getProInsIdByBusinessKeyAndEntityNumber",
			"getProcDefById",
			"getProcDefByNumberAndVerson",
			"getProcElementsByProcDefId",
			"getProcElementsBySchemeId",
			"getProcElementsBySchemeNumber",
			"getProcSchemeBySchemeId",
			"getProcSchemeBySchemeNumber",
			"getProcSchemesByProcDefId",
			"getProcess",
			"getProcessAttachmentsInfo",
			"getProcessDefinitionInfoById",
			"getProcessDefinitionInfoByProcInstId",
			"getProcessElements",
			"getProcessInfo",
			"getProcessInstanceIdByBusinessKey",
			"getProcessInstancePropertiesByBusinesskey",
			"getProcessNodes",
			"getProcessWindowRecords",
			"getProcessesByEntityNumber",
			"getRejectInnerNodes",
			"getRejectNodes",
			"getRejectedPreNode",
			"getTaskCountByType",
			"getTaskCounts",
			"getTaskEntityName",
			"getTaskIdByBusinessKeyAndUserId",
			"getTaskIdByProcessInstanceIdAndActivityIdAndUserId",
			"getToHandleTasksByUserId",
			"getToHandleTasksMessage",
			"getVariablesByProcInstId",
			"getWorkflowModelMultiLanguageIdsByAppId",
			"getWorkflowMultiLanguageIdsByAppId",
			"getWorkflowMultiLanguageWords",
			"getWorkflowTemplateMultiLanguageIdsByCategoryId",
			...OBJECT_READS,
		],
		readsHint: "inProcess、getXxx / findXxx 等查询方法",
		what: "WorkflowServiceHelper",
		why: "审批、撤回、终止、跳转等流程写操作会推动真实单据的审批流。临时探针只调查询方法；要验写操作，把代码写进工程源码，用 cosmic_run call 带断言跑",
		readSample:
			"boolean running = WorkflowServiceHelper.inProcess(key);\nObject status = WorkflowServiceHelper.getBizProcessStatus(new String[]{key});",
		writeSample: 'WorkflowServiceHelper.completeTask(taskId, userId, "Consent", "同意");',
	},
	// 平台 AI 设计器（bos-designer-ai）里读写同在一个类的服务。reads 取自 8.0 JAR 的方法表，
	// 只留查询；set* / add* / update* / delete* / register* 都是一调就存库（S42 批 0 实测 setProperties 每调一次存一次）。
	{
		type: "MetaPropertyService",
		reads: ["listElements", "getPropertySchema", "getProperties", ...OBJECT_READS],
		what: "MetaPropertyService",
		why: "改控件和字段属性，一调就存库",
		readSample: 'List<PropertySchema> s = MetaPropertyService.getPropertySchema("demo_bill", "fs_baseinfo");',
		writeSample: 'MetaPropertyService.setProperties("demo_bill", "fs_baseinfo", props);',
	},
	{
		type: "ComplexPropertyService",
		reads: [
			"listParameterForms",
			"listBaseEntityTypes",
			"listRefLayouts",
			"listOrgFuncs",
			"listOrgViewSchemes",
			"listAsstTypes",
			...OBJECT_READS,
		],
		readsHint: "list*",
		what: "ComplexPropertyService",
		why: "改样式、下拉项、过滤等复杂属性，一调就存库",
		readSample: 'List<Map<String, String>> t = ComplexPropertyService.listBaseEntityTypes("demo_bill");',
		writeSample: 'ComplexPropertyService.setStyle("demo_bill", "fs_baseinfo", style);',
	},
	{
		type: "MetaOperationService",
		reads: [
			"listAvailableOperationTypes",
			"listOperations",
			"getOperation",
			"getOperationTypeSchema",
			"validateOperationType",
			...OBJECT_READS,
		],
		readsHint: "list* / get*",
		what: "MetaOperationService",
		why: "增删改单据操作，一调就存库",
		readSample: 'OperationListResult r = MetaOperationService.listOperations("demo_bill");',
		writeSample: "MetaOperationService.addOperation(param);",
	},
	{
		type: "MetaRuleService",
		reads: ["listRules", ...OBJECT_READS],
		what: "MetaRuleService",
		why: "增删改界面规则，一调就存库",
		readSample: 'RuleListResult r = MetaRuleService.listRules("demo_bill", null);',
		writeSample: "MetaRuleService.addRule(param);",
	},
	{
		// 同名类平台里不止一个；按方法判，别的 MetadataUtil 调了名单外的方法也会被拒，照读方法改写即可。
		type: "MetadataUtil",
		reads: [
			"getFormIdByNumber",
			"readFormMetadata",
			"readEntityMetadata",
			"getCurrentIsv",
			"isGrayGroup",
			"isProductEnv",
			"isProductEnvIgnoreKingDeeIsv",
			"isDeploying",
			"isLightExt",
			"checkEnv",
			"checkAppWritable",
			"checkAppCreatable",
			"checkFormIsvMatch",
			"checkPageModifyPermission",
			"checkPageNewPermission",
			"checkDevportalViewPermission",
			"verifyPermission",
			"checkEditable",
			"checkReadable",
			"checkCanAddForm",
			...OBJECT_READS,
		],
		readsHint: "read* / check* / is*",
		what: "MetadataUtil",
		why: "saveAndLog 存元数据，createMetadataWriter 拿写入器，write* 写日志",
		readSample: 'FormMetadata fm = MetadataUtil.readFormMetadata("demo_bill");',
		writeSample: 'MetadataUtil.saveAndLog("demo_bill", fm, em);',
	},
	{
		type: "MetaOpsEngine",
		reads: ["preview", ...OBJECT_READS],
		what: "MetaOpsEngine",
		why: "apply 按改动清单存元数据",
		readSample: "MetaOpsEngine engine = build();\nPreviewResult p = engine.preview(ops, ctx);",
		writeSample: "MetaOpsEngine engine = build();\nengine.apply(ops, ctx);",
	},
	{
		type: "SnapshotService",
		reads: ["getHistory", ...OBJECT_READS],
		what: "SnapshotService",
		why: "saveLog 写日志，rollbackTo 回退元数据",
		readSample: "SnapshotService snapshots = build();\nList<OperationLog> h = snapshots.getHistory(sessionId);",
		writeSample: "SnapshotService snapshots = build();\nsnapshots.rollbackTo(ctx, 3, engine);",
	},
];

export const AD_HOC_FORBIDDEN: readonly ForbiddenApi[] = [...WRITE_APIS, ...ESCAPE_APIS];
