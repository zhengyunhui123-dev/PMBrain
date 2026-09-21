# GBrain 能力成熟度台账

> 用途：GBrain 能力进入 PMBrain 代码、自动流程和普通用户界面前的唯一准入表。
>
> 当前审计基线：GBrain `0.50.0.0`，commit `a6be012a3bcfac42e279630aedec5cda4a450e29`；PMBrain `1.3.79`。
>
> 核心原则：代码存在、已经合入、测试通过、默认关闭，都不等于产品稳定。

只有「稳定」能力才有资格进入产品价值评审；稳定不等于必须吸收。

## 1. 成熟度定义

| 等级 | 判定标准 | PMBrain 处置 |
|---|---|---|
| 稳定 | 上游合同不是 provisional；当前目标环境有真实端到端成功记录；错误和数据边界明确；自动化、回滚及回归测试完整 | 允许吸收并进入普通界面或默认产品流程 |
| Beta | 主链已实现且有测试，但仍依赖未完成接入、缺少当前环境真实验收，或只覆盖部分场景 | 不进入普通菜单；不进入默认自动流程；默认拒绝吸收，重新评审后才能晋级 |
| 实验 | 上游明确写 provisional、eval-gated、TODO，或质量、成本、接口稳定性尚未过门禁 | 不进入主产品代码与界面；只允许隔离分支验证 |
| 研发工具 | 面向开发、评测或 CI，不是最终用户能力 | 可留在 eval/CI，不得包装成用户功能 |
| 未完成 | 缺关键依赖、产品闭环或真实可用链路，当前用户无法可靠完成任务 | 撤下入口；不得自动运行；补齐后重新从 Beta 评审 |

## 2. 技术与产品双门禁

一项能力进入 Admin、Desktop 或默认自动化前，必须同时满足：

1. 本表状态为「稳定」。
2. 写明上游版本、commit 和非 provisional 的合同证据。
3. 有 PMBrain 当前 Windows + PGLite 的真实端到端成功记录；涉及数据库时同时有 Postgres 证据。
4. 有普通用户能理解的成功、空状态和原生失败提示。
5. 明确默认开关、成本、隐私、回滚和老用户兼容边界。
6. 相关回归测试和发布 CI 对准确 SHA 通过。
7. 对 PMBrain 主要的中文用户有明确、高频、不可被已有功能轻易替代的价值。

任何一项缺失，都不能先做菜单再补证据。研发工具没有产品界面准入资格。低价值的稳定能力同样不进入普通界面。

## 2.1 图片 / OCR 统一导入专项评审（2026-09-21）

| 能力 | 成熟度 | 证据与判断 | 当前界面决定 | 后续条件 |
|---|---|---|---|---|
| GBrain 0.50.0.0 独立 OCR 路由与调用上限 | Beta | 上游已有专用 OCR 模型路由和测试，但未形成 Office、独立图片、Source 同步与维护凭据的完整产品闭环 | 不直接照搬上游界面；仅复用模型路由思路 | 继续跟踪上游真实端到端证据与调用预算策略 |
| PMBrain 统一图片 / OCR 导入与维护 | Beta | Core 已统一 PDF、OOXML、独立图片入口，保存识别凭据并支持模型变化和失败后的维护重试；本地模拟视觉接口、PGLite 导入和同步回归已覆盖，但未使用用户真实视觉模型，也未完成 GitHub / Postgres 远端验收 | 根据用户 2026-09-21 的明确指令加入桌面设置：图片模型留空时自动使用普通模型，单独配置时才覆盖；不支持视觉时跳过并提示，不阻断维护 | 用当前 Windows 安装版完成真实视觉模型 PDF、Office、图片 E2E；补 Postgres 与准确 SHA CI 后再评审“稳定” |

## 3. 本轮 PR1–PR12 成熟度审计

