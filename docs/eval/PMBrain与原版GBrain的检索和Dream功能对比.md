# PMBrain 与原版 GBrain 的检索和 Dream 功能对比

维护日期：2026-08-22

PMBrain 基线：1.2.75，AI 深度整理第三批实现

GBrain 基线：`D:\cursor-claude\gbrain` 的最新本地 `master`，commit `055ac6c7`，VERSION `0.46.25.0`

> 两个项目采用不同版本规则，版本号不能直接比较大小。本对比以实际代码、阶段顺序、配置解析和测试入口为准，不以版本号推断能力。

## 1. 结论

PMBrain 不是重新实现了一套 RAG 和 Dream：

- RAG 的混合召回、搜索模式、排序增强、图谱召回、缓存、遥测和评测底座主要沿用 GBrain。
- Dream 的阶段顺序、锁、Source 作用域、知识抽取、概念合成、观点与校准等主流程主要沿用 GBrain。
- PMBrain 的新增集中在中文与项目管理检索、普通模型统一兜底、无默认 Embedding 安全契约、桌面与 Admin 产品化、Source 安全实体解析、知识关系回填、孤儿治理和面向真实用户的质量评分。
- PMBrain 仍有尚未同步的上游更新，不能把这些差异误称为产品创新。查询向量共享 deadline、最新缓存隔离、Retrieval Reflex 等仍需评估；SkillOpt、Chronicle 等继续按产品边界暂缓。

后续维护原则仍是：

1. GBrain 负责核心知识运行时骨架。
2. PMBrain 优先移植不冲突的底层修复。
3. 中文、国产模型、Windows 桌面、Admin、Office 和项目管理交互留在 PMBrain 产品层。
4. 与 Source 安全规则、老用户数据兼容相冲突的上游能力不得直接覆盖。

## 2. RAG：沿用原版 GBrain 的能力

| 能力 | 来源判断 | PMBrain 当前状态 | 主要代码 |
|---|---|---|---|
| Vector、FTS、trigram 多路召回 | 沿用 GBrain | 保留，并继续作为混合检索候选集 | `src/core/search/hybrid.ts`、`vector.ts`、`keyword.ts` |
| RRF 融合、去重和结果预算 | 沿用 GBrain | 保留 | `hybrid.ts`、`dedup.ts`、`token-budget.ts` |
| conservative / balanced / tokenmax | 沿用 GBrain | 保留三种搜索模式及 per-call → config → bundle → balanced 解析链 | `src/core/search/mode.ts` |
| 多查询扩展 | 沿用 GBrain | 保留；tokenmax 默认启用，普通模式按配置使用 | `src/core/search/expansion.ts` |
| Query cache 与旋钮哈希 | 沿用 GBrain | 保留，但当前缓存哈希版本落后于最新上游，见第 6 节 | `query-cache.ts`、`mode.ts` |
| 意图权重、时间、情绪、Source boost | 沿用 GBrain | 保留，并增加中文意图词 | `query-intent.ts`、`intent-weights.ts`、`source-boost.ts` |
| 标题短语、精确匹配与别名加权 | 沿用后适配 | 保留上游标题/别名逻辑；PMBrain 额外强化中文精确 slug 尾名 | `title-match.ts`、`alias-normalize.ts`、`intent-weights.ts` |
| Graph signals | 沿用 GBrain | balanced/tokenmax 保留图谱邻接、跨 Source hub 和会话多样性信号 | `graph-signals.ts` |
| Relational recall | 沿用 GBrain | 关系问题可从实体进入 typed-edge 图谱，多跳深度上限为 3 | `relational-intent.ts`、`relational-recall.ts` |
| Contextual retrieval | 沿用 GBrain | balanced 使用标题上下文，tokenmax 可使用分块概要 | `contextual-retrieval-resolver.ts`、`contextual-retrieval-service.ts` |
| 专用 Reranker 与 autocut | 沿用后调整默认值 | 能力保留；PMBrain 的 balanced 默认关闭，tokenmax 或高级配置可显式启用 | `rerank.ts`、`autocut.ts`、`mode.ts` |
| Adaptive return | 沿用 GBrain | 保留按结果质量调整返回量 | `return-policy.ts` |
| Cross-modal 搜索 | 沿用 GBrain | 保留文本、图片和双路 RRF | `by-image.ts`、`image-loader.ts`、`embedding-column.ts` |
| Explain、evidence、telemetry | 沿用后增强 | 保留上游得分归因；PMBrain 增加 vector/reranker 实际执行状态 | `explain-formatter.ts`、`evidence.ts`、`telemetry.ts` |
| qrels、eval gate、LongMemEval | 沿用后增强 | 保留上游评测入口，并扩展真实用户题集和评分字段 | `src/core/bench/`、`src/commands/eval-*` |

