# GBrain 知识运行时 — 设计文档

**状态：** 草稿，待 CEO 审查。
**日期：** 2026-04-18。
**替代：** 早期的"Feynman Ideas Assessment + Phase A/B"计划。

---

## 0. 上下文

在对一个狭窄的两功能计划（裸推文引用修复 + 完整性分数，从 Feynman 借用）进行 CEO 审查期间，范围被重新构建。这个狭窄的计划复制了 Garry 的 OpenClaw 已经在做的工作，并且错过了真正的杠杆点：**隐藏在 OpenClaw 中的定制抽象 — 解析器、丰富编排、调度、确定性输出 — 应该作为一流原语在 GBrain 中。**

北极星：*"当 Garry 的 OpenClaw 的 Claw 升级到这个版本的 GBrain 时，它应该立即认识到 brilliance 和完整性，并说'是时候切换到这些抽象了。'"*

这就是本文档设计对抗的测试。其他一切都是下游。

---

## 1. 四层

该设计是四个分层抽象。每个都是独立有用的；它们一起构成了知识运行时。

```
  ┌───────────────────────────────────────────────────────────────────┐
  │                   KNOWLEDGE RUNTIME (新)                         │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 4: 确定性输出构建器                            │
  │     BrainWriter · 脚手架 · 反向链接执行器 · Slug 注册表  │
  │     规则：LLM 选择 WHAT。代码保证 WHERE 和 HOW。 │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 3: 调度器                                               │
  │     ScheduledResolver · TZ 感知的安静时间（强制执行） ·         │
  │     自动交错 · 持久状态 · 重试/断路器            │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 2: 丰富编排器                                 │
  │     触发器收敛 · 层级路由 · 预算 · 级联 ·       │
  │     证据加权完整性 · 故障安全事务       │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 1: 解析器 SDK                                            │
  │     Resolver<I,O> 接口 · 注册表 · 工厂 · 插件配方 │
  │     移植的参考实现：X-API、Perplexity、Mistral、brain     │
  └───────────────────────────────────────────────────────────────────┘
          │                                                │
          ▼                                                ▼
     重用（GBrain 中已打磨的原语）  替换（临时代码）
     FailImproveLoop · 退避 · 存储工厂 ·   enrichment-service ·
     check-resolvable · 操作验证器 ·      embedding · transcription ·
     engine 接口 · publish · 反向链接          2 个配方格式
```

---

## 2. 为什么是这个顺序（L1 → L4）

每个更高层都依赖于更低层。**L1 必须首先落地，否则其余部分会泄漏抽象。**

- **L1（解析器）** 是基底。没有统一的查找接口，每个编排器 + 写入器都有定制调用者。
- **L2（编排器）** 使用 L1 进行获取；没有 L1，它仍然是临时的。
- **L3（调度器）** 定期运行 L2；没有 L2，它就没有结构化地调度任何东西。
- **L4（输出构建器）** 是每个层最终通过写入的；没有它，我们有 14 个调用站点使用 `fs.writeFile` 和手工制作的引用规范。

更早的实现可以先发布 L1 + L4（两个"最纯粹"的层），并具有最直接的一致性影响，然后添加 L2 + L3。但最终状态必须包括所有四个。

---

## 3. 层 1 — 解析器 SDK

### 3.1 今天有什么问题

Garry 的 OpenClaw 在 X API（14 种形状）、Perplexity、Mistral OCR、Gmail、Calendar、Slack、GitHub、YouTube、Diarize.io、YC 工具、OSINT 收集器和 brain 本地查找中有 **69 种不同的外部查找模式**。每个都是 `scripts/` 下的一个定制脚本，具有自己的错误处理、重试逻辑和输出形状。GBrain 有 3 个临时包装器（`embedding.ts`、`transcription.ts`、`enrichment-service.ts`），它们不共享接口。

常见后果：
- 没有统一的重试/退避策略（一些脚本重试，大多数不重试）
- 没有成本跟踪（Perplexity 账单在调用返回无实质结果时被静默吃掉）
- 没有置信度/来源传播（调用者无法判断答案是已验证的还是推断的）
- 用户无法在不 fork GBrain 的情况下添加解析器

### 3.2 接口

```typescript
// src/core/resolvers/interface.ts

export type ResolverCost = 'free' | 'rate-limited' | 'paid';

export interface ResolverRequest<I> {
  input: I;
  context: ResolverContext;
  timeoutMs?: number;
}

export interface ResolverResult<O> {
  value: O;
  confidence: number;      // 0.0–1.0；1.0 = 来自真实来源 API 的确定性
  source: string;          // 例如 "x-api-v2"、"perplexity-sonar"、"brain-local"
  fetchedAt: Date;
  costEstimate?: number;   // 美元；如果免费则为 0
  raw?: unknown;           // 用于通过 put_raw_data 进行边车持久化
}

export interface Resolver<I, O> {
  readonly id: string;           // 稳定的，类似 slug 的："x_handle_to_tweet"
  readonly cost: ResolverCost;
  readonly backend: string;      // "x-api-v2"、"perplexity"、"brain-local"
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;

  available(ctx: ResolverContext): Promise<boolean>;
  resolve(req: ResolverRequest<I>): Promise<ResolverResult<O>>;
}
```

