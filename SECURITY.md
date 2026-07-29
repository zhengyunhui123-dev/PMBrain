# PMBrain 安全策略

## 报告安全问题

请不要在公开 Issue 中披露未修复的漏洞。使用
[GitHub Private Vulnerability Reporting](https://github.com/zhengyunhui123-dev/PMBrain/security/advisories/new)
提交复现步骤、影响范围、受影响版本和建议修复方式。

PMBrain 主命令是 `pmbrain`；`gbrain` 仅作为旧版兼容别名。安全修复以当前
PMBrain 版本为准，不直接套用上游 GBrain 的版本说明。

## 数据与密钥边界

- PMBrain 默认是本机知识库。原始资料、Wiki、页面和分块不得因升级、模型切换或修复被自动删除。
- `config.json` 可能包含数据库地址、API Key 和管理员 bootstrap token。不要提交到 Git、复制到日志或发给第三方。
- 云端 Chat、Embedding、Reranker 或语音服务会收到对应请求内容；本地 Ollama/llama-server 才能把该阶段保留在本机。
- `--log-full-params` 会记录完整请求参数，只能在受控调试环境短时启用。
- 备份应放在项目或用户配置的 `backups` 目录，并与原始资料分开保存。

## HTTP、OAuth 与管理员入口

- HTTP 服务默认绑定 `127.0.0.1`。需要局域网或公网访问时，必须同时配置反向代理、TLS、防火墙和最小权限凭据。
- OAuth 服务支持预注册客户端；动态客户端注册 DCR 默认关闭，只有显式启用时才开放。
- 管理员 bootstrap token 可通过 `PMBRAIN_ADMIN_BOOTSTRAP_TOKEN` 设置。生产环境应避免把 bootstrap token 输出到日志。
- Cookie 使用 HttpOnly、SameSite 等浏览器保护；生产环境必须通过 HTTPS 才能获得完整传输保护。
- 远程调用不仅受 read/write/admin 权限约束，还受 Source 范围、federated read 和 `localOnly` 限制。不要给客户端超出任务需要的 Source。
- 当前 `/token` 和管理员 magic-link 入口有独立限流。不要假设所有 `/mcp` 请求都已有相同的正文上限或双桶限流；部署方仍需在反向代理层设置请求大小、频率和超时限制。

环境变量优先使用 `PMBRAIN_*`。`GBRAIN_*` 仅用于兼容旧安装，不能同时设置互相冲突的两组变量。

## Embedding 安全契约

PMBrain 不提供默认向量模型。

1. 只有同时显式配置 `embedding_model` 和 `embedding_dimensions` 后，导入、同步、Dream 和后台任务才允许生成文本向量。
2. 普通 Chat 模型、DeepSeek/MIMO 等 API Key、Dream 阶段模型都不能自动选择或启用 Embedding。
3. 未配置模型时，PMBrain 只保存原文和分块，并使用关键词、标题、关系等非向量检索能力。
4. 本地 Ollama/llama-server 不可用、凭据缺失、请求失败或维度不符时，必须保留原错误；不得回退到 ZeroEntropy、OpenAI 或其他供应商。
5. 每条非空文本向量必须记录实际生成它的 `provider:model`；没有向量的分块，其模型 provenance 必须为 `NULL`。
6. 环境变量与持久化配置冲突时，写入前停止，不允许静默覆盖桌面端配置。
7. 已有向量与当前模型不一致时停止混写。切换模型和重建向量必须由用户明确确认，只能重建派生向量，不得删除原始资料、页面或分块。
8. 相同维度不代表向量空间兼容；不同模型的向量不能因为维度相同而混用。

## 部署检查

发布或开放网络访问前至少确认：

- 配置文件和备份没有进入版本控制；
- 服务只监听预期网卡，TLS 和代理限制生效；
- OAuth 客户端、API Key 和管理员凭据遵循最小权限；
- 每个客户端只可访问授权 Source；
- 未显式配置 Embedding 的实例没有产生向量请求；
- 日志中没有正文、密钥、数据库密码或 bootstrap token；
- 数据库、配置和原始资料具备可恢复备份。
