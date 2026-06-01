---
id: restart-sweep
name: Restart Sweep
version: 0.1.0
description: 检测 OpenClaw 网关重启期间丢弃的 Telegram 消息。读取 OpenClaw 会话状态，在中止的运行中会话和（可选）可疑静默间隙上发出警报。Cooldown 门控，因此重复检测不会垃圾邮件。
category: reflex
requires: []
secrets:
  - name: OPENCLAW_OWNER_IDS
    description: 拥有此大脑实例的用户 ID 的逗号分隔列表
    where: openclaw config — 您连接的平台的自己的用户 ID
  - name: OPENCLAW_TELEGRAM_GROUP
    description: 重启警报的目标 Telegram 组 ID（组的负数）
    where: 将来自组的消息转发到 @userinfobot，复制 chat.id
health_checks:
  - type: env_exists
    name: OPENCLAW_OWNER_IDS
    label: 所有者 ID 已配置
  - type: env_exists
    name: OPENCLAW_TELEGRAM_GROUP
    label: Telegram 组已配置
  - type: command
    argv: [openclaw, sessions, --json]
    label: OpenClaw CLI 可达
setup_time: 10 min
cost_estimate: "$0（无每次调用成本；在 cron 上本地运行）"
---

# Restart Sweep：检测网关重启后丢弃的消息

当 OpenClaw 网关重新启动时，尚未处理的 webhook 传递的 Telegram 消息
会永久丢弃。长轮询机器人
可以通过 `getUpdates` 重放错过的更新。Webhook 机器人不能。此
配方通过读取 OpenClaw 的会话状态并发出警报来检测间隔，
当会话在重启前处于活动状态但之后静默时。

## 重要：给代理的说明

**您是安装程序。** 此配方是为**您（AI 代理）**编写的
代表用户执行。请精确按照这些步骤操作。

**停止点（在继续之前必须暂停并验证）：**
- 步骤 1 后：先决条件通过？如果没有，请在继续之前修复。
- 步骤 4 后：空运行产生合理的输出？如果没有，请在
   连接 cron 之前调试。
- 步骤 5 后：cron 条目已创建并且在 `crontab -l` 中可见？如果没有，
   cron 未安装。

**当某些事情失败时：** 准确地告诉用户什么失败了，它
意味着什么，以及尝试什么。永远不要说"出了点问题。"

## 这是做什么的

1. 读取 `/tmp/bootstrap-services.log`（或 `$OPENCLAW_BOOTSTRAP_LOG`）
   以查找网关最后重新启动的时间。如果日志不可读，则回退到 `now() - 30
   分钟`。
2. 运行 `openclaw sessions --json` 以枚举所有实时会话。
3. 过滤到匹配 `$OPENCLAW_TELEGRAM_GROUP` 的 Telegram 组会话。
4. 标记带有 `abortedLastRun: true` 的会话（丢弃的
   消息的强信号）。可选地标记在重启前 5 分钟处于活动状态但在重启后 10 分钟
   内静默的会话 — 隐藏在 `OPENCLAW_RESTART_SWEEP_AGGRESSIVE=1` 后面，因为时序
   启发式在安静期间产生误报。
5. Cooldown 层：每个 alerted 的 sessionKey 都会加盖
   `lastAlertedAt` 时间戳。无论综合重启
   时间是否匹配，相同的 sessionKey 上的重新警报
   都会被抑制 6 小时。这可以防止"缺少引导日志 →
   永远每 5 分钟重新警报"的失败模式。
6. 每个周期发送一个警报到 Telegram（如果没有 Telegram
   配置，则发送到 stdout），然后将警报记录到
   `~/.gbrain/integrations/restart-sweep/alerted.json`。

## 先决条件

- OpenClaw 在 webhook 模式下运行（长轮询模式
   不需要这个 — `getUpdates` 在重启时恢复错过的消息）
- PATH 上的 `openclaw` CLI（或者您将在步骤 5 中提供绝对路径）
- Telegram 机器人令牌已在 OpenClaw 中配置，组 ID 和
   可选的主题 ID 已知
- 主机上的 Cron 可用（此配方安排一个 5 分钟的作业；
   systemd 计时器、launchd 或任何其他调度程序也可以 — 相应地
   调整步骤 5）

## 步骤 1：验证先决条件

```bash
openclaw sessions --json | head -40
```

