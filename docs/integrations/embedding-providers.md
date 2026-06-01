# 嵌入提供商

GBrain 附带 16 个嵌入提供商配方，涵盖 OpenAI、ZeroEntropy、Voyage、OpenRouter（单个密钥，许多托管模型）、主要的托管替代方案、三个本地选项和一个通用逃生舱口（LiteLLM 代理）。运行 `gbrain providers list` 查看实时注册表；`gbrain providers explain --json` 为 agent 发出机器可读的矩阵。

本页面是人类可读的对应部分：每个提供商的功能、环境变量设置、维度、成本和已知约束。

## 快速开始

```
gbrain providers list                          # 查看所有提供商
gbrain providers env <provider-id>             # 查看所需环境变量
gbrain providers test --model openai:text-embedding-3-large   # 冒烟测试
gbrain init --pglite --model voyage            # 使用非默认提供商
```

## Init 从环境变量解析你的提供商

从 v0.37 开始，`gbrain init --pglite` 从你的环境变量自动检测要使用哪个提供商。设置了 `OPENAI_API_KEY`，你就得到 OpenAI。设置了 `ZEROENTROPY_API_KEY`，你就得到 ZeroEntropy。如果设置了多个提供商密钥，init 会触发交互式选择器。如果在非 TTY 上下文中没有设置提供商密钥（CI、Docker 构建），init 以退出码 1 退出，并附上可粘贴的设置提示。显式标志（`--embedding-model`、`--no-embedding`）始终胜过环境变量检测。

解析后的提供商 + 维度会自动原子地持久化到 `~/.gbrain/config.json`，因此后续运行在版本之间是具有确定性的。

## 太长不看表格

| 提供商 | 环境变量 | 默认维度 | 成本（$/1M tokens） | 本地？ | 多模态？ |
|---|---|---|---|---|---|
| `zeroentropyai` | `ZEROENTROPY_API_KEY` | 2560（Matryoshka 到 1280/640/320/...） | 0.05 | 否 | 否 |
| `openai` | `OPENAI_API_KEY` | 1536 | 0.13 | 否 | 否 |
| `openrouter` | `OPENROUTER_API_KEY` | 1536 | 0.02 | 否 | 取决于模型 |
| `voyage` | `VOYAGE_API_KEY` | 1024 | 0.18 | 否 | 是（`voyage-multimodal-3`） |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | 768 | 0.025 | 否 | 否 |
| `azure-openai` | `AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_ENDPOINT`、`AZURE_OPENAI_DEPLOYMENT` | 1536 | 0.13 | 否 | 否 |
| `minimax` | `MINIMAX_API_KEY` | 1536 | 0.07 | 否 | 否 |
| `dashscope` | `DASHSCOPE_API_KEY` | 1024 |  vary | 否 | 否 |
| `zhipu` | `ZHIPUAI_API_KEY` | 1024 |  vary | 否 | 否 |
| `ollama` |（无 — 本地运行） | 768 | 0 | 是 | 否 |
| `llama-server` |（无 — 本地运行） | 用户设置 | 0 | 是 | 否 |
| `litellm` | `LITELLM_API_KEY`（可选） | 用户设置 |  vary | 是（代理） | 否 |
| `together` | `TOGETHER_API_KEY` | 768 |  vary | 否 | 否 |
| `anthropic` |（无嵌入模型 — 仅聊天） | — | — | — | — |
| `deepseek` |（无嵌入模型 — 仅聊天） | — | — | — | — |
| `groq` |（无嵌入模型 — 仅聊天） | — | — | — | — |

**关于本地提供商的说明。** Ollama 和 llama-server 没有必需的 API 密钥，因此它们不会出现在环境变量检测自动选择中。使用 `--embedding-model ollama:<model>` 显式选择它们，以避免静默路由到可能未运行的守护程序。

## 如果首次导入失败

如果 `gbrain import` 失败并显示 `expected N dimensions, not M`，运行 `gbrain doctor`。输出将打印确切的 `gbrain config set ...` 或 `gbrain retrieval-upgrade` 命令来修复不匹配。**你不需要删除 `~/.gbrain`。** 历史上迫使 `rm -rf` 恢复的 bug 类从 v0.37 开始已关闭。

Doctor 区分两个修复路径：

- **空 brain**（尚未有嵌入块）— 以正确的维度删除并重新初始化：
  ```
  gbrain init --force --pglite --embedding-model <provider>:<model> --embedding-dimensions <N>
  ```

- **非空 brain** — 使用支持的重新索引路径干净地迁移：
  ```
  gbrain retrieval-upgrade --to <provider>:<model> --reindex
  ```

## 决策树