### 3.3 上下文

```typescript
export interface ResolverContext {
  engine: BrainEngine;
  storage: StorageBackend;
  config: GBrainConfig;
  logger: Logger;
  metrics: MetricsRecorder;
  budget: BudgetLedger;       // 硬开销上限，在解析前查询
  requestId: string;
  remote: boolean;            // 信任边界 — 不受信任的调用者获得更严格的验证
  deadline?: Date;
}
```

### 3.4 注册表 + 工厂（镜像 `src/core/storage.ts`）

```typescript
// src/core/resolvers/registry.ts
export class ResolverRegistry {
  register<I, O>(r: Resolver<I, O>): void;
  get(id: string): Resolver<unknown, unknown>;
  list(filter?: { cost?: ResolverCost; backend?: string }): Resolver[];
  async resolve<I, O>(id: string, input: I, ctx: ResolverContext): Promise<ResolverResult<O>>;
}

// src/core/resolvers/factory.ts（动态导入，类似 engine-factory）
export async function createResolver(
  type: 'x-api' | 'perplexity' | 'mistral-ocr' | 'brain-local' | 'plugin',
  config: ResolverConfig,
): Promise<Resolver>;
```

### 3.5 插件格式（统一 `recipes/` + `data-research` 格式）

插件是 YAML + JS 模块，通过 `~/.gbrain/resolvers/` 和 `recipes/` 的文件系统扫描发现。

```yaml
# 示例：resolvers/x-api/handle-to-tweet.yaml
id: x_handle_to_tweet
version: 1
category: lookup
cost: rate-limited
backend: x-api-v2
module: ./handle-to-tweet.ts
input_schema:
  type: object
  properties:
    handle:   { type: string, pattern: "^[A-Za-z0-9_]{1,15}$" }
    keywords: { type: string }
  required: [handle]
output_schema:
  type: object
  properties:
    url:        { type: string, format: uri }
    tweet_id:   { type: string }
    text:       { type: string }
    created_at: { type: string, format: date-time }
requires:
  env: [X_API_BEARER_TOKEN]
health_check:
  kind: http
  url: https://api.twitter.com/2/tweets/1
  expect: { status: [200, 401] }   # 401 = 认证失败但端点可达
tests:
  - input:  { handle: "garrytan" }
    expect: { url: { pattern: "^https://x\\.com/garrytan/status/\\d+$" } }
```

信任标记遵循现有的 `src/commands/integrations.ts` 模式：只有包捆绑的解析器是 `embedded=true` 并且可以运行任意命令；用户提供的解析器被限制为 `http` 并经过验证的模式。

### 3.6 用 `FailImproveLoop` 包装每个解析器

现有的 `src/core/fail-improve.ts` 是确定性优先/LLM-回退模式。每个解析器自动获得包装：如果确定性路径（例如 X API）返回有效结果，则使用它；如果失败，可选择回退到基于 LLM 的解析器；记录两个路径以供未来的模式分析和自动测试生成。

### 3.7 要发布的参考实现

OpenClaw 调查盘点了 69 个解析器形状。发布所有这些是错误的（范围过大）；发布零个是范围不足。狗粮集：

| # | 解析器 | 用途 | 被使用 |
|---|---|---|---|
| 1 | `x_handle_to_tweet` | 裸推文引用修复（原始阶段 A） | `gbrain integrity` |
| 2 | `url_reachable` | 死链接检测 | `gbrain integrity` |
| 3 | `brain_slug_lookup` | 名称/电子邮件 → slug（包装现有的 `resolveSlugs`） | 输出构建器 |
| 4 | `openai_embedding` | 将 `src/core/embedding.ts` 重构为解析器 | 导入管道 |
| 5 | `perplexity_query` | 查询 → 综合 + 引用 | 丰富编排器 |
| 6 | `text_to_entities` | LLM 实体提取（结构化 JSON） | 丰富编排器 |

其余 63 个 OpenClaw 模式根据用户输入增量移植。每个移植都是 `recipes/` 或 `~/.gbrain/resolvers/` 下的一个新 YAML + 模块，没有框架更改。

---

## 4. 层 2 — 丰富编排器

### 4.1 今天有什么问题

Garry 的 OpenClaw 的丰富 **在数据层是打磨过的，在控制层是 hacky 的**：

