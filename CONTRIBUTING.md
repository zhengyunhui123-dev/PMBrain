# 为 GBrain 贡献代码

## 环境设置

```bash
git clone https://github.com/garrytan/gbrain.git
cd gbrain
bun install
bun test
```

需要 Bun 1.0+。

## 项目结构

```
src/
  cli.ts                  CLI 入口点
  commands/               CLI 专用命令（init, upgrade, import, export 等）
  core/
    operations.ts         契约优先的操作定义（基础）
    engine.ts             BrainEngine 接口
    postgres-engine.ts    Postgres 实现
    db.ts                 连接管理 + schema 加载器
    import-file.ts        导入管道（分块 + 嵌入 + 标签）
    types.ts              TypeScript 类型
    markdown.ts           前置元数据解析
    config.ts             配置文件管理
    storage.ts            可插拔存储接口
    storage/              存储后端（S3, Supabase, local）
    supabase-admin.ts     Supabase 管理 API
    file-resolver.ts      MIME 检测 + 内容哈希
    migrate.ts            迁移助手
    yaml-lite.ts         轻量级 YAML 解析器
    chunkers/             3 层分块（递归, 语义, llm）
    search/               混合搜索（向量, 关键词, 混合, 扩展, 去重）
    embedding.ts          OpenAI 嵌入服务
  mcp/
    server.ts             MCP stdio 服务器（从操作生成）
  schema.sql              Postgres DDL
skills/                  为 AI agent 准备的完整 markdown 技能
test/                     单元测试（bun test，无需数据库）
test/e2e/                 端到端测试（需要 DATABASE_URL，真实 Postgres+pgvector）
  fixtures/               小型现实 brain 语料库（16 个文件）
  helpers.ts              DB 生命周期, fixture 导入, 计时
  mechanical.test.ts      针对真实数据库的所有操作
  mcp.test.ts             MCP 工具生成验证
  skills.test.ts          Tier 2 技能测试（需要 OpenClaw + API 密钥）
docs/                     架构文档
```

## 运行测试

