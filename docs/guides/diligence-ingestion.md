# 尽职调查摄取：数据室到 Brain 页面

## 目标

将 pitch deck、财务模型和数据室材料转换为可搜索、交叉引用的 brain 页面，并带有牛市/熊市分析。

## 用户获得什么

没有它：pitch deck 位于电子邮件附件中。财务模型在 Google Drive 中。没有到公司 brain 页面的交叉引用。你无法搜索"Acme Corp 的 A 轮 deck 中的关键指标是什么？"

有了它：每个数据室文档都被提取、日记化、交叉引用到公司页面，并且可搜索。Index.md 让你一眼就能看到牛市/熊市案例。`gbrain query "Acme Corp 收入增长"` 找到确切的图表。

## 实现

通过包含 "Data Deck"、"Intro Deck"、"Data Room"、"Cap Table"、"Financial Model"、"Investor Memo"、"Pitch Deck" 或系列轮名称的 PDF 文件名来识别数据室材料。带有 Revenue、Retention、Cohorts、CAC、Gross Margin、Unit Economics、ARR 选项卡的电子表格。用户语言如 "data room"、"diligence"、"deck"、"pitch"、"fundraise materials"。

### 9 步管道

**步骤 1：识别公司。**
从文档内容或文件名中，识别公司名称。
检查 `brain/companies/{slug}.md` 是否存在。

**步骤 2：创建尽职调查目录。**

```bash
mkdir -p brain/diligence/{company-slug}/.raw
```

**步骤 3：提取内容。**

- **PDF：** 使用 PDF 提取工具。对于扫描的/图像密集的 PDF，使用 OCR（例如，Mistral OCR 或类似的）。
- **电子表格：** 将每个工作表导出为 CSV。对于 Google Sheets：
  ```
  https://docs.google.com/spreadsheets/d/{ID}/gviz/tq?tqx=out:csv&sheet={Sheet Name}
  ```

**步骤 4：日记化并保存。**
将提取的内容写入 `brain/diligence/{company}/{doc-name}.md`：
- 文档标题和类型
- 逐部分分解，带有关键指标
- 值得注意的脚注或警告
- 相关处的原始数据表

**步骤 5：保存原始文件。**
将原始 PDF/文件复制到 `brain/diligence/{company}/.raw/`
保留原始文件以供参考。日记化版本用于搜索。

**步骤 6：创建或更新 index.md。**
每个尽职调查目录都需要一个 `index.md`：

```markdown
# {Company Name} — 尽职调查

## 轮次详情
- 阶段：A 轮
- 金额：$10M
- 日期：2026-04

## 文档清单
- [Pitch Deck](pitch-deck.md) — 25 张幻灯片，公司概述 + 牵引力
- [Financial Model](financial-model.md) — 5 个选项卡，3 年预测
- [Cap Table](cap-table.md) — 当前所有权 + 期权池

## 关键发现
- 过去 6 个月收入增长 30% MoM
- CAC 投资回收期：4 个月
- 净保留率：135%

## 牛市案例
- 强大的产品市场契合度信号（NPS 72）
- 扩展到相邻垂直领域

## 熊市案例
- 单个客户占收入的 40%
- 上次季度燃烧率增加了 3 倍

## 未解决的问题
- 盈利能力的路径是什么？
- 护城河的可防御性如何？
```

**步骤 7：丰富公司 Brain 页面。**
更新 `brain/companies/{slug}.md`：
- 将文档来源添加到 frontmatter
- 用关键发现更新编译真相
- 添加"另请参阅"链接到尽职调查目录
- 如果没有公司页面，通过丰富 skill 创建一个

**步骤 8：提交。**

```bash
cd brain/ && git add -A && git commit -m "diligence: {Company} — {doc type} ingestion" && git push
```

**步骤 9：发布（如果被要求）。**
当用户想要可共享的简报时，创建一个受密码保护的发布版本。删除内部笔记和原始评估语言。

### 质量门槛

一个好的尽职调查页面读起来像情报评估：
- **他们说的** vs **数据显示的**（差距就是洞察力）
- 明确的牛市/熊市案例（不仅仅是摘要）
- 突出显示的关键指标，而不是埋没
- 在决策之前需要答案的未解决问题

## 棘手的地方

1. **PDF 提取是有损的。** 扫描的 deck 和图像密集的 PDF 在提取过程中会丢失表格和图表。始终根据原始 `.raw/` 文件检查日记化输出。如果关键指标丢失，请使用 OCR 重新提取或手动转录。

2. **重新摄取时的幂等性。** 如果用户为同一家公司发送更新的 deck，不要创建重复的目录。检查现有的 `brain/diligence/{company-slug}/` 并在适当位置更新。如果应该保留旧版本，请在文档文件名后附加版本后缀。

3. **index.md 的完整性。** index.md 是整个尽职调查包的入口点。如果它缺少牛市/熊市案例或未解决的问题，尽职调查就不完整。即使某些部分需要判断调用，也要始终生成所有部分 — 明确地标记不确定的评估。

## 如何验证

1. **搜索关键指标。** 摄取后，运行 `gbrain search "revenue growth"` 或 `gbrain search "{company name} CAC"`。日记化内容应该出现在结果中。如果没有，则跳过了同步或嵌入步骤。

2. **检查公司页面交叉引用。** 打开 `brain/companies/{slug}.md` 并验证它链接到尽职调查目录。编译真相部分应该包括来自 deck 的关键发现。

3. **验证 index.md 具有所有部分。** 打开 `brain/diligence/{company}/index.md` 并确认它具有轮次详情、文档清单、关键发现、牛市案例、熊市案例和未解决的问题。缺少的部分意味着管道提前停止。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
