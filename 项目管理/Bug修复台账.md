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

## 2026-06-11 HTTP 服务启动后立即退出

- 时间：2026-06-11
- 标题：修复 `serve --http` 打印启动信息后立即返回命令行
- 描述：执行 `bun run src/cli.ts serve --http` 后，终端打印 PMBrain MCP Server banner 和 Admin Token，但马上回到 PowerShell 提示符，HTTP 服务随即掉线。根因是 `runServeHttp` 只调用 `app.listen(...)`，没有保存 HTTP server 并等待其关闭，导致 async 函数返回后 CLI 生命周期结束。
- 是否完成：是
- 最终结果：`runServeHttp` 现在保存 HTTP server，并等待 server close/error 或 SIGINT/SIGTERM；关闭时走统一清理并断开 engine。二次复查发现“下方终端仍起不来”的直接原因是 3131 已有后台 PMBrain 服务占用；同时修正 listen 时序，只有端口真正监听成功后才打印 banner/token，端口冲突时不再误导性显示启动成功。按版本规则将 PMBrain 从 `1.0.0` 更新到 `1.0.2`。已通过 `serve-http-bootstrap-token` 测试、端口冲突复现验证、临时端口真实启动保持存活验证。

## 2026-06-11 Admin 自然语言导入 source 解析错误

- 时间：2026-06-11
- 标题：修复 Admin 自然语言导入已注册 source 路径时落到 default
- 描述：从 Admin 自然语言任务导入 `D:\duwu\youdao\订单+清单项目` 时，命令生成为 `bun src/cli.ts import ... --include-office`，没有带 `--source-id dingdan-qingdan`。该目录已注册为 source `dingdan-qingdan`，但执行层解析为 `default`，导致已存在页面建版本快照时报 `createVersion failed: page "项目管理" (source=default) not found`。
- 是否完成：是
- 最终结果：Admin 执行 import_path 时会根据导入路径匹配 sources.local_path 的最长前缀，自动补齐正确 `--source-id`；显式传入 sourceId 时仍优先使用用户指定值。按版本规则将 PMBrain 从 `1.0.2` 更新为 `1.0.3`。
## 2026-06-16 Dream MIMO 价格配置缺失

- 时间：2026-06-16
- 版本号：1.0.5
- 标题：修复 Dream propose_takes 使用 MIMO 时提示价格未配置
- 描述：`pmbrain dream` 在 `propose_takes` 阶段使用 `mimo:mimo-v2.5-pro` 时，旧 Dream budget meter 只读取 Anthropic 价格表，导致 `BUDGET_METER_NO_PRICING` 并让预算计量失效；新 `BudgetTracker` 也缺少通用 provider recipe 价格读取。
- 是否完成：是
- 最终结果：预算计量器现在会读取 provider recipe 中的 chat 输入/输出单价，MIMO 按 `$1.25/$10.00 per 1M tokens` 计入预算；`models.propose_takes` 与 `models.grade_takes` 已确认均为 `mimo:mimo-v2.5-pro`，本地 HTTP 服务已启动并通过 `/health` 检查。
## 2026-06-16 全局 pmbrain 命令入口修复

- 时间：2026-06-16
- 版本号：1.0.7
- 标题：修复全局 pmbrain 入口版本不一致和 help 误报失败
- 描述：系统 PATH 中的 `pmbrain`/`gbrain` 仍指向旧全局安装版本，直接执行 `pmbrain dream` 会绕过当前 PMBrain 源码修复；同时 `embed --help` 与 `config --help` 虽打印 Usage 但返回错误码 1，容易被自动化判断为命令不可执行。
- 是否完成：是
- 最终结果：全局 `pmbrain.cmd`/`gbrain.cmd` 已转发到当前项目源码；`pmbrain --version` 与 `gbrain --version` 均返回当前版本；`embed --help` 和 `config --help` 改为正常返回。
## 2026-06-18 Dream 校准阶段 source 作用域修复

- 时间：2026-06-18 09:14:45
- 版本号：1.0.11
- 标题：修复 dream 校准三阶段忽略显式 source 的问题
- 描述：执行 `dream --source <id>` 时，`propose_takes`、`grade_takes`、`calibration_profile` 已经通过命令行解析得到 `opts.sourceId`，但校准上下文仍按 `brainDir` 重新推断 source，导致显式 source 可能被覆盖，进而扫描错误的数据范围。
- 是否完成：是
- 最终结果：校准三阶段现在优先使用 `opts.sourceId`，仅在未传入 source 时才回退到 `resolveSourceForDir(engine, opts.brainDir)`；新增结构回归测试防止该路径回退。

## 2026-06-18 Dream dry-run、模型诊断与帮助文案修复

- 时间：2026-06-18 09:23:47
- 版本号：1.0.12
- 标题：修复 dream dry-run 卡 LLM、models doctor 参数解析、PM 阶段 dry-run 与帮助文案过期
- 描述：`propose_takes --dry-run` 仍会调用 LLM，容易长时间卡住；`models doctor` 因子命令参数下标判断错误，直接执行时只显示模型路由表；`project_health`、`risk_detect` 未收到 dry-run 参数；`dream --help` 仍描述旧阶段和旧审批流程。
- 是否完成：是
- 最终结果：`propose_takes` dry-run 现在只扫描并统计需要 LLM 的页面，不调用 LLM、不写候选观点；`models doctor` 正常进入探针模式；PM 三阶段 dry-run 参数已传递；`dream --help` 更新为真实阶段列表和“候选观点 -> 观点审批 -> takes -> 校准画像”流程说明。