## 3. RAG：PMBrain 自己新增或产品化的能力

| 能力 | PMBrain 新增内容 | 原因 |
|---|---|---|
| 中文查询规范化 | 新增 `query-normalize-zh.ts`，处理 NFKC、中文相对时间、项目词同义表达和最多 4 个词法变体 | 原版主要面向英文个人知识场景 |
| 中文意图识别 | 为 temporal、event、entity、canonical、recency、salience 增加中文规则 | 让“近期进展”“谁负责”“现在怎么样”等进入正确排序路径 |
| 中文精确名称保护 | 完整 slug、slug 尾名或标题精确命中至少获得 1.25 倍加权 | 导入页标题可能泛化，但用户记得原文件名或中文名称 |
| 普通模型统一兜底 | `models.default` / `chat_model` 成为普通模型；高级模型失败后回退普通模型 | 发布版不能要求所有用户持有 Anthropic、OpenAI 或专用模型密钥 |
| balanced 无专用 Reranker 依赖 | balanced 默认关闭 Reranker 和依赖其分数的 autocut | DeepSeek 等普通模型加本地向量即可运行 |
| 检索链路状态回显 | `--explain` 标明 vector 与 reranker 是 applied、disabled 还是 failed | 禁止静默降级被误认为模型质量问题 |
| Source 作用域真实题集 | qrels 每题可指定 Source，相关页按 `source_id + slug` 判断 | 防止多知识源同名页被算作正确命中 |
| 完整排序指标 | 在上游 Recall/Top1 基础上增加 MRR、Precision、nDCG、逐题返回页和页面级去重 | 同一页多个 chunk 不能重复增加 Recall |
| 公开与私有双层评测 | 公开固定题集用于 CI；私人真实问题存放在忽略目录 | 同时约束所有用户的公共质量和个人真实措辞 |
| 中文质量规范与模型评分 | 固定预计回答、答案条件、引用准确率、Source 隔离和模型 A/B 规则 | 模型推荐必须来自同题集实测，而不是主观印象 |
| 无默认 Embedding | 新安装、普通模型 API Key 和 Dream 模型都不会自动选择向量供应商；必须显式配置模型和维度 | 防止未授权的云端调用、混合向量空间和错误模型标签 |
| 向量 provenance 一致性 | 只有非空向量才记录实际 `provider:model`；无向量分块为 `NULL`，no-embed 重写保留原向量标签 | 修复 Ollama 向量被错误标成 ZeroEntropy 的统计和冲突更新问题 |
| Keyword-only 明确降级 | 未配置 Embedding 时 vector 状态为 unavailable，关键词、标题和关系检索仍可工作 | 所有用户都能理解实际执行链路，不把未启用误认为模型效果差 |

## 4. Dream：沿用原版 GBrain 的能力

PMBrain 的 `ALL_PHASES` 与 GBrain 主序列基本一致。除 GBrain 的 `skillopt` 未进入 PMBrain 外，核心顺序仍是：

```text
lint → backlinks → sync → synthesize → extract → extract_facts
→ extract_atoms → resolve_symbol_edges → patterns → synthesize_concepts
→ recompute_emotional_weight → consolidate
→ propose_takes → grade_takes → calibration_profile → drift
→ conversation_facts_backfill → enrich_thin
→ embed → orphans → schema-suggest → purge
```

