# 插件处理程序 — 注册主机特定的 Minion 处理程序

GBrain 的 Minion worker 附带七个内置处理程序：`sync`、`embed`、`lint`、`import`、`extract`、`backlinks`、`autopilot-cycle`。这些覆盖了 gbrain CLI 本身执行的每个后台操作。

主机平台（OpenClaw 部署、将来的主机）通过导入 `gbrain/minions` 的插件引导注册它们自己的处理程序。没有 `handlers.json` 风格的数据文件 — 处理程序是代码，由 worker 加载，具有与主机仓库中任何其他代码相同的信任模型。

## 为什么是代码，而不是数据

一个早期的设计草案附带了 `~/.claude/gbrain-handlers.json`，其中每个条目都是 worker 在认领作业时会执行的 shell 命令。Codex 将其标记为持久的 RCE 表面：一个代理可写的文件，会生成任意 shell。我们放弃了数据文件方法；处理程序是主机显式导入并通过代码审查发布的代码。

## 插件合约

主机 worker 引导看起来像这样（TypeScript）：

```ts
import { MinionQueue, MinionWorker } from 'gbrain/minions';
import type { BrainEngine } from 'gbrain/engine';

async function main() {
  const engine: BrainEngine = /* 你的引擎设置 */;
  await engine.connect({});

  const worker = new MinionWorker(engine, { queue: 'default' });

  // 注册主机特定的每个处理程序，主机的 cron 清单会引用这些处理程序。
  // 每个处理程序返回一个普通对象（序列化为作业结果）。
  // 失败时抛出 — worker 会根据 max_attempts 捕获并重试。

  worker.register('ea-inbox-sweep', async (ctx) => {
    const slot = ctx.data.slot ?? new Date().toISOString();
    // 主机特定的代理回合：调用你的 LLM，扫描收件箱，写入
    // brain 页面，返回摘要。ctx.signal.aborted 指示
    // worker 希望你配合关闭 — 尊重它。
    return { swept: true, slot };
  });

  worker.register('morning-briefing', async (ctx) => {
    /* 主机逻辑 */
    return { briefed: true };
  });

  // 在注册每个处理程序后调用 start()。worker 的
  // 失速检测器会忽略名称不在已注册集合中的作业。
  await worker.start();
}

main().catch(err => { console.error(err); process.exit(1); });
```

将其作为单独的可执行文件发布在主机仓库中（例如 `your-openclaw-worker`），或者作为 stock `gbrain jobs work` 命令在启动时自动加载的副作用模块（通过主机提供的入口点可配置）。

## 处理程序合约

每个处理程序接收一个 `MinionJobContext`：

```ts
interface MinionJobContext {
  data: Record<string, unknown>;   // 作业参数（无论 cron 提交传递了什么）
  job: MinionJob;                   // 完整的作业行（id、队列、尝试等）
  signal: AbortSignal;              // 当 worker 关闭时设置为中止
  inbox: MinionInbox;               // 读取此作业运行时发送给它的消息
}
```

成功时返回可序列化对象。失败时抛出（worker 会根据 `max_attempts` 记录 + 重试）。

**中止配合。** 当 `ctx.signal.aborted` 变为 true 时，请优雅地完成。worker 会在 SIGKILL 之前等待 30 秒让你返回。长时间运行的 LLM 调用应该将信号传递给它们使用的任何网络库。

**幂等性。** 队列在数据库层强制执行唯一的 `idempotency_key`，所以你不需要担心 cron 在前一次调用仍在运行时触发的双重提交。

## Gbrain 的迁移流程

v0.11.0 迁移编排器（由 `gbrain apply-migrations` 运行）检测处理程序名称不在 GBrain 内置集合中的 cron 条目，并向 `~/.gbrain/migrations/pending-host-work.jsonl` 发出结构化 TODO。每个 TODO 的形状为：

```json
{
  "type": "cron-handler-needs-host-registration",
  "handler": "ea-inbox-sweep",
  "cron_schedule": "0 */30 * * *",
  "manifest_path": "/path/to/cron/jobs.json",
  "recommendation": "Add a handler registration for `ea-inbox-sweep` in your host worker bootstrap per docs/guides/plugin-handlers.md. Once registered, re-run `gbrain apply-migrations` to auto-rewrite this entry.",
  "status": "pending"
}
```

主机代理使用 `skills/migrations/v0.11.0.md` 遍历这些条目：

1. 读取 `~/.gbrain/migrations/pending-host-work.jsonl`。
2. 对于每个 `cron-handler-needs-host-registration` 行，请按照上面的模式在主机 worker 引导中发布处理程序注册。
3. 部署更新的 worker。
4. 重新运行 `gbrain apply-migrations --yes`。编排器现在会识别新可注册的处理程序（worker 在启动时将注册的名称写入发现文件）并重写 cron 条目以使用 `gbrain jobs submit`。JSONL 行被标记为 `status: "complete"`。

## 信任边界

处理程序代码在 worker 进程内运行，具有与主机可执行文件其余部分相同的特权。没有提权。但也有没有运行时沙箱 — 处理程序可以读取 + 写入 worker 用户可以访问的任何位置。像审查任何其他触及生产数据的代码一样审查处理程序 PR。

## 相关

- `skills/conventions/cron-via-minions.md` — cron 清单的重写约定。
- `skills/migrations/v0.11.0.md` — 迁移编排器如何驱动主机代理完成此工作。
- `skills/minion-orchestrator/SKILL.md` — 处理程序上线后提交、监控、引导重放作业的模式。