- **完整性 = "长度 > 500 个字符 + 无 `needs-enrichment` 标签"**（`lib/enrich.mjs:351-355`）。天真。富含 Perplexity 摘要的丰富页面（参见 `brain/people/0interestrates.md` — 38 个重复块）通过了此检查。
- **30 天自动重新丰富** 永远运行。没有"完成"状态。一个在 2023 年见过一次的人仍然每月被重新研究。
- **级联仅是约定。** Person→company 存根会自动创建；company→investors、company→employees 遍历已被记录但从未实施。
- **没有硬预算上限。** 成本是按批次估算的，从未跨批次或按天强制执行。
- **失败是静默的。** 错误的 Perplexity 响应会记录并继续；部分写入可能会使页面带有时间线条目但没有原始数据边车。

### 4.2 编排器

```typescript
// src/core/enrichment/orchestrator.ts

export interface EnrichmentRequest {
  entitySlug: string;
  trigger: 'mention' | 'stub-creation' | 'cron-sweep' | 'manual' | 'cascade';
  tier?: 1 | 2 | 3;                // 可选覆盖；如果不存在则自动计算
  cascadeDepth?: number;           // 0 = 无级联；默认 1
}

export interface EnrichmentResult {
  entitySlug: string;
  completenessBefore: number;
  completenessAfter: number;
  resolversUsed: string[];         // 例如 ["perplexity_query", "x_handle_to_tweet"]
  costSpent: number;
  writtenTo: string[];             // 接触的页面路径，用于事务审计
  cascadedTo: string[];            // 已丰富的相关实体
  status: 'enriched' | 'skipped' | 'failed' | 'budget-exhausted';
  reason?: string;
}

export class EnrichmentOrchestrator {
  constructor(
    private registry: ResolverRegistry,
    private writer: BrainWriter,
    private budget: BudgetLedger,
    private scorer: CompletenessScorer,
    private graph: EntityGraph,
  ) {}

  async enrich(req: EnrichmentRequest): Promise<EnrichmentResult>;
  async enrichBatch(reqs: EnrichmentRequest[]): Promise<EnrichmentResult[]>;
}
```

### 4.3 证据加权完整性（替换长度启发式）

完整性是每个实体类型的评分标准，在写入时持久化在前置元信息中，并根据需要重新计算。

```typescript
// src/core/enrichment/completeness.ts
export interface CompletenessRubric<Page> {
  entityType: PageType;
  dimensions: {
    name: string;
    weight: number;                // 总和必须为 =1.0
    check: (page: Page) => number; // 0.0–1.0
  }[];
}
```

**示例人员评分标准：**
```
  - has_role_and_company   0.20
  - has_source_urls        0.20  (≥1 个 URL，解析器验证可达性)
  - has_timeline_entries   0.15  (≥1)
  - has_citations          0.15  (每个声明都有 [Source: ...])
  - has_backlinks          0.10  (每个链接的页面都反向链接)
  - recency_score          0.10  (上次验证在 90 天内)
  - non_redundancy         0.10  (无重复块；distinct-lines/total-lines > 0.8)
```

**关键属性：** `non_redundancy` + `recency_score` 显式杀死在审计中观察到的两个 brain 病理（`garrytan/0interestrates.md` 中 Wilco 风格的重复块；没有 `last_verified` 的陈旧页面）。

`completeness` 字段以前置元信息中的 `0.0–1.0` 形式存在。它变得可通过 `list_pages(where: completeness < 0.5)` 进行查询。

### 4.4 带硬预算的层级路由

二维路由：**重要性**（person-score 的层级 1/2/3）× **预算状态**。

```typescript
// src/core/enrichment/tiers.ts
export const TIER_CONFIG = {
  1: { models: ['opus', 'sonar-deep'], maxCostUsd: 0.10, cascadeDepth: 2 },
  2: { models: ['sonar'],              maxCostUsd: 0.02, cascadeDepth: 1 },
  3: { models: ['sonar'],              maxCostUsd: 0.005, cascadeDepth: 0 },
};

// src/core/enrichment/budget.ts
export class BudgetLedger {
  // 硬上限。在解析前可查询。
  dailyCapUsd: number;
  perEntityCapUsd: number;
  perResolverCapUsd: Map<string, number>;

  async reserve(resolverId: string, estimateUsd: number): Promise<Reservation | 'exhausted'>;
  async commit(reservation: Reservation, actualUsd: number): Promise<void>;
  async rollback(reservation: Reservation): Promise<void>;
  async state(): Promise<{ spent: number; remaining: number; perResolver: Record<string, number> }>;
}
```

**属性：** 如果达到每日上限，`orchestrator.enrich()` 立即返回 `status: 'budget-exhausted'`。没有静默超限。断路器在用户配置的 TZ 的午夜重置。

