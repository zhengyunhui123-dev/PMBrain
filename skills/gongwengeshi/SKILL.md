---
name: gongwengeshi
version: 0.1.0
description: "中国政府公文(.docx)格式规范。当用户需要生成或格式化政府公文、申报材料、请示报告、汇报材料等正式公文时使用。触发词：公文、政府公文、申报材料、请示、报告、汇报材料、红头文件、正式文档、Word排版、仿宋、方正仿宋、方正小标宋、方正黑体。确保生成的docx符合党政机关公文格式标准。"
triggers:
  - "公文"
  - "政府公文"
  - "申报材料"
  - "请示"
  - "报告"
  - "汇报材料"
  - "汇报稿"
  - "方案"
  - "写方案"
  - "红头文件"
  - "正式文档"
  - "Word排版"
  - "仿宋"
  - "方正仿宋"
  - "方正小标宋"
  - "方正黑体"
---

# gongwengeshi — 中国政府公文格式规范

> 参考标准：GB/T 9704-2012《党政机关公文格式》实际落地经验。

## Contract

- 输入为政府公文、申报材料、请示、汇报材料或相关 Word 排版需求。
- 只按本技能规范调整页面、字体、行距和缩进，不擅自改变业务内容。

## Anti-Patterns

- 不使用未要求的装饰色、非规范字体或随意页边距。
- 不跳过用户确认直接生成需要用户交付的最终文档。

## Output Format

- 输出格式检查结果或完整文档生成说明，并列出页面、字体、行距、缩进等关键规范。

## The rule

**生成任何政府公文 .docx 时，必须严格遵守以下格式规范。违反即不合格。**

---

## 一、页面设置

```
纸张：A4 (11906×16838 DXA, 210mm×297mm)
页边距：上下左右 1440 DXA (1英寸 / 2.54cm)
```

```javascript
// docx-js
page: {
  size: { width: 11906, height: 16838 },
  margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
}
```

## 二、字体体系（四层，全部用方正系列）

| 层级 | 字体 | 字号(pt) | DXA | 粗体 | 对齐 | 额外 |
|------|------|---------|-----|------|------|------|
| 主标题 | **方正小标宋_GBK** | 44(二号) | 88 | 否 | 居中 | spacing=95, kern=2 |
| 副标题 | **方正小标宋_GBK** | 40 | 80 | 否 | 居中 | spacing=95, kern=2 |
| 单位/日期 | **楷体** | 36(小二号) | 72 | 否 | 居中 | — |
| 一级标题 | **方正黑体_GBK** | 36(小二号) | 72 | 否 | 两端 | indent firstLine=720 |
| 正文 | **方正仿宋_GBK** | 36(小二号) | 72 | 否 | 两端 | indent firstLine=720 |
| 英文数字 | Times New Roman | 36 | 72 | — | — | 嵌入中文段落 |

> ⚠️ **不是系统自带的「黑体」「仿宋_GB2312」**，必须用方正系列。

## 三、行距（整篇统一固定值）

```javascript
// 所有段落（含标题、正文、空行）统一：
spacing: { line: 600, lineRule: "exact" }
```

换算：600 DXA / 20 = 30磅固定行距。不要用 auto 模式的 1.5 倍行距。

## 四、缩进与对齐

| 参数 | 值 |
|------|-----|
| 正文首行缩进 | `firstLine: 720` (恰好2个中文字符) |
| 一级标题首行缩进 | `firstLine: 720` |
| 正文对齐方式 | `BOTH` (两端对齐) |
| 标题/单位对齐 | `CENTER` |

## 五、字符间距微调

仅标题行需要：
```javascript
characterSpacing: 95,   // 字符缩放95%
kerning: 2              // 字偶距微调
```

正文不需要额外设置。

## 六、代码模板

```javascript
// 主标题
new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { line: 600, lineRule: LineRuleType.EXACT },
  children: [new TextRun({
    text: "标题文字",
    font: { eastAsia: "方正小标宋_GBK" },
    size: 88, characterSpacing: 95, kerning: 2
  })]
})

// 正文段落
new Paragraph({
  alignment: AlignmentType.BOTH,
  spacing: { line: 600, lineRule: LineRuleType.EXACT },
  indent: { firstLine: 720 },
  children: [new TextRun({
    text: "正文内容...",
    font: { eastAsia: "方正仿宋_GBK", ascii: "Times New Roman" },
    size: 72
  })]
})

// 一级标题
new Paragraph({
  alignment: AlignmentType.BOTH,
  spacing: { line: 600, lineRule: LineRuleType.EXACT },
  indent: { firstLine: 720 },
  children: [new TextRun({
    text: "一、标题文字",
    font: { eastAsia: "方正黑体_GBK" },
    size: 72
  })]
})
```

## 七、常见错误对照

| ❌ 错误 | ✅ 正确 |
|---------|---------|
| 系统「黑体」 | 方正黑体_GBK |
| 「仿宋_GB2312」 | 方正仿宋_GBK |
| 正文四号(28pt) | 正文小二号(36pt) |
| auto 1.5倍行距 | exact 30磅(600 DXA) |
| 首行缩进随意 | firstLine=720 |
| 标题擅自加粗 | 方正字体本已够粗 |

## 八、内容结构

推荐顺序：**数据 → 机制 → 协同**
- 引子从国务院/国家部委政策要求起笔
- 正文用具体数字说话
