---
id: agent-voice
name: Voice Personas (Mars + Venus)
version: 0.1.0
description: WebRTC 优先的语音代理参考实现（Mars + Venus 角色，可选 Twilio 适配器）。采用 skillpack-as-reference 范式 —— 安装时代理将代码复制到您的主机代理仓库中，成为用户拥有并可修改的代码，而非运行时 gbrain 依赖。
category: voice
install_kind: copy-into-host-repo
requires: []
secrets:
  - name: OPENAI_API_KEY
    description: OpenAI API 密钥（需启用 Realtime API 访问权限）
    where: https://platform.openai.com/api-keys — 点击"+ Create new secret key"，立即复制
  - name: TWILIO_ACCOUNT_SID
    description: （可选）Twilio 账户 SID —— 仅当需要接入 Twilio 来电时使用
    where: https://www.twilio.com/console
  - name: TWILIO_AUTH_TOKEN
    description: （可选）Twilio 认证令牌 —— 仅当需要接入 Twilio 来电时使用
    where: https://www.twilio.com/console
health_checks:
  - type: env_exists
    var: OPENAI_API_KEY
    label: OPENAI_API_KEY 存在
setup_time: 10 min
cost_estimate: "$0.06-0.24/分钟 OpenAI Realtime，可选 $1-2/月 Twilio 号码"
---

# 语音角色：Mars + Venus

一个参考级语音代理（WebRTC 优先；OpenAI Realtime）以**复制到您的仓库**的方式提供，而非运行时 gbrain skill。安装时代理读取此配方，将捆绑包复制到您的主机代理仓库（例如 `~/git/your-agent-repo/`），接入解析器，并启动语音服务器。从此，代码存在于**您的仓库中，按您的节奏，由您编辑**。

## 捆绑包内容

- **两个角色** —— Mars（内省思考伙伴；语音 `Orus`）和 Venus（敏锐的执行助理；语音 `Aoede`）。
- **WebRTC 浏览器客户端**位于 `/call?test=1`，用于生产级语音循环。生产部署不安装测试工具；`?test=1` 启用 Web Audio API tee → MediaRecorder 捕获用于端到端测试。
- **工具路由器**，默认使用只读允许列表（search、query、get_page、list_pages、find_experts、get_recent_salience、get_recent_transcripts、read_article）。写操作被拒绝；操作员可通过本地覆盖选择加入有限集合。
- **角色感知提示构建器**，采用身份优先组合 + Unicode 清理以确保 Realtime API 安全。
- **可选 Twilio 适配器**（`/voice` TwiML、WSS 桥接）用于电话接入。如果只需要浏览器语音，可跳过。
- **三个 skill** 用于解析器路由：`voice-persona-mars`、`voice-persona-venus`、`voice-post-call`。
- **单元测试 + 端到端测试**随复制一起提供。PII 形状正则守卫每个提示，分类器分流上游与管道故障。

## Skillpack 作为参考范式

早期的 gbrain skillpack 安装到 `~/.gbrain/skills/<name>/` 作为受管块规范的一等 skill。用户的本地编辑与规范漂移，更新要么是"覆盖本地"要么是"跳过更新" —— 都不是操作员在扩展代码时想要的。

此配方提供不同的形态：gbrain 持有最新的**参考**，而 `gbrain integrations install agent-voice --target <host-repo>` 将**其复制到操作员的仓库中**。代码现在存在于主机仓库中，按操作员的发布节奏，带着操作员的编辑。后续的 `--refresh` 调用将主机端文件与 gbrain 的参考进行差异比较并提出更改；操作员逐文件选择（保留我的 / 接受他们的 / 合并）。

 shipped 参考**不包含个人姓名、硬编码私有路径或上游代理代号**。CI 守卫（`scripts/check-no-pii-in-agent-voice.sh`）阻止任何漂移；确定性导入脚本（`scripts/import-from-upstream.sh`）从上游语音代理源刷新 gbrain 参考。

## 安装

```bash
# 1. 检测目标仓库
export TARGET_REPO=$OPENCLAW_WORKSPACE     # 或您的代理仓库路径

# 2. 安装
gbrain integrations install agent-voice --target $TARGET_REPO

# 3. 在 $TARGET_REPO/.env 中设置环境变量（不在 gbrain 中）
echo "OPENAI_API_KEY=sk-..." >> $TARGET_REPO/.env
echo "DEFAULT_PERSONA=venus" >> $TARGET_REPO/.env

# 4. 实现上下文构建器（可选但推荐）
# 替换 $TARGET_REPO/services/voice-agent/code/lib/context-builder.example.mjs
# 使用您的操作员特定实现。参见合约：
#   $TARGET_REPO/services/voice-agent/code/lib/personas/context-builder.contract.md

# 5. 运行主机端测试
cd $TARGET_REPO/services/voice-agent && bun install && bun run test
# 或者如果您的仓库使用 npm：npm install && npm test

# 6. 启动语音服务器
cd $TARGET_REPO/services/voice-agent && bun run start
# 语音代理监听 http://localhost:8765
```

打开 `http://localhost:8765/call` 并点击连接。浏览器请求麦克风权限；授予后，通过 `POST /session` 进行 SDP 交换，OpenAI Realtime API 返回 SDP 应答，音频通过 WebRTC 双向流动。