### 4.5 级联（实体图遍历）

```typescript
// src/core/enrichment/cascade.ts
export class EntityGraph {
  // 确定性的，没有 LLM。使用 engine.getLinks() + engine.getBacklinks()。
  async neighbors(slug: string, depth: number): Promise<string[]>;
  async cascadeFrom(trigger: string, depth: number): Promise<EnrichmentRequest[]>;
}
```

如果丰富了 person X 并获得了新的 `company: Acme` 字段，级联检查：`companies/acme` 是否存在？如果不存在，创建存根 + 在层级 2 排队。 `companies/acme` 是否反向链接到 X？如果没有，写入反向链接。**铁律是机器强制的，而不是技能强制的。**

### 4.6 故障安全事务

每个丰富都包装在 BrainWriter 事务（层 4）中。部分写入被回滚。没有像时间线条目而没有原始边车这样的非对称状态。

```typescript
await writer.transaction(async (tx) => {
  const research = await registry.resolve('perplexity_query', {...}, ctx);
  await tx.appendTimeline(slug, {...});
  await tx.putRawData(slug, 'perplexity', research.raw);
  await tx.setFrontmatterField(slug, 'completeness', score);
  // 退出时全有或全无提交。
});
```

---

## 5. 层 3 — 调度器

### 5.1 今天有什么问题

Garry 的 OpenClaw 的 cron 是 **外部驱动的 JSON**（`cron/jobs.json`），约有 ~30 个作业手动交错偏移在不同的分钟。GBrain **零原生调度** — `src/commands/autopilot.ts` 是单个守护进程循环，并且 `docs/guides/cron-schedule.md` 是架构指南，而不是代码。

在 Garry 的 OpenClaw 的实际状态中观察到的失败：
- `X OAuth2 Token Refresh`：11 次连续超时（关键路径静默失败）
- `flight-tracker daily scan`：5 次连续超时
- `morning-briefing`：4 次连续超时
- 安静时间在技能中在运行时检查，因此忘记检查的技能会在凌晨 3 点 DM。
- 交错是手动约定；在配置编辑后，没有防止两个作业冲突的保护。

### 5.2 ScheduledResolver 接口

```typescript
// src/core/scheduling/scheduler.ts
export interface Schedule {
  kind: 'cron' | 'interval';
  expr?: string;                    // cron 字符串
  intervalMs?: number;
  tz: string;                       // IANA："America/Los_Angeles"
  quietHours?: {
    startHour: number;              // 22 = 晚上 10 点本地时间
    endHour: number;                // 7 = 上午 7 点本地时间
    policy: 'skip' | 'defer' | 'silent-run';
  };
  staggerKey?: string;              // 具有相同键的作业自动偏移
  maxConcurrent?: number;           // 全局并发上限
  maxDurationMs?: number;           // 超时
}

export interface ScheduledResolver extends Resolver<void, ScheduledResult> {
  schedule: Schedule;
  retryPolicy: { maxRetries: number; backoffMs: number };
  circuitBreaker: { failureThreshold: number; cooldownMs: number };
  state: DurableState;              // 水印、内容哈希、幂等键
}
```

### 5.3 强制执行与约定（与 Garry 的 OpenClaw 的关键差异）

| 关注点 | Garry 的 OpenClaw 今天 | 知识运行时 |
|---|---|---|
| 安静时间 | 在每个技能内检查（基于信任） | 在调度器强制执行，技能无法覆盖 |
| 交错 | `jobs.json` 中的手动分钟偏移 | 调度器通过哈希 staggerKey 分配槽位 |
| 并发 | `MAX_BATCH_PROCESSES=2` 在退避中，被 cron 忽略 | 调度器中的全局信号量 |
| 超时 | JSON 中的每作业字符串，并不总是被遵守 | 通过 `AbortController` 强制执行，超时引发 `TimeoutError` 被编排器捕获 |
| 重试 | cron 级别无 | 带有指数退避的 `retryPolicy` |
| 静默失败 | "11 次连续超时"未被注意到 | 断路器在阈值处打开 → 升级到用户 |
| 幂等性 | 每作业状态文件，没有框架 | `DurableState` 原语：水印/ID/内容哈希 |

### 5.4 原生引擎 + OS cron 适配器

调度器作为以下两者之一运行：
1. **嵌入式**（用于 `gbrain autopilot` 的默认）：守护进程内的原生事件循环。一个进程，许多 ScheduledResolver。
2. **OS 驱动**（用于 Railway/launchd/systemd）：`gbrain schedule run <id>` 由 OS cron 调用，调度器状态是持久的，因此跨调用去重仍然有效。

两种模式共享相同的 `Schedule` 配置 + 状态。

