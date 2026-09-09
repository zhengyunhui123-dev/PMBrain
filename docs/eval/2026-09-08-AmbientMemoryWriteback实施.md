# Ambient Memory Writeback 本地实施与验收

时间：2026-09-08。版本：Core 1.3.48 / Desktop 1.1.79 / Schema 124；WorkBuddy 托管 Pack v2，通用 agent-pack 1.0.1。

依据：用户提供的 `01a07f59-56f2-74a3-861f-d72a72badf62/plan.md`。本轮是在已有部分实现上补齐，不重复升级 Core/Desktop 版本，不建立新台账。

## 计划完成情况

| 切片 | 本地结果 |
|---|---|
| A 配置与 MCP 合同 | 默认 off；CLI、管理 API 和 Desktop 共用配置入口；DB/文件不一致或读取失败停止自动合同；HTTP initialize 按实时配置及真实 write 权限，stdio 重连读取新合同。off 与原五条合同字节一致。 |
| B TTL 与读取 | remember 支持有效期；两种引擎 active recall、会话/时间列表、去重候选及统计过滤过期记录；热记忆缓存不超过事实到期时间；include_expired 仍可查历史。Admin 显示即将到期/已过期。 |
| C 桌面交互 | 三种模式与同一 Core 状态；首次接入四选项，稍后只记录已询问；共享模式不自动询问；保存重启本地服务。 |
| D 深度接入 | Codex / Claude Code 先完成 MCP smoke 验证再安装托管块；幂等、CRLF、用户内容保留、AGENTS.override 拒绝；关闭移除块和 Hook；核心卸载 API 移除注册及托管内容。 |
| E Claude Stop Hook | 读取实际 Stop 的 transcript_path 中最新用户回合；无数据库连接，短输入等待、有限文件读取、失败 exit 0；中文/寒暄/引用/密钥预过滤；内容地址暂存。服务每 15 秒通过既有 Facts Pipeline 收获，真实 Source 与 provenance 分离，失败保留待处理文件。 |
| F doctor 与旧规则 | doctor/设置共用状态，检查配置漂移、缺失和残留；WorkBuddy 自动写入受合同开关约束，主路径改 remember。已安装旧规则在保存记忆设置时复用安全更新器迁移到 v2；用户修改不覆盖并提示。 |

## 审查修复的主要问题

- 避免配置读取失败继续沿用已开启缓存，以及文件已关闭、DB 仍开启时继续发布合同。
- HTTP 只读凭证不再因工具表包含 remember 就获得自动写入指导。
- Claude Stop 并不提供 last_user_message；改为从官方支持的 transcript_path 读取同 session 的用户文本，排除工具结果与元消息。
- Hook 使用明确 config-dir，修复 PMBRAIN_HOME 是父目录而非 config.json 所在目录导致的重复目录问题。
- Windows CRLF 托管标记正确识别；先预检所有修改，失败回滚；损坏 JSON/标记不覆盖。
- 模型异常或无法解析的抽取结果不把暂存文件误标为完成；关闭后、逐条写入前再次检查开关。
- 热记忆缓存区分本地/远程可见性，并在有效期到达时失效。
- Desktop 状态用文本呈现，避免异常消息作为 HTML；保存其他系统设置不意外把记忆重置为 off；深度接入按钮确实加入 DOM。
- WorkBuddy 原 Pack 版本未递增会把旧官方规则误报为用户修改；已升 v2，旧规则可安全更新。

## 验证证据

全部数据库写入在隔离测试实例/测试库中，未操作用户实际知识库。Postgres 使用本机 Docker gbrain-pg 的专用 `pmbrain_test_writeback_20260908`，不使用业务库。

| 验证 | 结果 |
|---|---|
| 首批配置/合同/Hook/暂存/托管/TTL/WorkBuddy 13 文件 | 51 通过，0 失败 |
| 相关 Facts、权限、抽取和接入回归 43 文件 | 首次 322 通过、3 项初始化/清理超时；3 个文件独立原超时重跑 24 通过、0 失败，未放宽测试时间或断言 |
| Postgres TTL 与旧 Facts idea 保留 | 2 文件、2 通过，0 失败 |
| 真实 HTTP + stdio initialize、权限、开启/关闭和托管移除 | 2 通过，0 失败；HTTP 使用实际 serve 子进程，非 mock transport |
| 收尾生命周期/配置/收获/发布说明 | 5 通过，0 失败 |
| WorkBuddy v2 安装/升级/关闭收敛/用户修改保护 | 16 通过；新增旧版本收敛断言与 PGLite TTL 再跑 8 通过 |
| 当前 Admin/桌面页面 | Playwright 以隔离 API/IPC fixture 打开最新构建资源；两种 TTL 文案、三模式、关闭状态与两个深度接入按钮通过；Admin 无浏览器运行错误 |
| TypeScript / 版本 | 根项目与 Desktop 通过；Core 1.3.48 / Desktop 1.1.79 同步 |
| 本地资源 | Admin、Desktop、Sidecar 已构建；Windows runtime 的 Bun、Sidecar、Canvas、PGLite 验证通过 |

日志位于本机临时目录：`pmbrain-wb-targets.log`、`pmbrain-wb-regression.log`、`pmbrain-wb-retry.log`、`pmbrain-wb-postgres.log`、`pmbrain-wb-transports-final2.log`、`pmbrain-wb-final-targets.log`、`pmbrain-wb-pack-final.log`、`pmbrain-wb-last-db.log`、`pmbrain-wb-runtime.log`。这些为本地证据，不包含数据库密码输出。截图在 `desktop/out/writeback-admin.png` 和 `desktop/out/writeback-desktop.png`。

## 与计划的差异及边界

- 本地 Postgres 已启动，本轮实际验证，不再沿用计划中的“未实测”。
- Hook 文件通过服务轮询收获，不增加新数据库表或迁移。按计划，Hook 抽取暂不自动设置 TTL；经 remember 保存的临时信息由调用方传 TTL。
- 卸载托管组件提供 Core Admin API；桌面主要关闭入口为 AI 长期记忆“关闭”。未新增独立的桌面卸载按钮。
- WorkBuddy 用户手改规则无法自动收敛；保留并报错，不能宣称这些规则已停止。已连接的 Agent 须重新建立 MCP 会话；无法强制清除外部 Agent 已缓存的旧指令。
- 尚未在用户真实 Codex / Claude / WorkBuddy 配置中安装或启用，也未完成真实模型的长期对话质量验收。契约/管道测试通过不代表千问、DeepSeek 会百分之百遵守合同；先前中文题集问题不在此轮宣称已全部解决。
- 暂存成功有 .done 防止正常重复收获；进程在 Facts 写入后、完成标记前崩溃的跨进程恰好一次保证未增加，仍依赖既有 Facts 去重能力。
- Windows HTTP socket 测试临时目录保留供诊断。两个旧测试临时目录的删除曾被自动审批拒绝（blocked by policy），未绕过；最终测试明确保留 Windows fixture，功能断言未减少。
- 未改真实 Wiki、原始资料、已有 Facts 或向量；未执行历史重抽取、重建、GitHub、提交或 build:win。CI 增加了 Postgres TTL/transport 用例，远程执行留给用户。

## 资料和工作方式

使用 mcp-builder、webapp-testing、openai-docs；PMBrain 连接器查询返回不可用，后续依据本地代码与计划。流程：比对既有实现 → 补兼容契约 → 最小修复/补齐 → 双数据库与真实传输验证 → 最新页面检查 → 资源构建 → 更新原台账。

官方契约参考：[Claude Code hooks](https://code.claude.com/docs/en/hooks)、[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)。
