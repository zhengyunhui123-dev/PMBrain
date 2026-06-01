# llama-server 重排序器（本地）— Qwen3-Reranker、自托管 ZE、任意 ZE 线格式的提供程序

[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
是 llama.cpp 自带的 HTTP 包装器。通过 `--reranking` 参数，它会
暴露一个 OpenAI 风格的 `POST /v1/rerank` 端点，返回
`{results: [{index, relevance_score}]}` — 这正是 gbrain
已经为 ZeroEntropy 托管重排序器使用的线格式。
`llama-server-reranker` 配方（在 v0.40.6.1 中添加）将
`gateway.rerank()` 路由到你的本地 llama.cpp 实例，而不是 ZE。

本配方涵盖两种"本地"风格：

- **Qwen3-Reranker** (0.6B / 4B / 8B) — 开放权重交叉编码器；从
  HuggingFace 拉取 GGUF 并提供服务。
- **自托管 ZeroEntropy** (`zerank-2`、`zerank-1-small`) —
  权重也在 HuggingFace 上。将其转换为 GGUF 并以
  相同方式提供服务。**质量不保证与 ZE 托管的匹配：** GGUF
  转换 + 量化 + 池化/排序元数据 + 分词器特殊
  令牌都会影响分数。如果你为生产检索
  自托管 ZE，请固定你自己的大脑相关评估（
  [docs/eval-bench.md](../eval-bench.md)）作为回归保障。

本配方是路径覆盖 + 配方格式。任何
请求/响应线格式与 ZE/llama.cpp 匹配的提供程序都可以通过
指向不同的基础 URL 来使用它。线格式不同的提供程序（Voyage 使用
`top_k` 而不是 `top_n`，返回 `data[]` 而不是 `results[]`）需要单独的
带有适配器钩子的配方 — 这会在后续计划中落地。

## 设置

### 1. 构建 llama.cpp（或下载发布版本）

```bash
# 克隆并构建（仅 CPU；为 GPU 添加 `-DGGML_CUDA=ON`）
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
cmake -B build
cmake --build build --config Release -j
```

部署时固定特定提交 — `llama-server` 的路径别名
（`/rerank`、`/v1/rerank`、`/reranking`、`/v1/reranking`）在不同
版本间有变化。本配方发送到 `/v1/rerank`。

### 2. 拉取重排序器 GGUF

对于 Qwen3-Reranker-4B（量化版 Q4_K_M 是 CPU 的最佳选择）：

```bash
# 选择量化级别 — Q4_K_M 是通常的 CPU 最佳选择。
huggingface-cli download \
  Qwen/Qwen3-Reranker-4B-GGUF qwen3-reranker-4b-q4_k_m.gguf \
  --local-dir ./models
```

对于自托管 ZeroEntropy 权重，找一个社区 GGUF 转换版本
或者自己从 HuggingFace 权重转换（超出本文档范围 —
参见 llama.cpp 的 `convert_hf_to_gguf.py`）。

### 3. 使用 --reranking 和 --alias 启动 llama-server

```bash
./build/bin/llama-server \
  --model ./models/qwen3-reranker-4b-q4_k_m.gguf \
  --alias qwen3-reranker-4b \
  --reranking \
  --port 8081
```

`--alias` 很重要：没有它，llama-server 的 `/v1/models`（以及
重排序请求回显的 `model` 字段）默认为完整的 gguf 文件
路径，这会让 gbrain 配置字符串变得丑陋且脆弱。使用
`--alias qwen3-reranker-4b`，你的配置字符串就简短且稳定。

`--reranking` 和 `--embeddings` 在服务器启动时是互斥的。
如果你也通过
[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
配方运行本地嵌入器，请在两个不同的端口上运行两个独立的 llama-server 进程
（通常为 8080 用于嵌入，8081 用于重排序 — gbrain 的默认值
匹配此约定）。

### 4. 在你的服务器上连接 gbrain

```bash
# 将 gbrain 指向 llama.cpp 主机（如果在默认端口上本地运行则跳过）
gbrain config set provider_base_urls.llama-server-reranker http://your-host:8081/v1

# 告诉搜索使用此重排序器
gbrain config set search.reranker.model llama-server-reranker:qwen3-reranker-4b
gbrain config set search.reranker.enabled true
```

冒号后面的 `qwen3-reranker-4b` 是你第 3 步中的 `--alias` 值。
任何字符串都可以，只要它与你的服务器的别名匹配。

环境变量也可以作为上述配置的替代方案：

```bash
export LLAMA_SERVER_RERANKER_BASE_URL=http://your-host:8081/v1
# 可选：如果你用 nginx + bearer 认证为 llama-server 设置前端
export LLAMA_SERVER_RERANKER_API_KEY=your-bearer-token
```

### 5. 验证

```bash
gbrain models doctor
# 预期：✔ reranker_config llama-server-reranker:qwen3-reranker-4b ok
#         ✔ reranker_config llama-server-reranker:qwen3-reranker-4b ok (reachability)

gbrain search "some query" --json | jq '.[].rerank_score'
# 预期：每一行都有 rerank_score
```

如果 `gbrain models doctor` 将可达性探测报告为 `network`
状态，两个常见原因：

1. 服务器可达但处于嵌入模式，而不是重排序模式。
   `--reranking` 和 `--embeddings` 在启动时是互斥的 —
   重新启动正确的那个。
2. 配方路径与你安装的 llama.cpp 版本所服务的路径不匹配。
   本配方发送 `/v1/rerank`；较旧的 llama.cpp 安装可能只
   服务 `/rerank`。固定到最新的 llama.cpp 提交。

## 冷启动余量

仅 CPU 的 4B 重排序器首次调用预热可能需要 8-15 秒。
配方声明 `default_timeout_ms: 30000`，因此服务器重启后的
第一次调用不会静默失败开放。除非你覆盖它，否则该值会通过
搜索模式解析流动：

```bash
# 收紧或放宽每次搜索的超时（覆盖配方默认值）：
gbrain config set search.reranker.timeout_ms 60000
```

`SearchOpts.reranker_timeout_ms` 中的每次调用覆盖仍然对任何
单个调用有效。

## 预算上限 + 本地重排序

配方声明 `cost_per_1m_tokens_usd: 0` 并在
预算跟踪器中注册到 `FREE_LOCAL_RERANK_PROVIDERS` 下，因此
配置了本地重排序的 `--max-cost` 受限调用者（自动驾驶循环、批处理作业）不会
硬失败。本地重排序消耗
电力，而不是 API token。

```bash
GBRAIN_MAX_USD=0.01 gbrain search "..." --reranker llama-server-reranker:qwen3-reranker-4b
# 有效：重排序触发，记录为 $0，累积上限未触及。
```

## 保持失败开放契约

`src/core/search/rerank.ts` 中的 `applyReranker` 仍然保持
失败开放姿态：任何错误类别（网络、超时、格式错误的
响应）都会记录到 `~/.gbrain/audit/rerank-failures-*.jsonl` 并
返回原始 RRF 顺序不变。搜索可靠性优于
重排序质量。如果你的 llama.cpp 主机宕机，你的搜索继续
工作 — 它们只是停止针对交叉编码器进行重排序，直到你
重新启动服务器。
