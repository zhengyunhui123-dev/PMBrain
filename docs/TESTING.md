# PMBrain 测试与 CI 契约

## 命令分层

| 命令 | 作用 |
| --- | --- |
| `bun run verify` | 静态 Guard、版本/生成物、Admin 构建门禁和 typecheck；权威检查清单在 `scripts/run-verify-parallel.sh`。 |
| `bun run test` | 清理数据库环境后的快速 unit 测试。 |
| `bun run test:full` | `verify`、unit、slow，以及存在数据库 URL 时的 E2E。 |
| `bun run test:e2e` | 统一 E2E wrapper：测试库名 floor、HOME/GBRAIN_HOME 隔离、逐文件串行、逐文件超时和失败汇总。 |
| `bun run test:heavy` | `tests/heavy/` 运维形状测试；每个会触碰数据库的脚本先经过 `_db_floor.sh`。 |
| `bun run ci:local:diff` | 根据 Git diff 选择 E2E；未识别的源代码、Guard、配置或工作流变更 fail-closed。 |
| `bun run ci:local` | 本地发布前的完整 Docker/Postgres、verify、unit、PGLite snapshot 和 E2E 链路。 |

`bun run check:all` 只作为旧调用方的兼容别名，等同于 `bun run verify`，不再拥有独立
的手工检查列表。

## 数据库安全契约

- 普通 unit、serial、slow 和 shard 包装器清掉 `DATABASE_URL`、`GBRAIN_DATABASE_URL`、
  `PMBRAIN_DATABASE_URL` 以及 `GBRAIN_TEST_ALLOW_DATABASE_URL`。
- E2E 只能通过 wrapper 或明确的一次性命令设置 `GBRAIN_TEST_ALLOW_DATABASE_URL=1`。
  allow 不是全局环境变量，也不能跳过数据库名 floor。
- `DATABASE_URL`、`GBRAIN_DATABASE_URL` 和 `PMBRAIN_DATABASE_URL` 都受 Bun preload Guard
  保护；E2E shell 层在第一次 `psql` 前再次检查数据库名必须包含 `test` 名称段。
- wrapper 使用临时 `HOME` 与 `GBRAIN_HOME`，并验证用户真实 `.gbrain/config.json` 没有被创建、
  删除或改写。E2E 文件按顺序执行，避免共享数据库的 `TRUNCATE` 与 fixture 导入竞态。
- heavy shell 测试必须 source `tests/heavy/_db_floor.sh`，或明确清除所有数据库 URL。

## Guard 与生成物

`scripts/guards-manifest.tsv` 是所有 `scripts/check-*` 文件的分类注册表。标记为
`selftest=yes` 的 scanner 必须同时拥有 bad/good fixture，并由
`bun run check:guard-self-test` 验证“坏样本失败、好样本通过”。

`check:admin-build` 先运行完整 `bun run build:admin`，再检查以下受版本控制的生成物无 diff：

- `admin/dist/`
- `src/admin-embedded.ts`
- `release-manifest.json`

生成物不由 CI 自动提交。源码修改后应在本地运行 `bun run build:admin`，审阅生成 diff 并将
必要的生成文件一起提交；本任务不执行 `bun run build:win`。

## CI 分层

普通 Test workflow 运行 verify、unit、serial、slow、Windows Desktop runtime 和统一状态汇总；
缓存只在所有门禁成功后写入，schedule/manual 会绕过已有 pass marker。E2E workflow 单独维护
Postgres JSONB parity、Tier 1 mechanical、Tier 2 LLM skills 和独立状态汇总；Tier 2 因
OpenClaw 需要 runner HOME 配置而保留显式 direct-Bun 例外，但 URL 必须是 `*_test`，allow
只在该 job 的测试步骤设置。

报告验证结果时要区分通过、失败、跳过和环境不可用。缺少 Bun、Docker、Postgres 或外部
API key 时只能报告“未运行/部分验证”，不能称为完整 CI 通过。
