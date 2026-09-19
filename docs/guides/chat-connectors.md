# 连接 ChatGPT / Claude

把你自己的 ChatGPT、Claude 对话历史同步进 PMBrain。用的是本机会话凭证，不是把 Cookie 交给远程 MCP。

本分支已吸收该能力：`src/core/connectors/`。Admin「日常 → 连接器」可以看状态并点同步，**不能在页面里粘贴 Cookie**。首次登录仍走 CLI。

## 图形界面

1. 打开 Admin 或桌面「日常 → 连接器」。
2. 看 ChatGPT / Claude 是否已有本机凭证、上次同步时间。
3. 已登录时可点「同步」。自动同步默认关，需要时再开。

页面上看不到 Cookie。凭证只写在 `~/.pmbrain/connectors/<provider>.json`（文件 0600，目录 0700），不进数据库、`sources.config` 或 MCP 远程 payload。

## 命令行

```powershell
pmbrain connectors auth chatgpt --cookie -
pmbrain connectors auth claude --cookie -
pmbrain connectors status
pmbrain connectors sync chatgpt --dry-run
pmbrain connectors sync chatgpt --limit 5
pmbrain connectors sync chatgpt --full
pmbrain connectors logout chatgpt
```

可选：`pmbrain config set connectors.chatgpt.auto_sync true`，再装 autopilot。未配置 Embedding 时不会为了同步去调用向量服务，也不会回退 ZeroEntropy。

`connector_sync` 是 `localOnly`：HTTP MCP 看不到、也调不了。在跑 Sidecar 的那台机器上执行。

Perplexity 没有实时连接器，继续用会话导出文件导入。