| 能力 | 来源判断 | PMBrain 当前状态 |
|---|---|---|
| 单一有序 Dream cycle | 沿用 GBrain | 继续以 `ALL_PHASES` 作为唯一执行顺序，未另建平行流水线 |
| Cycle lock、刷新、超时与 dry-run | 沿用 GBrain | 保留，写阶段统一进入锁保护 |
| Phase scope | 沿用 GBrain | 保留 source / global / mixed 分类 |
| Transcript synthesize | 沿用后适配 | 保留会话转知识页的核心逻辑，增加 PMBrain 路径与模型适配 |
| Synthesize verdict | 沿用后对齐 | 已升级为评分、内容类型、候选分段、实体、模型和 triage 版本；旧布尔缓存会重判，截断、拒答和格式错误不会永久缓存 |
| Link、timeline 与 facts 抽取 | 沿用后适配 | 保留上游抽取骨架，并增加 PMBrain Source 解析规则 |
| CJK 人名和中文关系类型 | 最新上游能力移植 | 已支持中日韩名称及中文 founded / works_at / advises 等关系语义 |
| 正文日期推断 | 最新上游能力移植 | `--infer-dates` 只使用可信正文、frontmatter 或文件名日期，不用 `updated_at` 代替事件日期 |
| Atom 与 concept | 沿用后增强 | 保留原子抽取和概念合成；PMBrain 增加结构化证据关系 |
| Patterns | 沿用后增强 | 保留跨会话模式发现；PMBrain 增加反向证据写入 |
| Consolidate / takes / grade / calibration | 沿用 GBrain | 保留事实合并、候选观点、评价和校准画像 |
| Drift 与 enrich_thin | 沿用 GBrain | 保留且默认受配置门控制 |
| Conversation facts backfill | 沿用 GBrain | 保留，支持 conversation、meeting、slack、email |
| Embed、orphans、schema-suggest、purge | 沿用后适配 | 保留后段顺序；PMBrain 改进孤儿分母和产品回显 |
| PGLite Dream 子任务执行 | 沿用后对齐 | 私有子任务在同进程串行排空，不再跳过 synthesize 和 patterns；PostgreSQL 保留受控并发 |
| Source 新鲜度与全局阶段 | 沿用后对齐 | 每个 Source 只运行确定性的 Source 阶段，混合/全局阶段由单独维护任务执行一次，避免多 Source 重复消耗模型 |
| extract-atoms-drain | 沿用后对齐 | 单锁、固定时间窗持续清理积压；无进展停止；供应商全失败让持久任务重试而不是显示成功 |

## 5. Dream：PMBrain 自己新增或产品化的能力

| 能力 | PMBrain 新增内容 | 主要位置 |
|---|---|---|
| quick / full / meeting 预设 | 在不改变 `ALL_PHASES` 顺序的前提下选择阶段子集；meeting 强制执行必要的 atom 阶段 | `src/commands/dream.ts` |
| 普通模型与阶段级高级模型 | 七个真实 Dream 阶段可单独覆盖模型；留空继承实际 tier，失败回退普通模型 | `cycle/model-routing.ts`、Desktop 高级模型设置 |
| 国产与 OpenAI-compatible 模型 | DeepSeek、MIMO、智谱、Ollama 等可走统一 Gateway；非 Anthropic subagent 使用 Gateway tool loop | `model-config.ts`、`ai/gateway.ts` |
| Filing rules 与允许路径 | Dream 输出路径来自个人知识归档规则或 active schema pack，避免任意目录写入 | `cycle/allowed-slug-prefixes.ts` |
| 独立 Dream 输出目录 | 支持配置输出根目录并为桌面打包环境创建目录 | `cycle/dream-output.ts` |
| 结构化证据关系 | concept、pattern 等产物除正文 Wikilink 外，还写入 `derives_from` 与反向 `evidence_of` | `synthesize-concepts.ts`、`patterns.ts` |
| Source 内实体优先 | 当前 Source 精确解析优先，只回退 `default` 共享实体；跨其他 Source 必须显式限定 | `link-extraction.ts`、两种数据库引擎 |
| 任意目录精确路径 Wikilink | 精确路径存在时可以解析，不依赖历史目录白名单 | `link-extraction.ts` |
| PMBrain 孤儿统计规则 | 排除 Youdao 原始镜像、originals、附件、输出页、维护页等不应入链页面 | `orphan-policy.ts` |
| 历史关系安全回填 | 写入前导出完整 links 备份，回填后统计关系类型、缺失端点与跨 Source 目标 | `scripts/backup-links.ts`、`scripts/report-link-quality.ts` |
| Admin 与桌面 Dream 产品层 | 一键整理、定时运行、阶段摘要、成果明细、后台无窗口运行和高级模型配置 | `admin/`、`desktop/` |
| 面向发布的 Dream 评分 | 事实保真、证据有效、实体串联、孤儿改善、去重、Source 规则和行动价值分开评分 | `docs/eval/PMBrain检索与Dream质量评测规范.md` |
| 未配置向量时跳过 embed | Dream 返回 `embedding_not_configured` 的 skipped 阶段，不会选择 ZE，也不会把普通模型当向量模型 | `src/core/cycle.ts`、`src/core/embedding-dim-check.ts` |
| 深度整理两阶段筛选 | 便宜模型先输出可验证的结构化 triage map，昂贵综合阶段优先读取候选分段和实体；可配置阈值、并发与时间预算 | `cycle/structured-triage.ts`、`cycle/synthesize.ts` |
| Source 内链接候选清单 | 综合前用标题、名称、slug 尾名和关键词生成零 Embedding 候选；只在当前 Source 内提供人物、项目、公司和概念链接 | `cycle/link-manifest.ts` |
| 原子积压自动排空 | Autopilot 只为确有积压的 Source 提交受保护的排空任务；一次任务持有同一 Source cycle lock 并重复处理 bounded batch | `cycle/extract-atoms-drain.ts`、`autopilot-fanout.ts` |
| Dream 产物可检索 | atom、concept 统一走导入切块管线；无向量配置时仍写 `content_chunks` 并可关键词召回 | `extract-atoms.ts`、`synthesize-concepts.ts` |
| 会话输入适配 | 当前 PMBrain 与本地 GBrain 均为 19 个 built-in；补齐 ChatGPT 导出、Slack 块、AI 角色标题、Speaker A/B 等格式并保留普通文档保护 | `conversation-parser/builtins.ts` |

