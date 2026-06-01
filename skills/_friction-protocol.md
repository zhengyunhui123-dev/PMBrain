# 摩擦协议 — 约定

> 被 claw-test 测试工具覆盖的技能共享的跨领域规则（setup、brain-ops、query、
> ingest、smoke-test、migrations）。通过
> `> **Convention:** see [skills/_friction-protocol.md](_friction-protocol.md).` 引用。

当您在运行 gbrain 时遇到摩擦——任何令人困惑、缺失、意外或错误的情况——通过 `gbrain friction log` 记录，以便维护者无需您撰写错误报告即可看到。摩擦报告驱动 claw-test 反馈循环（工具收集、渲染并重新运行）。

## 何时记录

当以下任一情况发生时记录摩擦：

- 命令因不可操作的错误消息而失败
- 文档说的是一回事，工具做的是另一回事
- 找不到下一步操作
- 设置命令需要手动变通
- 存在某个标志但未在 `--help` 中记录
- 成功条件不明确（无法判断命令是否成功）

当出现以下情况时记录正向反馈（积极信号）：

- 某功能第一次就成功了，且文档完全准确
- 错误消息直接给出了解决方案
- 您猜测的标志确实存在且名称显而易见

## 如何记录

```
gbrain friction log \
  --severity {confused|error|blocker|nit} \
  --phase <which-phase-or-command> \
  --message "<one-line-what-happened>" \
  [--hint "<one-line-what-could-be-better>"]
```

对于正向反馈，添加 `--kind delight` 并选择任意严重级别。

CLI 会自动填充 `ts`、`cwd`、`gbrain_version`，并从 `$GBRAIN_FRICTION_RUN_ID`（由工具设置）解析 `run_id`，或回退到 `standalone.jsonl`。因此您可以在任何地方调用——在工具运行期间、正常使用期间手动调用，或从脚本化测试中调用。

## 严重级别指南

| severity   | 含义 |
|------------|------|
| `blocker`  | 完全无法继续。硬性阻断。 |
| `error`    | 命令意外失败。 |
| `confused` | 文档/工具不匹配、歧义、缺少指引。 |
| `nit`      | 打磨机会。外观性或低影响。 |

要具体："'doctor 显示 `schema_version=0` 并指向 apply-migrations，但 apply-migrations 以退出码 0 退出且无输出"比"doctor 令人困惑"好得多。

## 查看报告

```
gbrain friction list                      # 最近的运行及计数
gbrain friction render --run-id <id>      # Markdown 报告（默认）
gbrain friction render --run-id <id> --json
gbrain friction summary --run-id <id>     # 摩擦与正向反馈并排展示
```

`render` 默认使用 `--redact` 生成 Markdown（将 `$HOME`/`$CWD` 替换为 `<HOME>`/`<CWD>` 占位符），以便报告可以安全地粘贴到 PR 和 Issue 中。
