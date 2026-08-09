# PMBrain 数据记录边界

PMBrain 同时保护原始资料和数据库内知识。任何一方都不能被简单假设为“随时可从另一方完整
重建”。老用户可能拥有只存在数据库中的页面、标签、权限、审计、回收站和向量状态。

## 数据分类

### 受保护的原始数据

- 用户注册到 Source 的原始文件；
- 导入后保存的页面正文和分块正文；
- Wiki 与用户编辑内容；
- DB-only 页面、标签、权限、审计和回收站记录。

项目升级、测试、修复和打包不得删除、覆盖或批量改写这些数据。

### 可重建的派生数据

只有被代码和操作明确列入白名单的派生数据才可以重建，例如：

- Embedding 向量；
- 查询缓存；
- 检索索引；
- 可验证来源的部分派生关系或统计。

即使属于派生数据，也必须由用户明确授权，并且先验证不会影响原始页面、分块和 Source。

### 运行与审计状态

任务记录、迁移状态、锁、权限和审计不是普通缓存。不得为了“恢复运行”直接清空。

## 写入路径

```text
Source 原始资料
  → import / sync
  → pages + chunks + raw data
  → extract / Dream
  → facts + links + takes + derived pages
  → embedding / retrieval indexes
```

关键实现：

- `src/core/import-file.ts`、`src/core/sync.ts`
- `src/core/engine.ts`
- `src/core/pglite-engine.ts`、`src/core/postgres-engine.ts`
- `src/core/cycle/`
- `src/core/migrate.ts`

## 修复原则

1. 先区分初始化、锁、WASM、权限、catalog、迁移和业务查询阶段。
2. PGLite 恢复实验使用数据库副本，不操作活动目录。
3. 不删除活动进程持有的锁，不允许两个所有者同时写同一目录。
4. 迁移完成以实际 Sidecar 健康和数据烟雾测试为准，不以 schema 版本号或构建成功为准。
5. 向量模型切换保留页面和分块，只处理明确授权的派生向量。
6. 数据库结构修改同时验证 PGLite 与 Postgres。
