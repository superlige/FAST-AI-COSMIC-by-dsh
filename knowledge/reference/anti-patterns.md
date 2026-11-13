---
class: D
when: 方法名幻觉、上下文或事务场景错配
---

# 苍穹插件语义陷阱

> 定位：只保留“编译可能通过但上下文或业务语义仍错误”的陷阱。类、方法、字段和常量是否存在，
> 交给当前工程的 `api` / `findclass` / `lint` 实时裁决；官方候选见
> [official-knowledge.md](official-knowledge.md)。

## 先让工具裁决存在性

```bash
cosmic_knowledge action=findclass query=<类名关键字>
cosmic_knowledge action=api query=<全限定类名>[#成员名]
cosmic_lint <Java文件>
```

不维护“某类/方法永远不存在”的静态黑名单，也不复制 `QCP` 常量全表。版本升级后，静态表比真实
classpath 更容易漂移。需要 QCP 值时直接查 `cosmic_knowledge action=api query=kd.bos.orm.query.QCP`，常量连值一起给。

## 编译能过但语义会错

| 错误做法 | 为什么错 | 正确处理 |
|---|---|---|
| 用 `not_equals` 代替判非空 | SQL 的 `字段 != 值` 不包含 NULL 行 | 从 `api` 查 `QCP` 取当前判空常量，值参数按真实签名传递 |
| 在操作插件中调用 `getView/getModel` | 操作插件没有页面上下文 | 处理事件参数里的 `DynamicObject`，错误写入 `OperationResult` |
| 在 UI 插件中做长事务或全量查询 | 阻塞页面会话且失败边界不清 | 业务写入放操作插件/服务层，UI 只编排和提示 |
| 在 `registerListener` 读取已绑定业务值 | 此时数据可能尚未完成绑定 | 推迟到 `afterBindData` 或对应数据事件 |
| 在 `afterCreateNewData` 赋值后等待普通 `propertyChanged` 链 | 当前实测新增初始化不会按普通交互链触发 | 显式复用联动函数，并用 `run form` 观察事件 |
| 只实现 Listener 而未注册 | 编译通过但事件不会触发 | 在 `registerListener` 中注册一次，并验证真实事件 |
| 对所有回调机械调用或省略 `super` | 基类生命周期与监听接口来源不同 | 按真实继承关系和周围代码裁决，见 [plugin-dev.md](plugin-dev.md#正确处理-super-调用) |
| 基础资料对象属性直接写 `Long` | `_id` 与对象属性类型不同 | 查 `MetaProbe`，对象属性写已加载的 `DynamicObject` |
| 分录查询按短字段名读取 | 查询结果可能以 `分录.字段` 为属性名 | 按 select 字段完整路径读取并用探针回验 |
| 插件成员长期持有 `DataSet` / 流 | 生命周期、关闭责任和序列化边界错位 | 在最小作用域打开并关闭，不跨线程/回调保存 |
| 非 `final static` 保存页面、请求或打印状态 | 多实例和并发请求互相污染 | 页面状态用 PageCache；其它状态先确认实例生命周期和清理时机 |
| 把服务端模拟说成浏览器验证 | DOM、焦点、拖拽、下载、打印外观仍在浏览器边界 | 明确 synthetic 输入；视觉结果单独做浏览器/PDF验收 |

## 项目公共库边界

`OpUtils`、`BotpUtils`、`FormUtils`、`DynamicObjectUtils` 等名字可能来自某个二开项目的公共库，
不是苍穹平台保证的通用 API。使用前先在当前工程搜索来源，并用 `findclass` / `api` 复核；不存在时按
项目现有公共层风格实现，不能把某个出处工程的工具名写成所有苍穹工程的强制要求。

## 验证闭环

存在性通过不等于行为正确。插件代码至少经过：`api` / `findclass` → `lint` → 改业务代码后 `fast` →
对应 `probe` 或 `run op/form/list/flow`。涉及视觉、浏览器交互或最终 PDF 排版时，再补真实客户端验收。
