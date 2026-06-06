# PMBrain — 项目管理知识大脑

PMBrain 是一个**纯本地、开箱即用**的项目管理知识大脑。把你的项目文档、会议纪要、需求文档、合同文件放进一个文件夹，AI 就能自动构建知识图谱、追踪进度、预警风险、生成报告。

基于 GBrain（Y Combinator 总裁 Garry Tan 开发的开源个人知识大脑）改造，保留完整知识管理能力，增加项目管理增强层。

---

## 特色

### 对话上下文总结，知识不遗漏

你在 CodeBuddy 或其他 AI 工具里聊过的所有内容——技术方案讨论、决策过程、问题排查——PMBrain 的 **`capture`** 命令一键存入知识库。

```powershell
bun src/cli.ts capture "把刚才的讨论记下来"
```

AI 对话是碎片化的，PMBrain 把它们变成可持续检索的知识。以后再搜"那个方案为什么选 A 不选 B"，答案就在那里。

### 导入功能扩展（支持常见办公文档）

原本只支持 Markdown，现扩展支持国人常用的办公文档格式，无需手动转换：

| 格式 | 说明 |
|------|------|
| `.md` | Markdown 笔记（原生支持） |
| `.docx` | Word 文档（`--include-office`） |
| `.pdf` | PDF 文档（`--include-office`） |
| `.xlsx` / `.xls` | Excel 表格（`--include-office`） |
| `.csv` | 表格数据（`--include-office`） |
| `.mp3` / `.wav` / `.m4a` / `.ogg` / `.flac` | 音频文件（自动转写为文字） |

```powershell
# 导入整个项目文件夹
bun src/cli.ts import "D:\项目文件夹" --include-office

# 注册为 source，后续增量同步
bun src/cli.ts sources add my-project --path "D:\项目文件夹"
bun src/cli.ts sync --source my-project
```

> doc 格式（旧版 Word）、视频导入正在研究中。

### 增量同步，每天开机自动更新

注册为 source 的文件夹，每次启动自动增量同步，只处理新增和修改的文件：

```powershell
# 启动时一键同步所有 source
bun src/cli.ts sync --all
bun src/cli.ts embed --stale
```

已经提供了一个 `start-pmbrain.ps1` 启动脚本，一键完成同步 + 嵌入。

### 混合搜索（可视化 + 可溯源）

PMBrain 的搜索不是黑盒。每个搜索结果都可以查看**分阶段评分归属**：

```powershell
bun src/cli.ts search "项目进度" --explain
```

输出示例：

```
1. projects/alpha (score=12.4)
   base=10.2 (rrf+cosine)
   + backlink ×1.08
   + adjacency ×1.05 (hits=3)
   = final 12.4
```

搜索融合了四种信号：**向量搜索**（语义匹配）+ **关键词搜索**（精确匹配）+ **知识图谱**（实体关联）+ **重排序**（精排优化）。每一步都可解释、可溯源。

### 自动化维护

PMBrain 每晚自动跑一次维护周期：修复链接 → 提取事实 → 检测模式 → 补全嵌入 → 项目健康评估 → 风险检测 → 报告生成。

```powershell
bun src/cli.ts dream
```

### 项目管理增强

在知识管理能力之上，新增面向项目经理的功能：

- **项目健康度评估**：自动分析项目状态
- **风险检测**：识别潜在风险
- **报告生成**：自动生成项目周报
- **PM 模式包**：7 种项目管理页面类型（project / task / milestone / risk / decision / meeting / stakeholder）

### 两种部署方式

**PGLite（本地嵌入式）**：不需要安装 Docker，一条命令初始化。但在 Windows 上 PGLite 的 WASM 运行时有兼容性问题，部分环境可能初始化失败。

**Docker + Postgres（推荐）**：更稳定，适合生产环境。Windows 用户推荐优先使用此方式。

### 多模型支持（国内可用）

内置 18 家 AI 提供商，国内可直接使用：

