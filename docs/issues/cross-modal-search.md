# 跨模态搜索：文本↔图像检索

## 摘要

gbrain 有一个工作的多模态嵌入管道（Voyage multimodal-3、`embedding_image` 列、已索引的 11K 图像块），但搜索是孤立的：文本查询仅搜索文本嵌入，图像查询不存在。本提案添加了跨模态查询路由，以便文本查询可以显示图像，图像查询可以显示文本，使用 Voyage multimodal-3 的共享嵌入空间。

## 问题

**用户看到的：** 你不能搜索"hackathon 的照片"并获取实际图像。你不能上传照片并问"关于这个人我们知道什么？"文本搜索返回文本。图像嵌入除了通过显式的 `embeddingColumn: 'embedding_image'` 覆盖外未被使用，没有用户面向的路径触发。

**系统做的：**
- 文本查询通过配置的文本模型（OpenAI/ZE）嵌入并搜索文本列
- `embedding_image` 列存在（Voyage multimodal-3，1024d）并有 11,204 个嵌入块和有效的 83 MB HNSW 索引
- `postgres-engine.ts:searchVector()` 支持 `embeddingColumn: 'embedding_image'` 但查询向量必须来自兼容的模型（Voyage multimodal，1024d）
- 目前，`embedQuery()` 始终使用文本嵌入模型，产生 1536d 或 2560d 向量，无法查询 1024d 图像列

**它应该做的：**
1. 检测搜索查询中的跨模态意图（"show me photos of..."、"find images from..."，或显式的图像搜索标志）
2. 通过 Voyage multimodal-3（用于图像嵌入的相同模型）嵌入文本查询
3. 使用多模态查询向量搜索 `embedding_image` 列
4. 返回图像结果连同或代替文本结果
5. 支持图像作为查询：接受图像输入，通过 Voyage multimodal-3 嵌入它，搜索文本嵌入（如果存在共享的多模态列）或图像列

## 证据

### 图像嵌入存在并被索引

```sql
-- 生产状态（2026 年 5 月）
SELECT COUNT(*) FROM content_chunks WHERE embedding_image IS NOT NULL;
-- 11,204

SELECT indexrelid::regclass, indisvalid, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_index WHERE indrelid = 'content_chunks'::regclass
AND indexrelid::regclass::text LIKE '%image%';
-- idx_chunks_embedding_image | true | 83 MB
```

### 模态元数据损坏

```sql
SELECT COUNT(*) FROM content_chunks WHERE modality = 'image';
-- 10（应该是 ~11,204）
```

大多数图像块的 `embedding_image IS NOT NULL` 但 `modality` 未设置为 `'image'`。这是 v0.27.1 迁移的回填缺口。

### Voyage multimodal-3 按设计是跨模态的

来自 Voyage 文档：voyage-multimodal-3 将文本、图像和交错的文本+图像编码到相同的 1024 维向量空间中。通过此模型嵌入的文本查询可以找到相关图像，反之亦然。gbrain 已经将它用于图像列，但从未用于查询嵌入。

### 搜索路由是仅文本的

`hybrid.ts` 约第 414 行：
```typescript
const embeddings = await Promise.all(queries.map(q => embedQuery(q)));
```

`embedQuery()` 始终使用全局文本模型。不存在通过多模态模型嵌入文本查询以进行跨模态搜索的路径。

## 提议的修复

### 阶段 1：文本 → 图像搜索

**1. 跨模态意图检测**（新文件：`src/core/search/cross-modal.ts`）

添加一个轻量级意图分类器，检测查询何时寻找图像：

```typescript
function detectCrossModalIntent(query: string): 'text' | 'image' | 'both' {
  // 显式图像模式
  const imagePatterns = [
    /\b(show|find|get)\s+(me\s+)?(photos?|images?|pictures?|screenshots?)/i,
    /\bwhat\s+does\s+.+\s+look\s+like/i,
    /\b(whiteboard|diagram|slide|screenshot)\b/i,
    /\bphoto(s)?\s+(of|from|at|with)\b/i,
  ];
  if (imagePatterns.some(p => p.test(query))) return 'image';
  return 'text'; // 默认：仅文本
}
```

**2. 多模态查询嵌入**（扩展 `embedding.ts`）

添加 `embedQueryMultimodal(text: string): Promise<Float32Array>`，通过配置的多模态模型（Voyage multimodal-3）而不是文本模型路由。

