# Postgres 与真实中文 Facts 评估

日期：2026-09-08。Core 1.3.45 / Desktop 1.1.76 / Schema 123。本轮补充验收，未修改生产代码或递增产品版本。

## 数据库结果

本机 Docker `gbrain-pg`，Postgres 16 / pgvector，端口 5433。创建专用 `pmbrain_test_alignment_20260908` 和最终干净测试库 `pmbrain_test_alignment_20260908_final`，没有使用正式库、恢复库或既有 `gbrain_test`。

最终通过 `scripts/run-e2e.sh` 顺序执行以下四个文件，6 项通过、0 失败、0 跳过：

- `facts-idea-postgres.test.ts`：旧五种类型和已有向量不变，idea 插入/筛选，迁移幂等，非法类型仍被约束拒绝。
- `session-import-postgres.test.ts`：已有格式样本的手动会话导入、Source 隔离、去重、原文件保留。
- `read-enrichment-alignment.test.ts`：私有和跨 Source 证据不能影响排名。
- `cycle-consolidate-postgres.test.ts`：事实归纳、年龄门槛、dryRun 不写入。

PGLite 迁移、Facts idea、Facts 围栏三个文件共 40 项通过、0 失败。数据库测试期间的两次失败均保留日志：

1. Bun 1.3.14 的异步 `.rejects` 断言触发等待超时。测试契约改成直接 await/try/catch，并严格断言 Postgres CHECK 错误码 `23514`；没有放宽生产约束。
2. 重跑旧测试库时，权限用例的固定 Source `align-work` 与上次残留冲突。最终换用新建空测试库完整验证。现有通用 setupDB 未清理 sources，重复使用同一测试库仍有这一限制，本轮未扩大修改。

两个专用库保留作复核；不含用户知识库数据。GitHub、远程 CI 和安装包仍由用户执行。

## 真实中文质量

按用户指定，使用当前 Codex 对话中的用户原话，依据日志 `user.text` 元数据排除插件推荐、AGENTS、环境信息、助手输出及工具日志。制作 15 条可追溯原文片段，预先标注可接受类别；包含 10 条应抽取输入和 5 条应忽略输入。全部使用生产 `extractFactsFromTurn` 与网关，实际调用本机 `ollama:qwen3:4b`；无模型模拟、无外部模型、无向量生成或入库。

| 指标 | 结果 |
|---|---|
| 正式模型调用 | 15 次，HTTP 200，0 超时/调用错误 |
| 按预先标注的逐题类别通过 | 8/15，53.3% |
| 应忽略输入被错误抽取 | 1/5 |
| 应抽取输入的类别通过 | 4/10 |
| 返回事实条数 | 13 |
| 平均每题耗时 | 约 15 秒（本机并行运行数据库测试，仅供参考） |

这里的 53.3% 是单次、单会话、人工标注小样本的类别匹配率，不能解释为通用中文准确率，也不是 GBrain 对照提升。部分 preference/commitment/belief 边界有主观性，评分后没有反改预期标签。题集缺少独立明确构想、复杂转述、量化指标和完整会议上下文，不能据此宣布 idea 全面达标。

主要失败：

- 完成状态追问被存为 `fact`，应返回空数组。
- GitHub 操作的长期约定被标为 `belief`。
- 产品兼容目标被标为 `idea`，且丢失桌面稳定性与体验约束。
- 中文使用现状被标为 `preference`，同一输入中的疑问片段又被抽成观点。
- 暂缓严格认证与历史重建的输入只保留“不知道用途”，遗漏“先放着”的决定。

四条正确忽略的输入均核对过原始模型响应，确实返回空 facts，不是网络错误被吞掉。保留此前 Qwen 原生响应解包逻辑，未用关键词改写类别或启用兜底模型。

## 实际 Codex 格式缺口

对本次真实日志只读执行当前 `parseSessionExport`：14 条明确用户输入、0 条 `event_msg.user_message`；结果为用户 0 条、助手 61 条。当前桌面日志把用户输入存于 `response_item.message`，并带 `internal_chat_message_metadata_passthrough.content_item_kinds=["user.text"]`。现有适配器只接受旧式 event 用户消息，因此会漏读。

这意味着既有样本的导入测试通过，不等于当前桌面真实日志已经兼容。质量评估直接取有元数据证据的用户原文，绕开导入层测抽取；本轮没有悄悄改动导入行为。下一步应补充这一格式及注入消息排除、双格式重复消息、异常元数据的回归，再扩充中文提示与保留完整上下文的复测。严格分块认证和历史重建继续暂缓。

## 本地证据与偏差

完整原文、行内 ordinal、预标注、原始 HTTP 响应、逐条评分及脚本保存在已忽略目录 `eval/private/facts-20260908/`：`dataset.json`、`results.json`、`assessment.json`、`parser-audit.json`、`postgres-clean.log`、`pglite-final.log`。不修改既有检索 qrels，不将真实对话提交到仓库。

正式评估使用独立配置目录。首次探测时，模型配置兼容迁移曾将探测提供的 `facts.extraction_model` 写入用户配置；已精确移除该新增项，随后改用隔离配置完整重跑，首次结果不计分。未修改真实知识、原文、向量或数据库。

与计划的差异：真实题集采用用户指定的 Codex 工程对话而非会议录音；本轮发现的导入格式和模型质量问题留作下一轮修复，不能将“测试完成”写成“中文质量已达标”。

## 2026-09-08 后续修复

Core 1.3.46。未改生产数据库约束，未重跑 Postgres 四个文件；PGLite 会话导入与 idea 迁移 3 项通过。

解析：`parseSessionExport` 现接受桌面 `user.text`。对同一份真实日志：用户 15、助手 66，注入 0。旧 event_msg 样本与无元数据注入排除仍保留。双格式相同正文去重、异常元数据跳过、损坏 user.text 报错已加回归。未照搬上游“跳过全部 response_item 用户消息”。

抽取：未知 kind 丢弃，不再把 `question` 存成 fact。中文提示改为：已发生事件必须抽取；整句才是追问/继续才可空；约定和桌面约束按 preference/commitment 整句保留；“可以先放着”为暂缓决定。

同一 15 题、同一 `qwen3:4b` 复测：11/15，0 调用错误。应忽略 5 题中 4 题仍为空，第 14 题把“不确定就算了”抽成 belief。类别通过的改善来自追问、长期约定和暂缓决定；第 3、11、13 题仍失败。隔离配置目录，未写回用户 `config.json`。不能据此宣布所有中文会议达标。
