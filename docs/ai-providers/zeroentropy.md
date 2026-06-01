# ZeroEntropy — zembed-1 + zerank-2

[ZeroEntropy](https://zeroentropy.dev) 提供两个专门用于
检索管道的小型模型：

- **`zembed-1`** — 从 zerank-2 蒸馏的多语言嵌入。
  灵活的 Matryoshka 维度 (2560/1280/640/320/160/80/40)，32K 上下文，
  非对称 `input_type: query|document` 编码。$0.025/1M token
  （促销价）/ $0.05 常规价。
- **`zerank-2`** — SOTA 多语言交叉编码器重排序器。
  $0.025/1M token（比 Cohere/Voyage 重排序器便宜约 50%）。
  另外还有 `zerank-1` 和 `zerank-1-small` 用于旧版 / 开源需求。

两者都在 gbrain v0.35.0.0 中通过开放式 AI 兼容的配方路径落地，
与 OpenAI 和 Voyage 并列。

## 设置

1. 在 [dashboard.zeroentropy.dev](https://dashboard.zeroentropy.dev) 获取 API 密钥。
2. 导出它：
   ```bash
   export ZEROENTROPY_API_KEY=<your-key>
   ```

## 嵌入切换 — zembed-1

**重要提示：** `gbrain config set embedding_model …` 不是
实时网关切换。`embedding_model` 和 `embedding_dimensions` 会调整
schema，并且必须在引擎连接之间保持稳定，因此它们只从
**文件平面**（`~/.gbrain/config.json`）和 **环境变量平面**
（`GBRAIN_EMBEDDING_MODEL` / `GBRAIN_EMBEDDING_DIMENSIONS`）解析。对于这两个键，数据库平面
被有意忽略（与当今的 Voyage 设置姿态相同）。

### 选项 A — 文件平面（推荐用于稳定安装）

编辑 `~/.gbrain/config.json`：

```json
{
  "embedding_model": "zeroentropyai:zembed-1",
  "embedding_dimensions": 2560
}
```

有效维度：`2560`（默认）、`1280`、`640`、`320`、`160`、`80`、`40`。
Matryoshka 风格 — 较小的维度会单调地权衡质量以换取存储。
选择适合你列宽的最大维度。

### 选项 B — 环境变量平面（CI / Docker）

```bash
export GBRAIN_EMBEDDING_MODEL=zeroentropyai:zembed-1
export GBRAIN_EMBEDDING_DIMENSIONS=2560
```

### 重新嵌入

切换嵌入模型会使向量索引失效。重新嵌入：

```bash
gbrain embed --stale --limit 50    # 先小规模测试
gbrain embed --stale               # 完整重新嵌入
```

### 验证

```bash
gbrain models doctor --json | jq '.probes[] | select(.touchpoint=="embedding_config")'
```

预期：`status: "ok"`。无效维度（例如 `1024`、`1536`、`3072`）
会显示为 `status: "config"`，并带有可直接粘贴的
`gbrain config set embedding_dimensions <2560|1280|640|320|160|80|40>` 修复提示。

## 重排序器切换 — zerank-2

重排序器是更重要的部分：gbrain 在 v0.35.0.0 之前没有交叉编码器重排序器
阶段。它位于混合搜索中 RRF 去重和 token 预算
强制执行之间。

### 默认启用（使用 `tokenmax` 模式）

`tokenmax` 模式现在默认 `search.reranker.enabled = true`，使用
`zerank-2`。如果你已经使用 `tokenmax` 并且设置了 `ZEROENTROPY_API_KEY`，
重排序器会自动触发。没有密钥时，每次重排序调用
都会失败开放（记录到审计日志）并且搜索返回 RRF 顺序 — 与
之前相同的用户体验，只是在 `gbrain doctor` 中会显示一个可观察的失败。

### 在 `conservative` 或 `balanced` 模式中选择加入

```bash
gbrain config set search.reranker.enabled true
```

覆盖位于模式包默认值之上；选择退出只需一次翻转。

### 成本锚定

30 个候选 × ~400 token/块 × $0.025/1M = **约 $0.0003/查询**。
根据 CLAUDE.md 成本矩阵，在单用户量下，
与 `tokenmax + Opus` 配对的约 $700/月相比，这是舍入误差。

### 验证

```bash
gbrain models doctor --json | jq '.probes[] | select(.touchpoint=="reranker_config")'
```

为重排序器运行两个探测：

- `reranker_config`（零网络）— 验证模型通过
  配方注册表解析并且在端点的允许列表中。
- 可达性探测发送一个最小化的 `{query: "probe", documents:
  ["probe"]}` 重排序以验证认证 + URL。

## 旋钮参考

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `search.reranker.enabled` | `tokenmax` 为 `true`，其他为 `false` | 一键选择加入/退出 |
| `search.reranker.model` | `zeroentropyai:zerank-2` | 尝试 `zerank-1`（较旧的 SOTA）或 `zerank-1-small`（Apache-2.0 开源） |
| `search.reranker.top_n_in` | `30` | 发送到重排序器的候选数（限制 API 支出） |
| `search.reranker.top_n_out` | `null`（不截断） | 将重排序后的输出截断到此数量；`null` 保留完整长度 |
| `search.reranker.timeout_ms` | `5000` | HTTP 超时；长时间的停滞比 RRF 回退更损害用户体验 |

## 失败可观察性

重排序器在构造上是失败开放的：每个错误类别（认证、速率限制、
网络、超时、负载过大、未知）都会返回原始 RRF
顺序不变。失败记录到
`~/.gbrain/audit/rerank-failures-YYYY-Www.jsonl`（ISO 周轮换）。

`gbrain doctor` 读取审计并显露：

- **认证失败** — 任何一个都会警告（配置时问题，doctor 的
  自身探测应该已经捕获）
- **负载过大** — 任何一个都会警告（工作负载不匹配信号）
- **瞬时（网络/超时/速率限制）** — 7 天内 >=5 次时警告

查询文本在审计中进行 SHA-256 哈希；永远不会以原始形式记录。

## 非对称 input_type

ZE zembed-1（和 Voyage v3+）使用非对称查询/文档编码以获得
更好的检索效果。网关的 `embedQuery(text)` 配套方法传递
`input_type: 'query'`；标准 `embed(texts)` 默认为
`'document'`。混合搜索的两个查询侧嵌入位置自动使用
`embedQuery()`；所有摄取路径使用 `embed()`。

对称提供程序（OpenAI text-embedding-3、固定维度 Voyage 模型）
忽略此字段 — 行为不变。

## 缓存键版本控制

v0.35.0.0 将 `KNOBS_HASH_VERSION` 从 1 提升到 2，以将重排序器配置
折叠到 `query_cache.knobs_hash` 列中。在滚动部署期间：

- 预期缓存命中率暂时下降（约 1 小时，默认
  `cache.ttl_seconds = 3600s`）
- 热查询可能会短暂地使其缓存行计数加倍（每个
  版本一行）

两者都会自然清除；不需要操作员操作。

## 故障排除

| 症状 | 可能原因 | 修复 |
|---|---|---|
| `embedding_config` 探测显示无效维度 | 默认为 1536（OpenAI 默认值） | 将 `embedding_dimensions` 设置为 2560/1280/640/320/160/80/40 之一 |
| `reranker_config` 探测显示模型不在允许列表中 | `search.reranker.model` 中有拼写错误 | 使用 `zerank-2` / `zerank-1` / `zerank-1-small` 之一 |
| `reranker_health` doctor 警告认证问题 | 未设置或无效 `ZEROENTROPY_API_KEY` | 重新导出环境变量；运行 `gbrain models doctor` 以验证 |
| `reranker_health` doctor 警告瞬时失败 | 上游故障或速率限制 | 重排序器失败开放到 RRF；如果持续存在，请检查 ZE 状态页面 |
| 升级后缓存命中率下降 | 滚动部署期间预期 | 在 `cache.ttl_seconds`（默认 3600 秒）内清除 |
