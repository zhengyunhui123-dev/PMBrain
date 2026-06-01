---
status: ACTIVE
---
# CEO 计划：v0.38 Schema Packs — 自带形态

由 /plan-ceo-review 于 2026-05-19 生成
分支：garrytan/houston-v1 | 模式：EXPANSION
仓库：garrytan/gbrain

## 定义（全文使用的术语）

- **Primitive（原型）** — 一个命名的捆绑包，包含（默认链接动词、默认
  frontmatter 字段、专家路由标志、 enrichment rubric 槽位）。
  五个内置原型：`entity`、`media`、`temporal`、`annotation`、
  `concept`。Pack 类型通过名称扩展一个原型，继承
  其默认值，然后可选择覆盖特定字段。不是
  表形态，不是 SQL 意义上的 schema — 而是引擎在推理和搜索时
  查询的行为模板。
- **Alias closure（别名闭包）** — 对于读取路径，当 pack 声明类型
  `researcher` 别名基础类型 `person` 时，对 `researcher` 的查询
  会将 WHERE 子句扩展为 `type IN ('researcher','person', + 其他
  别名 person 的类型)`。闭包在 pack 加载时计算一次，
  缓存在 pack 对象上，并内联到搜索 SQL 中。别名是单向的
  （researcher → person；查询 `person` 不会显示 `researcher` 行，
  除非声明了反向关系）。
- **Pack 解析链（7 层）** — 扩展 model-config 的
  6 层模式。顺序：(1) 每次调用的 `schema_pack` 选项，(2)
  `GBRAIN_SCHEMA_PACK` 环境变量，(3) 通过数据库配置键
  `schema_pack:source:<id>` 的每源 `--source <id>` 覆盖，
  (4) brain 级别的数据库配置键 `schema_pack`，(5) `gbrain.yml` 的
  `schema:` 部分，(6) `~/.gbrain/config.json` 的 `schema_pack`，
  (7) 默认的 `gbrain-base`。
  第 3 层是 v0.38 引入的新层；第 1、2、4-7 层
  镜像现有模式。

## 愿景

### 10x 检查
已接受的计划发布的是一个自扩展（self-EXPANDING）引擎，而不仅仅是一个
自描述引擎。与基线计划的区别：

- Brain 监视你创建的内容，并提议你没想到要请求的 schema 改进
  （`schema suggest`）
- Schema 是每源隔离的（ISOLATED reads），因此 ~/git/brain 和
  ~/git/zion-brain 在同一个引擎中持有不同的心智模型，
  无需重命名。跨源联邦读取仍然隔离地查看每源的
  packs — 跨挂载点连接结果的查询
  不会计算两个 pack 之间的闭包。联邦（跨挂载点的闭包）
  明确推迟到 v0.39。
- Pack 是可检查的：ASCII 图形、 plain-English 解释、
  针对实际内容的一致性 lint
- 第一次未知类型写入会询问"添加到 pack 吗？"并提供原型
  推理，而不是静默记录
- Schema packs 通过 v0.37 skillpack 管道以 `.gbrain-schema` tarball 形式分发；
  skillpacks 重命名为 `.gbrain-skillpack` 以保持对称性。社区 schema packs
  以与社区 skillpacks 相同的方式传播。

### 理想状态
新用户克隆 gbrain 并输入 `gbrain init`。在 30 秒内，
gbrain 已读取他们磁盘上任何位置的现有 markdown，提议一个
  匹配他们自然形态的 schema，询问 3-5 个是/否问题以
  完善，然后 brain 就上线了。他们永远不需要编写 YAML，除非
  他们想要。他们可以将他们的 pack 发布为 `.gbrain-schema` tarball，
  供任何人安装和 fork。

12 个月后的状态：`gbrain init` 自动运行 `schema detect`，
  提议一个原型结构，90% 的用户永远不会看到
  manifest 格式。想要自定义的 10% 用户会看到一个干净的 YAML，他们
  可以编辑。社区 packs 覆盖长尾领域。

## 范围决策

