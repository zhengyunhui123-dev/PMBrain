# 无头安装：Docker、CI、postinstall

从 v0.37 开始，在非 TTY 上下文中（Docker `RUN`、CI 步骤、postinstall 钩子），当环境中没有 embedding-provider API 密钥时，`gbrain init --pglite` 退出代码 1。这是一种故意的 fail-loud 设计 — 替代方案是 v0.36 的 silent-broken-state 类，其中 init 成功但使用了与任何真实密钥都不匹配的默认值。

两种模式适用于无头安装。选择适合你镜像生命周期的一种：

## 模式 1：构建时可用 provider 密钥

如果你的 CI / Docker pipeline 可以在构建时通过 build-time env var 注入 API 密钥，在 `gbrain init` 之前设置它：

```dockerfile
# 多阶段 Dockerfile 示例
FROM oven/bun:1 AS builder

# 通过 --build-arg 或 `--env` 从 CI 注入密钥。
ARG OPENAI_API_KEY
ENV OPENAI_API_KEY=$OPENAI_API_KEY

RUN bun install -g github:garrytan/gbrain
RUN gbrain init --pglite  # 自动选择 OpenAI，持久化配置
```

```yaml
# GitHub Actions 等效
- name: Initialize gbrain
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    bun install -g github:garrytan/gbrain
    gbrain init --pglite
```

Init 将解析的 `embedding_model` + `embedding_dimensions` 写入 `~/.gbrain/config.json`。后续运行（在相同镜像 / runner 中）从该配置读取，不会重新解析。

## 模式 2：仅运行时可用 provider 密钥（延迟设置）

如果 API 密钥是运行时秘密（Kubernetes secret、运行时 env 注入、最终用户提供的），在构建时使用 `--no-embedding`，并在容器实际运行时配置 provider：

```dockerfile
FROM oven/bun:1
RUN bun install -g github:garrytan/gbrain

# 在没有 provider 的情况下构建 brain shape — schema 以默认宽度着陆，但不会有实际的 embed callsite 运行，直到运行时配置。
RUN gbrain init --pglite --no-embedding

# 在容器启动时（entrypoint），提供真实的 provider：
ENTRYPOINT ["/bin/sh", "-c", "\
  gbrain config set embedding_model openai:text-embedding-3-large \
  && gbrain init --force --pglite \
  && exec gbrain serve"]
```

`gbrain init --no-embedding` 选择写入 `embedding_disabled: true` 到配置。每个 embed callsite（`gbrain import`、`gbrain embed`、`runEmbedCore` 库入口点）都会检查这一点，并干净地拒绝，并提示 `gbrain config set embedding_model <id>`，而不是继续使用静默默认值。

运行时 `gbrain init --force` 针对现在已填充的 env 重新运行 init 流程，这会：

- 从配置中移除 `embedding_disabled`。
- 通过 env 检测解析 provider。
- 如果 dim 与构建时默认值不同，重新模板化 PGLite schema。

## 什么**不会**工作

```dockerfile
# 不要这样做 — 静默默认值会让你得到 vector(1280) ZE 列
# 和运行时 1536d OpenAI provider，不匹配。
RUN gbrain init --pglite
```

如果你从使用此模式的前 v0.37 镜像升级，`gbrain doctor` 会在升级后首次运行时发现它，并打印可粘贴的修复命令（对于空 brains 使用 `gbrain init --force --embedding-model …`，对于非空 brains 使用 `gbrain retrieval-upgrade --reindex`）。

## 验证无头安装

Init 后，运行 `gbrain doctor --json` 验证状态：

```bash
gbrain doctor --json | jq '.checks[] | select(.name=="embedding_provider")'
```

当满足以下条件时，`embedding_provider` 检查返回 `status: 'ok'`：

- 配置有持久化的 `embedding_model`。
- 配置有持久化的 `embedding_dimensions`。
- 实时 provider probe 返回配置的 dim。
- DB 列宽度匹配。

如果你使用了模式 2 的延迟设置路径，在运行时配置填充之前，检查会显示 `Skipped (no provider credentials)`。这是预期的。
