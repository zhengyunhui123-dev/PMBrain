# PMBrain — 项目管理知识大脑

PMBrain 是一个**纯本地、开箱即用**的项目管理知识大脑。把你的项目文档、会议纪要、需求文档、合同文件放进一个文件夹，AI 就能自动构建知识图谱、追踪进度、预警风险、生成报告。

基于 GBrain（Y Combinator 总裁 Garry Tan 开发的开源个人知识大脑）深度改造，保留完整知识管理能力，做了大量国产化修改，更符合国人的使用习惯。

---

## 核心能力

PMBrain 集成了 GBrain 的核心能力，安装后相当于给你的 AI 工具装了一个**有记忆的大脑**。

你的 AI 工具（CodeBuddy、Codex、Cursor、Claude Code 等）原本每一次对话都是独立的，聊完就忘。有了 PMBrain，AI 可以搜索你存过的所有文档、笔记、对话记录，回答问题时带着历史上下文。

- **混合搜索引擎**：向量搜索 + 关键词 + 知识图谱三重融合，搜索质量远高于单纯的关键词匹配
- **知识图谱**：自动从文档中提取人物、公司、项目之间的关联关系
- **MCP 接口**：CodeBuddy、Codex、Cursor、Claude Code 等 AI 工具在对话中直接调用知识库
- **GUI 管理控制台**：通过浏览器导入资料、浏览知识库、运行自然语言任务、配置 MCP 接入、查看任务监控和系统诊断
- **数据本地化**：知识库存储在你自己的电脑或服务器上，不会上传到第三方云端，确保公司机密和个人隐私不泄露
- **双引擎架构**：支持本地 PGLite 和 Docker Postgres 两种部署方式

## 特色功能

### 导入即用，无需转换格式

支持国人常用的办公文档格式，直接导入，无需手动转换：

| 格式 | 说明 |
|------|------|
| `.md` | Markdown 笔记 |
| `.docx` | Word 文档 |
| `.pdf` | PDF 文档 |
| `.xlsx` / `.xls` | Excel 表格 |
| `.csv` | 表格数据 |
| `.mp3` / `.wav` / `.m4a` | 音频文件（自动转写） |

```powershell
bun src/cli.ts import "D:\项目文档" --include-office
```

### 增量同步

注册文件夹为 source 后，每次启动自动同步更新的文件。

```powershell
bun src/cli.ts sources add my-project --path "D:\项目文档"
bun src/cli.ts sync --source my-project
```

### 原始数据和知识库数据可视化

启动 Admin Console 后，可以在浏览器里查看原始数据导入、知识库页面、数据源分布、向量化覆盖率、MCP 接入状态和后台任务健康情况。

```powershell
pmbrain serve --http --port 3131
```

浏览器打开 `http://localhost:3131/admin`，即可进入 PMBrain 知识控制台。

CLI 仍然支持可溯源搜索，每个搜索结果可以查看评分来源：

```powershell
pmbrain search "项目进度" --explain
```

### 自然语言 AI 控制台

Admin Console 不是传统后台，而是面向 AI Agent 的本地控制台。你可以直接输入自然语言任务：

- `导入文件夹路径\需求.md`
- `同步所有知识库`
- `查一下项目相关资料`
- `运行系统诊断`

系统会调用已配置的对话模型识别意图，校验后映射到 PMBrain 允许的操作。

### 多模型支持（国内可用）

内置 18 家 AI 提供商，国内可直接使用：

| 提供商 | 用途 |
|--------|------|
| 智谱 BigModel | 向量嵌入、对话 |
| MIMO 小米 | 搜索扩展、对话 |
| DeepSeek | 对话 |
| OpenAI / Anthropic / Ollama | 嵌入/对话/重排序 |

## 使用场景

### 个人知识库

- **对话沉淀**：把你和 AI 的每一次讨论保存下来。不管在 CodeBuddy、Codex、Cursor 还是 Claude Code，所有工具的知识沉淀到同一个地方
- **文档归集**：日常文档、办公文件、笔记直接导入，支持 Word、PDF、Excel、Markdown、音频等格式
- **增量同步**：注册文件夹后每次开机自动更新，只处理新增和修改的文件