### 5.5 可观测性

每个计划的运行都发出结构化事件：`started`、`skipped-quiet-hours`、`deferred-to-active-hours`、`failed-retrying`、`circuit-opened`、`completed`。事件转到：

- `~/.gbrain/scheduler/events.jsonl`（本地，始终）
- `engine.logIngest`（brain DB 中的审计跟踪）
- 可选 webhook（用于用户的 Slack/Telegram）

`gbrain doctor` 读取事件日志并报告：当前断路器状态、任何具有 > 3 次连续失败的解析器、任何在其间隔的 3 倍内未触发的解析器（新鲜度 SLA，如 Garry 的 OpenClaw 的 `freshness-check.mjs`，但是内置的）。

---

## 6. 层 4 — 确定性输出构建器

### 6.1 反幻觉不变式

**铁律：LLM 选择 WHAT。代码保证 WHERE 和 HOW。**

Garry 的 OpenClaw 的现有 `lib/enrich.mjs:buildTweetEntry` 与此接近 — 推文 URL 是从 X API 返回的 `tweet.id` 构建的，从不是从 LLM 记忆构建的。但是：

- 过去的事件：*"子代理测试 #2 失败 — 在所有日常文件中幻觉了 'Philip Leung' 实体链接。LLM 重写日常文件太容易出错。"*（Garry 的 OpenClaw 记忆日志，2026-04-13。）
- 反向链接依赖于到处调用 `appendTimeline`（跳过是静默的）。
- Slug 冲突未检查（没有对 `slugify` 的冲突检测）。
- 引用格式是事后 lint 的，而不是写前强制执行的。

### 6.2 BrainWriter

```typescript
// src/core/output/writer.ts
export class BrainWriter {
  constructor(
    private engine: BrainEngine,
    private slugRegistry: SlugRegistry,
    private scaffolder: Scaffolder,
  ) {}

  async transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T>;
}

export interface WriteTx {
  // 高级类型化操作；从不是原始字符串写入。
  createEntity(input: EntityInput): Promise<string>;          // 返回 slug，经过冲突检查
  appendTimeline(slug: string, entry: TimelineInput): Promise<void>;
  setCompiledTruth(slug: string, body: CompiledTruthInput): Promise<void>;
  setFrontmatterField(slug: string, key: string, value: unknown): Promise<void>;
  putRawData(slug: string, source: string, data: object): Promise<void>;
  addLink(from: string, to: string, context: string): Promise<void>;  // 自动创建反向反向链接

  // 验证器（在提交时隐式调用）
  validate(): Promise<ValidationReport>;
}
```

### 6.3 脚手架 — 确定性链接 + 引用构建

每个用户可见的 URL/链接/引用都由代码从解析器输出构建，而不是从 LLM 文本构建。

```typescript
// src/core/output/scaffold.ts
export class Scaffolder {
  tweetCitation(handle: string, tweetId: string, dateISO: string): string {
    // "[Source: [X/garrytan, 2026-04-18](https://x.com/garrytan/status/123456)]"
  }
  emailCitation(account: string, messageId: string, subject: string): string {
    // 根据 OpenClaw 模式确定性的 Gmail URL
  }
  sourceCitation(resolverResult: ResolverResult<unknown>): string {
    // 从结果中提取 .source、.fetchedAt、.raw
  }
  entityLink(slug: string): string {
    // slugRegistry 检查存在；返回可解析的 wikilink
  }
}
```

### 6.4 SlugRegistry — 冲突检测

```typescript
// src/core/output/slug-registry.ts
export class SlugRegistry {
  async create(desiredSlug: string, displayName: string, type: PageType): Promise<CreatedSlug>;
  // 如果另一个实体已经占据 desiredSlug 并且未被
  // 确认为同一个人（通过电子邮件 / x_handle / 消歧器），则引发 SlugCollision。
  // 通过附加消歧器自动解析近乎冲突。

  async confirmSame(slugA: string, slugB: string, confidence: number): Promise<void>;
  async merge(canonical: string, duplicate: string): Promise<void>;
}
```

### 6.5 写前验证器（为完整性而故障关闭）

在提交前的 `WriteTx.validate()` 上：

1. **引用验证器。** `compiled_truth` 中的每个事实句子必须在 N 行内有内联 `[Source: ...]`。不合规的段落被标记。可配置：严格模式拒绝事务，lint 模式警告。
2. **链接验证器。** 每个 `[text](path)` 必须指向存在的页面或 Scaffolder 构建的 URL（因此它是保证有效的）。没有原始 LLM 组合的 URL。
3. **反向链接验证器。** 每个出站链接必须在同一事务中写入反向链接。
4. **Triple-HR 验证器。** 编译的真相 / 时间线拆分在模式级别强制执行。

