# 可靠性修复（v0.12.2）

如果你在真正的 Postgres 或 Supabase 上运行 v0.12.0，两个 bug 可能已经损坏了你的 brain 中的数据。v0.12.1 修复了后续代码。
v0.12.2 在 `gbrain doctor` 中添加了检测，并为机械可修复的类添加了独立的 `gbrain repair-jsonb` 命令。PGLite 用户不受影响。

## 什么被损坏了

**JSONB 双重编码。** 四个写入站点使用
`${JSON.stringify(x)}::jsonb` 和 postgres.js，它存储了 JSONB
*字符串字面量*而不是对象。`frontmatter ->> 'key'` 返回 NULL；
GIN 索引无效。受影响：`pages.frontmatter`、
`raw_data.data`、`ingest_log.pages_updated`、`files.metadata`。

**Markdown 正文截断。** `splitBody()` 将 `---` 水平规则
视为正文/时间线分隔符，丢弃第一个规则后的所有内容。
带有多个 `##`/`###` 部分的 Wiki 风格页面在导入时丢失了大部分
内容。

## 检测

```
gbrain doctor
```

报告两个新检查：

- `jsonb_integrity` — 计算每个表的双重编码行数并指向你
  在 `gbrain repair-jsonb`。
- `markdown_body_completeness` — 启发式，页面的 `compiled_truth`
  与 `raw_data.data ->> 'content'` 相比 suspiciously 短。

## 修复

对于 JSONB（机械可修复）：

```
gbrain repair-jsonb
```

运行 `UPDATE <table> SET <col> = (<col>#>>'{}')::jsonb WHERE jsonb_typeof(<col>) = 'string'`
跨越每个受影响的列。幂等。第二次运行报告 0 行。使用
`--dry-run` 预览，`--json` 用于结构化输出。`v0_12_2`
迁移在 `gbrain upgrade` 时自动运行此。

对于截断的 markdown 正文（取决于源）：

```
gbrain sync --force
# 或每页
gbrain import <slug> --force
```

如果你不再有源 markdown 文件，v0.12.2 无法恢复已经丢失的内容。`gbrain doctor` 告诉你哪些页面看起来很短；
你决定是否从源重新导入或接受截断。

## 验证

```
gbrain doctor
```

所有四个 `jsonb_integrity` 行应读取零。`markdown_body_completeness`
应与你对语料库的期望相匹配。

---
*是 [GBrain 文档](../../README.md) 的一部分。*
