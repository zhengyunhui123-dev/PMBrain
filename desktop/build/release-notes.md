## PMBrain 1.1.64

- 搜索索引（GIN）损坏时不再整库恢复，也不再跳过知识页。确认数据库能打开后，按库里实际存在的 GIN 索引保存定义、删除并重建，再用真实搜索验证成功才提示「搜索索引修复完成」。数据库本身打不开时会明确提示需要先修库或恢复备份。

## PMBrain 1.1.63

- 修复从旧版升级时因向量列超过 2000 维无法创建 HNSW 索引而启动失败。升级按库里真实列宽跳过超限索引，搜索仍可用精确扫描；不覆盖、不重建用户向量和知识库。

## PMBrain 1.1.62

- 修复快速维护在 extract 之后看起来卡住：历史关系补抽会显示 `extract.stale` 进度。导入若撞上 PGLite GIN 索引损坏（`right sibling of GIN page is of different type`），会先重建索引再重试，避免每次整库 2000 多文件失败后无法推进 Git 书签。

## PMBrain 1.1.61

- 修复 AI 深度整理卡在「权重计算」且长时间无进度的问题。读取标签/观点时不再全表聚合，写入按 500 页一批更新，并打出 load/write 起止进度，便于区分卡在读还是写。

## PMBrain 1.1.60

- 修复更新后快速维护卡在 `cycle.sync` / `sync.detect_head` 的问题。Windows 上不再用 `git diff -M HEAD` 扫工作区，也不再把整个仓库打 tar 展开；改为 `git status --porcelain` 检查未提交文件，并用 `git checkout` 只取出需要导入的已提交文件。