应打印带有 `sessions` 数组的 JSON。如果出错，请修复
在继续之前的 `openclaw` 可达性。

确定主机仓库安装路径。配方假设
`~/openclaw/scripts/restart-sweep.mjs` 和用户的 `.env` 位于
`~/openclaw/.env`。调整您的仓库布局。

## 步骤 2：收集秘密

与用户确认：

- `OPENCLAW_OWNER_IDS` — 逗号分隔的用户 ID（例如 `123456789,987654321`）
- `OPENCLAW_TELEGRAM_GROUP` — 目标组 ID（对于
  群组聊天为负数，例如 `-1001234567890`）。将
  来自组的消息转发到 `@userinfobot` 以获取它。
- `OPENCLAW_ALERT_TOPIC` — 可选，论坛的主题/线程 ID
  组。在 Telegram 中打开主题，URL 以线程 ID 结尾。

将这三行添加到主机的 `.env`（或主机从中加载
env 的任何位置）：

```bash
OPENCLAW_OWNER_IDS=...
OPENCLAW_TELEGRAM_GROUP=...
OPENCLAW_ALERT_TOPIC=...
```

可选调整：

```bash
# 设置为 1 以启用基于时序的启发式（重启前活动，
# 重启后静默）。默认关闭，因为它在安静期间产生误报。
OPENCLAW_RESTART_SWEEP_AGGRESSIVE=1

# 覆盖引导日志路径（默认 /tmp/bootstrap-services.log）
OPENCLAW_BOOTSTRAP_LOG=/var/log/openclaw/bootstrap.log
```

## 步骤 3：将脚本写入主机仓库

将下一节中的脚本内容写入
`~/openclaw/scripts/restart-sweep.mjs`（或用户选择的任何位置）。
脚本是自包含的 — 不需要 npm install，只需要 Node 18+
或 Bun。

