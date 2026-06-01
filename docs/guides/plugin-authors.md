# 插件作者指南 (v0.15)

`gbrain` 通过 `GBRAIN_PLUGIN_PATH` 从本仓库之外发现子代理定义。如果你维护下游代理（你的 OpenClaw 部署、工作流主机、私有工具）并希望随其分发自定义子代理，请将插件目录放在该环境路径上。

本指南面向插件作者。CLI 用户不需要阅读它。

## 最小可行插件

```
/path/to/my-plugin/
├── gbrain.plugin.json
└── subagents/
    └── my-summarizer.md
```

`gbrain.plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "plugin_version": "gbrain-plugin-v1"
}
```

`subagents/my-summarizer.md`:

```markdown
---
name: my-summarizer
model: claude-sonnet-4-6
allowed_tools:
  - brain_search
  - brain_get_page
---

You are a brain page summarizer. Given a slug, fetch the page and produce
a 3-sentence summary.
```

## 启用插件

```bash
export GBRAIN_PLUGIN_PATH="/path/to/my-plugin"
gbrain jobs work           # worker 启动时打印插件加载行
gbrain agent run "summarize meetings/2026-04-20" --subagent-def my-summarizer
```

多个插件：用冒号分隔，就像 `$PATH` 一样：

```bash
export GBRAIN_PLUGIN_PATH="/path/to/plugin-a:/path/to/plugin-b"
```

## 规则（设计严格）

**路径策略。** 仅限绝对路径。相对路径、`~` 前缀路径和 URL 风格路径（`https://`、`file://`）会被拒绝并警告。你控制插件在磁盘上的位置；`gbrain` 不会猜测。

**冲突策略。** 如果两个插件附带同名的子代理，则 `GBRAIN_PLUGIN_PATH` 中首先列出的那个获胜。另一个会被丢弃并附带警告，说明两个来源。

**信任策略。** 插件在 v0.15 中仅分发子代理定义：

- 你**不能**声明新工具。
- 你**不能**扩展 brain 工具允许列表。
- 你**不能**覆盖任何 `agentSafe` 或类似标志。
- 你的 `allowed_tools:` frontmatter 字段必须是从属的 brain 工具注册表。名称不在注册表中的会在插件加载时间（worker 启动时）被拒绝，而不是在子代理调度时间 — 所以插件中的拼写错误会给你一个响亮的启动错误，而不是凌晨 3 点静默的"工具从未触发"。

v0.16+ 可能会通过单独的合约打开插件声明的工具。不要指望它。

## `gbrain.plugin.json`

| 字段            | 类型   | 必需 | 备注                                                              |
|------------------|--------|----------|--------------------------------------------------------------------|
| `name`           | string | 是      | 人类可读的插件 ID。显示在警告和冲突日志中。             |
| `version`        | string | 是      | 你的插件的 semver。信息性的。                               |
| `plugin_version` | string | 是      | 合约锁定。对于 v0.15 必须等于 `"gbrain-plugin-v1"`。          |
| `subagents`      | string | 否       | 子目录名称（默认 `subagents`）。会拒绝转义尝试。   |
| `description`    | string | 否       | 显示在将来的 `gbrain plugin list` 中。                              |

## 子代理定义文件

带有 YAML frontmatter 的纯 markdown。正文是系统提示。frontmatter 控制运行时行为。

可识别的 frontmatter 字段：

| 字段           | 类型     | 必需 | 备注                                                                                   |
|-----------------|----------|----------|-----------------------------------------------------------------------------------------|
| `name`          | string   | 否       | 用作 `--subagent-def` 的子代理标识符。默认为文件基本名称。            |
| `model`         | string   | 否       | Anthropic 模型 ID。默认为 handler 默认值 (sonnet)。                           |
| `max_turns`     | number   | 否       | 助手回合上限。默认为 20。                                                 |
| `allowed_tools` | string[] | 否       | 工具名称白名单。必须从属的衍生 brain 注册表。不匹配时会在加载时拒绝。  |

未知的 frontmatter 字段会被保留但忽略。v0.16 可能会消耗更多。

## 会坑你的注意事项

1. **插件定义在运行期间不能更改。** 加载器在 worker 启动时读取磁盘一次。编辑子代理定义不会生效，直到你重启 worker。这是故意的 — 实时重载会破坏崩溃可恢复的重放。

2. **`~/.gbrain/audit/subagent-jobs-*.jsonl` 仅在本地。** 如果你的 worker 在与 `gbrain agent logs` 调用者不同的主机上运行，CLI 将看不到来自该 worker 的心跳。v0.16 将统一这一点；目前假设 worker + CLI 共享文件系统。

3. **工具调用始终以 `ctx.remote = true` 运行。** 即使在本地 CLI 调用时也是如此。对 `remote=true` 进行门控的工具（file_upload 的严格限制、put_page 的命名空间检查）将会应用。好的默认设置；想要本地文件系统访问超出 brain 范围的子代理定义无法拥有它。

4. **`put_page` 写入是命名空间限定的。** ID 为 42 的子代理只能写入 `wiki/agents/42/...` 下。这在工具架构（显示给模型的 slug 模式）和服务器端 `put_page` 操作（如果 `viaSubagent=true` 则失败关闭）中都是强制的。不要试图绕过它；你会得到 `permission_denied`。

## 示例：下游 OpenClaw 插件

```
~/your-openclaw/
└── gbrain-plugin/
    ├── gbrain.plugin.json
    └── subagents/
        ├── meeting-ingestion.md
        ├── signal-detector.md
        └── daily-task-prep.md
```

`~/your-openclaw/gbrain-plugin/gbrain.plugin.json`:

```json
{
  "name": "your-openclaw",
  "version": "2026.4.20",
  "plugin_version": "gbrain-plugin-v1",
  "description": "Your OpenClaw's personal-brain subagents"
}
```

环境：

```bash
export GBRAIN_PLUGIN_PATH="$HOME/your-openclaw/gbrain-plugin"
```

然后你的 OpenClaw 调用 `gbrain agent run --subagent-def meeting-ingestion --fanout-by transcript ...` 并且它的定义会自动加载。
