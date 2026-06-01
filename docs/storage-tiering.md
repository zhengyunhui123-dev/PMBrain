# 存储分层：db-tracked vs db-only目录

## 概述

GBrain支持存储分层，以将版本控制的内容与批量机器生成的数据分开。这可以防止git仓库因大量自动生成的内容而膨胀，同时仍将其保留在数据库中。

> 关于命名的说明：在v0.22.11之前，键是`git_tracked` / `supabase_only`。规范名称现在是`db_tracked` / `db_only`（引擎无关 — 在PGLite和Postgres上都工作）。已弃用的键仍然加载，并带有每次进程一次的警告。当该路径落地时，运行`gbrain doctor --fix`进行自动重命名。

## 配置

在brain仓库根目录的`gbrain.yml`文件中添加`storage`部分：

```yaml
storage:
  # 版本控制的目录（人工编辑，提交到git）。
  db_tracked:
    - people/
    - companies/
    - deals/
    - concepts/
    - yc/
    - ideas/
    - projects/

  # 仅通过brain数据库持久化的目录（批量机器生成的内容）。
  # 作为本地缓存写入磁盘，但不提交到git；
  # `gbrain sync`自动管理这些路径的.gitignore。
  # `gbrain export --restore-only`从数据库重新填充缺失的文件。
  db_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
```

路径要求：

- 每个目录必须以`/`结尾以采用规范形式。验证器自动规范化缺失的尾部斜杠（一次性信息注释显示更改的内容）。
- 目录不能出现在两个层级中 — 这是层级重叠错误，`loadStorageConfig`抛出`StorageConfigError`。编辑`gbrain.yml`以删除重叠，然后重试。

## 行为更改

### 1. `gbrain sync` — 自动.gitignore管理

当存在存储配置时，`gbrain sync`在每次成功同步时自动管理`.gitignore`条目：

- 将缺失的`db_only`目录模式添加到`.gitignore`。
- 幂等 — 重新运行不会添加重复的条目。
- 稳定注释头，以便管理的块可以被grep。
- 在`--dry-run`上跳过（不要在预览模式下变异磁盘）。
- 在`blocked_by_failures`状态上跳过（同步状态不一致）。
- 当仓库是git子模块（`.git`是文件，而不是目录）时跳过 — 子模块.gitignore更改不会在父更新中生存。会显示警告。
- 当设置了`GBRAIN_NO_GITIGNORE=1`时完全跳过（对于维护者希望gbrain单独放置.gitignore的共享仓库设置的逃生舱）。
- 失败（写入权限被拒绝等）被捕获并记录，永远不会使同步崩溃。

示例`.gitignore`添加：

```gitignore
# Auto-managed by gbrain (db_only directories)
media/x/
media/articles/
meetings/transcripts/
```

### 2. `gbrain export --restore-only` — 重新填充缺失的db_only文件

```bash
# 仅从数据库恢复缺失的db_only文件。
gbrain export --restore-only --repo /path/to/brain

# 按页面类型过滤。
gbrain export --restore-only --type media --repo /path/to/brain

# 按slug前缀过滤。
gbrain export --restore-only --slug-prefix media/x/ --repo /path/to/brain

# 组合过滤器。
gbrain export --restore-only --type media --slug-prefix media/x/ --repo /path/to/brain
```

`--restore-only`标志：

- 通过`--repo` → 类型化的`sources.getDefault()` → 硬错误解析repoPath。永远不会落到当前目录。
- 仅导出匹配`db_only`模式且磁盘上缺失的页面。
- 理想用于容器重启恢复和新鲜克隆。

### 3. `gbrain storage status` — 存储层级运行状况仪表板

```bash
# 人类可读的状态。
gbrain storage status --repo /path/to/brain

# 用于脚本和编排器的JSON输出。
gbrain storage status --repo /path/to/brain --json
```

输出包括：