## 6. 当前尚未同步或明确暂缓的上游能力

这些项目不能算作 PMBrain 新增能力。

| 上游能力 | PMBrain 状态 | 建议 |
|---|---|---|
| Query embedding 共享 deadline | 尚未同步；GBrain 有 `makeQueryEmbedDeadline()`，PMBrain 当前没有 | 高优先级评估移植，避免向量服务卡住缓存查询和主搜索两次 |
| Dream embed 的 AbortSignal 与 quiet 输出 | 最新 GBrain 已接入，PMBrain 当前仅完成“未配置则跳过”和不回退 | 后续移植中止信号与安静输出，不改变现有阶段数据语义 |
| Query cache 最新隔离 | GBrain `KNOBS_HASH_VERSION=21`，PMBrain 当前为 9 | 高优先级移植，防止模型切换或排除规则变化后误用旧缓存 |
| Provider-agnostic embedding migration 命令 | GBrain 有独立 `migrate-embeddings.ts`；PMBrain 仍使用自己的受保护重嵌入流程 | 与老用户向量保护规则对照后移植，不能直接清空索引 |
| Global basename Wikilink 解析 | 明确不移植跨目录 basename | 当前 Source-local → default 更符合多 Source 安全边界 |
| Life Chronicle / 事件页投影 / 本体维度 | 尚未同步 | 知识库已能分类事件页；Chronicle、`event_page_id`、`facts.dimension` 仍暂缓 |
| Retrieval reflex | 尚未同步 | 需要真实题集证明收益后再决定 |
| SkillOpt | 明确暂缓 | 缺少专属 benchmark 前不允许自动改 Skill |
| `extract --stale` 关系抽取水位 | **已移植**（Schema 115） | `pages.links_extracted_at` + `pmbrain extract --stale` + `links_extraction_lag` |
| MEMORY_VERBS `entity` | **已移植** | 零模型实体卡片 |
| Fact remember/forget | **已移植** | 知识库可列出 facts 表 |
| MCP `list_skills` / `get_skill` 协议信封 | **已对齐** | 返回 `instructions` / `client_guidance`；本地 Sidecar 默认打开 `mcp.publish_skills`；Agent 先读 Skill 再搜知识。未移植 `list_brain_skillpack`、SkillOpt |

## 7. 本轮三项完成后的实际体验

