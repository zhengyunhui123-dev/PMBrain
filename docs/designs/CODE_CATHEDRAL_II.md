# 代码大教堂 II — v0.20.0 设计

**状态：** 已接受。CEO + 工程 + 2次 codex 审查已清除（2026-04-24）。共吸收了 16 个跨模型发现：7个 codex 第1轮（结构性前置条件）+ 6个 codex 第2轮（吸收错误，包括 CHUNKER_VERSION 静默无操作网关和入边失效）+ 3个工程审查架构决策。DX 审查建议在发布前在发布前审查新的 CLI 界面后再发布。

**替代：** 大教堂 I（计划 v0.18.0–v0.19.0 代码索引，已发布 v0.19.0）。

**模式：** 范围扩展（用户明确："我要世界上最好的代码搜索"）。

**规模：** 14 个可二分层次，~20–25 CC 小时，3–5 人周。一个模式迁移，带有拆分的边表（`code_edges_chunk` + `code_edges_symbol`）。通过 `CHUNKER_VERSION` 碰撞（下次同步时自动）+ 显式 `gbrain reindex-code` 命令进行回填。

## 为什么是 v0.20.0

v0.19.0 发布了代码索引：tree-sitter 分块器、29 个活跃语言、符号列、前向 doc↔impl 链接、增量嵌入缓存、BrainBench 代码类别。大教堂 I 的四个项目在发布期间被推迟：`query --lang` 过滤器、`sync --all` 成本预览、markdown 围栏提取、反向扫描 doc↔impl 回填。

大教堂 II 是对这四个的守诺发布，捆绑了使 gbrain *成为* 代码搜索的飞跃：结构边（调用图 + 引用 + 导入 + 继承）、父作用域捕获、doc-comment FTS 绑定和两遍检索。不再有针对代码的 grep 类检索。

## 10x 飞跃

今天：代理询问"混合搜索如何处理 N+1？" → 获得 3 个 `hybrid.ts` 的散文块。

大教堂 II：相同查询返回锚定函数 + 其 3 个调用者 + 其 2 个被调用者 + 其 JSDoc + `/docs` 中引用它的指南 + 执行它的测试文件 + 父作用域链。一次遍历。支持代码的 brain。

## 范围（5 个层级 + 层级 0 前置条件，14 个可二分层次提交）

### 层级 0 — 前置条件（由 codex 在外部声音中揭示）

**0a. 文件分类扩展。** `sync.ts:35` 目前仅将 9 个扩展名分类为代码（TS、JS、Python、Go、Rust、Ruby、Java、C、C++）。大教堂 II 的 B1 发布了 165 个懒加载语法，因此分类器需要接受分块器可以处理的任何扩展名。还将 `detectCodeLanguage` 重新排序，以便 Magika（B2）作为无扩展名文件的回退运行，而不是在空返回网关之后。

**0b. 分块粒度 FTS。** 当前关键词搜索位于 `pages.search_vector` 上。在分块级别添加 doc-comments 或两遍锚定对页面粒度的原始数据没有排名效果。层级 0b 添加 `content_chunks.search_vector`，其触发器从限定符号名 + doc-comment（权重 A）和 chunk_text（权重 B）构建，并重写 `searchKeyword` 以直接对分块进行排名。页面级 search_vector 保留用于标题重的搜索。

两个层级 0 项目都是 10x 飞跃的实际移动检索指标的先决条件。

### 层级 A — 结构边（10x 飞跃）

**A1. 带限定符号身份的调用图 + 引用提取。** 每个语言的 tree-sitter 查询在 `importCodeFile` 时捕获：

- `calls` — 函数调用站点
- `imports` — 模块依赖
- `extends` / `implements` — 类型层次结构
- `mixes_in` — Ruby `include`/`extend`/`prepend`
- `type_refs` — 参数 + 返回类型使用
- `declares` — 分块拥有符号定义

