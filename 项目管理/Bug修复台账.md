# Bug 修复台账

## 2026-06-02 PGLite WASM 在 Windows 下崩溃

- 时间：2026-06-02
- 标题：PGLite WASM 初始化失败（Aborted()）
- 描述：在 Windows + Bun 1.3.14 环境下执行 `gbrain init --pglite` 报错 `PGLite failed to initialize its WASM runtime. Original error: Aborted(). Build with -sASSERTIONS for more info.`。尝试升级 `@electric-sql/pglite` 从 0.4.3 到 0.4.6 无效。Bun 已是最新版本（1.3.14）。
- 根因：Bun on Windows 与 `@electric-sql/pglite` WASM 有已知兼容性问题。
- 解决方案：改用 Docker Postgres 引擎（`pgvector/pgvector:pg16` 容器 + `gbrain init --url`），绕过 PGLite 路径。
- 是否完成：是
- 最终结果：Docker Postgres 方案成功运行，Schema 107 版全部迁移通过。

## 2026-06-02 Docker Desktop 启动失败

- 时间：2026-06-02
- 标题：Docker Desktop 无法启动（WSL 未安装）
- 描述：执行 `docker run` 报错 `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`，Docker 服务状态为 Stopped。`wsl -l -v` 报错（WSL 未安装）。
- 根因：Windows 未安装 WSL2，Docker Desktop 依赖的 Linux 容器后端缺失。
- 解决方案：通过 Docker Desktop 设置启用 WSL2 后端（启动时自动提示安装），等待约 10 秒后 Docker 就绪。
- 是否完成：是
- 最终结果：Docker Desktop 正常启动，`docker ps` 返回正常。

## 2026-06-02 Embed 命令报"嵌入模型未配置"

- 时间：2026-06-02
- 标题：embed --stale 提示 deferred setup 未配置嵌入模型
- 描述：执行 `embed --stale` 报错 `This brain was initialized with --no-embedding (deferred setup)`。原因是首次 `gbrain init` 时用了 `--no-embedding`，导致 `~/.gbrain/config.json` 中残留 `embedding_disabled: true`。
- 根因：`--no-embedding` 初始化标记未在后续配置中被清除。
- 解决方案：手动编辑 `~/.gbrain/config.json` 删除 `embedding_disabled` 字段，添加 `embedding_model` 和 `embedding_dimensions`。
- 是否完成：是
- 最终结果：配置文件修复后 `embed --stale` 正常执行。

## 2026-06-02 嵌入维度不匹配（1280 vs 1536）

- 时间：2026-06-02
- 标题：嵌入列维度不匹配导致 embed 拒绝执行
- 描述：初始 schema 使用 ZeroEntropy 默认（1280d），后来改为 OpenAI 的 1536d，数据库列宽不匹配。报错 `Refusing to silently re-template existing brain. Existing column: vector(1280), Requested: vector(1536)`。
- 根因：首次初始化时 schema 按默认嵌入模型（ZeroEntropy）建了 1280d 列，切换模型后维度冲突。
- 解决方案：在 Docker Postgres 中执行 SQL 修改列宽（`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(N)`），后续更换模型时重复此步骤。
- 是否完成：是
- 最终结果：列宽修改后嵌入正常。后续每次换嵌入模型需同步修改列宽。

## 2026-06-02 Embed 连接 OpenAI API 失败

- 时间：2026-06-02
- 标题：OpenAI API 无法连接（国内网络限制）
- 描述：`embed` 报错 `Cannot connect to API: Unable to connect. Is the computer able to access the url?`，但 `Bun.fetch` 直接测试 OpenAI 正常。
- 根因：`provider_base_urls` 配置对 `native` 类型的 OpenAI recipe 无效，SDK 仍走官方端点。
- 解决方案：创建自定义 `mimo` recipe（`openai-compatible` 类型），通过 `base_url_default` 指向 MIMO API 端点。后改用智谱 `embedding-3`（国内直连）。
- 是否完成：是
- 最终结果：改用智谱 embedding-3（国内直连）后嵌入成功。

## 2026-06-02 MCP 服务连接失败

- 时间：2026-06-02
- 标题：MCP 报错 Connection closed / Module not found
- 描述：CodeBuddy 连接 MCP 报错 `MCP error -32000: Connection closed` 和 `error: Module not found "src/cli.ts"`。
- 根因：MCP 启动时当前工作目录不是 PMBrain 目录，相对路径 `src/cli.ts` 找不到。
- 解决方案：在 MCP 启动命令中加入 `cd d:\cursor-claude\PMBrain`。
- 是否完成：是
- 最终结果：MCP 连接正常，AI 可正常调用 PMBrain 工具。

## 2026-06-02 PowerShell 编码问题导致 load-env.ps1 报错

- 时间：2026-06-02
- 标题：load-env.ps1 报"字符串缺少终止符"
- 描述：执行 `. .\load-env.ps1` 报错 `ParserError: 字符串缺少终止符: "`。
- 根因：`write_to_file` 工具写入的 .ps1 文件编码与 PowerShell 不兼容。
- 解决方案：用 `Set-Content -Encoding UTF8` 重新写入文件，简化脚本内容避免特殊字符。
- 是否完成：是
- 最终结果：`load-env.ps1` 可正常执行。

## 2026-06-06 legacy .doc 导入不可用