| 提供商 | 用途 | 配置 Key |
|--------|------|---------|
| **智谱 BigModel**（`zhipu:embedding-3`） | 向量嵌入 | `zhipu_api_key` |
| **MIMO 小米**（`mimo:mimo-v2.5-pro`） | 搜索扩展、对话 | `mimo_api_key` |
| **DeepSeek** | 对话（备用） | `deepseek_api_key` |
| OpenAI / Anthropic / Ollama / 更多 | 嵌入/对话/重排序 | 对应 API Key |

---

## 安装

### 方式一：Docker + Postgres（推荐，Windows 优先）

PGLite 在 Windows 上有 WASM 兼容性问题，推荐优先使用 Docker：

```powershell
# 1. 安装 Docker Desktop

# 2. 启动 Postgres（含 pgvector 插件）
docker run -d --name gbrain-pg ^
  -e POSTGRES_USER=postgres ^
  -e POSTGRES_PASSWORD=postgres ^
  -e POSTGRES_DB=gbrain ^
  -p 5433:5432 ^
  pgvector/pgvector:pg16

# 3. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 4. 全局安装 PMBrain
bun install -g github:zhengyunhui123-dev/PMBrain

# 5. 配置（编辑 ~/.gbrain/config.json）
# {
#   "engine": "postgres",
#   "database_url": "postgresql://postgres:postgres@localhost:5433/gbrain",
#   "embedding_model": "zhipu:embedding-3",
#   "embedding_dimensions": 1024,
#   "zhipu_api_key": "你的智谱Key"
# }

# 6. 初始化
gbrain init

# 7. 验证
gbrain doctor
```

### 方式二：PGLite 本地安装（macOS / Linux 推荐）

Windows 上 PGLite WASM 运行时可能存在兼容性问题，如果遇到 `PGLite failed to initialize` 错误，请改用 Docker 方式。

```powershell
# 1. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 全局安装
bun install -g github:zhengyunhui123-dev/PMBrain

# 3. 配置（编辑 ~/.gbrain/config.json）
# { "engine": "pglite", ... }

# 4. 初始化
gbrain init --pglite

# 5. 验证
gbrain doctor
```

> 安装后 CLI 命令是 `gbrain`，任何路径下直接 `gbrain <命令>` 即可。

### 方式三：从源码安装

```powershell
git clone https://github.com/zhengyunhui123-dev/PMBrain.git
cd PMBrain
bun install
bun src/cli.ts init --pglite
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
```

---

## MCP 接入 AI 工具

安装好 PMBrain 后，可以通过 MCP 协议让 AI 编程工具直接调用知识库。

### 本地安装的配置方式

直接在 AI 工具的 MCP 配置文件（`mcp.json`）中添加：

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "gbrain",
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
      "command": "gbrain",
      "args": ["serve", "--http", "--port", "3131"]
    }
  }
}
```

启动后浏览器打开 `http://localhost:3131/admin` 可查看管理后台。

### 在线/远程服务器的配置方式

如果 PMBrain 部署在远程服务器上，使用 HTTP 模式并配置地址：

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "gbrain",
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
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
请把它添加到当前工具的 MCP 配置文件中。
```

---

## 项目结构

```
PMBrain/
├── src/                    # 源代码
│   ├── cli.ts              # CLI 入口
│   ├── core/               # 核心引擎、搜索、AI 网关、梦境周期
│   │   ├── engine.ts       # BrainEngine 接口
│   │   ├── operations.ts   # 所有操作定义
│   │   ├── search/         # 混合搜索
│   │   ├── ai/             # AI 网关 + 18 个提供商配方
│   │   └── cycle/          # Dream 周期各阶段
│   ├── commands/           # CLI 命令
│   └── mcp/                # MCP 服务器
├── skills/                 # AI 智能体技能（43 个）
├── templates/              # 模式包模板
│   └── pm-schema-pack/     # PM 模式包
└── docs/                   # 文档
```

## 待实现

- [ ] **视频导入**：视频文件提取音轨转写
- [ ] **全程可视化可溯源**：类似 UltraRAG 的搜索链路可视化
- [ ] **本地数据库安装简化**：让非技术用户也能一键部署
- [ ] **doc 格式支持**：旧版 Word 文档导入

## 许可证

MIT License。基于 [GBrain](https://github.com/garrytan/gbrain) 改造。