**所有 8 种语言的限定符号身份。** `parent_symbol_path`（A3）是作用域的真相来源；边使用从中构建的限定名。示例：`Admin::UsersController#render`（Ruby 实例）、`Admin::UsersController.find_all`（Ruby 单例）、`admin.users_controller.UsersController.render`（Python）、`(*UsersController).Render`（Go）、`users::UsersController::render`（Rust）、`com.acme.admin.UsersController.render`（Java）。每种语言的界定符 + 方法/类方法区分。Ruby 在排序器（CLI + A2 两遍）中完全发布 — 不推迟。

**拆分模式（两个表，不是一个多态）：**
```sql
CREATE TABLE code_edges_chunk (
  from_chunk_id INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  to_chunk_id   INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE (from_chunk_id, to_chunk_id, edge_type)
);
CREATE TABLE code_edges_symbol (
  from_chunk_id INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
);
```
`code_edges_chunk` = 已解析（两个端点已知）。`code_edges_symbol` = 未解析（目标符号通过限定名存在，定义分块尚未见）。升级时从 symbol→chunk 表提升。`source_id` 是匹配实际 `sources.id` 类型的 TEXT。

**发布语言：** TypeScript、TSX、JavaScript、Ruby、Python、Go、Rust、Java（8 种语言，约占真实 brain 代码的 85%）。其他语言正常分块（通过 B1 懒加载）但在 v0.20.0 中不发射边 — 扩展是每个语言一个查询文件 + 界定符配置，可作为小型跟进 PR 发布。

**A2. 两遍检索。** 当前：关键词 + 向量 → RRF → 去重。新：关键词 + 向量 → 锚定集 → 在 `code_edges_chunk` 上扩展 1–2 跳，带有结构距离衰减 → 混合到 RRF。

**所有情况下默认关闭。** 仅通过 `--walk-depth N` 或 `--near-symbol <name>` 选择加入。精确符号匹配自动开启是不安全的（符号名跨文件冲突）。每跳邻居上限 50，深度上限 2。去重的每页上限（当前为 2）在行走时提升到 `min(10, walkDepth × 5)`，以便来自一个文件的结构邻居不被剪裁。距离衰减：扩展邻居 RRF 贡献上的 `1/(1 + hop)`。

**A3. 父作用域捕获 + 嵌套分块发射。** 两部分：

*第1部分：* 嵌套符号在 `content_chunks` 上获得 `parent_symbol_path text[]`。嵌入到分块标头：`[TypeScript] src/foo.ts:42-58 function formatResult (in BrainEngine.searchKeyword)`。作用域流入嵌入。双重用途：驱动 A1 的限定符号身份。

*第2部分：* 扩展 `splitLargeNode` 以将其自己的分块发射为嵌套函数/方法/内部类。当前分块器是顶层节点导向的 — 一个 `class Foo { method1() {} method2() {} }` 发射一个分块。顶层节点上的 parent_symbol_path 为空（顶层之上没有父级），因此如果没有子顶层分块，A3 什么也不贡献。第2部分使作用域注释承载负担。

**A4. Doc-comment → 符号绑定。** 前导 AST 注释提取到 `doc_comment text`。位于 **分块粒度** search_vector（层级 0b 前置条件）上，FTS 权重为 `'A'`。自然语言查询将文档字符串匹配排在正文之上和标题之下。`'A' > 'B' > 'C' > 'D'` 按照 Postgres FTS 权重约定。

### 层级 B — 覆盖率，诚实的 Chonkie 奇偶校验

**B1.** 懒加载 tree-sitter-language-pack（~165 种语言）。用清单 + 每进程解析器缓存替换 36 个提交的 WASM。大教堂 I 承诺了这一点但没有交付 — 大教堂 II 做到了。

**B2.** 无扩展名文件的 Magika 自动检测（Dockerfile、Makefile、`.envrc`）。~1MB 打包资源。如果分类器无法加载，则回退到空 → 递归分块器。

### 层级 C — 代理 CLI 界面

