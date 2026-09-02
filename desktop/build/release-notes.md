## PMBrain 1.1.62

- 修复快速维护在 extract 之后看起来卡住：历史关系补抽会显示 `extract.stale` 进度。导入若撞上 PGLite GIN 索引损坏（`right sibling of GIN page is of different type`），会先重建索引再重试，避免每次整库 2000 多文件失败后无法推进 Git 书签。

## PMBrain 1.1.61

- 修复 AI 深度整理卡在「权重计算」且长时间无进度的问题。读取标签/观点时不再全表聚合，写入按 500 页一批更新，并打出 load/write 起止进度，便于区分卡在读还是写。

## PMBrain 1.1.60

- 修复更新后快速维护卡在 `cycle.sync` / `sync.detect_head` 的问题。Windows 上不再用 `git diff -M HEAD` 扫工作区，也不再把整个仓库打 tar 展开；改为 `git status --porcelain` 检查未提交文件，并用 `git checkout` 只取出需要导入的已提交文件。

## PMBrain 1.1.59

- 首页 Advisor 的孤立知识按钮改为「查看孤立知识」，直接打开知识图谱的孤立视图；不再把只读扫描 `dream --phase orphans` 冒充为关系整理，也不会无依据自动创建关系。
- 修复向量模型切换后 Sidecar 重启覆盖选择按钮、页面一直停在「正在保存并重启」的问题；修复 Windows 打包运行时完成 import 后不退出或过早退出丢失结果的问题。

## PMBrain 1.1.58

- 修复 1.1.57 的发布门禁：向量模型切换后的“继续等待”选择由独立桌面模块协调，Windows 真实用户旅程会明确选择继续重建；同步更新安全回归契约与 Admin 内嵌资源，避免源码功能已更新但安装包仍携带旧管理台。



