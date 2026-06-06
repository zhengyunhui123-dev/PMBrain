# PMBrain 配置指南

## 环境概览

| 项目 | 当前值 |
| --- | --- |
| 操作系统 | Windows |
| 运行时 | Bun 1.3.14 |
| 数据库 | 本地 PGLite |
| 数据库路径 | `D:\cursor-claude\PMBrain\.gbrain\brain.pglite` |
| 默认 Dream / sync 目录 | `D:\Obsidian\Valut\PMGbrain` |
| MCP 配置文件 | `C:\Users\zhengyunhui\.codebuddy\mcp.json` |

## 统一密钥管理

真实 API key 只放在私有配置文件，不写入 Windows 全局环境变量，不写入仓库 `.env`。

| 用途 | 配置字段 | 运行时映射 |
| --- | --- | --- |
| MIMO 对话 / 扩展 | `mimo_api_key` | `MIMO_API_KEY` |
| 智谱向量化 | `zhipu_api_key` | `ZHIPUAI_API_KEY` |
| DeepSeek 备用 | `deepseek_api_key` | `DEEPSEEK_API_KEY` |

私有配置文件：

- `C:\Users\zhengyunhui\.gbrain\config.json`
- `D:\cursor-claude\PMBrain\.gbrain\config.json`

仓库内 `.env` 不保存真实 key。`load-env.ps1` 只负责从私有 `config.json` 导出当前进程环境变量，用于兼容仍读取 `process.env` 的旧入口。

## AI 提供商配置

| 功能 | 当前提供商 | 模型 | 维度 |
| --- | --- | --- | --- |
| 向量化 | 智谱 BigModel | `zhipu:embedding-3` | 1024 |
| 对话 | MIMO 小米 | `mimo:mimo-v2.5-pro` | - |
| 查询扩展 | MIMO 小米 | `mimo:mimo-v2.5-pro` | - |
| Dream 提炼 / 判定 | MIMO 小米 | `mimo:mimo-v2.5-pro` | - |
| propose_takes / grade_takes | MIMO 小米 | `mimo:mimo-v2.5-pro` | - |

## 常用命令

```powershell
cd D:\cursor-claude\PMBrain

# 可选：给旧工具导出当前进程环境变量，不含明文 key
. .\load-env.ps1

# 查看脱敏配置
bun run src/cli.ts config show

# 同步 Obsidian brain 仓库
bun run src/cli.ts sync --repo D:\Obsidian\Valut\PMGbrain --source default --no-pull

# 向量化过期内容
bun run src/cli.ts embed --stale

# 运行 Dream
bun run src/cli.ts dream --source default
```

## 当前注意事项

- `D:\Obsidian\Valut\PMGbrain` 当前只有 `.git`，没有 Markdown 文件和首个 commit；Dream 的 sync 阶段会提示 `No commits in repo`。先添加内容并提交一次即可。
- 当前数据库已有 546 pages、7574 chunks、7574 embedded，旧数据和向量化结果可读。
- `bun run typecheck` 当前仍有既有类型错误，集中在 `cycle project_health/risk_detect/report_gen` 和 `search.ts`，不属于 API key 治理改动。