```bash
# 内循环编辑（Mac 开发机上约 85 秒，3700+ 单元测试）
bun run test                      # 并行 8-shard 扇出 + 串行后处理
bun test test/markdown.test.ts    # 特定单元测试

# 推送前门禁（匹配 CI 在 shard 1 上运行的内容 + 类型检查）
bun run verify                    # privacy + jsonb + progress + test-isolation + wasm + admin-build + resolver + typecheck

# 合并前完整性检查（CI 运行的所有内容）
bun run test:full                 # verify + 并行单元测试 + slow + smart e2e

# 隔离运行慢速 / 串行 / e2e 测试
bun run test:slow                 # 仅 *.slow.test.ts（冷路径正确性）
bun run test:serial               # 仅 *.serial.test.ts（--max-concurrency=1）
bun run test:e2e                  # 真实 Postgres E2E（需要 DATABASE_URL）

# E2E 设置（带 pgvector 的 Postgres）
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# 或使用你自己的 Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

在推送前使用 `bun run verify`。守护链会捕获：禁止的 fork-name 泄漏（`scripts/check-privacy.sh`）、`JSON.stringify(x)::jsonb` 插值模式（`scripts/check-jsonb-pattern.sh`）、`\r` 进度泄漏到 stdout（`scripts/check-progress-to-stdout.sh`）、测试隔离规则违规（`scripts/check-test-isolation.sh` — 参见下面的"编写在并行循环中生存的测试"）、编译二进制中静默回退到递归分块（`scripts/check-wasm-embedded.sh`）、过时的管理后台构建 artifacts（`scripts/check-admin-build.sh`）、以及捆绑技能的解析器漂移（`bun run check:resolver` — 严格模式 `check-resolvable`，在任何警告时 exit-1，在 v0.41.14.0 中添加以在合并前捕获 SKILL.md frontmatter ↔ RESOLVER.md 漂移）。`bun run check:all` 运行完整的历史扫描，包括 trailing-newline 和 exports-count 检查。

### 编写在并行循环中生存的测试

`bun run test` 在 8 个工作进程中分片 92+ 单元测试文件。同一分片中的文件共享一个进程，因此进程全局状态会在它们之间泄漏。四个 lint 规则（`scripts/check-test-isolation.sh`，R1-R4）强制执行隔离：

| 规则 | 禁止什么 | 修复方法 |
|---|---|---|
| **R1** | 直接的 `process.env.X = ...` 突变 | 使用 `test/helpers/with-env.ts` 中的 `withEnv()`，或重命名为 `*.serial.test.ts` |
| **R2** | 文件中任何地方的 `mock.module(...)` | 重命名为 `*.serial.test.ts` |
| **R3** | `new PGLiteEngine(` 在 `beforeAll(` 后不在约 50 行内 | 使用规范 PGLite 块（见下文） |
| **R4** | `new PGLiteEngine(` 没有配对的 `afterAll(disconnect)` | 添加 `afterAll(() => engine.disconnect())` |

规范 PGLite 块（符合 R3 + R4 — 逐字粘贴此代码）：

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });
```

涉及环境变量的测试：

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});
```

`withEnv` 通过 try/finally 保存和恢复密钥，包括回调抛出时。跨测试安全；**不是**文件内并发安全（`process.env` 是进程全局的）。使用 `withEnv` 的文件停留在未来的 `test.concurrent()` codemod 的资格过滤器之外。

何时隔离而不是修复：如果文件使用 `mock.module(...)`、真正与环境耦合（模块加载环境读取器 + ESM 缓存击败动态导入后环境技巧）、或故意在 `it()` 边界之间共享状态，则重命名为 `*.serial.test.ts`。隔离计数上限：10（信息性）。

在 v0.26.7 基线违反这些规则的文件列在 `scripts/check-test-isolation.allowlist` 中。**允许列表必须随时间缩小**...永远不要添加新条目。v0.26.8（env 扫描）和 v0.26.9（PGLite 扫描 + codemod）在文件修复时删除条目。

### 本地 CI 门禁（推送前推荐，v0.23.1+）

```bash
bun run ci:local         # 完整门禁：gitleaks + 单元测试 + 所有 29 个 E2E 文件（顺序）
bun run ci:local:diff    # 带差异感知的 E2E 选择器
bun run ci:select-e2e    # 打印选择器将运行哪些 E2E 文件
```

`ci:local` 通过 `docker-compose.ci.yml` 启动 `pgvector/pgvector:pg16` + `oven/bun:1`，运行 PR CI 运行的所有内容加上完整的 E2E 套件，然后拆除。命名卷在运行之间保持安装温暖（第一次冷拉取后约 16-20 分钟顺序 E2E）。需要 Docker（Docker Desktop、OrbStack 或 Colima）和主机上的 `gitleaks`（`brew install gitleaks`）。如果 5434 冲突，使用 `GBRAIN_CI_PG_PORT=5435 bun run ci:local` 覆盖 postgres 主机端口。

失败关闭选择器：未映射的 `src/` 更改运行所有 29 个 E2E 文件。通过 `scripts/e2e-test-map.ts` 手动调整更窄的映射。

## 构建

```bash
bun build --compile --outfile bin/gbrain src/cli.ts
```

## 添加新操作

GBrain 使用契约优先架构。将你的操作添加到一个文件中，它会自动出现在 CLI、MCP 服务器和 tools-json 中：

1. 将你的操作添加到 `src/core/operations.ts`（定义参数、处理程序、cliHints）
2. 添加测试
3. 就这样。CLI、MCP 服务器和 tools-json 都是从操作生成的。

对于 CLI 专用命令（init, upgrade, import, export, files, embed, doctor, sync）：
1. 创建 `src/commands/mycommand.ts`
2. 将 case 添加到 `src/cli.ts`

奇偶测试（`test/parity.test.ts`）验证 CLI/MCP/tools-json 保持同步。

## 添加新引擎

参见 `docs/ENGINES.md` 了解完整指南。简而言之：

1. 创建实现 `BrainEngine` 的 `src/core/myengine-engine.ts`
2. 添加到 `src/core/engine.ts` 中的引擎工厂
3. 针对你的引擎运行测试套件
4. 在 `docs/` 中记录

原始 SQLite 引擎计划被 PGLite（通过 WASM 嵌入的 Postgres 17）取代，它使用与 Postgres 相同的 SQL 方言，消除了对单独 FTS5/sqlite-vss 转换层的需要。参见 [`docs/ENGINES.md`](docs/ENGINES.md) 了解引擎架构和原理。

## CONTRIBUTOR_MODE — 开启开发循环

gbrain 捕获检索流量，以便你可以在合并前针对你的代码更改重放真实查询。**默认情况下这是关闭的**（生产用户获得安静的 brain，没有意外数据积累）。贡献者通过一个 shell rc 行开启它：

```bash
# 在 ~/.zshrc 或 ~/.bashrc 中：
export GBRAIN_CONTRIBUTOR_MODE=1
```

就这样。从该 shell 运行的每个 `query` / `search`（或指向你的开发 brain 的 agents）现在都会向 `eval_candidates` 写入一行，[重放工具](#运行真实世界评估基准触摸检索代码) 有数据可以使用。

CONTRIBUTOR_MODE 实际做什么：

- 开启 `query`/`search` 捕获到本地 `eval_candidates` 表。
  没有它，门禁关闭，捕获是无操作。
- 就这样。PII 擦除、保留和重放是独立的。

解析顺序（最明确的获胜）：

1. `~/.gbrain/config.json` 中的 `eval.capture: true` → 开启
2. `~/.gbrain/config.json` 中的 `eval.capture: false` → 关闭
3. `GBRAIN_CONTRIBUTOR_MODE=1` → 开启
4. 否则 → 关闭

快速检查捕获是否实际运行：

```bash
gbrain query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'
# （或 `gbrain doctor` — 跨进程显示静默捕获失败）
```

即使设置了环境变量也要禁用捕获，将 `{"eval": {"capture": false}}` 写入 `~/.gbrain/config.json` — 明确配置在两个方向上都胜过环境变量。

## 运行真实世界评估基准（触摸检索代码）

如果你的 PR 涉及检索 — 搜索排名、RRF 融合、嵌入、意图分类、查询扩展、源增强、或 `query` / `search` 操作处理程序 — 在合并前针对真实流量快照运行 `gbrain eval replay`。需要 `CONTRIBUTOR_MODE`（ above）以便你有捕获的行可以重放。

快速循环：

```bash
gbrain eval export --since 7d > baseline.ndjson    # 更改前的快照
# ... 进行你的更改 ...
gbrain eval replay --against baseline.ndjson       # 差异检索，获取 Jaccard@k
```

返回三个数字：捕获的和当前的 slug 集之间的平均 Jaccard@k、top-1 稳定性和平均延迟 Δ。重放工具标记最差的回归，以便你可以目测更改是否损害真实查询。

触发路径（如果你的 diff 触及这些中的任何一个，则重新运行）：

- `src/core/search/hybrid.ts`
- `src/core/search/source-boost.ts`, `sql-ranking.ts`
- `src/core/search/intent.ts`, `expansion.ts`, `dedup.ts`
- `src/core/embedding.ts`
- `src/core/operations.ts`（`query` / `search` 处理程序）
- `src/core/postgres-engine.ts` / `pglite-engine.ts`（searchKeyword /
  searchVector SQL）

参见 [`docs/eval-bench.md`](./docs/eval-bench.md) 了解完整指南，包括 CI 集成、手工制作的 NDJSON 语料库（因此没有捕获数据的全新检出仍然可以重放）和成本考虑。NDJSON 线路格式记录在 [`docs/eval-capture.md`](./docs/eval-capture.md) 中。

为了在重放之上进行公开基准测试覆盖，`gbrain eval longmemeval <dataset.jsonl>`（v0.28.1）针对 gbrain 的混合检索运行 LongMemEval。每个问题一个内存中 PGLite，问题之间的运行时枚举 `TRUNCATE`，通过 LongMemEval 发布的 `evaluate_qa.py` 进行基础事实评分。当更改影响长上下文对话数据上的检索质量时，与重放一起使用 — 重放在你的查询上捕获回归，LongMemEval 在基准社区已经引用的公开集上捕获它们。参见 [`docs/eval-bench.md`](./docs/eval-bench.md) 中的"公开基准：LongMemEval"部分。

## 欢迎 PR

- SQLite 引擎实现
- 用于自托管 Postgres 的 Docker Compose
- 其他迁移源
- 新的丰富 API 集成
- 性能优化