# 待我处理（Open Loops）

目的不是「搜索邮件」，而是：**谁在等你、你答应了什么、回信要带哪段上下文。**

本分支已吸收该能力：`src/core/loops/`、Gmail 检测器，以及默认关闭的会议/连接器 lane。先看[连接 Google](google-connect.md)。

## 图形界面

Admin / 桌面「日常 → 待我处理」。可以标记已处理或不再跟踪。菜单和托盘「待我处理」打开同一页。

没有 Google 源时，文案是「Google 未配置」，**不会**说「已清零」。那是没接邮箱，不是收件箱空了。

## 命令行

```powershell
pmbrain waiting
pmbrain waiting --top 5 --json
pmbrain loops list
pmbrain loops done <id>
pmbrain loops drop <id>
pmbrain loops mute sender you@example.com
```

`waiting` 只读。关掉一条开环用 `loops`。

## 两条检测器

1. **确定性线程状态机**（`src/core/google/loop-detect.ts`，零模型，Gmail 同步时一直开）。对方最后一封、你在 To:、超过 24 小时没回 → 待我回复；你最后一封带问句、超过 72 小时没回 → 你在等对方。对方回了就关闭，行还在，不当成没发生过。通知信、列表邮件、纯抄送、日历系统信（iCalendar METHOD）不会开环。
2. **承诺抽取**（`src/core/google/loops-extract.ts`，默认开，只扫近 30 天、上限 500）。关掉：`pmbrain config set loops.extraction_enabled false`。没有对话模型时不会排队抽取，邮件页照常导入。

会议 / 转录 / Connector 的 LLM 抽取默认关（`loops.meeting_extraction_enabled` 等）。确定性 `loops_scan_meetings` 默认不调度。不要把「待我处理为空」理解成会议待办也扫过了。

对手方只用带 Source 的实体解析，不会把「张总」自动 slug 成另一个人。跨 Source 同名人物要在「日常 → 人物关联」手工连。
