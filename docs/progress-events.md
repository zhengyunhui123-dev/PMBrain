# 进度事件

`gbrain`在批量命令运行时使用`--progress-json`写入`stderr`的JSONL进度流的规范参考。从v0.15.2开始稳定。仅 additive 更改；没有重命名或删除，除非是主要版本升级。

大多数人类不会阅读此页面。解析进度的代理会。

## 何时会收到这些事件？

当设置`--progress-json`时，以下任何命令都会流式传输事件：

- `gbrain doctor` (DB检查, JSONB完整性, markdown body完整性, 完整性采样)
- `gbrain orphans`
- `gbrain embed`
- `gbrain files sync`
- `gbrain export`
- `gbrain extract [links|timeline|all]` (fs或db源)
- `gbrain import`
- `gbrain sync`
- `gbrain migrate --to …`
- `gbrain repair-jsonb`
- `gbrain check-backlinks`
- `gbrain lint`
- `gbrain integrity auto`
- `gbrain eval`
- `gbrain apply-migrations` (编排器 + 每个子命令)

非批量命令（`stats`, `graph-query`, `get`, `put`等）不发出事件 — 它们在不到一秒内返回。

## 通道

- 进度事件：**`stderr`**，每行一个JSON对象，`\n`终止。
- 数据结果（来自每个命令的`--json`负载）：**`stdout`**。
- 最终人类摘要：**`stdout`**。

代理可以安全地捕获stdout用于其结果解析，并单独读取stderr以获取进度。

## 标志

| 标志 | 行为 |
|---|---|
| *(无)* | 自动。TTY：`\r`重写单行。非TTY：stderr上每行事件。 |
| `--progress-json` | 强制stderr上的JSON行模式（本文档）。 |
| `--quiet` | 完全抑制进度。警告和最终输出仍然打印。 |
| `--progress-interval=<ms>` | 覆盖tick发射之间的最小间隔（默认1000）。 |

全局标志：在命令调度之前由`src/core/cli-options.ts`解析，因此`gbrain --progress-json doctor`与`gbrain doctor --progress-json`的工作方式相同（后者也工作 — 每命令解析器通过共享的`CliOptions`单例看到标志）。

## 事件类型

每个事件都是一个单行JSON对象，具有这些公共字段：

| 字段 | 类型 | 备注 |
|---|---|---|
| `event` | string | 以下之一：`start`, `tick`, `heartbeat`, `finish`, `abort`。 |
| `phase` | string | 机器稳定的snake_case，点分隔。参见下面的"阶段名称"。 |
| `ts` | ISO 8601 UTC字符串 | 事件发射时间。 |
| `elapsed_ms` | number | 阶段开始以来的毫秒数。出现在`tick`/`heartbeat`/`finish`/`abort`上。 |

### `start`

阶段开始时发射。

```json
{"event":"start","phase":"doctor.db_checks","ts":"2026-04-20T12:34:56.789Z"}
{"event":"start","phase":"import.files","total":52000,"ts":"2026-04-20T12:34:56.789Z"}
```

可选字段：

- `total` — 开始时已知的项目总数。

### `tick`

迭代期间定期发射。时间和项目门控：报告器不会比`minIntervalMs`（默认1000）和`minItems`（默认`max(10, ceil(total/100))`）更频繁地发射。

```json
{"event":"tick","phase":"orphans.scan","done":15000,"total":52000,"pct":28.8,"elapsed_ms":4200,"eta_ms":10300,"ts":"..."}
```

字段：

- `done` — 此阶段完成的项目。
- `total` — 总项目数，如果已知。当前置扫描没有前置总数（例如流式迭代器）时省略。
- `pct` — `done/total * 100`，一位小数。当`total`未知时省略。
- `eta_ms` — 从观察到的速率到`done === total`的预计毫秒数。当`total`未知时省略。
- `note` — 当前项目的可选字符串（例如slug或文件名）。

### `heartbeat`

为不迭代的长期运行的单个操作发射（例如针对50K行表的`SELECT`）。没有`done`，没有`total` — 只是一个工作仍在进行中的信号。

```json
{"event":"heartbeat","phase":"doctor.markdown_body_completeness","note":"scanning pages for truncation…","elapsed_ms":1000,"ts":"..."}
```

### `finish`

阶段正常完成时发射。

```json
{"event":"finish","phase":"import.files","done":52000,"total":52000,"elapsed_ms":187000,"ts":"..."}
```

### `abort`

由跟踪每个活动阶段的单个进程级SIGINT/SIGTERM处理程序发射。在`abort`之后，该阶段不再发射事件。

```json
{"event":"abort","phase":"doctor.markdown_body_completeness","reason":"SIGINT","elapsed_ms":5300,"ts":"..."}
```

## 阶段名称

阶段使用`snake_case.dot.path`命名。新的报告器从根开始；`child()`组合附加到父级的当前阶段，因此调用import的sync会发射`sync.import.<file>`，而不是`import.<file>`。

v0.15.2中发布的稳定阶段名称：

- `doctor.db_checks` (所有DB端doctor检查的总括)
- `orphans.scan`
- `embed.pages`
- `extract.links_fs`, `extract.timeline_fs`, `extract.links_db`, `extract.timeline_db`
- `import.files`
- `sync.deletes`, `sync.renames`, `sync.imports`
- `migrate.copy_pages`, `migrate.copy_links`
- `repair_jsonb.run`, `repair_jsonb.<table>.<column>`
- `backlinks.scan`
- `lint.pages`
- `integrity.auto`
- `eval.single`, `eval.ab`
- `export.pages`
- `files.sync`

通过`child()`公开子阶段：

- `sync.import.files` — sync内嵌套
- `apply_migrations.v0_12_2.jsonb_repair` — 嵌套在编排器内

## 子进程继承

当父CLI生成`gbrain …`子进程时（主要在`src/commands/migrations/*`中），全局标志（`--quiet`, `--progress-json`, `--progress-interval`）通过`src/core/cli-options.ts`中的`childGlobalFlags()`帮助程序传播到子进程的argv。子进程stderr直接通过`stdio: 'inherit'`传递，因此事件流是父进程stderr上的一个合并的JSONL流。

一个例外：`migrations/v0_12_2.ts`中捕获子进程stdout（`repair-jsonb --dry-run --json`用于验证）的编排器阶段不会传递`--progress-json`以避免任何stdout污染破坏编排器的`JSON.parse`的风险。它的stdio是显式的：`['ignore', 'pipe', 'inherit']`因此stderr仍然流过。

## Minion作业

`gbrain jobs work`（Minion工作守护程序）将进度保留在DB中，而不是stderr上。每个运行批量核心（embed, sync, extract, import, backlinks）的Minion处理程序在每次迭代时调用`job.updateProgress({done, total, …})`。代理通过`get_job_progress` MCP操作或`gbrain jobs get <id>`读取每作业进度。

`jobs work`守护程序本身仅为活跃度发出粗略的单行每作业stderr输出。每页细节存在于DB中。

## 兼容性

- **仅添加**。新的事件类型，新的字段，新的阶段名称 — 都是安全的。代理必须忽略未知字段和未知事件类型。
- **删除/重命名**：永远不会没有主要版本升级。
- **模式更改**：在`CHANGELOG.md`和`skills/migrations/v<next>.md`中宣布。

如果您的代理依赖于此模式，并且有些东西让您感到惊讶，请打开一个带有您收到的事件以及您期望的问题。