- **成本敏感，仅英文**：Ollama（免费，本地）或 Voyage（付费，每美元质量最佳）。
- **质量优先**：Voyage `voyage-4-large`（1024-2048 维度，比 OpenAI tiktoken 密约 3-4 倍）。
- **代码密集的 brain（gstack 每工作树，源代码仓库）**：Voyage `voyage-code-3`（1024 默认；支持 256/512/1024/2048）。在编程语言上调整。Voyage 发布了头对头数字，显示它在代码检索上优于他们的一般旗舰产品（[voyageai.com/blog](https://voyageai.com/blog)）。对于 gstack 的每工作树 pglite 支持的代码 brain，这是正确的默认设置 — 请参阅 `docs/architecture/topologies.md` 中的拓扑 3。
- **重排序对**：ZeroEntropy `zerank-2` 是 `tokenmax` 模式中的托管默认值（请参阅 [`docs/ai-providers/zeroentropy.md`](../ai-providers/zeroentropy.md)）。Voyage `rerank-2.5` 与 Voyage 嵌入干净地配对。
- **本地重排序（无 API 支出）**：`llama-server-reranker` 配方（v0.40.6.1）— 将 gbrain 指向你自己的运行 Qwen3-Reranker 或自托管 ZeroEntropy 权重的 `llama-server --reranking` 实例。相同的 `gateway.rerank()` 接缝，每次调用 $0。演练在 [`docs/ai-providers/llama-server-reranker.md`](../ai-providers/llama-server-reranker.md) 中。
- **一个密钥用于许多托管模型**：OpenRouter。设置 `OPENROUTER_API_KEY` 并使用 `openrouter:<provider>/<model>` 针对 GPT-5.2、Claude 4.x、Gemini 3、DeepSeek 和数十个更多进行聊天，而无需杂耍每个提供商的密钥。嵌入目录包括 OpenAI、Google、Qwen、BGE-M3。
- **企业合规性**：Azure OpenAI（数据驻留 + 私有端点）或通过 llama-server / Ollama 自托管。
- **中国区域**：DashScope（阿里巴巴）或 Zhipu（BigModel）。DashScope 在 `dashscope-intl.aliyuncs.com` 的国际端点；为中国端点覆盖 `provider_base_urls.dashscope`。
- **OSS 本地，完全控制**：llama-server（`llama.cpp`）用于任何 GGUF 模型；Ollama 用于精选目录。
- **其他任何**：LiteLLM 代理。在 any provider（Bedrock、Vertex、Cohere、Jina、Fireworks 等）前面运行 LiteLLM，并通过 `LITELLM_BASE_URL` 将 gbrain 指向它。

## 每个提供商的详细信息

### OpenAI

默认。设置 `OPENAI_API_KEY`。模型：`text-embedding-3-large`（3072 最大，1536 默认）、`text-embedding-3-small`（1536）。通过 `dimensions` 字段的 Matryoshka — gbrain 从 `embedding_dimensions` 配置固定它，因此现有的 1536 维 brain 在 SDK 升级中保持对齐。

### Voyage AI

Voyage 4 系列中同类最佳质量（2026 年 1 月发布）。设置 `VOYAGE_API_KEY`。模型：`voyage-4-large`、`voyage-4`、`voyage-4-lite`、`voyage-4-nano`、`voyage-3.5`、`voyage-code-3`（代码调整）、`voyage-finance-2`、`voyage-law-2`、`voyage-multimodal-3`（文本 + 图像）。

Voyage 4 系列在所有变体之间共享嵌入空间，因此你可以使用 `voyage-4-large` 索引并使用 `voyage-4-lite` 查询而无需重新索引。维度：256、512、1024、2048。**2048 超过 pgvector 的 HNSW 上限 2000** — 那些 brain 回退到精确向量扫描（仍然正确，只是较慢）。

**对于索引源代码的 brain**（gstack 的每工作树 pglite 支持的代码 brain — 请参阅 `docs/architecture/topologies.md` 中的拓扑 3），首选 `voyage-code-3` 而不是 `voyage-4-large`。Voyage 在编程语言上调整它，并发布了与它们在代码检索上的一般旗舰产品的头对头数字。在安装时配置：

```bash
gbrain init --pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
```

要切换现有 brain，请使用 `gbrain reinit-pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024`（PGLite）或遵循 `docs/embedding-migrations.md`（Postgres）。`gbrain config set embedding_model` 被拒绝 — schema 列必须调整大小。

`gbrain reindex --code` 将在针对配置的嵌入模型未经代码调整的 brain 运行时打印建议；如果你故意选择了另一个模型（单一供应商采购、合规性等），使用 `GBRAIN_NO_CODE_MODEL_NUDGE=1` 抑制。

### Google Gemini

设置 `GOOGLE_GENERATIVE_AI_API_KEY`（AI Studio 公共 API 密钥）。模型：`gemini-embedding-001`。默认 768 维度；Matryoshka 高达 3072。便宜。

对于 GCP 服务帐户 / Vertex AI 身份验证（生产部署），请参阅 v0.32.x 后续 — Vertex ADC 在路线图上。

### OpenRouter

用于扇出到 OpenAI、Anthropic、Google、DeepSeek、Meta Llama、Qwen 和数十个其他托管提供商的单个 OpenAI 兼容 API。一个密钥，许多模型。设置 `OPENROUTER_API_KEY` 并使用 `openrouter:<provider>/<model>`（例如 `openrouter:openai/gpt-5.2`、`openrouter:anthropic/claude-sonnet-4.6`）。

**嵌入**：`openai/text-embedding-3-small`（1536d 默认，Matryoshka 缩小到 512/768/1024）。OR 的嵌入目录还包括 `text-embedding-3-large`、`google/gemini-embedding-2-preview`、`qwen/qwen3-embedding-8b`、`bge-m3` — 通过 `--embedding-model openrouter:<id>` 选择加入。定价与上游提供商匹配（OR 添加小额加价）。

**聊天**：每个聊天模型 OR 代理通过 `/v1/chat/completions` 工作。配方列出了 8 个精选入口点（GPT-5.2 系列、Claude 4.5/4.6/4.7、Gemini 3 Flash Preview、DeepSeek）；任何其他的 OR 目录 ID 也有效。工具调用信封受 OR 端点支持，但每个模型的能力各不相同 — 在依赖特定 slug 的工具之前，请查看 https://openrouter.ai/models。

**可选环境变量**：
- `OPENROUTER_BASE_URL` — 指向自托管的 OR 兼容代理。
- `OPENROUTER_REFERER`（默认 `https://gbrain.ai`）和 `OPENROUTER_TITLE`（默认 `gbrain`）— OR 排行榜的归属标头。在不同 agent 堆栈（OpenClaw 部署等）内运行 gbrain 的分叉应该设置这些，以便他们的流量归因于他们，而不是 gbrain。

**子代理循环**：gbrain 的子代理基础设施硬连接到 Anthropic 直连（崩溃/重放中的稳定 `tool_use_id`）。无论配方标志如何，在提交时拒绝 OR 路由的 Anthropic。如果你想要 OR 为工具调用提供的价格/可用性故事，请仅将其用于聊天，并为子代理工作保留 Anthropic 密钥。

### Azure OpenAI

Azure 租户背后的企业 OpenAI。所需环境变量：`AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_ENDPOINT`（例如 `https://my-resource.openai.azure.com`）、`AZURE_OPENAI_DEPLOYMENT`（你的 Azure 门户中的部署名称）。可选：`AZURE_OPENAI_API_VERSION`（默认为 `2024-10-21`）。

与香草 OpenAI 不同，Azure 使用 `api-key:` 标头（不是 `Authorization: Bearer`）和带有 `?api-version=` 查询参数的模板化 URL — gbrain 通过配方的 resolveAuth + resolveOpenAICompatConfig 覆盖处理这两者。

模型：`text-embedding-3-large`、`text-embedding-3-small`、`text-embedding-ada-002`（你的 Azure 部署必须提供请求的模型）。

### MiniMax（海螺 AI）

设置 `MINIMAX_API_KEY`。可选 `MINIMAX_GROUP_ID` 用于组织范围的企业帐户。模型：`embo-01`（1536 维度）。

MiniMax 的 API 采用 `type: 'db' | 'query'` 字段进行非对称检索。v0.32 将所有内容路由为 `type='db'`（对称检索 — 索引和查询的相同向量空间）。非对称查询支持是 v0.32.x 后续。

### DashScope（阿里巴巴）

设置 `DASHSCOPE_API_KEY`。默认在 `dashscope-intl.aliyuncs.com` 的国际端点；为中国端点覆盖 `provider_base_urls.dashscope`。模型：`text-embedding-v3`（当前；Matryoshka 64-1024 维度）、`text-embedding-v2`。

CJK 主导的内容标记化比 OpenAI tiktoken 更密集；gbrain 声明 `chars_per_token: 2`，因此批次预拆分留下余量。

### Zhipu AI（BigModel）

设置 `ZHIPUAI_API_KEY`。模型：`embedding-3`（当前；Matryoshka 256-2048 维度）、`embedding-2`。v0.32 默认为 1024（HNSW 兼容）。2048 维选项有效，但落入精确扫描分支（请参阅上面的 Voyage 4 Large 注释）。

### Ollama（本地）

无需环境变量 — Ollama 在本地未经身份验证运行。可选 `OLLAMA_BASE_URL`（默认 `http://localhost:11434/v1`）和 `OLLAMA_API_KEY`（用于启用身份验证的部署）。

配方附带 `nomic-embed-text`（768d，推荐）、`mxbai-embed-large`（1024d）、`all-minilm`（384d）。`gbrain providers test --model ollama:nomic-embed-text` 冒烟测试本地安装。

### llama-server（本地，llama.cpp）

`llama.cpp` 的 `llama-server --embeddings` 端点。无需环境变量。可选 `LLAMA_SERVER_BASE_URL`（默认 `http://localhost:8080/v1`）和 `LLAMA_SERVER_API_KEY`。

用户驱动的模型：使用 `--model <gguf-path> --embeddings` 启动 llama-server，然后运行 `gbrain init --embedding-model llama-server:<your-id> --embedding-dimensions <N>`。配方拒绝隐式简写 `--model llama-server`，因为没有规范的第一模型。

### LiteLLM 代理（通用逃生舱口）

在 any provider 前面运行 [LiteLLM](https://docs.litellm.ai/docs/proxy/quick_start) — Bedrock、Vertex、Cohere、Jina、Fireworks、OctoAI 等。代理将所有内容规范化为 OpenAI 兼容的 API；gbrain 通过 `LITELLM_BASE_URL` 指向代理并代理调用。

这是"我的提供商不在上面的列表中"的包罗万象。设置 LiteLLM，然后 `gbrain init --embedding-model litellm:<your-model-id> --embedding-dimensions <N>`。

## 选择维度

三个数字很重要：
1. **提供商的原生维度**：每个模型都有一个"真实"输出维度（例如 OpenAI `text-embedding-3-large` 是 3072 原生）。
2. **Matryoshka 缩减**：大多数现代提供商允许你通过 `dimensions` 字段请求较小的向量。
3. **HNSW 上限**：pgvector 的 HNSW 索引最多支持 2000 维度。高于此的 Brain 回退到精确向量扫描（较慢但正确；gbrain 通过 `src/core/vector-index.ts` 中的 `chunkEmbeddingIndexSql` 自动处理 SQL）。

对于大多数用户：**保持在 1024 或 1536**。在噪声地板以下，更大并不是更好；在 Matryoshka 提供商上，较小会节省磁盘 + RAM，而召回损失边际。

## 我的提供商未列出

四个选项：

1. **使用 OpenRouter**，当提供商/模型可通过 OR 的 OpenAI 兼容 API 获得时（涵盖大多数托管聊天模型 + 不断增长的嵌入目录）。
2. **使用 LiteLLM 代理**（ above）— 通用逃生舱口。适用于 100+ 提供商。
3. **打开功能请求**，网址为 [github.com/garrytan/gbrain/issues](https://github.com/garrytan/gbrain/issues)，附上提供商的 API 文档 URL 和设置片段。配方约为 30-40 行 TypeScript。
4. **提交配方**：克隆，复制 `src/core/ai/recipes/voyage.ts` 作为黄金标准 openai-compat 模板，在 `src/core/ai/recipes/index.ts` 中注册，在 `test/ai/recipe-<name>.test.ts` 下添加每配方冒烟测试。配方契约测试（`test/ai/recipes-contract.test.ts`）和 IRON RULE 回归测试固定结构不变量。

## 在现有 brain 上切换提供商

嵌入维度在 `gbrain init` 时烘焙到 schema 中。从 v0.37.11.0 开始，`gbrain config set embedding_model` 和 `gbrain config set embedding_dimensions` 被拒绝 — schema 列必须随配置一起调整大小，而 `config set` 仅触及配置行。

支持的路径：

- **PGLite（默认安装）**：`gbrain reinit-pglite --embedding-model <provider>:<model> --embedding-dimensions <N>` — 一键擦除并重新初始化，保留所有其他配置字段（聊天模型、扩展模型、API 密钥），将先前的 brain 备份到 `<path>.bak`，使用新标志运行 `gbrain init`，并重新同步你的 brain 仓库。添加 `--no-sync` 以跳过重新同步，`--yes` 以跳过 TTY 确认，`--json` 以用于脚本。
- **Postgres（Supabase / 自托管）**：遵循 `docs/embedding-migrations.md` 中的 SQL 配方（删除 HNSW 索引、ALTER COLUMN TYPE、清除陈旧嵌入、有条件地重新创建索引，然后 `gbrain init --supabase --embedding-model X --embedding-dimensions N` 以更新文件平面并重新嵌入）。

`gbrain doctor` 8c "alternative_providers" 显示环境变量已设置但未配置的提供商 — 当你已配置 OpenAI 但还导出了例如 `VOYAGE_API_KEY` 并想知道你可以在不进行额外设置的情况下切换时很有用。

---
*是 [GBrain 文档](../../README.md) 的一部分。*