- 按存储层级的页面总数。
- 按层级的磁盘使用情况细分。
- 需要恢复的缺失文件（显示前10个；完整列表在`--json`中）。
- 配置验证警告。
- 当前层级目录列表。

示例输出：

```
Storage Status
==============

Repository: /data/brain
Total pages: 15,243

Storage Tiers:
-------------
DB tracked:     2,156 pages
DB only:        12,887 pages
Unspecified:    200 pages

Disk Usage:
-----------
DB tracked:     45.2 MB
DB only:        2.1 GB

Missing Files (need restore):
-----------------------------
  media/x/tweet-1234567890
  media/x/tweet-0987654321
  ... and 47 more

Use: gbrain export --restore-only --repo "/data/brain"

Configuration:
--------------
DB tracked directories:
  - people/
  - companies/
  - deals/

DB-only directories:
  - media/x/
  - media/articles/
  - meetings/transcripts/
```

## 验证

`loadStorageConfig`在解析后运行`normalizeAndValidateStorageConfig`：

- 自动修复（静默，带一次性信息注释显示更改的内容）：
  - 添加缺失的尾部`/`：`'media/x'` → `'media/x/'`。
- 抛出`StorageConfigError`（调用者看到干净的exit-1，带有可操作的消息）：
  - 同一目录同时在`db_tracked`和`db_only`中（模糊路由）。

## 使用案例

### Brain仓库扩展

非常适合跨越50K-200K+文件的brain仓库，其中：

- 核心知识（people, companies, deals）保持git跟踪。
- 批量数据（tweets, articles, transcripts）移动到db_only。
- 开发保持快速，git仓库更小。
- 完整数据通过数据库保持可用。

### 基于容器的部署

对临时容器环境至关重要：

- Git仓库仅包含基本文件。
- 容器重启不会丢失db_only数据。
- `gbrain export --restore-only`在需要时快速恢复批量文件。
- 本地磁盘充当缓存层。

### 多环境一致性

实现跨环境的一致数据访问：

- 开发：小型git克隆，按需恢复批量数据。
- 生产：通过数据库的完整数据集，选择性本地缓存。
- CI/CD：仅使用git跟踪的数据进行快速测试。

## 迁移策略

1. **评估当前仓库**：使用`gbrain storage status`了解当前分布。
2. **计划目录结构**：确定哪些目录应该是db_tracked vs db_only。
3. **创建`gbrain.yml`**：将存储配置添加到仓库根目录。
4. **使用干运行测试**：`gbrain sync --dry-run`验证行为；`.gitignore`在干运行时不触及。
5. **运行真实同步**：`gbrain sync`成功时自动更新`.gitignore`。
6. **验证恢复**：针对小型db_only目录测试`gbrain export --restore-only --repo .`。

## 最佳实践

- **目录命名**：存储路径以`/`结尾（规范形式）。如果您忘记，验证器会规范化。
- **从小开始**：从`db_only`中明显机器生成的目录开始。
- **解决验证错误**：层级重叠是错误，而不是警告。在同步之前修复它。
- **测试恢复**：定期在staging环境中测试`--restore-only`。
- **记录决策**：注释您的`gbrain.yml`以解释层级选择。

## PGLite引擎说明

在PGLite引擎（gbrain的仅本地嵌入式Postgres）上，您的db_only页面所在的"DB"就是gbrain用于其他所有内容的本地文件。`.gitignore`内务处理仍然有帮助（使批量内容远离git历史），但卸载到DB的承诺在技术上是空的。每次进程一次的软警告在检测到引擎时解释。要获得完整的分层，请使用`gbrain migrate --to supabase`迁移到Postgres。

## 兼容性

- **向后兼容**：没有`gbrain.yml`的系统工作不变。
- **渐进式增强**：需要时添加配置。
- **数据库不变**：无论层级如何，所有数据都保留在Postgres中。
- **现有工作流**：保留所有现有的`sync`和`export`行为。
- **已弃用的键**：`git_tracked` / `supabase_only`仍然加载并带有每次进程一次的警告。