| PR / 能力 | 成熟度 | 证据与判断 | 当前界面决定 | 后续条件 |
|---|---|---|---|---|
| PR1 Schema 125–130 地基 | 稳定 | 纯加法 Schema；PGLite 迁移与定向测试已覆盖；不主动改写用户内容 | 无独立入口 | 随实际消费者继续做双引擎迁移验证 |
| PR2 跨 Source Entity Identity 核心 | Beta | GBrain `src/core/entity-identity.ts` 明写 `v1`、`MANUAL-ONLY`，retrieval union 默认 OFF；安全边界清楚，但不是完成的普通用户工作流 | 人物关联页和自动候选退出普通界面 | 需要当前 PMBrain 真实人物数据 E2E、误关联回滚与长期检索评测 |
| PR3 ChatGPT / Claude Chat Connectors | 实验 | GBrain 两个 provider 均为 `status: 'provisional'`；源码说明未在仓库中用真实账号探测，且 ChatGPT 可能被 Cloudflare 403 阻断 | Admin/Desktop 数据连接入口撤下；常驻自动同步撤销 | 上游合同转 stable，且 PMBrain 当前版本真实账号连续同步验收通过 |
| PR4 Google source + 凭证保险库核心 | Beta | 使用正式 Google API、凭证隔离和同步测试较完整；但 PMBrain 普通用户授权、Source 登记和连续同步尚无本轮真实 Windows E2E | 不提供普通数据连接向导；保留 CLI/Core 研发验证 | 完成真实 OAuth、首次同步、增量同步、过期恢复和 Windows 防火墙场景验收 |
| PR5 Gmail Open Loops 核心 | 稳定 | GBrain 已公开为 Gmail-first Open Loops；确定性线程状态机、30 天窗口/500 ceiling、只读 waiting 与关闭状态测试完整 | **不吸收为 PMBrain 产品功能**；撤下“待我处理”入口 | 技术上稳定，但 Gmail-first 对 PMBrain 中文主要用户的覆盖和价值不足 |
| PR5 PMBrain 会议/转录/Connector Open Loops 扩展 | 实验 | PMBrain 自增 lane；默认不调度，缺真实语料准确率、误报率和成本门禁 | 撤下来源标签、自动扫描开关和扫描按钮；不再常驻调度 | 建立真实语料 precision/recall、成本和纠错验收后重新评审 |
| PR6 Ontology | Beta | GBrain 有双时态合并和冲突查询；新维度仍先 quarantine，当前主要为 CLI/Core 能力 | 不新增普通用户入口 | 补真实人物、项目状态 E2E、冲突纠正和双引擎证据 |
| PR7 Life Chronicle / Timeline | 实验 | GBrain `src/core/chronicle/config.ts` 明写 default OFF，默认翻转仍是 `eval-gated` 的 TODO T8；会产生 LLM 成本 | 时间线菜单、自动生成开关和常驻调度撤下 | 上游评测门禁完成；PMBrain 历史回填、增量事件和空状态真实验收通过 |
| PR8 Memorable | 未完成 | 依赖未随 PMBrain 分发的第三方 `memorable-cli`；三重 consent 默认关闭；此前未完成真实 SessionEnd E2E | 不进入普通界面和默认流程 | 依赖可安装、披露和撤销完整、三种宿主真实 E2E 通过 |
| PR9 知识库体检基础能力 | 稳定 | PMBrain 原有 Advisor 已有真实页面、只读报告、受限 apply 白名单和回归测试 | 保留总体概览“知识库体检” | 新 collector 分别按自身成熟度准入 |
| PR9 Chronicle / writeback / brain-pack collectors | Beta | collector 自身有测试，但 Chronicle 仍实验，writeback 与 brain-pack 依赖配置和宿主状态 | 不为这些 collector 新建菜单，不允许借体检自动执行实验能力 | 各依赖能力先达到稳定，再单独晋级 |
| PR10 BrainBench / LongMemEval | 研发工具 | GBrain README 与命令明确是 eval/CI conformance suite；BrainBench 使用隔离 PGLite 与合成语料 | 仅保留 CLI、eval 和 CI，不做用户功能 | 持续作为吸收前质量门禁 |
| PR11 Admin / Desktop 产品面 | 未完成 | 先把不同成熟度能力平铺进 GUI，真实使用后才暴露 provisional 和空页面问题 | 本轮撤下数据连接、时间线、人物候选和实验扫描；模型快照退出侧栏 | 以后由本表逐项放行，不再整组产品化 |
| PR12 “文档反转暂缓” | 未完成 | 旧文档把“代码已合入”写成“产品已吸收”，没有成熟度维度 | 由本台账取代该判断 | 对比文档只记录代码差异，产品准入必须引用本表 |
| 1.3.75 产品常驻自动化调度 | 实验 | PMBrain 新增但没有上游成熟度或真实运行证据，同时会启动 provisional Connector、实验 Chronicle 和扩展 Open Loops | 从 `serve-http` 正常启动流程撤销 | 只允许稳定能力按各自成熟机制接入，不再使用总开关打包放行 |

## 4. 当前允许保留的普通产品入口

- 总体概览与知识库体检。
- 知识工作台、知识库、知识图谱、知识整理。
- MCP、任务中心、请求日志。
- 自动化：仅 PMBrain 已有的知识整理、模型调用许可和定时快速维护。
- 知识库设置、其他设置。

## 5. 当前撤下但不破坏底层数据的能力

- ChatGPT / Claude / Google 数据连接产品页与 Desktop 入口。
- Gmail Open Loops 与“待我处理”产品入口。
- 时间线产品页及自动生成开关。
- 人物候选与实体合并产品入口。
- 会议、转录、AI 对话待办扫描入口。
- 1.3.75 新增的统一产品常驻调度。

撤下入口不删除 Schema、不清空表、不修改既有配置和用户数据。研发代码后续是否删除，必须另行评审。

## 6. 更新规则

- 每次对齐 GBrain，先更新本表，再写代码。
- 成熟度只能按证据晋级，不能因为版本号更大、测试数量多或代码已合入而晋级。
- 上游出现 `provisional`、`experimental`、`preview`、`eval-gated TODO` 时，最高只能标「实验」。
- 没有当前 PMBrain 真实环境 E2E 时，最高只能标「Beta」。
- 产品入口与本表不一致时，以本表为准，入口必须撤下。
- 能力即使达到「稳定」，仍必须通过 PMBrain 主要用户的产品价值评审；不因为 GBrain 有、代码已合入或实现成本已发生就保留。