```typescript
export async function embedQueryMultimodal(text: string): Promise<Float32Array> {
  // 使用多模态提供商，而不是文本提供商
  return gatewayEmbedQuery(text, { provider: cfg.embedding_multimodal_model });
}
```

**3. 混合搜索路由**（扩展 `hybrid.ts`）

当检测到跨模态意图时：
- 通过多模态模型（Voyage multimodal-3，1024d）嵌入查询
- 搜索 `embedding_image` 列
- 返回带有 `modality: 'image'` 标签的结果
- 如果意图是 `'both'`：运行文本搜索和图像搜索，与 RRF 合并

**4. SearchOpts 扩展**（扩展 `types.ts`）

```typescript
interface SearchOpts {
  // ... 现有字段
  crossModal?: 'text' | 'image' | 'both' | 'auto';  // 默认：'auto'（意图检测）
}
```

### 阶段 2：图像 → 文本搜索（未来）

接受图像缓冲区/URL 作为搜索输入。通过 Voyage multimodal-3 嵌入。搜索文本嵌入。这需要一个新的搜索入口点（`searchByImage`）和 MCP 工具暴露。推迟到后续 PR。

### 阶段 3：统一多模态列（未来）

通过 Voyage multimodal-3 将所有内容（文本 + 图像）嵌入到单个列中。这创建了一个真正统一的搜索空间，但使嵌入成本加倍，并且需要重新嵌入所有文本。在阶段 1 结果后评估。

## 回填：修复模态元数据

在跨模态搜索有用之前，修复模态列：

```sql
-- 具有图像嵌入但模态错误的块
UPDATE content_chunks
SET modality = 'image'
WHERE embedding_image IS NOT NULL AND (modality IS NULL OR modality != 'image');
```

这是阶段 1 的先决条件，因为结果显示需要知道哪些块是图像。

## 测试指导

### 红色测试（修复前应失败，修复后应通过）

1. **意图检测：** `detectCrossModalIntent("show me photos from the hackathon")` 返回 `'image'`。
2. **意图检测负例：** `detectCrossModalIntent("what is founder mode?")` 返回 `'text'`。
3. **多模态嵌入路由：** `embedQueryMultimodal("hackathon")` 返回 1024d 向量（Voyage multimodal 维度），而不是 1536d 或 2560d。
4. **跨模态搜索：** `hybridSearch("show me hackathon photos", { crossModal: 'image' })` 从 `embedding_image` 列返回结果。
5. **默认行为不变：** `hybridSearch("what is founder mode?")` 像以前一样返回文本结果（除非检测到，否则没有跨模态）。
6. **显式覆盖：** `hybridSearch("anything", { crossModal: 'image' })` 强制图像搜索，无论意图检测如何。

### 边缘情况

- 查询匹配图像意图但该主题没有图像嵌入：返回空图像结果，回退到文本。
- 多模态模型未配置：跳过跨模态，记录警告，返回文本结果。
- 混合结果（'both' 模式）：合并文本和图像结果，每个都标记模态以供显示。

## 相关上下文

- PR #1106 添加动态文本嵌入列选择（先决条件：该 PR 的 `embedding_columns` 注册表和提供商路由使这更容易实现）
- v0.27.1 引入了双列模式（`embedding` + `embedding_image`）
- `postgres-engine.ts` 中的 `importImageFile` 处理图像摄取和多模态嵌入
- Voyage multimodal-3 已在 gbrain 配置中配置为 `embedding_multimodal_model`
- 图像 OCR 管道（`embedding_image_ocr: true`）在嵌入之前从图像中提取文本，因此图像块具有视觉和文本表示

## 分阶段

| 阶段 | 范围 | 工作量 | 价值 |
|---|---|---|---|
| **1（此 PR）** | 带有意图检测的文本 → 图像搜索 | 中等 | 高 — 解锁"查找照片"查询 |
| 2 | 图像 → 文本搜索（上传照片，查找相关文本） | 中等 | 中等 — 很酷但小众的用例 |
| 3 | 统一多模态列（所有内容在一个空间中） | 大 | 高 — 但昂贵且需要重新嵌入 |
| 先决条件 | 修复模态列回填 | 小 | 阶段 1 需要 |

---
*是 [GBrain 文档](../../README.md) 的一部分。*