| # | 提案 | 工作量 | 决策 | 理由 |
|---|----------|--------|----------|-----------|
| 0C-bis | 方案 C（完整大教堂） | ~4 周 | 已接受 | 用户明确选择了三种方案中最雄心勃勃的一个；生态系统 + 引擎一次性发布 |
| D2 | 每源 schema packs | ~1 周 | 已接受 | 用户今天拥有两个 brains；v0.34.1.0 的源隔离使得接缝在架构上干净 |
| D3 | `gbrain schema suggest`（LLM 驱动） | ~3-5 天 | 已接受 | 缩小"存在什么"和"你的 brain 暗示什么"之间的差距；通过采样限制成本 |
| D4 | `schema graph` + `lint` + `explain` | ~2 天 | 已接受 | Schema 变得清晰和可自我文档化；微小努力，巨大 UX 提升 |
| D5 | 首次未知类型的自动提示 | ~1-2 天 | 已接受 | TTY 门控 + 每类型可静音；将 lenient-mode 从回退转变为功能 |
| D6-orig | `fork-from <brain-path>`（实时 brain） | ~3-5 天 | 已拒绝 | 隐私风险（对整个仓库的读取访问）；与已发布的 tarball 相比价值不明确 |
| D6-reframed | Skillpack tarball 重用 + 扩展名扩展 | ~3-5 天 | 已接受 | Schema packs 以 `.gbrain-schema` 形式发布；skillpacks 在现有 `.tgz` 旁边获得 `.gbrain-skillpack` 扩展名；两者都通过 manifest 鉴别器参数化的 v0.37 管道。扩展名是安装时的类型检测器 — 允许在提取之前将验证路由到正确的 manifest 验证器。 |

总预算：**修订为 9-11 周**（vs ~6.5-7 初始估计；
spec 审查发现了 `schema suggest` 的 LLM prompt 调优循环、
自动提示的原型推理启发式、7 层 × 联邦读取
交互边缘、完整重命名迁移表面，以及 v0.36/v0.37 范围的
  先例中的 400-600 个测试用例）。如果出现预算压力，
  最安全的削减顺序为：D5 自动提示（~2 天）、
  D4 检查三元组（~2 天）、将示例从 7→3 减少（~3 天）、
  将 suggest LLM 优化推迟到 v0.38.1（~1 周）。

## 已接受的范围（添加到此计划）

- **引擎层：** gbrain-base 通用入门 pack；5 个可组合
  原型（entity、media、temporal、annotation、concept）；读取路径的别名
  闭包；写入路径的默认宽松模式 + 审计；
  严格模式选择加入。
- **检测层：** `gbrain schema detect` SQL 驱动的启发式
  聚类，提议一个匹配 brain 形态的 pack manifest。
- **建议层：** `gbrain schema suggest` 通过 gateway.chat() 在限定样本上
  进行 LLM 驱动的优化。
- **检查层：** `gbrain schema graph`（ASCII 可视化）、
  `gbrain schema lint`（一致性检查）、`gbrain schema explain
  <type>`（plain English）。
- **创作层：** `gbrain schema init/use/fork/edit/validate/
  diff/review-candidates` CLI。
- **源层：** 每源 schema-pack 解析；pack
  解析获得第 7 层（在每 brain 之前进行每源覆盖）；
  每个相关命令上的 `--source <id>` 标志。
- **自动提示层：** 在首次未知类型时对 `put_page` 进行
  TTY 门控中断，并提供原型推理；每类型"始终静音"
  的逃生舱口。
- **分发层：** `.gbrain-schema` tarball 格式；将
  skillpacks 重命名为 `.gbrain-skillpack`；v0.37 skillpack 管道
  在制品类型上参数化（manifest 鉴别器驱动
  特定类型的验证）；为了向后兼容，安装时接受
  两种扩展名。
- **示例：** 树内的 7 个示例 packs（minimal、person-first、
  media-archive、temporal-archive、research-notebook、founder-ops、
  personal-archive），明确框定为草图而非产品。
- **gbrain-base：** 字节级完全重现今天的硬编码
  行为，因此现有 brains 在升级后看不到任何变化。
- **迁移：** v76 删除 `takes.kind` CHECK 约束；
  验证移动到针对活动 pack 的声明类型的运行时。
- **Doctor 检查：** schema_pack_active、schema_pack_consistency、
  每源 pack 漂移。
- **引擎重构覆盖：** v0.38 计划参数化原始探索中列出的
  每个硬编码类型耦合点，
  而不仅仅是 `takes.kind`。具体来说：`inferType` 路径前缀表、
  `inferLinkType` 正则表达式库、`FRONTMATTER_FIELD_OVERRIDES` 表、
  `find_experts` SQL（`type IN (…)`）、`whoknows` 的 `DEFAULT_TYPES`、
  `enrichment-service` 对 person/company 的限制、
  `completeness.ts` rubric 映射、dream-cycle 实体类型提示。
  gbrain-base 为每个重现今天的值。