**故障关闭**：默认是严格模式。松动需要显式的 `writer.transaction({ strictMode: false }, ...)` 并向摄取日志写入警告。

### 6.6 LLM 输出清理

任何注定要进入 brain 页面的 LLM 输出首先通过 JSON-Schema 验证的解析器。没有自由格式的 markdown 进入磁盘。

- 实体提取：JSON 数组 `{ name, type, context }` 按照现有的 `extractEntities` 模式 — 严格验证。
- 编译真相综合：LLM 发出结构化的 `{ sections: [{heading, paragraphs: [{text, sources: [...]}]}]}`，脚手架渲染为 markdown。
- 时间线条目：LLM 发出 `{ date, summary, detail, sources }`，脚手架渲染。

LLM 从来看见文件路径，从不在文件上写入，从不明细完成 markdown。

---

## 7. 与现有 GBrain 的集成

### 7.1 重用（已打磨）

| 现有 | 被使用 | 更改 |
|---|---|---|
| `src/core/fail-improve.ts` (9/10) | 包装 L1 中的每个解析器 | 无；成为默认包装器 |
| `src/core/backoff.ts` (9/10) | ResolverContext.backoff | 无 |
| `src/core/storage.ts` (9/10) | 解析器工厂模式的模板 | 无；用作模式参考 |
| `src/core/check-resolvable.ts` (9/10) | 扩展到验证解析器插件 | 添加 `checkResolvers()` 模式 |
| `src/commands/publish.ts` (9/10) | 在底层使用 BrainWriter | 轻微：通过 L4 路由 |
| `src/commands/backlinks.ts` (8/10) | 折叠到 L4 验证器 | 保留为面向 CLI 的 lint 入口点 |
| `src/core/operations.ts` 验证器 | 在 ResolverContext 信任强制执行中重用 | 无 |
| `src/core/engine.ts` BrainEngine（35 个方法） | ResolverContext.engine | 用 `getResolverRegistry()` 扩展 |

### 7.2 替换（今天是临时的）

| 现有 | 替换为 |
|---|---|
| `src/core/enrichment-service.ts` (5/10) | `src/core/enrichment/orchestrator.ts`（L2） |
| `src/core/embedding.ts`（整体式） | `src/core/resolvers/builtin/embedding/openai.ts` |
| `src/core/transcription.ts`（整体式） | `src/core/resolvers/builtin/transcription/{groq,openai}.ts` |
| `src/commands/integrations.ts` 配方格式 | 统一的解析器插件格式（§3.5） |
| `src/core/data-research.ts` 配方格式 | 相同的统一格式 |
| `src/commands/autopilot.ts` 硬编码守护进程循环 | 包装一组 ScheduledResolver |

### 7.3 扩展

- `src/core/engine.ts`：添加 `getResolverRegistry()`、`getWriter()`、`getScheduler()`。引擎成为运行时的根容器。
- `src/core/operations.ts`：`OperationContext` 从 `ResolverContext` 继承（或反之亦然）。信任标志统一。
- `src/core/types.ts`：向 `Page` 添加 `completeness: number`，向 `sourcedBy: string[]` 添加来源。

---

## 8. 迁移路径（分阶段，可发布）

每个阶段独立发布，通过完整的 E2E，是功能标记的，并且是可逆的。没有大爆炸。

### 阶段 0 — 基础（人类：~1 周 / CC：~4 小时）

- 定义 `Resolver<I,O>`、`ResolverContext`、`ResolverRegistry`、`ResolverResult`（§3.2–3.4）。
- 添加 `src/core/resolvers/index.ts` 布线 + 注册表测试（注册/获取/列表）。
- 没有行为更改；作为带有功能标记的 `v0.11.0-alpha` 发布。

### 阶段 1 — 三个参考解析器（人类：~1 周 / CC：~4 小时）

- 将 `src/core/embedding.ts` 移植到 `resolvers/builtin/embedding/openai.ts`。
- 实施 `resolvers/builtin/brain-local/slug-lookup.ts`（包装 `engine.resolveSlugs`）。
- 实施 `resolvers/builtin/url-reachable.ts`（HEAD 检查）。
- 证明接口：旧调用者交换到 `registry.resolve('openai_embedding', ...)`。

### 阶段 2 — BrainWriter + Slug 注册表（人类：~1.5 周 / CC：~6 小时）

- L4 核心：`BrainWriter.transaction`、`Scaffolder`、`SlugRegistry` 带有冲突检测。
- 写前验证器：引用、链接、反向链接、triple-HR。
- 将 `src/commands/publish.ts` + `src/commands/backlinks.ts` 迁移到通过 BrainWriter 路由。
- **现在** Garry 的 OpenClaw 的"Philip Leung"幻觉在结构上是不可可能的 — LLM 输出在到达 Scaffolder 之前通过 JSON-Schema 验证器。