<!-- restart-sweep:script -->
```javascript
#!/usr/bin/env node

/**
 * Restart Message Sweep Script
 *
 * 检测 OpenClaw 网关重启期间丢弃的 Telegram 消息。
 * Webhook 传递的消息无法通过 getUpdates 重放，因此我们
 * 读取 OpenClaw 的会话状态并查找显示
 * 处理丢弃迹象的会话。
 *
 * 在 Node 18+ 或 Bun 下运行。将此文件复制到您的主机仓库并
 * 将其连接到 5 分钟 cron。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

// 模块级常量（此处无 env 读取 — env 在构造时读取）
const RESTART_THRESHOLD_MINUTES = 30;  // 缺少引导日志时的回退重启时间窗口
const COOLDOWN_HOURS = 6;              // 每个 sessionKey 的重新警报抑制
const STALE_DAYS = 30;                 // 修剪早于此的 alerted.json 条目
const PRE_RESTART_WINDOW_MS = 5 * 60 * 1000;
const POST_RESTART_WINDOW_MS = 10 * 60 * 1000;

class MessageSweepDetector {
    /**
     * @param {{ execFile?: typeof execFile, runOpenclawSessions?: () => Promise<any[]> }} [deps]
     *   测试的可选依赖注入。生产：保留未定义。
     */
    constructor(deps = {}) {
        // 构造时的 env 读取（C2）：测试可以每个构造改变 process.env
        const ownerEnv = process.env.OPENCLAW_OWNER_IDS ?? '';
        this.OWNER_IDS = ownerEnv.split(',').map(s => s.trim()).filter(Boolean);
        this.TELEGRAM_GROUP_ID = process.env.OPENCLAW_TELEGRAM_GROUP ?? '';
        this.ALERT_TOPIC = process.env.OPENCLAW_ALERT_TOPIC ?? '';
        this.AGGRESSIVE = process.env.OPENCLAW_RESTART_SWEEP_AGGRESSIVE === '1';

        const gbrainHome = process.env.GBRAIN_HOME ?? path.join(os.homedir(), '.gbrain');
        this.STATE_DIR = path.join(gbrainHome, 'integrations', 'restart-sweep');
        this.LOG_PATH = path.join(this.STATE_DIR, 'sweep.log.jsonl');
        this.ALERTED_PATH = path.join(this.STATE_DIR, 'alerted.json');
        this.BOOTSTRAP_LOG = process.env.OPENCLAW_BOOTSTRAP_LOG ?? '/tmp/bootstrap-services.log';

        // DI 钩子（默认为实际实现）
        this._execFile = deps.execFile ?? execFile;
        this._runOpenclawSessions = deps.runOpenclawSessions ?? null;

        this.sessions = null;
        this.restartTime = null;
        this.alertMode = this.determineAlertMode();
        this.alerted = new Map();  // 在 run() / loadAlerted() 中填充
    }

    determineAlertMode() {
        if (this.TELEGRAM_GROUP_ID && this.ALERT_TOPIC) return 'telegram';
        if (this.TELEGRAM_GROUP_ID) return 'telegram_stdout';
        return 'stdout';
    }

    async run() {
        try {
            console.log('🔍 正在启动重启消息扫描检测...');

            if (this.OWNER_IDS.length === 0) {
                console.warn('⚠️  未配置 OPENCLAW_OWNER_IDS。设置此环境变量。');
            }
            if (!this.TELEGRAM_GROUP_ID) {
                console.warn('⚠️  未配置 OPENCLAW_TELEGRAM_GROUP。警报将仅转到 stdout。');
            }

            fs.mkdirSync(this.STATE_DIR, { recursive: true });
            this.alerted = await this.loadAlerted();

            this.restartTime = await this.getLastRestartTime();
            console.log(`📅 检测到的最后重启时间：${new Date(this.restartTime).toISOString()}`);

            this.sessions = await this.getSessionState();
            console.log(`📊 找到 ${this.sessions.length} 个总会话`);

            const telegramSessions = this.filterTelegramSessions(this.sessions);
            console.log(`📱 找到 ${telegramSessions.length} 个 Telegram 会话`);

            const droppedMessages = await this.detectDroppedMessages(telegramSessions);
            const newDrops = droppedMessages.filter(m => !this.isInCooldown(m.sessionKey));
            const suppressedCount = droppedMessages.length - newDrops.length;

            if (newDrops.length > 0) {
                const tail = suppressedCount > 0 ? `（${suppressedCount} 个被 cooldown 抑制）` : '';
                console.log(`⚠️  找到 ${newDrops.length} 个可能丢弃的消息${tail}`);
                await this.recordAndAlert(newDrops);
            } else if (suppressedCount > 0) {
                console.log(`✅ 所有 ${suppressedCount} 个候选者都被 cooldown 抑制`);
            } else {
                console.log('✅ 未检测到丢弃的消息');
            }

            await this.logResults(droppedMessages);

        } catch (error) {
            console.error('❌ 消息扫描中的错误：', error);
            await this.logError(error);
        }
    }

    async getLastRestartTime() {
        try {
            const logContent = await fsp.readFile(this.BOOTSTRAP_LOG, 'utf8');
            const gatewayLines = logContent.split('\n')
                .filter(line => line.includes('Gateway token synced') || line.includes('✅ OpenClaw gateway'))
                .reverse();
            if (gatewayLines.length > 0) {
                const match = gatewayLines[0].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                if (match) {
                    return new Date(match[1] + ' UTC').getTime();
                }
            }
            return Date.now() - (RESTART_THRESHOLD_MINUTES * 60 * 1000);
        } catch (error) {
            console.warn('⚠️  无法从日志确定重启时间，使用回退');
            return Date.now() - (RESTART_THRESHOLD_MINUTES * 60 * 1000);
        }
    }

    async getSessionState() {
        if (this._runOpenclawSessions) {
            return await this._runOpenclawSessions();
        }
        try {
            const { stdout } = await execP('openclaw sessions --json');
            const sessionData = JSON.parse(stdout);
            return sessionData.sessions || [];
        } catch (error) {
            console.error('❌ 无法获取会话状态：', error);
            throw error;
        }
    }

    filterTelegramSessions(sessions) {
        if (!this.TELEGRAM_GROUP_ID) return [];
        return sessions.filter(session => {
            return session.key &&
                   session.key.includes('telegram:group:' + this.TELEGRAM_GROUP_ID) &&
                   session.kind === 'group';
        });
    }

    async detectDroppedMessages(telegramSessions) {
        const droppedMessages = [];
        const recentRestartWindow = this.restartTime - PRE_RESTART_WINDOW_MS;
        const afterRestartWindow = this.restartTime + POST_RESTART_WINDOW_MS;

        for (const session of telegramSessions) {
            try {
                const sessionUpdated = session.updatedAt;

                // 主要：中止的最后一次运行是强信号
                if (session.abortedLastRun) {
                    const topic = this._extractTopic(session.key);
                    droppedMessages.push({
                        sessionKey: session.key,
                        topic,
                        lastUpdate: new Date(sessionUpdated).toISOString(),
                        sessionId: session.sessionId,
                        abortedLastRun: true,
                        reason: '会话在最后一次运行时中止',
                    });
                    continue;
                }

                // 次要：基于时序的间隔检测 — 仅选择加入（易于误报）
                if (!this.AGGRESSIVE) continue;

                if (sessionUpdated >= recentRestartWindow &&
                    sessionUpdated < this.restartTime &&
                    Date.now() > afterRestartWindow) {
                    const topic = this._extractTopic(session.key);
                    droppedMessages.push({
                        sessionKey: session.key,
                        topic,
                        lastUpdate: new Date(sessionUpdated).toISOString(),
                        timeSinceUpdate: Math.floor((Date.now() - sessionUpdated) / 1000 / 60),
                        sessionId: session.sessionId,
                        suspiciousGap: true,
                        reason: '重启前活动，重启后静默',
                    });
                }
            } catch (error) {
                console.warn(`⚠️  分析会话 ${session.key} 时出错：`, error);
            }
        }
        return droppedMessages;
    }

    _extractTopic(sessionKey) {
        const m = sessionKey?.match(/:topic:(\d+)/);
        return m ? m[1] : 'unknown';
    }

    /**
     * Cooldown 层（C1）：抑制同一 sessionKey 上的重新警报
     * 对于 COOLDOWN_HOURS，无论综合的重启时间是否
     * 匹配。当引导日志丢失且 restartTime 不稳定时，Cooldown 获胜。
     */
    isInCooldown(sessionKey) {
        const entry = this.alerted.get(sessionKey);
        if (!entry || !entry.lastAlertedAt) return false;
        const ageMs = Date.now() - new Date(entry.lastAlertedAt).getTime();
        return ageMs < COOLDOWN_HOURS * 60 * 60 * 1000;
    }

    async loadAlerted() {
        try {
            const content = await fsp.readFile(this.ALERTED_PATH, 'utf8');
            const parsed = JSON.parse(content);
            const map = new Map();
            const cutoffMs = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
            for (const [key, entry] of Object.entries(parsed || {})) {
                if (entry && entry.lastAlertedAt) {
                    const ts = new Date(entry.lastAlertedAt).getTime();
                    if (Number.isFinite(ts) && ts >= cutoffMs) {
                        map.set(key, entry);
                    }
                }
            }
            return map;
        } catch (err) {
            if (err && err.code === 'ENOENT') return new Map();
            console.warn(`⚠️  无法加载 ${this.ALERTED_PATH}：${err && err.message}；从空状态开始`);
            return new Map();
        }
    }

    async saveAlerted() {
        const obj = Object.fromEntries(this.alerted);
        const json = JSON.stringify(obj, null, 2);
        const tmp = this.ALERTED_PATH + '.tmp';
        // 在 POSIX 上是原子的：先写 tmp，然后重命名。注意：这仅防止
        // 文件损坏 — 并发 cron 运行仍然可以读取旧状态，都决定发出警报，都重命名。给定
        // 5 分钟节奏和 2-5 秒运行时间，重叠很少，并且
        // 重复警报比错过的警报更可取。
        await fsp.writeFile(tmp, json);
        await fsp.rename(tmp, this.ALERTED_PATH);
    }

    async recordAndAlert(droppedMessages) {
        let alertSent = false;
        try {
            await this.alertOnDroppedMessages(droppedMessages);
            alertSent = true;
        } catch (err) {
            console.error('❌ 无法发送警报（将在下一个周期重试）：', err && err.message);
        }
        if (!alertSent) return;

        const nowIso = new Date().toISOString();
        const restartIso = new Date(this.restartTime).toISOString();
        for (const msg of droppedMessages) {
            this.alerted.set(msg.sessionKey, {
                lastAlertedAt: nowIso,
                restartTime: restartIso,
            });
        }
        try {
            await this.saveAlerted();
        } catch (err) {
            console.warn('⚠️  无法保存 alerted 状态：', err && err.message);
        }
    }

    async alertOnDroppedMessages(droppedMessages) {
        let alertText = `⚠️ 在重启后找到 ${droppedMessages.length} 个未处理的消息：\n\n`;
        for (const msg of droppedMessages.slice(0, 10)) {
            alertText += `• 主题 ${msg.topic}：${msg.reason}（最后更新：${msg.lastUpdate}）\n`;
            if (msg.timeSinceUpdate) {
                alertText += `  ${msg.timeSinceUpdate} 分钟前\n`;
            }
        }
        if (droppedMessages.length > 10) {
            alertText += `\n... 还有 ${droppedMessages.length - 10} 个`;
        }

        switch (this.alertMode) {
            case 'telegram':
                await this.sendTelegramAlert(alertText);
                break;
            case 'telegram_stdout':
                console.log('📢 将发送 Telegram 警报，但未配置主题：');
                console.log(alertText);
                break;
            default:
                console.log('📢 警报：');
                console.log(alertText);
        }
    }

    async sendTelegramAlert(alertText) {
        // execFile（不是 exec）：argv 数组，无 shell 解释，
        // shell 元字符在 env vars 中不能注入命令。
        const argv = [
            'message', 'send',
            '--channel', 'telegram',
            '--target', this.TELEGRAM_GROUP_ID,
            '--thread-id', this.ALERT_TOPIC,
            '--message', alertText,
        ];
        await new Promise((resolve, reject) => {
            this._execFile('openclaw', argv, (err, _stdout, stderr) => {
                if (err) {
                    err.stderr = stderr;
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        console.log('📢 警报已发送到 Telegram');
    }

    async logResults(droppedMessages) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            restartTime: new Date(this.restartTime).toISOString(),
            droppedMessageCount: droppedMessages.length,
            droppedMessages,
        };
        try {
            await fsp.appendFile(this.LOG_PATH, JSON.stringify(logEntry) + '\n');
        } catch (error) {
            console.warn('⚠️  无法写入日志文件：', error && error.message);
        }
    }

    async logError(error) {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            error: error && error.message,
            stack: error && error.stack,
        };
        try {
            await fsp.appendFile(this.LOG_PATH, 'ERROR: ' + JSON.stringify(errorEntry) + '\n');
        } catch (logError) {
            console.error('无法记录错误：', logError && logError.message);
        }
    }
}

// 如果直接执行则运行
if (import.meta.url === `file://${process.argv[1]}`) {
    const detector = new MessageSweepDetector();
    detector.run().catch(console.error);
}

