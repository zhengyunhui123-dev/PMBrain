# PMBrain 代码分层

PMBrain 不要求 AI 在每次任务前理解整个项目。先看项目地图，再沿当前任务的一条调用链读取。

## 分层

```text
Admin / Desktop / CLI / MCP
          ↓
Command 与 HTTP 路由
          ↓
Operation 与核心能力
          ↓
BrainEngine 接口
          ↓
PGLite / Postgres
```

### 交互层

- `admin/`：React Admin Console；请求封装在 `admin/src/api.ts`。
- `desktop/`：Electron 主进程、preload 和 renderer；主进程负责 Sidecar 生命周期。
- `src/cli.ts`、`src/commands/`：CLI 与部分独立命令处理器。
- `src/mcp/dispatch.ts`：MCP 调度。

### 合同与核心能力层

- `src/core/operations.ts`：共享 Operation 合同、权限和参数边界。
- `src/core/search/`：检索流水线。
- `src/core/import-file.ts`、`src/core/sync.ts`：导入和同步。
- `src/core/cycle/`：Dream 阶段。
- `src/core/source-resolver.ts`：Source 解析。

并非所有 CLI 命令都会自动经过 `operations.ts`。修改前必须用 `rg` 跟踪真实入口，不要根据
目录名猜测调用关系。

### 数据引擎层

- `src/core/engine.ts`：`BrainEngine` 接口；
- `src/core/pglite-engine.ts`：本地 PGLite；
- `src/core/postgres-engine.ts`：Postgres；
- `src/core/engine-factory.ts`：引擎选择；
- `src/core/migrate.ts`：迁移编排；
- `src/schema.sql`、`src/core/schema-embedded.ts`、`src/core/pglite-schema.ts`：schema。

## 修改原则

1. GUI 和 Desktop 优先调用已有 CLI、Operation 或 HTTP 能力。
2. 如果底层没有能力，先说明缺口，不要为了一个按钮偷偷新增另一套数据逻辑。
3. 核心能力或数据逻辑属于底层架构，修改前要得到用户确认。
4. 数据库相关改动同时验证 PGLite 和 Postgres。
5. 打包前检查实际内嵌 Admin、Sidecar 和资源，不以源码 diff 代替运行时验收。