### 项目经理

把项目文档、会议纪要、需求文件放入一个文件夹，AI 自动构建知识图谱，追踪进度，预警风险，生成周报。

### 团队协作

PMBrain 作为团队的共享知识库，MCP 接入 AI 工具后，每个人在对话中直接调取知识。新成员加入可以搜索历史讨论和决策记录。

### AI 编程辅助

在 CodeBuddy、Codex、Cursor 中开发时，PMBrain 作为知识库后端，AI 可以搜索技术方案、查看历史决策，回答更准确。

---

## 安装

### 方式一：Docker + Postgres（推荐，Windows 优先）

PGLite 在 Windows 上有 WASM 兼容性问题，推荐优先使用 Docker：

```powershell
# 1. 安装 Docker Desktop

# 2. 启动 Postgres（含 pgvector 插件）
docker run -d --name pmbrain-pg ^
  -e POSTGRES_USER=postgres ^
  -e POSTGRES_PASSWORD=postgres ^
  -e POSTGRES_DB=pmbrain ^
  -p 5433:5432 ^
  pgvector/pgvector:pg16

# 3. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 4. 全局安装 PMBrain
bun install -g github:zhengyunhui123-dev/PMBrain

# 5. 配置（编辑 ~/.pmbrain/config.json）
# {
#   "engine": "postgres",
#   "database_url": "postgresql://postgres:postgres@localhost:5433/pmbrain",
#   "embedding_model": "zhipu:embedding-3",
#   "embedding_dimensions": 1024,
#   "zhipu_api_key": "你的智谱Key"
# }

# 6. 初始化
pmbrain init

# 7. 验证
pmbrain doctor

# 8. 启动 GUI 管理控制台
pmbrain serve --http --port 3131
```

启动后浏览器打开 `http://localhost:3131/admin`。首次登录需要使用终端打印的 Admin Token，或让 AI Agent 生成一次性管理员登录链接。

### 方式二：PGLite 本地安装（macOS / Linux 推荐）

Windows 上 PGLite WASM 运行时可能存在兼容性问题，如果遇到 `PGLite failed to initialize` 错误，请改用 Docker 方式。

```powershell
# 1. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 全局安装
bun install -g github:zhengyunhui123-dev/PMBrain

# 3. 配置（编辑 ~/.pmbrain/config.json）
# { "engine": "pglite", ... }

# 4. 初始化
pmbrain init --pglite

# 5. 验证
pmbrain doctor

# 6. 启动 GUI 管理控制台
pmbrain serve --http --port 3131
```

> 安装后 CLI 命令是 `pmbrain`，任何路径下直接 `pmbrain <命令>` 即可。旧版 `gbrain` 命令会继续作为兼容别名保留一段时间。

### 方式三：从源码安装

```powershell
git clone https://github.com/zhengyunhui123-dev/PMBrain.git
cd PMBrain
bun install
bun src/cli.ts init --pglite
bun src/cli.ts serve --http --port 3131
```

如果修改了 Admin Console 前端代码，先运行：

```powershell
bun run build:admin
```

### 方式四：Supabase 托管数据库

适合不想自己管理服务器的团队。详见[原版文档](docs/INSTALL.md)。

### 方式五：MCP 瘦客户端

远程连接到已有的 PMBrain 服务器，本地不需要数据库。详见[MCP 接入指南](docs/mcp/)。

### 方式六：AI 智能体自动安装

让 Claude Code、Codex 等 AI 智能体自动完成安装。详见[原版安装协议](INSTALL_FOR_AGENTS.md)。

### 导入数据

```powershell
# 导入项目文件夹
bun src/cli.ts sources add my-project --path "D:\项目文档"
bun src/cli.ts sync --source my-project

# 或者一次性导入（含 Office 文档）
bun src/cli.ts import "D:\项目文档" --include-office
```

### 每日使用

```powershell
cd D:\cursor-claude\PMBrain

# 1. 保存当前对话/笔记
bun src/cli.ts capture "要记住的内容"

# 2. 搜索已有知识
bun src/cli.ts search "关键词"

# 3. 同步增量
bun src/cli.ts sync --all
bun src/cli.ts embed --stale

# 4. 打开 GUI 管理控制台
bun src/cli.ts serve --http --port 3131
```