1. 深度整理不再只得到“值得/不值得”布尔值。便宜模型先标出分数、内容类型、实体和原文片段，昂贵模型拿着这张地图整理，例行操作更少进入昂贵阶段，人物、项目和概念链接更容易接到既有知识页。
2. 模型输出被截断、拒答或 JSON 损坏时，本轮不会把错误结果写进永久缓存。下一轮仍可重新判断，不会长期出现“这份内容永远不再整理”的假阴性。
3. 原子提取每批仍受预算和批量上限保护，但后台会在固定窗口内继续处理下一批。积压清空即停止，连续无进展即停止，全部供应商请求失败则任务失败并进入重试，不再把剩余积压包装成成功。
4. PGLite 桌面用户可完成完整 Dream 阶段；多 Source 下全局综合不再为每个 Source 重复运行。atom 和 concept 即使没有 Embedding，也会切块并可通过关键词搜索。

数据库兼容：Schema 116 只为 `dream_verdicts` 增加可空字段，不回填、不清空旧判定，也不修改现有知识页、原始资料或向量。旧布尔判定按需重判。

## 8. Embedding 差异结论

最新 GBrain 仍保留 `zeroentropyai:zembed-1` 运行时默认值，因此这一点不沿用。
GBrain 已把部分分块 provenance 从硬编码 ZE 改为 Gateway 当前模型，这个方向沿用，
但 PMBrain 进一步要求“没有实际向量就不写模型”。

PMBrain 本次新增并固定以下行为：

1. `config.json` 没有完整的 `embedding_model + embedding_dimensions` 时不调用任何向量服务。
2. DeepSeek、MIMO、智谱等普通模型/API Key 只影响 Chat 和推理，不自动启用 Embedding。
3. Ollama 或其他显式模型失败时保留原错误，不切换到 ZE 或其他供应商。
4. Fresh schema 不写 `embedding_model`；1280 只作为未配置时的向量列存储宽度。
5. 导入、Dream、后台补全和两种数据库引擎共享 provenance 规则。
6. 历史上已被错误标记的行不自动批量改写；需另行取得授权并以可验证证据回填。

## 9. 如何判断后续功能属于哪一层

满足以下任一条件，优先视为 GBrain 核心层：

- 改动 vector / FTS / RRF / cache / graph / Dream phase 的通用算法。
- 同时影响 CLI、MCP、Admin 和桌面端调用的底层数据语义。
- 改动 pages、chunks、links、facts、takes 等通用数据结构。

满足以下条件，适合留在 PMBrain 产品层：

- 中文项目管理措辞、国内模型和 Windows 本地运行。
- Admin、桌面端、小白配置和成果展示。
- Office、会议目录、Codex/Claude 会话目录等具体输入体验。
- 本机私有题集、中文发布文档和用户配置迁移。

每次拉取 GBrain 更新时应先对照第 6 节，按以下顺序处理：

1. 安全和正确性修复。
2. RAG/Dream 通用能力。
3. 与 PMBrain Source、普通模型和老用户数据规则的冲突检查。
4. 公开题集、私人真实题集和隔离 Dream 评测。
5. 最后才更新桌面与 Admin 产品入口。

## 10. 2026-08-25 同步规则补充对齐

本节仅补充同步能力的专项复核，不表示前述 RAG/Dream 全文已重新审计。专项基线为 PMBrain 1.3.5 与本地 GBrain `master` commit `9dadfb97`。

| 同步能力 | GBrain 专项证据 | PMBrain 1.3.5 处理 |
|---|---|---|
| working-tree 显式开关 | `--working-tree` 与 `sync.include_working_tree` | 对齐；Admin 产品化为“包含未提交内容”，默认关闭 |
| Source 作用域失败账本 | open / acknowledged / auto_skipped 状态与次数阈值 | 对齐；固定文件第三次同类失败自动跳过，健康检查继续展示 |
| 基础设施失败保护 | Git sentinel 与数据库/Embedding 错误不允许跳过 | 对齐并保持 fail-closed |
| 数据库 op checkpoint | 长任务使用独立 DB checkpoint，不等同于最终书签 | 对齐；按 Source、仓库、commit 和参数隔离，成功后才清理 |
| Full Sync 内容来源 | 当前 GBrain `performFullSync()` 仍把现场目录交给 `runImport()` | PMBrain 按本次产品规则补齐为 `git archive HEAD` 快照；这是相对专项基线的兼容性修复，不宣称原版已具备 |

最终不变量：默认增量与 Full Sync 都只读取 Git HEAD；未提交变化只提示。只有显式开启 working-tree 同步才读取现场目录；任何路径都不会自动执行 `git commit`。