对于测试模式往返检查，在 URL 后附加 `?test=1` —— 这将启用 `window._gbrainTest` 工具命名空间 + 响应音频的 MediaRecorder 捕获。

## 更新（从 gbrain 刷新）

```bash
# 拉取最新 gbrain → 使用 --refresh 重新运行安装
git -C $(which gbrain | xargs -I{} dirname {})/.. pull   # 或您的 gbrain 更新路径
gbrain integrations install agent-voice --target $TARGET_REPO --refresh
```

`--refresh` 读取原始安装写入的 `.gbrain-source.json` 清单，针对 gbrain 当前参考重新计算每个文件的 SHA-256，并对每个文件分类：

- **unchanged-identical** —— 主机文件与 gbrain 参考匹配；跳过。
- **unchanged-stale** —— 主机文件与记录的 SHA 匹配但参考已移动；提供更新。
- **locally-modified** —— 主机文件与记录的 SHA 偏离；显示差异，提供三个选项（保留我的 / 接受他们的 / 合并）。
- **source-deleted** —— gbrain 参考删除了文件；提供清理。
- **source-renamed** —— 通过路径映射检测；提供跟随。

`<target>/services/voice-agent/.gbrain-source.refresh.log` 中的事务日志允许在刷新被中断时恢复部分应用。

## 架构

```
                Browser (call.html)
                       │
                       │  WebRTC (麦克风 + 远程音频 + 数据通道)
                       ▼
              ┌─────────────────────┐
              │   server.mjs (8765) │
              │   ─────────────     │
   ┌──────────┤  GET  /call         │      POST /session
   │ static   │  GET  /health        ├──────────────────▶  api.openai.com/v1/realtime/calls
   │ files    │  POST /session       │       (通过 FormData 的 SDP 交换)
   └──────────┤  POST /tool          │
              │  POST /voice  (Twi.) │
              │  WSS  /ws     (Twi.) │
              └──────────┬───────────┘
                         │  /tool 通过 tools.mjs 允许列表分发
                         ▼
              ┌─────────────────────┐
              │  tools.mjs 路由器    │
              │  ─────────────       │   拒绝列表：put_page、submit_job、file_upload、...
              │  仅只读操作          │   允许列表：8 个读取操作；操作员通过覆盖扩展可选操作
              └──────────┬───────────┘
                         │
                         ▼  stdio JSON-RPC
              ┌─────────────────────┐
              │  gbrain serve (MCP)  │
              └─────────────────────┘
```

## 生产检查清单

参考代码 intentionally 最简。在公开部署之前：

- **Twilio 签名验证**在 `/voice` 上 —— 当前缺失；添加 `X-Twilio-Signature` 头验证。
- **速率限制**在 `/session` 和 `/tool` 上 —— 当前缺失。
- **CORS 允许列表** —— 当前为 `*`；限制到您的部署源。
- **/tool 认证** —— 语音端工具调用当前信任进程内连接；如果您公开 `/tool`，应通过会话令牌对其进行网关保护。
- **HTTPS** —— 生产环境中浏览器麦克风访问需要。使用 ngrok / Caddy / Cloudflare Tunnel。
- **Twilio 回退 URL** —— `/fallback` 是 TwiML 存根；连接到操作员的手机用于崩溃恢复。
- **上下文构建器中的 PII 清理** —— shipped `context-builder.example.mjs` 包含电话/电子邮件正则清理，但操作员应根据其大脑的 PII 模式集进行扩展。

## 测试

```bash
cd $TARGET_REPO/services/voice-agent
bun run test                   # 主机端单元测试（5 个套件，约 100 个用例）
AGENT_VOICE_E2E=1 bun run test:e2e             # WebRTC 往返（约 $0.10/运行）
AGENT_VOICE_FULL_E2E=1 bun run test:full-flow  # openclaw 驱动的安装有往返（约 $1-2/运行）
```

完整流程端到端测试是**摩擦发现**，而非发布门控。发布前门控在主机端单元测试和 PII 守卫；实时 OpenAI Realtime 路径中的片状失败以 `STATUS: skipped_upstream_degraded` 软失败并记录到摩擦通道。

## 延迟项目

- 自建 STT+LLM+TTS 管道（`pipeline.mjs`、`pipeline-v3.mjs` 用于 Gemini Live） —— 配方选项 A（直接连接到 OpenAI Realtime 的 WebRTC）现在提供；选项 B（Deepgram + Claude + Cartesia）是后续浪潮。
- 多语言 Mars —— 在 multilingual eval 落地之前，角色放弃多语言声明；恢复受 eval 门控。
- 会话间实时跨调用记忆 —— 角色当前是会话作用域的。
- 预计算参与竞标系统（生产部署中的"竞标系统"模式） —— 将属于 `prompt.mjs`。
- 智能 VAD 预设（安静/正常/嘈杂/非常嘈杂） —— 今天使用 Realtime API 的默认 VAD。
- WebRTC `/session` 尚未提供 MediaRecorder 回退用于 WebAudio-tee 失败的环境。

每个延迟项目都作为 TODO 归档在 gbrain 仓库的 `TODOS.md` 中。