### 阶段 3 — `gbrain integrity` 命令（人类：~0.5 周 / CC：~2 小时）

- 在新的基础之上发布最初范围的用户面向上功能。
- 使用解析器 SDK：`x_handle_to_tweet` + `url_reachable`。
- 使用 BrainWriter：所有自动修复都通过验证的写入进行。
- `--auto --confidence 0.8` 模式为用户在 cherry-pick #1 中批准。
- **用户可见的价值在阶段 3 发布，而不是阶段 7。**

### 阶段 4 — 丰富编排器（人类：~2 周 / CC：~8 小时）

- L2 核心：`EnrichmentOrchestrator`、`BudgetLedger`、`CompletenessScorer`、`EntityGraph.cascadeFrom`。
- 迁移 `src/core/enrichment-service.ts` 调用者（之后弃用旧文件）。
- 每次写入时的前置元信息中的完整性分数（狗粮级联）。

### 阶段 5 — 调度器（人类：~2 周 / CC：~8 小时）

- L3 核心：`Scheduler`、`ScheduledResolver`、`DurableState`、断路器、安静时间强制执行器。
- 将 `src/commands/autopilot.ts` 迁移到一组 ScheduledResolver。
- 发布 `gbrain schedule list|run|pause|tail` CLI 以进行可观测性。

### 阶段 6 — 移植 5–8 个 OpenClaw 解析器（人类：~1.5 周 / CC：~6 小时）

- `perplexity_query`、`text_to_entities`、`mistral_ocr_pdf`、`x_search_all`、`x_user_to_tweets`、`gmail_query_to_threads`、`calendar_date_to_events`。
- 每个都作为 YAML + TS 模块发布在 `resolvers/builtin/` 下 — **插件格式的证明。**

### 阶段 7 — OpenClaw 采用集成（人类：~1 周 / CC：~4 小时）

- 编写 `docs/openclaw/ADOPTION.md`，展示你的 OpenClaw 如何用调用 `gbrain registry.resolve(...)` 来替换其 69 个定制脚本。
- 发布一个 `gbrain claw-bridge` 子命令，将 Garry 的 OpenClaw 的当前脚本调用代理到解析器注册表 — 零编辑采用路径。
- **这是对北极星测试。** 如果你的 OpenClaw 可以站起一个 1 行 shim 并删除 `scripts/x-api-client.mjs`，抽象就成功了。

总计：人类：~10 周 / CC：~42 小时 / 使用单个实现者的日历：~3–4 周。

---

## 9. 关键文件

### 新目录 / 文件

```
src/core/
  runtime/
    index.ts                       # RuntimeContext（引擎、存储、配置、日志记录器、指标、预算）
    registry.ts                    # ResolverRegistry
    factory.ts                     # createResolver()
  resolvers/
    interface.ts                   # Resolver<I, O>
    fail-improve-wrapper.ts        # 用 FailImproveLoop 自动包装每个解析器
    builtin/
      x-api/
        handle-to-tweet.ts
        handle-to-tweet.yaml
      perplexity/
        query.ts
        query.yaml
      brain-local/
        slug-lookup.ts
        url-reachable.ts
      embedding/
        openai.ts                  # 从 src/core/embedding.ts 重构
      transcription/
        groq.ts
        openai.ts
  enrichment/
    orchestrator.ts                # EnrichmentOrchestrator
    tiers.ts                       # TIER_CONFIG
    budget.ts                      # BudgetLedger
    completeness.ts                # CompletenessScorer + 每类型评分标准
    cascade.ts                     # EntityGraph
  scheduling/
    scheduler.ts                   # Scheduler + ScheduledResolver
    schedule.ts                    # Schedule 类型，cron expr 解析器
    state.ts                       # DurableState 原语
    quiet-hours.ts                 # TZ 感知的强制执行
    stagger.ts                     # 确定性槽位分配
  output/
    writer.ts                      # BrainWriter
    scaffold.ts                    # Scaffolder（类型化 URL 构建器）
    slug-registry.ts               # SlugRegistry（冲突检测）
    validators/
      citation.ts
      link.ts
      back-link.ts
      triple-hr.ts

src/commands/
  integrity.ts                     # 在阶段 3 发布，替换 Feynman 阶段 A/B
  schedule.ts                      # gbrain schedule list|run|pause|tail（阶段 5）

docs/openclaw/
  ADOPTION.md                      # 在阶段 7 编写
```

### 替换 / 删除

- `src/core/enrichment-service.ts` — 折叠到 `enrichment/orchestrator.ts`
- `src/core/embedding.ts` — 移动到 `resolvers/builtin/embedding/openai.ts`
- `src/core/transcription.ts` — 移动到 `resolvers/builtin/transcription/`