浏览器访问 `http://localhost:3131/admin` 后，可以通过图形界面完成导入、浏览、MCP 接入、任务监控和系统诊断。

---

## MCP 接入 AI 工具

安装好 PMBrain 后，可以通过 MCP 协议让 AI 编程工具直接调用知识库。

### 本地安装的配置方式

直接在 AI 工具的 MCP 配置文件（`mcp.json`）中添加：

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve"]
    }
  }
}
```

### HTTP 模式（带管理后台）

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve", "--http", "--port", "3131"]
    }
  }
}
```

启动后浏览器打开 `http://localhost:3131/admin` 可查看管理后台。

如果希望每次重启后管理员初始令牌保持不变，可以设置环境变量：

```powershell
$env:PMBRAIN_ADMIN_BOOTSTRAP_TOKEN="至少32位的安全随机字符串"
pmbrain serve --http --port 3131
```

### 在线/远程服务器的配置方式

如果 PMBrain 部署在远程服务器上，使用 HTTP 模式并配置地址：

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve", "--http", "--port", "3131", "--bind", "0.0.0.0"]
    }
  }
}
```

> 远程部署需要配置 OAuth 认证，详见 [MCP 部署指南](docs/mcp/)。

### 让 AI 帮你配置

把下面这段发给你的 AI 编程工具，它就会自动帮你配好 MCP：

```
请帮我配置 PMBrain 的 MCP 服务。
PMBrain 安装在当前电脑。
MCP 配置如下：
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve"]
    }
  }
}
请把它添加到当前工具的 MCP 配置文件中。
```

---

## 配置说明

### API Key 配置

PMBrain 需要调用 AI 接口来生成向量和回答，Key 配置在 `~/.pmbrain/config.json` 中：

```json
{
  "zhipu_api_key": "你的智谱Key",
  "mimo_api_key": "你的MIMO Key",
  "openai_api_key": "sk-xxx"
}
```

| 功能 | 推荐提供商 | 模型 | 是否需要 Key |
|------|-----------|------|-------------|
| 向量化（必需） | 智谱 BigModel | `zhipu:embedding-3` | ✅ `zhipu_api_key` |
| 对话/搜索扩展（可选） | MIMO 小米 | `mimo:mimo-v2.5-pro` | ✅ `mimo_api_key` |
| 对话备用（可选） | DeepSeek | `deepseek:deepseek-chat` | ✅ `deepseek_api_key` |

> **向量化是搜索的基础**，配置了 `zhipu_api_key` 才能让搜索生效。智谱的向量模型 `embedding-3` 效果好、价格低（每百万 token 仅 0.01 美元），国内可直接访问 [open.bigmodel.cn](https://open.bigmodel.cn) 申请 Key。

### 模型切换

编辑 `~/.pmbrain/config.json` 中的 `embedding_model`、`chat_model` 字段即可切换。

---

## 项目结构

```
PMBrain/
├── admin/                  # Admin Console 前端源码
├── src/                    # 源代码
│   ├── cli.ts              # CLI 入口
│   ├── core/               # 核心引擎、搜索、AI 网关、梦境周期
│   │   ├── engine.ts       # BrainEngine 接口
│   │   ├── operations.ts   # 所有操作定义
│   │   ├── search/         # 混合搜索
│   │   ├── ai/             # AI 网关 + 18 个提供商配方
│   │   └── cycle/          # Dream 周期各阶段
│   ├── commands/           # CLI 命令和 HTTP Admin Console 后端
│   └── mcp/                # MCP 服务器
├── skills/                 # AI 智能体技能（43 个）
├── templates/              # 模式包模板
│   └── pm-schema-pack/     # PM 模式包
└── docs/                   # 文档
```

## 待实现

- [ ] **国内视频网站导入**：B站等国内视频平台内容直接导入知识库
- [ ] **全程可视化可溯源**：类似 UltraRAG 的搜索链路可视化
- [ ] **本地数据库安装简化**：让非技术用户也能一键部署

## 许可证

MIT License。基于 [GBrain](https://github.com/garrytan/gbrain) 改造。

