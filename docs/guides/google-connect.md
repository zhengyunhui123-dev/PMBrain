# 连接 Google（Gmail、日历、联系人）

用你自己的 Google Cloud OAuth 客户端，把邮件、日历、联系人读进 PMBrain，并驱动[待我处理](open-loops.md)。连接器只读（`gmail.readonly` / `calendar.readonly` / `contacts.readonly`），不会改你的 Google 账号。

本分支已吸收该能力：`src/core/google/`、`src/core/creds/`。令牌只在本机保险库 `~/.pmbrain/credentials.json`（0600），`sources.config` 只存账号指针。

桌面/Admin 的「连接 Google」走 Sidecar `pmbrain google connect --json`，loopback 不在 Electron 里。页面和渲染进程看不到授权码、refresh_token、client_secret。防火墙挡住回跳页时，把地址栏完整网址粘贴回来。

## 最快路径

```powershell
pmbrain google setup
```

一键：收客户端 JSON → 授权 → 登记 source → 首次同步（新邮件优先，有时间预算）→ 第一次 `pmbrain waiting`。重复运行是安全的，做完的步骤会跳过。

拆开写：

```powershell
pmbrain google connect --client-json $HOME\Downloads\client_secret_*.json
pmbrain sources add gmail-you --kind google --account you@example.com
pmbrain sync --source gmail-you
pmbrain waiting
```

Admin / 桌面：日常 → 连接器 → 选择 Desktop 应用 JSON → 连接 Google → 登记知识源 → 到任务中心同步。

## 一次性 Google Cloud（约 7 分钟）

需要 **Desktop 应用** OAuth 客户端，不要用 Web application。

1. 建或选项目：<https://console.cloud.google.com/projectcreate>
2. 打开三个 API：Gmail、Calendar、People。
3. 同意屏幕：Workspace 用 Internal；个人 gmail.com 用 External，把自己加成 Test user，并 **Publish app**。停在 Testing 会让 refresh token 每 7 天失效。
4. 创建 OAuth 客户端，类型 **Desktop app**，下载 JSON。
5. `pmbrain google connect --client-json <path>`。也可 `--client-json -` 从 stdin 粘贴。

Google 会显示「Google hasn’t verified this app」——这是你自己的应用，点 Advanced → Continue。

## 打不开 127.0.0.1 时

```powershell
pmbrain google connect --paste
pmbrain google connect --code "http://127.0.0.1:41999/?code=...&state=..."
```

批准后浏览器会停在打不开的 `http://127.0.0.1/...` 页，把**地址栏完整网址**贴回来，不要贴同意页本身的 URL，也不要把授权码发给别人。

## 多账号与副日历

每个账号单独 `pmbrain google connect --account work@yourco.com`，再 `sources add --kind google --account ...`。副日历：

```powershell
pmbrain google calendars
pmbrain sources add family-cal --kind google --account you@example.com --services calendar --calendar-id "....@group.calendar.google.com"
```

## 持续同步

`pmbrain sync --source <id>`、`pmbrain sync --all`、autopilot、Dream 都会带上 Google source。不带目标的裸 `pmbrain sync`（仓库模式）不会。健康检查：`pmbrain google status`、`pmbrain doctor` 的 `google_oauth`。

## 故障对照

与 `src/core/creds/errors.ts` 同一份目录。`--json` 会带上 `code / problem / cause / fix`。

| Code | 发生了什么 | 怎么修 |
|---|---|---|
| `client_json_wrong_type` | JSON 是 Web application（顶层 `"web"`） | 改建成 Desktop app 再下 JSON |
| `client_json_unreadable` | 路径不对或不是控制台下的 JSON | 重新下载，`--client-json <path>` |
| `client_shape_invalid` | ID/密钥粘贴变形 | 改用 `--client-json` |
| `redirect_uri_mismatch` | 回跳被拒 | 几乎都是 Web 客户端，换成 Desktop app |
| `access_denied_test_user` | External + Testing 且你不在 Test users，或点了取消 | Audience → Test users 加上自己 |
| `pasted_wrong_url` | 贴了同意页 URL | 批准后贴 `http://127.0.0.1...` |
| `state_mismatch` | 贴了上一次的回跳 | 重新 connect |
| `admin_policy_enforced` | Workspace 挡住第三方应用 | 管理员放行，或同意屏幕改 Internal |
| `wrong_account_consented` | 浏览器默认了另一个 Google 账号 | 重跑，选对账号 |
| `port_in_use` | 本机回跳端口被占 | 重跑、`--port` 或 `--paste` |
| `consent_timeout` | 10 分钟内没完成同意 | 重跑 |
| `invalid_grant_testing_expiry` | Testing 模式约 7 天令牌作废 | Publish 到 Production，再 `--reauth` |
| `invalid_grant_revoked` | 密码变更、手动撤销或客户端被删 | `--reauth` |
| `invalid_grant_clock_skew` | 系统时间偏差超过约 1 分钟 | 先对时 |
| `code_reused` | 授权码用了两次 | 重跑 connect |
| `invalid_client` | 客户端密钥已轮换 | 下最新 JSON 再连 |
| `no_refresh_token` | Google 没给 refresh token | 重跑；不行就到 myaccount.google.com/permissions 撤掉再连 |
| `api_not_enabled` | 项目没开对应 API | 按报错里的链接打开 |
| `rate_limited` | 配额 | 客户端会退避，一般不用动手 |
| `scope_missing` | 当时 `--scopes` 过窄 | `--reauth` |
| `relay_unreachable` / `relay_session_expired` / `claim_already_used` / `relay_disabled` | 托管中继不可用 | 继续用自带客户端：`pmbrain google connect` |
| `not_connected` | 保险库没有这个账号 | `pmbrain google connect` |
| `access_command_failed` | `--access command` 没打出 token | 先在 shell 里跑通该命令 |
| `access_env_missing` | `--access env` 变量空 | 由外部刷新该变量，或改回保险库流程 |
| `upstream` | Google 返回未归类错误 | `pmbrain google status --json` |

## 隐私与花费

- 断开：`pmbrain google disconnect <email>` 只删本机令牌；Google 侧到 <https://myaccount.google.com/permissions> 撤销。
- 承诺抽取会把近 30 天邮件正文发给你配置的对话模型。关掉：`pmbrain config set loops.extraction_enabled false`。确定性「谁在等我」检测器不花模型。
