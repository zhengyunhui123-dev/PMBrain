## PMBrain 1.1.57

- 更换向量模型后不再堵在“准备搜索索引”直到全部重建完成。可随时点「稍后处理，进入 PMBrain」；旧向量会在继续重建时清掉，任务中心留下暂停的重建任务，点继续即可断点补齐。未完成的条目暂时不能语义搜索，和尚未向量化的新导入内容一样。

## PMBrain 1.1.56

- 安装包补齐内置 Schema Pack（`gbrain-base-v2.yaml` 及 `src/core/schema-pack/base/` 下全部 YAML）。缺少 `gbrain-base-v2.yaml` 时 `bun run build:win` 会失败，避免管理台再报 pack 无法解析。

## PMBrain 1.1.55

- 数据库目录里的 `.gbrain-lock.released-*` / `.stale-*` 不再无限堆积。获取或释放锁时自动清理：保留最近 3 天，超过 3 天也至少留最新 5 份；正在使用的 `.gbrain-lock` 和知识库文件不动。

## PMBrain 1.1.54

- 修复 Windows 上升级冷备校验副本时 PGLite WASM 中止后无法 `rename pg_wal`（`EPERM`），导致每次启动都卡在「服务没有成功启动」的问题。校验副本在发现未干净关闭后先做受保护 WAL 修复再打开，不再先打开再锁死文件。
- WAL 目录搬家遇到文件占用会自动重试；未改动数据库的忙碌失败不再进入 1 小时冷却，下次进程会在打开前修复。不删除、不重建用户知识库、向量、Wiki 或原始资料。

## PMBrain 1.1.53

- 修复异常关闭或向量任务被终止后 PGLite WAL/checkpoint 不完整，导致升级冷备校验持续报 `Aborted()`、Sidecar 无法启动的问题；按 GBrain 的受保护 WAL 自愈链路先留存修复前 WAL，再只重试一次，失败会恢复原状态。
- 冷备不再复制 `postmaster.pid`、`postmaster.opts` 和运行时 socket；损坏的冷备恢复副本通过同一受保护链路校验。首次健康启动后记录升级完成，后续启动不再重复冷备。