### 扩展

- `src/core/engine.ts` — 添加 `getResolverRegistry()`、`getWriter()`、`getScheduler()`
- `src/core/operations.ts` — 与 ResolverContext 统一；每个操作验证器可由解析器重用
- `src/core/types.ts` — 添加 `completeness: number`、`sourcedBy: string[]`、`lastVerified: Date`

---

## 10. 测试策略

### 契约测试

每个解析器实现都针对接口规范进行测试。表格驱动：针对 `openai_embedding`、`x_handle_to_tweet` 等运行相同的套件。确保插件作者不能发布损坏的解析器。

### 属性测试

- **幂等性：** 使用相同的状态运行 ScheduledResolver 两次会产生相同的输出，并且不会双重写入。
- **原子性：** 在飞行中途引发异常的 BrainWriter 事务会使 brain 在事务前逐位相同。
- **确定性脚手架：** 给定相同的解析器输出，Scaffolder 会产生逐字节相同的引用/链接。

### 集成测试

- 针对 PGLite（内存中，无 API 密钥）的 `EnrichmentOrchestrator` 端到端，带有模拟解析器注册表。
- 带有假时钟 + 安静时间场景的 `Scheduler`。
- 验证器失败时的 BrainWriter 事务回滚。

### 混沌测试

- 在丰富中途终止进程；下次运行必须干净地恢复。
- 在事务中途模拟 API 超时；事务必须完全回滚。
- 损坏的状态文件；调度器必须升级，而不是静默跳过。

### 与 Garry 的 OpenClaw 行为的回归测试

对于我们移植的每个 OpenClaw 模式（例如 X-handle → 推文 URL），回归测试证明新的解析器在对来自 brain 审计的真实世界输入产生相同的答案。这是"你的 OpenClaw 会采用"的证明。

---

## 11. 开放问题（标记为由 CEO 重新审查）

1. **范围形状。** 这是正确的四层分解，还是某些层最好留给 OpenClaw（例如调度生活在 GBrain 之上，而不是在其中）？
2. **阶段 3 用户价值突破。** 阶段 3（用户可见的 `gbrain integrity`）是否发布得足够早，或者我们是否需要一个更小的 MVP？
3. **LLM 作为解析器。** `text_to_entities` 应该是解析器，还是这模糊了不变式所依赖的"代码 vs LLM"界限？
4. **插件格式。** YAML + TS 模块（§3.5）与带有装饰器样式元数据的纯 TS 模块。后者更类型安全；前者更易发现。
5. **跨解析器事务。** 我们是否支持 L2 层的"从 Perplexity 原子获取 + 写入到 brain"？当前设计说可以；实施很棘手（Perplexity 调用不可回滚）。
6. **OpenClaw 桥接范围。** 阶段 7 `gbrain claw-bridge` — 这是否值得自己的一个阶段，或者采用应该仅是文档？
7. **完整性评分标准覆盖率。** 我们是否为所有 9 种 PageTypes 预先定义评分标准，或者首先发布人员/公司/会议并增量扩展？
8. **预算配置 UX。** 硬每日上限是严格的；我们是否还应该公开软上限警告模式，以及如何设置上限（env var？配置文件？在首次使用时提示？）
9. **向后兼容。** `src/commands/publish.ts` 和 `src/commands/backlinks.ts` 已经干净地运行了数周。通过 BrainWriter 重构带来了迁移风险。可接受吗？
10. **现有 TODOS 对齐。** `TODOS.md` 有 P0"运行时 MCP 访问控制"和 P2 安全加固。新的 RuntimeContext.remote 标志与两者交互 — 我们是将 MCP 访问控制折叠到阶段 0 还是保持分离？

---

## 12. 验证（"你的 OpenClaw 会采用"测试）

设计成功当且仅当：

- [ ] 用户可以通过在 `~/.gbrain/resolvers/` 中放置 YAML + TS 模块来添加新的解析器，而无需编辑 GBrain 源代码。
- [ ] 你的 OpenClaw 可以删除 `scripts/x-api-client.mjs` 并将所有调用者替换为 1 行 `await registry.resolve('x_handle_to_tweet', ...)`。
- [ ] 没有 brain 页面可以用裸推文引用、缺少的反向链接或未经验证的 URL 写入（验证器在提交前捕获它）。
- [ ] 对真实 brain 运行 `gbrain integrity --auto --confidence 0.8` 可以在没有人工审查的情况下修复 ≥1,000 个已知的裸推文引用。
- [ ] 完整的 E2E 测试套件在 PGLite + Postgres 引擎上都通过。
- [ ] 知识运行时跨 7 个阶段发布，每个阶段都是可独立发布和可逆的。