- 时间：2026-06-06
- 标题：修复 legacy .doc 文档导入依赖缺失时不可用
- 描述：Office 导入已识别 .doc 扩展名，但在未安装 LibreOffice/soffice 的 Windows 环境下无法抽取正文。
- 根因：legacy .doc 仅依赖 LibreOffice 转换为 docx，缺少 Microsoft Word 本机环境的只读抽取兜底。
- 解决方案：为 .doc/.wps 导入增加 Windows Word COM 只读文本抽取 fallback，并补充常见 LibreOffice 安装路径检测。
- 是否完成：是
- 最终结果：未安装 LibreOffice 时，Windows 可通过已安装的 Microsoft Word 只读打开 legacy .doc 并直接导入知识库；原文档不被修改。

## 2026-06-06 本地数据库无法连接

- 时间：2026-06-06
- 标题：PMBrain 本地数据库无法连接
- 描述：执行 PMBrain 命令时 PGLite 报 `PGLite failed to initialize its WASM runtime. Original error: Aborted().`，本地 HTTP 服务也无法连接。
- 根因：当前 Windows + Bun 环境下 PGLite WASM 不稳定；项目此前已验证可行路径是 Docker Postgres，但 Docker Desktop 和 `gbrain-pg` 容器处于停止状态，配置又被切回了 PGLite。
- 解决方案：启动 Docker Desktop，恢复 `gbrain-pg` 容器，配置统一切回 `postgresql://postgres:postgres@localhost:5433/gbrain`，并清理失败运行遗留的 cycle lock。
- 是否完成：是
- 最终结果：Docker Postgres 正常运行，`stats` 可读取 525 页、10036 chunks 且全部 embedded；HTTP 服务 `http://localhost:3131/admin/` 和 `/health` 均返回 200，`/health` 显示 `engine=postgres`。
## 2026-06-08 自然语言任务解析与单文件导入修复

- 时间：2026-06-08
- 标题：修复自然语言任务框无法解析 MIMO tool call 与单个 md 文件导入
- 描述：自然语言任务预览接口此前主要假设 LLM 返回纯 JSON 文本，遇到 MIMO 返回 tool_calls、function_call 或结构化结果时会因为 result.text 为空报 `LLM did not return a JSON object: (empty)`；同时 `import_path` 传入单个 `.md/.mdx` 文件时会被当作目录扫描，导致导入 0 个文件。
- 是否完成：是
- 最终结果：新增 `pmbrain_action` 工具规划 schema 和多形态 LLM 返回解析，兼容 tool_calls、function_call、structured_output、content parts、markdown JSON 与 gateway tool-call blocks；`import_path` 自动补充 `pathType`；`gbrain import <file.md>` 支持按单文件导入并记录 `source_type=file`。已新增并通过 `test/admin-console-intent.test.ts` 与 `test/import-single-file.test.ts`。

## 2026-06-08 向量化配置分裂导致智普费用消耗排查

- 时间：2026-06-08
- 标题：修复文件配置仍指向智普 embedding 导致继续消耗智普额度
- 描述：数据库中 4247 个 chunk 均已使用 `zeroentropyai:zembed-1` 完成向量化且无待向量化任务，但文件平面 `~/.gbrain/config.json` 仍配置为 `zhipu:embedding-3` / 1024，导致后续搜索或新导入可能继续调用智普生成 query/document embedding。
- 是否完成：是
- 最终结果：将文件平面 embedding 配置改回 `zeroentropyai:zembed-1` / 1280；验证 `embed --stale --dry-run` 显示 0 个待向量化 chunk，数据库中非 ZE chunk 为 0。该配置文件位于用户目录，不纳入仓库提交。

## 2026-06-10 Admin Token 复制体验修复

- 时间：2026-06-10
- 标题：修复启动横幅中的 Admin Token 被拆成多行影响复制
- 描述：`serve --http` 启动横幅此前将随机 Admin Token 按 50 字符拆成两行，并带有框线和填充空格，用户从终端复制时容易把空格、分隔符或换行一起复制到登录框。
- 是否完成：是
- 最终结果：Admin Token 改为单独的原始单行输出，可直接复制粘贴到 `/admin` 登录框；补充回归测试确保 token 不再被人为拆行。

## 2026-06-10 登录页品牌与登录链接说明修复

- 时间：2026-06-10
- 标题：修复 Admin 登录页仍显示 GBrain 且登录链接说明不清晰
- 描述：登录页品牌仍显示 `GBrain`，且“向 AI Agent 索取管理员登录链接”的说明容易让用户误以为链接需要粘贴到管理员令牌输入框。
- 是否完成：是
- 最终结果：登录页品牌改为 `PMBrain`；登录链接说明改为“Agent 返回 URL 后直接在浏览器打开”，并明确下方输入框仅用于粘贴终端打印的 Admin Token。

## 2026-06-10 系统诊断运行结果不持久显示

- 时间：2026-06-10
- 标题：修复 doctor 运行后结果不刷新且切页后丢失
- 描述：系统诊断页点击“运行 doctor --fast”后只读取一次 run 状态，长任务尚未完成时页面不会继续刷新；切换页面再回来也不会拉取本次服务内已有 doctor 运行记录。
- 是否完成：是
- 最终结果：系统诊断页新增运行状态轮询，并在页面加载时从 `/admin/api/runs` 恢复最近 doctor 记录；切页回来后仍可查看本次服务运行记录和输出。