- `query --lang <lang>` — 按 `content_chunks.language` 过滤
- `query --symbol-kind function|class|method|type|interface|enum` — 按 `symbol_type` 过滤
- `query --near-symbol <name> --depth 1..2` — 在已知符号处锚定的两遍检索
- `code-callers <symbol>` — 使用 A1 `calls` 边，反转
- `code-callees <symbol>` — 使用 A1 `calls` 边，前向

所有在 non-TTY 上自动 JSON。失败时 `StructuredAgentError` 信封。`code-signature` 推迟到 v0.20.1（需要每种语言的类型捕获）。

### 层级 D — 桥接项目（大教堂 I 承诺）

**D1.** `sync --all` 成本预览。从 `chunkers/code.ts` 提取 `estimateTokens` 到新的 `tokens.ts` 模块。在每来源循环之前：遍历同步差异集，求和 tokens，计算 $ 估算。TTY + !json + !yes → 交互式 `[y/N]`。Non-TTY 或 `--json` 或管道 → 发出 `ConfirmationRequired` 信封，退出 2。`--dry-run` 预览 + 退出 0。仅对 `--all` 预览，不对单个来源预览（DX 审查痛苦是首次大型同步意外账单）。

**D2.** `importFromContent` 中的 Markdown 围栏提取。在 `parseMarkdown` 之后，遍历标记的词法分析器令牌以获取 `{type:'code', lang, text}`。将围栏标签 → 语言映射。通过 `chunkCodeText` 对每个围栏进行分块。持久化为 `chunk_source='fenced_code'`。每个围栏 try/catch — 一个坏围栏不会破坏页面导入。

**D3.** `reconcile-links` 批处理命令。遍历 markdown 页面，对每个页面调用现有的 v0.19.0 `extractCodeRefs`，发射 `addLink(md, code, ..., 'documents')` + 反转。`ON CONFLICT DO NOTHING` 处理幂等性。通过 `sql.begin` + `SET LOCAL` 限定语句超时。进度报告器 + 最终摘要（添加的边 / 已存在的 / 缺失目标）。遵守 `auto_link` 配置。

### 层级 E — 评估、回填、诚实

**E1.** BrainBench 代码子类别：`call_graph_recall`（X 的调用者 → 预期集）、`parent_scope_coverage`（嵌套符号查询返回正确的作用域）、`doc_comment_matching`（NL 查询将文档注释排在散文之上）。针对 A1/A3/A4 漂移的回归网关。

**E2.** 回填：模式自动迁移（零成本）。**`CHUNKER_VERSION` 碰撞 3 → 4** — 该常量折叠到每个代码页面的 `content_hash` 中，因此每个代码页面的哈希在升级时都会更改。下次 `gbrain sync` 不会在"git HEAD 未更改"时短路；它重新分块每个代码文件。新的 `gbrain reindex-code [--source <id>] [--dry-run] [--yes] [--force]` 提供带有成本预览的显式完整回填（重用 D1 基础设施）和 `--force` 完全绕过 content_hash 跳过。用户控制何时付费；静默无操作路径已关闭。

**E3.** 诚实的 CHANGELOG。停用"Chonkie 超集"框架。运行前后 BrainBench 以获取真实数字：150+ 种语言已加载（B1 之后）、NL→代码查询的 MRR、P@1 调用图精度、symbol_name 查询的 P@k、5K 文件仓库的同步成本预览。用可运行命令支持每个声明。

## 实施顺序（14 个层级，codex 后）