- **缓存 + 回滚机制：**
  - `query_cache.knobs_hash`（v0.32.3 列）将 `schema_pack`
    名称和版本折叠到哈希中，因此在 `vc` 下写入的缓存行
    在 `research-state` 处于活动状态时无法访问。跨 pack
    污染在结构上不可能。
  - `eval_candidates` 行（v0.25.0）获得一个 `schema_pack` 列，
    因此 `gbrain eval replay` 重现相同的检索空间。
    迁移 v77 添加该列，允许 NULL；v0.38 之前的行
    在重放期间回退到活动 pack。
  - HNSW 索引是与 pack 无关的（向量列不会在
    packs 之间改变形态）；pack 切换时不需要重新索引。
  - 回滚：每个 `gbrain schema use` 操作将
    先前的 pack 名称写入 `~/.gbrain/schema-pack-history.jsonl`，
    因此 `gbrain schema use --previous` 只需一个按键。严格
    模式切换失败会显示有问题的页面，并附上
    粘贴就绪的"将类型重命名为 X"提示，然后才运行任何数据
    突变。自动 pilot 清除的软删除
    不会由 pack 更改触发。
- **测试预算：** 根据 v0.36/v0.37 的先例，跨单元测试 + e2e 约 400-600 个用例。具体来说：引擎层
  + 别名闭包约 150 个用例，检测启发式准确性约 50 个，
  suggest LLM prompts 约 50 个（通过 stubbed gateway 密封），
  每源解析 × 7 层矩阵约 30 个，自动提示 UX
  状态约 40 个，检查三元组输出稳定性约 30 个，tarball
  类型检测 + 参数化安装约 30 个，迁移 v76 +
  v77 + bootstrap  parity 约 50 个，示例 × 字节级
  gbrain-base 等价回归约 50 个。**gbrain-base 字节级
  等价是一个 CI 门控**，而不是希望 — 由
  `test/regressions/gbrain-base-equivalence.test.ts` 断言
  在 fixture brain 上从 pack 驱动的路径
  重现 v0.38 之前的硬编码行为。

## 推迟到 TODOS.md（v0.39+）

- 实时 brain `fork-from <brain-path>`（因隐私被拒绝；如果设计了沙盒化仅 schema 提取路径，请重新考虑）
- 跨挂载点的每源 pack 联邦（跨多个源的查询可以对每个源的 schema 使用闭包；现在每源仅是隔离读取）
- Schema 版本控制 + pack 版本之间的 semver 兼容性检查
- Skillpack ↔ schema-pack 交叉引用（skillpack 可以声明
  "当你的 pack 中存在这些原型时，我工作得最好"）
- 实时 schema 迁移助手（当你添加类型时，自动建议
  回填现有页面）
- PR 审查中的 Schema diff（将 pack 更改呈现为社区 pack PR 的人类可读
  diffs）

## 审查者关注点（来自 spec 审查循环，已部分解决）

- 第一次通过的质量得分：6.5/10。此修订中解决的问题：定义块（原型、别名闭包、7 层
  解析链）、每源隔离 vs 联邦矛盾
  已澄清、skillpack 扩展名框架从重命名更改为
  扩展、完整的硬编码站点覆盖已枚举、缓存 +
  回滚机制已添加、测试预算已枚举、预算已修订为
  9-11 周。
- 未完全解决的问题，提交给 11 节审查：
  - `schema suggest` LLM prompt 调优迭代预算仍然是一个
    范围估计，而不是测量数字。11 节审查
    应该在代码落地之前确定一个特定的评估 fixture 集（大小 + 多样性）
    和目标准确性阈值。
  - 7 层解析 × v0.34.1 federated_read OAuth 范围在
    交叉点有边缘情况，11 节审查必须
    枚举（具体来说：一个在联邦源上具有读取范围但没有
    源特定 pack 覆盖的 OAuth 客户端 — 哪个
    pack 驱动跨源查询的别名闭包？）。
  - 7→3 示例 pack 减少是一个真正的削减考虑。11 节
    审查应该决定 7 个示例是否是正确的
    数量，或者 3 + 社区衍生的是否更诚实。

## 值得在 11 节审查中提出的 Cathedral 风险

1. 7 周预算 vs 4 周的原始要求。如果出现压力，
   D5（自动提示）和 D4（检查三元组）是最安全的削减。
2. v0.37 skillpack 注册表目前有零个已发布的 packs。
   `.gbrain-schema` 重命名和 tarball 重用在没有任何
   使用信号的分发层上加倍下注。
3. 每源 pack 解析将第 7 层添加到解析
   链。model-config 6 层模式已经在认知上
   很密集；第 7 层是一个拐点。
4. `schema suggest` 每次调用都会引入持续的 LLM 成本。
   通过采样限制，但为"gbrain 命令
   要花钱"设置了先例。
5. 自动提示 UX 是新颖的。TTY 门控 + 每类型静音有帮助，
   但批量导入流程可能会遇到意外的中断模式。