export default MessageSweepDetector;
```

## 步骤 4：空运行

在连接 cron 之前，使用加载的 env 手动运行脚本一次：

```bash
set -a; source ~/openclaw/.env; set +a
node ~/openclaw/scripts/restart-sweep.mjs
```

预期输出（无丢弃）：

```
🔍 正在启动重启消息扫描检测...
📅 检测到的最后重启时间：2026-05-06T12:53:45.000Z
📊 找到 48 个总会话
📱 找到 39 个 Telegram 会话
✅ 未检测到丢弃的消息
```

如果您想查看警报路径，请手动编辑 OpenClaw
中的会话以设置 `abortedLastRun: true` 并重新运行。警报触发后，检查
`~/.gbrain/integrations/restart-sweep/alerted.json` — sessionKey
应该在那里带有 `lastAlertedAt` 时间戳。在 6 小时内重新运行会抑制警报。

## 步骤 5：连接 5 分钟 cron

Cron **不**继承您的 shell 环境。`openclaw` 和 `node` 可能
不在 cron 的精简 PATH 上。`.env` 文件不会自动加载。使用
以下包装脚本模式来同时处理这两者：

创建 `~/openclaw/scripts/restart-sweep-wrapper.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
set -a
source ~/openclaw/.env
set +a
exec /usr/local/bin/node ~/openclaw/scripts/restart-sweep.mjs
```

```bash
chmod +x ~/openclaw/scripts/restart-sweep-wrapper.sh
```

调整 `/usr/local/bin/node` 到您的 `node` 实际所在的位置
（`which node` 以查找它）。如果包装器需要
显式地将其添加到 PATH，则相同用于 `openclaw`：

```bash
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
```

通过 `crontab -e` 添加到 crontab：

```cron
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * /bin/bash ~/openclaw/scripts/restart-sweep-wrapper.sh >> ~/.gbrain/integrations/restart-sweep/cron.log 2>&1
```

使用 `crontab -l` 验证。等待 5 分钟，然后检查 cron 日志以
确认它已运行：

```bash
tail -20 ~/.gbrain/integrations/restart-sweep/cron.log
```

## 步骤 6：验证

1. `gbrain integrations doctor restart-sweep` — 应该通过所有三个
   健康检查
2. `~/.gbrain/integrations/restart-sweep/sweep.log.jsonl` 存在并且
   每 5 分钟获得一个新条目
3. `~/.gbrain/integrations/restart-sweep/cron.log` 显示成功的
   调用（无 PATH 错误，无 `command not found`）
4. 在具有卡住会话的真实 OpenClaw 重启后，Telegram
   警报触发一次，然后 cooldown 层在 6 小时内抑制重复

## 调整

`OPENCLAW_RESTART_SWEEP_AGGRESSIVE=1` — 启用次要的
"重启前活动，重启后静默"启发式。默认关闭，因为
在正常的安静期间（夜间、周末）它会产生误报。
如果您想要最大灵敏度**并且**您已经确定您的
组始终处于活动状态，请启用。

cooldown 阈值（6 小时）是脚本中的常量。如果您需要不同的行为，请编辑
`COOLDOWN_HOURS` — 例如，如果您的
组的正常节奏是每天，则为 24 小时。

## 故障排除

### 在同一会话上重复触发警报

检查 `~/.gbrain/integrations/restart-sweep/alerted.json`。如果
sessionKey 丢失或 `lastAlertedAt` 是最近的，则 cooldown 应该
抑制。如果没有抑制：

- 状态文件可能不可写。检查 `ls -ld
  ~/.gbrain/integrations/restart-sweep/`。
- `GBRAIN_HOME` 可能设置为与 cron 下的路径不同
  在您的 shell 中。检查包装器的 env 加载。
- 如果 mkdir 失败，脚本的 `STATE_DIR` 解析会在 stderr 中打印。
  检查 cron 日志。

### Telegram 警报静默失败

当 `openclaw message send` 返回非零时，脚本会将 `❌ 无法发送警报（将在下一个周期重试）` 记录到
stderr。常见原因：

- cron 的 PATH 上没有 `openclaw`（在包装器中使用绝对路径）
- Telegram 机器人令牌已过期或受速率限制
- 错误的组/主题 ID（尝试手动 `openclaw message send --channel telegram
  --target $OPENCLAW_TELEGRAM_GROUP --message test`）

当发送失败时，状态**不**会更新，因此下一个周期会重试。

### 引导日志丢失

如果 `/tmp/bootstrap-services.log`（或 `$OPENCLAW_BOOTSTRAP_LOG`）不存在，
脚本会回退到 `now() - 30 分钟` 作为 restartTime。
Cooldown 层可以防止这种情况发送垃圾邮件。如果您想要稳定的
重启锚点，请将 `OPENCLAW_BOOTSTRAP_LOG` 指向 OpenClaw 的实际
启动日志（无论您的部署使用什么）。

### Cron 环境

步骤 5 中的包装器脚本处理了 80% 的 cron 首日失败，但是
还有两个旋钮：

- **区域设置：** 如果您的脚本曾经将用户提供的文本插值到
  日志行中，请在 cron 条目中设置 `LANG=en_US.UTF-8` 以避免乱码。
- **工作目录：** cron 默认在 `$HOME` 中启动。脚本
  在任何地方都使用绝对路径，所以这应该不重要，但如果您
  曾经添加相对路径依赖项，请在包装器中执行 `cd ~/openclaw`。

## 未来升级路径

此配方是 v1 形态：复制到主机仓库并
连接到 cron 的脚本。v2 形态是在
OpenClaw 仓库中针对 `gbrain/minions` 注册的插件 Minion 处理程序（请参阅
`docs/guides/plugin-handlers.md`）。插件处理程序优势：

- 内置队列幂等性（不需要 cooldown 层）
- 从任何 cron / 代理 /
  手动触发器提交 `gbrain jobs submit restart-sweep`
- 集中式重试 / 退避 / 锁定管理
- 少一个要维护的主机脚本

当这成为正确的权衡（多个部署、
多个 cron 计划，或者只是足够的复杂性来证明移动是合理的）时，提升
到插件处理程序形态并弃用此配方。
