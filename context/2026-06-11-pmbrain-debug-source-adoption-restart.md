# PMBrain 2026-06-11 调试与运维上下文记录

## 会话目标

用户连续处理 PMBrain 项目的命名、版本、HTTP 服务掉线、Admin 导入、Source 注册与历史导入整理问题，并要求每次项目变更遵循版本号台账规则。

## 已确认的项目规则

- 项目管理记录写入子项目 `项目管理/变更台账.md` 或 `项目管理/Bug修复台账.md`。
- 如果项目有版本号，每次明确变更或 Bug 修复后默认递增最后一位，例如 `1.0.0 -> 1.0.1`；到 99 后向前进位；用户指定前两位时遵循用户要求。
- PMBrain 当前版本已推进到 `1.0.4`。
- 每次完成后需要说明使用了哪些 skill，以及 workflow。

## 已完成的关键修复

### GBrain 到 PMBrain 的命名治理

- 主要用户可见入口改为 PMBrain。
- `package.json` 包名和主 bin 为 `pmbrain`，保留 `gbrain` 兼容别名。
- MCP、OpenClaw、Admin、配置、环境变量等入口做了 PMBrain 区分。
- 初始发布版本设为 `1.0.0`，本地提交为 `c9c7925 chore: release PMBrain 1.0.0`。

### HTTP 服务启动后立即掉线

根因：`runServeHttp` 调用 `app.listen(...)` 后没有保存 HTTP server 并等待 close/error，导致 async 函数返回后 CLI 生命周期结束，HTTP 服务随即退出。

已修复：

- 保存 `HttpServer`。
- 新增等待 server close/error/SIGINT/SIGTERM 的逻辑。
- 只在实际 listen 成功后打印 banner/token，端口冲突时不再误导性打印启动成功。
- 相关测试通过：`test/serve-http-bootstrap-token.test.ts`。

### Admin 自然语言导入已注册 Source 路径落到 default

现象：从 Admin 自然语言任务导入 `D:\duwu\youdao\订单+清单项目` 时命令没有带 `--source-id dingdan-qingdan`，导入解析到 `default`，报 `createVersion failed: page "项目管理" (source=default) not found`。

根因：Admin 执行层没有根据导入路径匹配已注册 `sources.local_path`。

已修复：

- 新增 `resolveImportSourceIdForPath(...)`。
- 显式传入 sourceId 时优先使用显式值。
- 未显式传入时，按 `sources.local_path` 最长前缀匹配导入路径，自动填入 `--source-id`。
- 版本从 `1.0.2` 升到 `1.0.3`。

### 重庆保供项目忘记注册 Source 后的数据整理

用户问题：`D:\duwu\youdao\重庆保供项目` 已导入 PMBrain，但忘记注册 Source；担心后续增量导入和历史数据混在 `default` 里；Admin 页面“注册 source”按钮点不动。

排查结果：

- 导入日志显示 `2026-06-11 15:32:07` 首次导入成功：22 pages imported, 211 chunks。
- 这些页面原本落在 `default`。
- `2026-06-11 15:35:31` 再导入时 22 pages skipped，说明内容未变化。
- Admin 页面按钮点不动的直接原因是前端禁用了按钮：`disabled={!path.trim() || !sourceId.trim()}`，导致 Source ID 为空时无法注册。

已修复与处理：

- Admin 注册 Source 不再要求 Source ID 必填，只要路径不为空即可点击。
- 后端新增 `deriveSourceIdFromPath(...)`：英文路径生成可读 source id；中文等非 ASCII 路径生成稳定 hash id。
- 新增 CLI：`pmbrain sources adopt <id> --path <path> [--from-source default] [--dry-run] [--yes]`。
- `adopt` 根据 `ingest_log.source_ref + pages_updated` 找到历史导入页面，先支持 dry-run，必须 `--yes` 才会真正迁移。
- 实际已创建 Source：`chongqing-baogong`，名称 `重庆保供项目`，路径 `D:\duwu\youdao\重庆保供项目`。
- 已将 22 个页面从 `default` 收编到 `chongqing-baogong`。
- 收编后 sources 状态：`chongqing-baogong` 有 22 页，`default` 从 352 降到 330。
- 后续增量导入命令：

```powershell
bun run src/cli.ts import D:\duwu\youdao\重庆保供项目 --include-office --source-id chongqing-baogong
```

- 版本从 `1.0.3` 升到 `1.0.4`。
- 本地提交：`56d1d58 fix: support PMBrain source adoption for imports`。
- `git push` 失败：GitHub 连接被重置，错误为 `Recv failure: Connection was reset`。

## 当前 HTTP 服务状态与重启方法

用户反馈：掉线后不知道怎么重启，终端不给 token，手动关不掉进程，再启动又端口占用。

当前确认：

- 3131 端口曾由后台 `bun run src/cli.ts serve --http` 占用。
- 健康检查返回 `{"status":"ok","version":"1.0.4","engine":"postgres"}`。
- 后台启动时 token 写在日志，不会显示在当前终端。
- 本记录不保存完整 Admin Token；需要时查看启动终端或日志。

前台重启命令：

```powershell
cd D:\cursor-claude\PMBrain
$pid = (Get-NetTCPConnection -LocalPort 3131 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid) { Stop-Process -Id $pid -Force }
.\load-env.ps1
bun run src/cli.ts serve --http
```

后台重启命令：

```powershell
cd D:\cursor-claude\PMBrain
$pid = (Get-NetTCPConnection -LocalPort 3131 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid) { Stop-Process -Id $pid -Force }
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','cd D:\cursor-claude\PMBrain; . .\load-env.ps1; bun run src/cli.ts serve --http'
```

查看后台 token/日志：

```powershell
Get-Content D:\cursor-claude\PMBrain\pmbrain-http.out.log -Tail 80
```

健康检查：

```powershell
Invoke-WebRequest http://localhost:3131/health -UseBasicParsing
```

## 验证记录

- `bun test test/admin-console-intent.test.ts test/serve-http-bootstrap-token.test.ts`：17 pass。
- `bun run build:admin`：通过，并更新 `src/admin-embedded.ts`。
- `bun run src/cli.ts --version`：`pmbrain 1.0.4`。
- `http://localhost:3131/health`：返回 ok，版本 `1.0.4`。

## Git 状态摘要

- PMBrain 仓库本地分支 `master` 领先 `origin/master` 1 个提交。
- 最新提交：`56d1d58 fix: support PMBrain source adoption for imports`。
- 远端推送失败原因：网络连接被重置。
- 工作区剩余未跟踪临时文件/目录包括 `_import_code.cjs`、`imports/`、`temp-sections/`、`temp_doc_reader.py`、`{console.error(e)`；这些未纳入提交。
