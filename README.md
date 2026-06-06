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

### Dream 周期（自动维护）

每天晚上自动跑一次，做这些事：

```
自动修复链接 → 提取事实 → 提取概念 → 检测模式 →
补全嵌入 → 合并重复 → 项目健康评估 → 风险检测 → 报告生成
```

```powershell
bun src/cli.ts dream
```

不需要手动整理，大脑自己维护自己。

### 项目管理增强

在知识管理能力之上，新增面向项目经理的功能：

- **项目健康度评估**：自动分析项目状态
- **风险检测**：识别潜在风险
- **报告生成**：自动生成项目周报
- **PM 模式包**：7 种项目管理页面类型（project / task / milestone / risk / decision / meeting / stakeholder）

### 纯本地部署，不需要 Docker

PMBrain 使用 **PGLite**（嵌入式 Postgres，通过 WASM 运行），不需要安装 Docker，不需要配置数据库，一条命令初始化：

```powershell
bun src/cli.ts init --pglite
```

也支持 Docker Postgres 模式用于生产环境，但**开箱即用不需要**。

### 多模型支持（国内可用）

内置 18 家 AI 提供商，国内可直接使用：

| 提供商 | 用途 | 配置 Key |
|--------|------|---------|
| **智谱 BigModel**（`zhipu:embedding-3`） | 向量嵌入 | `zhipu_api_key` |
| **MIMO 小米**（`mimo:mimo-v2.5-pro`） | 搜索扩展、对话 | `mimo_api_key` |
| **DeepSeek** | 对话（备用） | `deepseek_api_key` |
| OpenAI / Anthropic / Ollama / 更多 | 嵌入/对话/重排序 | 对应 API Key |

### MCP 接入

PMBrain 通过 MCP 协议暴露 30+ 工具，可接入 CodeBuddy、Cursor、Claude Code 等 AI 编程工具，让 AI 在对话中直接搜索和写入知识库。

---

## 安装

### 方式一：全局安装（推荐，不下载源码）

```powershell
# 1. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 全局安装（从 GitHub 直接装）
bun install -g github:zhengyunhui123-dev/PMBrain

# 3. 配置 API Key（编辑 ~/.gbrain/config.json）
# {
#   "engine": "pglite",
#   "embedding_model": "zhipu:embedding-3",
#   "embedding_dimensions": 1024,
#   "zhipu_api_key": "你的智谱Key"
# }

# 4. 初始化本地大脑
gbrain init --pglite

# 5. 验证
gbrain doctor
```

> 安装后 CLI 命令是 `gbrain`。后续操作不再需要源码目录，任何路径下直接 `gbrain <命令>` 即可。

```powershell
git clone <你的仓库地址>
cd PMBrain
bun install
bun src/cli.ts init --pglite
```

如果愿意自己管理代码，也可以手动下载：

```powershell
git clone <你的仓库地址>
cd PMBrain
bun install
bun src/cli.ts init --pglite
```

### 方式三：Docker + Postgres（生产环境）

适合多用户、大容量数据、需要远程访问的场景：

```powershell
# 1. 启动 Postgres
docker run -d --name gbrain-pg ^
  -e POSTGRES_USER=postgres ^
  -e POSTGRES_PASSWORD=postgres ^
  -e POSTGRES_DB=gbrain ^
  -p 5433:5432 ^
  pgvector/pgvector:pg16

# 2. 下载项目、装依赖、配 Key（同上）
git clone <你的仓库地址>
cd PMBrain
bun install

# 3. 配置 config.json
# {
#   "engine": "postgres",
#   "database_url": "postgresql://postgres:postgres@localhost:5433/gbrain",
#   ...
# }

# 4. 初始化
bun src/cli.ts init

# 5. 从 PGLite 迁移到 Docker（可选）
bun src/cli.ts migrate --to supabase --url postgresql://postgres:postgres@localhost:5433/gbrain
```

### 方式三：Supabase 托管数据库

适合不想自己管理服务器的团队。详见[原版文档](docs/INSTALL.md)。

### 方式四：MCP 瘦客户端

远程连接到已有的 PMBrain 服务器，本地不需要数据库。详见[MCP 接入指南](docs/mcp/)。

### 方式五：AI 智能体自动安装

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

### 启动 MCP 接入 AI 工具

```powershell
# stdio 模式（给 Cursor、Claude Code 用）
bun src/cli.ts serve

# HTTP 模式（带管理后台 http://localhost:3131/admin）
bun src/cli.ts serve --http
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
