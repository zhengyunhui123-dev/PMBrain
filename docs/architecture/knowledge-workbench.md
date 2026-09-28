# 知识工作台与模型服务

更新：2026-09-28，统一产品版本 1.3.90。

## 模块边界

Desktop 与浏览器共用 `admin/src/workbench`，包含会话列表、消息、模型选择、知识辅助和输入区。`src/product/workbench` 独立承载会话生命周期、文件存储和受认证的 Admin API。`shared/workbench.ts` 定义跨端契约。原导入功能移到 `knowledge-import`，不再承担对话工作台职责。

模型调用复用 Core Gateway，知识检索复用 Admin 既有检索流程，再按命中的 Source 精确读取页面。工作台不复制 Gateway、向量引擎、OCR 或数据库业务逻辑，不依赖外部 MCP 客户端。

会话按当前数据库标识隔离，保存于配置目录下 `workbench/<数据库标识哈希>`。仅保存工作台消息，不写入 Wiki、原始资料或向量表。消息先落盘再生成，支持取消、显式重试、删除、重命名和服务重启后的中断提示。每轮传递最近 40 条、最多 80000 字符的有效消息；当前响应使用已有非流式 Gateway，页面显示检索/生成阶段，尚未逐 Token 输出。

## Cherry Studio 参考与吸纳

参考仓库：[Cherry Studio](https://github.com/CherryHQ/cherry-studio)，本轮核对提交 `24e68b754c3a33793755f6c55b9b68f948baf174`。

| 能力 | 处理 | PMBrain 实现 |
| --- | --- | --- |
| 主进程模型同步及网络栈 | 适配 | Electron `net.fetch`，共享系统代理与证书环境 |
| 平台鉴权、分页和错误说明 | 适配 | Google、Anthropic 分页，OpenAI 兼容列表，缺少密钥及 401/403/404/429 提示 |
| Ollama 本地模型发现 | 适配 | `/api/tags` 获取清单，`/api/show` 辨认类型、能力和维度；单模型详情失败保留列表并明确提示待确认 |
| 自定义模型元数据 | 适配 | 同步保留名称、价格、手动类型及能力标签，向量与普通接口可独立配置 |
| 多轮会话和上下文 | 适配 | 独立会话模块，复用 PMBrain Gateway 和知识检索 |
| 完整 Agent 工具循环、插件、联网、逐 Token 输出 | 暂未引入 | 本轮提供知识增强多轮对话，不宣称 Cherry 全量功能已经移植 |
| Cherry Electron/数据库/状态体系整体复制 | 不采用 | 保留 PMBrain 数据和调用基础，本轮未复制 Cherry 源码或改变项目许可证 |

核对文件包括 `src/main/ai/provider/listModels.ts`、`src/main/data/services/ModelService.ts`、`src/main/ai/messages/retainedContext.ts` 和 `packages/provider-registry/src/providers/ollama.ts`。吸收产品与协议处理方式，代码按既有 PMBrain 接口实现。

## 老用户兼容

读取模型服务时同时合并旧自定义模型清单，保留普通/向量独立地址、密钥、模型 ID、已选用途和维度。选中的旧用途保持 `custom-openai` 路由；其他模型按服务别名路由。同步不会删除已有手动模型或自动切换使用中的模型。保存使用配置版本检查和原有备份机制，避免覆盖并发设置。

当前使用中的向量接口地址不能直接改成另一个服务；需要通过原有模型用途切换和维度确认流程。此次升级不执行向量重建、Schema 变更或知识迁移。模型价格及能力标签仍为可维护元数据，不承诺计费、自动联网或工具执行。原高级分层及阶段路由通过既有配置 API 保留。

## 版本与验证

唯一产品版本来源是 `desktop/package.json`。根 package、VERSION、内嵌 Admin 和发布清单同步同一版本，使用 `bun run version:sync` 和 `bun run check:version-sync` 检查；保留构建所需字段，不另发浏览器版本。

定向测试覆盖老配置继承、分接口路由、缺少密钥、鉴权错误、本地模型分类、Ollama 部分详情失败、多轮真实 HTTP 请求、Source 引用隔离、取消/重试及重启持久化。界面使用最新构建加隔离适配器验证，不读取真实凭证或真实知识数据。真实平台凭证、原生安装版升级及 GitHub exact-SHA CI 需后续环境验收。
