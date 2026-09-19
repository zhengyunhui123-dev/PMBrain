## PMBrain 1.2.2

- Docker 数据库列表会识别已停止的 PMBrain 管理容器和历史 `gbrain-pg`、`pmbrain-postgres-*` 容器，并明确显示“运行中/已停止”。
- 选择已停止数据库时先启动容器，等待 TCP 与 SQL 就绪并校验 PMBrain 核心表；验证失败会恢复原停止状态，不会写入切换地址。
- 修复 Sidecar 启动迁移测试依赖单行代码格式，导致 Linux Test 分片误报失败的问题。

## PMBrain 1.2.1

- 一键迁移完成后回显当前 Postgres 地址，并自动扫描 Docker 中连接正常且包含 PMBrain 核心表的数据库。
- 数据库选择改为下拉切换：当前库优先显示，旧版 `pmbrain-postgres-*` 迁移库继续兼容；选择后沿用“保存修改并重启”安全切换。
- 新建 PMBrain Postgres 容器写入管理标签，普通 PostgreSQL、空库、初始化失败或不可查询的容器不会混入选择列表。

## PMBrain 1.2.0

- Docker 迁移先扫描完整旧库并展示处理方案；历史备份表按集中规则跳过，旧库重复 Facts 在新库保留并修复主键。
- 迁移前保留 PGLite 冷备，向全新 Docker Postgres 复制数据并逐表校验；仅在新服务健康后切换，失败则恢复原连接并保存报告。
- Docker Desktop 自动启动后等待引擎就绪的时间延长，迁移进度显示当前类别和已复制记录数。
- 新建 PostgreSQL 容器只在 TCP `pg_isready` 和真实 `SELECT 1` 都成功后继续，避免把首次初始化的临时 Unix socket 服务误判为正式数据库；扩展统一由 PMBrain Schema 初始化。

## PMBrain 1.1.98

- 新增一键创建 Docker Postgres 并迁移当前 PGLite 知识库：先建立冷备，复制完整数据库并逐表核对，确认后再切换连接。
- 迁移失败时恢复原 PGLite 配置与服务；原数据库和备份始终保留。未安装 Docker Desktop 时提供官方安装说明入口。

## PMBrain 1.1.97

- 同步会把 PGLite TOAST 索引分裂错误识别为数据库索引损坏，不再误报为 16 份源文件解析失败，也不会在连续三次后自动跳过。
- 阻断提示改为实际 `.pmbrain` 失败台账和 `pmbrain` 命令；数据库索引损坏时明确要求先修复副本，禁止用 `--skip-failed` 掩盖。
- PGLite 同步遇到已确认的 B-tree 索引结构损坏时，会核对系统目录、重建点名索引并重试当前文件；无法确认或修复失败时仍会停止同步。
- 请求日志默认显示 `recall`、`remember`、`forget_fact` 等实际工具调用；`tools/list` 等协议发现请求可在“全部请求”中查看。