1. **0a** — 文件分类扩展（sync.ts:35）+ Magika 重新排序为回退
2. **0b** — 分块粒度 FTS（content_chunks.search_vector + 触发器 + searchKeyword 分块级重写）
3. **基础** — 模式迁移（拆分边表、content_chunks 上的限定名列）+ 引擎方法存根 + 类型
4. **B1** — 懒加载语法清单 + bun --compile 守卫
5. **A1** — 边提取器 + 8 个每语言查询文件 + 限定符号身份 + 测试
6. **A3** — 父作用域列 + doc-comment 列 + splitLargeNode 嵌套分块发射
7. **A4** — 分块粒度 search_vector 上的 doc-comment FTS 权重 A
8. **A2** — 两遍检索，默认关闭，仅选择加入；行走时去重上限提升
9. **D 层级捆绑** — 成本预览 + 围栏提取 + 调和链接
10. **B2** — Magika 自动检测
11. **C 层级** — 5 个 CLI 界面
12. **E1** — BrainBench 子类别 + CHUNKER_VERSION 3→4 碰撞
13. **E2** — 带有 `--force` 的 `reindex-code` + 带有回填提示阶段的迁移编排器
14. **E3 + 发布** — 诚实的 CHANGELOG + 文档 + 迁移技能 + `/ship`

## 规模和成本

- Diff：~5500–6500 行（~2.5x v0.19.0 codex 扩展后）
- 测试：~2000 行（8 种语言 × 限定名 + 边提取夹具 + 层级 0b FTS 迁移测试）
- 文件：~36 个新文件，~25 个修改文件
- CC 时间：~20–25 小时专注（codex 前为 14–18；+6h 用于层级 0a/0b + 8 种语言的限定身份 + 嵌套分块发射 + CHUNKER_VERSION 碰撞层级）
- 人类等效：3–5 周
- 升级后的 v0.19.0 用户的首次同步成本冲击：升级后首次同步时每个代码页面重新分块（CHUNKER_VERSION 碰撞强制失效）。用户运行 `gbrain reindex-code --dry-run` 以获取成本预览，然后 `--yes` 或接受随时间 gradual 回填。
- 回填后的每日自动驾驶成本：不变（边在分块时提取，没有每查询 LLM）

## 风险和缓解措施

1. **实时 Postgres 上的模式迁移。** 在发布前针对生产形状 DB 进行测试。v0.12.0 JSONB 事件是可以的。
2. **每种语言的 tree-sitter 查询很繁琐。** 每种语言手工验证边集夹具。Ruby 因动态分派假阴性而获得额外覆盖率。
3. **两遍检索回归。** 散文默认关闭。在发布前，BrainBench Cat 1 必须显示无回归。
4. **回填形状（G1 已解决）。** 三个可组合层：模式自动迁移列为空（零成本）。懒加载触摸时捕获 80% 随时间（零成本）。带有成本预览的显式 `reindex-code` 供想要立即完整好处的用户使用。没有意外账单。
5. **Magika 捆绑（G2 已解决）。** +1MB 资源，`bun --compile` 守卫扩展。如果捆绑在实现后期出现错误，B2 是唯一可以回退到 v0.20.1 而不会阻塞大教堂的层级 — 它在层级 8 是自包含的。
6. **高扇出符号。** `console.log` 风格的符号有 100K 个调用者。邻居上限 50，深度上限 2。需要混沌测试夹具。

## 审查网关

- CEO 审查（大教堂 II）— 已清除 2026-04-24
- 外部声音（codex）— 在大教堂 II CEO 审查期间运行
- `/plan-devex-review` — 接下来（按用户请求，5 个新 CLI 界面 + reindex-code 在 eng 之前需要 DX 打磨审查）
- `/plan-eng-review` — 在实施开始前需要
- `/review` + `/codex review` — 在 `/ship` 之前需要

## 推迟到以后的大教堂

- **C6** `code-signature "(A, B) => C"` — 每种语言的类型捕获。v0.20.1。
- **超出 8 个发布语言的调用图** — PHP、Swift、Kotlin、Scala、C#、C++、Elixir 等。每种语言一个小型 PR。
- **LSP 集成** 用于实时精度。v0.22+ 大教堂。
- **代码游览生成器**（大教堂 I T1）。
- **私有代码编辑前嵌入** +  Redaction（大教堂 I T3）。
- **`gbrain doctor --chunker-debug`** AST 转储。
