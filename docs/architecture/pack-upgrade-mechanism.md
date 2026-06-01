# 包升级机制 (v0.41.22)

> `gbrain-base@1.x → gbrain-base-v2@1.0.0`（以及任何未来的包
> 继承）如何通过机载大教堂进行连接的。

## 契约

Schema 包清单可以声明 `migration_from` 字段：

```yaml
api_version: gbrain-schema-pack-v1
name: gbrain-base-v2
version: 1.0.0
migration_from:
  pack: gbrain-base
  version: "1.x"
```

当此声明存在 + `mapping_rules:` 块
已填充时，包会将自己注册为
`(parent_pack, version_range)` 的继承者。任何活动包与此
元组匹配的大脑都会点亮 `pack_upgrade_available` 登机
检查。

## 端到端流程

```
┌────────────────────────────────────────────────────────────────┐
│  PACK 创作                                                │
│                                                                │
│  Author declares: migration_from: {pack: P, version: R}        │
│  + mapping_rules: [retype/page_to_link/page_to_alias]          │
│  Pack ships bundled OR via ~/.gbrain/schema-packs/<name>/      │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  ONBOARD 检查发现                                       │
│                                                                │
│  checkPackUpgradeAvailable(engine) at src/core/onboard/        │
│  checks.ts:                                                    │
│    1. Read engine.getConfig('schema_pack') for dbConfig tier  │
│    2. loadActivePack({cfg: null, remote: false, dbConfig})    │
│    3. findPackSuccessors(active.name, active.version)         │
│         → walks BUNDLED_PACK_NAMES + ~/.gbrain/schema-packs/   │
│         → matches via _versionRangeMatches(version, range)    │
│         → returns ResolvedPack[] sorted by successor version  │
│    4. If successors.length > 0, emit OnboardCheckResult        │
│       with RemediationStep targeting `unify-types` handler    │
│       + protected: true (D17 → manual_only via render          │
│       allowlist)                                               │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  USER 决定                                                  │
│                                                                │
│  gbrain onboard --check shows finding                          │
│  gbrain onboard --check --explain shows per-cluster narrative  │
│  User reviews; if OK, runs:                                    │
│    gbrain jobs submit unify-types --allow-protected \          │
│      --params '{"target_pack":"gbrain-base-v2"}'               │
│  (Autopilot never auto-fires this; manual_only)                │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  HANDLER 执行 (src/core/schema-pack/unify-types-handler.ts) │
│                                                                │
│  1. 预检：加载目标包；断言 mapping_rules 存在  │
│  2. 统计快照（用于庆祝的 pre-state）                 │
│  3. 获取 gbrain-unify db-锁 (60 分钟 TTL)                   │
│  4. 应用阶段 (4):                                          │
│     a. 显式重类型规则（分块 UPDATE 1000/批）       │
│        - frontmatter.legacy_type 始终保留 (D8)         │
│        - 设置 subtype 时标记 frontmatter.subtype          │
│     b. 包罗万象的重类型：为每个未知类型合成规则       │
│        excluding declared types + explicit targets + page_to_  │
│        link/alias sources (D12 + 关键错误修复)             │
│     c. 页面到链接：解析正文+frontmatter，插入链接行，  │
│        soft-delete 源页面（每页面原子性，根据 F7）     │
│     d. 页面到别名：插入 slug_aliases 行，soft-delete     │
│        source page (NO rewriteLinks 根据 D15)                   │
│  5. 最终同步：path-prefix 对剩余 UNTYPED 行的类型   │
│  6. ACTIVE-PACK 翻转 (D13):                                    │
│     - engine.setConfig('schema_pack', target_pack)             │
│     - saveConfig({...existing, schema_pack: target_pack})      │
│  7. 验证：重新运行统计；信息警告如果 ≤ declared + 5 违反      │
│  8. 庆祝摘要到 stderr + 审计 JSONL                │
│  9. 释放 db-锁                                            │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  POST-UPGRADE 状态                                            │
│                                                                │
│  • pages.type 使用规范类型更新                     │
│  • frontmatter.legacy_type 保留用于回滚              │
│  • slug_aliases 填充用于 old-slug → canonical lookup      │
│  • links 表具有新的 partner_of / relates_to 行            │
│  • 源页面 soft-deleted (72 小时 TTL 用于还原）             │
│  • Active pack 翻转到 target_pack                          │
│  • Next gbrain onboard --check shows ok                        │
└────────────────────────────────────────────────────────────────┘
```

## 版本范围语义

`migration_from.version` 接受三种形状：

| 形式 | 匹配 |
|------|---------|
| `1.0.0`（精确字面量） | 仅 `1.0.0` |
| `1.x`（major 通配符） | `1.0.0`、`1.5.2`、`1.99.99` |
| `1.0.x`（minor 通配符） | `1.0.0`、`1.0.5`、`1.0.99` |

`*` 作为 `x` 的别名被接受。

实现：`src/core/schema-pack/load-active.ts` 中的 `_versionRangeMatches(version, range)`。由
`test/schema-pack-find-pack-successors.test.ts` 固定。

## findPackSuccessors 发现

遍历 `BUNDLED_PACK_NAMES`（当前为 `gbrain-base`、
`gbrain-recommended`、`gbrain-creator`、`gbrain-investor`、
`gbrain-engineer`、`gbrain-everything`、`gbrain-base-v2`）。对于每个
候选者 ≠ 活动包名称，通过
`loadActivePack({ perCall: candidate })` 加载清单，检查
`migration_from.pack === activeName && _versionRangeMatches(activeVer,
migration_from.version)`。返回按版本降序排序的匹配包。

v0.41.22 仅涵盖捆绑包。v0.43+ TODO：枚举用户安装的
包 `~/.gbrain/schema-packs/*/pack.yaml`（推迟到 v0.43，因为
文件系统扫描成本需要来自
`registry.ts` 的缓存失效策略）。

## manual_only 应用策略

已发布的登机契约具有 3 个 apply_policy 值：

| 策略 | 含义 |
|--------|---------|
| `auto_apply` | 自动驾驶无人值守运行 |
| `prompt_required` | 自动驾驶在 `--auto-with-prompt` 模式下提示用户 |
| `manual_only` | 自动驾驶永不自动触发；用户必须显式提交 |

`pack_upgrade_available` 发出带有 `protected:
true` + `job: 'unify-types'` 的 `RemediationStep`。`toOnboardRecommendation` 在
`src/core/onboard/render.ts` 中通过
`MANUAL_ONLY_PROTECTED_JOBS` 允许列表将此映射到 `manual_only`（根据 v0.41.18 A12+A24，其中还包含
`extract-takes-from-pages`）。

基本原理：包升级会更改大脑的分类法。分类法是
用户的判断调用 — 而不是自动驾驶的调用。即使使用 `--auto-with-
prompt`，在 tick 期间提示用户确认包升级也是
错误的 UX（用户前来修复孤儿，而不是被中断
"嘿，想迁移你的分类法吗？"）。显式提交是
正确的边界。

## 创作继承者包

针对添加 `researcher` 规范
的学术研究人员大脑的最小示例：

```yaml
api_version: gbrain-schema-pack-v1
name: gbrain-academic-v1
version: 1.0.0
description: Academic research brain — adds researcher canonical
gbrain_min_version: 0.42.0
extends: null

migration_from:
  pack: gbrain-base-v2
  version: "1.x"

page_types:
  # 在此处继承 gbrain-base-v2 的 15 个类型（或使用 extends 在 v0.43+ extends-chain 组合落地时自动合并）
  - { name: person, primitive: entity, path_prefixes: [people/], expert_routing: true }
  - { name: company, primitive: entity, path_prefixes: [companies/], expert_routing: true }
  # ... 所有其他 13 个 v2 规范...
  - { name: note, primitive: concept, path_prefixes: [notes/], extractable: true }
  # 学术添加：
  - name: researcher
    primitive: entity
    path_prefixes: [researchers/]
    aliases: [academic, professor, scholar]
    extractable: false
    expert_routing: true

mapping_rules:
  # 所有 v2 映射规则（从 v2 yaml 复制）
  # ... ~40 个规则...
  # 自定义：将 v2 标记的学者重新定位到 researcher
  - { kind: retype, from_type: person, to_type: researcher, path_filter: 'researchers/%' }
  # 包罗万象
  - kind: retype
    from_type: "*unknown*"
    to_type: note
    subtype_field: legacy_type
    subtype: "*original_type*"
```

放到 `~/.gbrain/schema-packs/gbrain-academic-v1/pack.yaml` 中。
可通过 `gbrain schema list` 发现。可通过
`gbrain schema use gbrain-academic-v1` 激活。激活后，
`pack_upgrade_available` 检查会针对
`gbrain-base-v2@1.x` 上的任何大脑触发，并显露针对你的包的 `unify-types` RemediationStep。

## 锁 + 并发

`gbrain-unify` 是专用的 `gbrain_cycle_locks` 行名称（60 分钟
TTL）。处理程序在任何应用阶段之前获取它，并在
`finally` 中释放。两个同时的 `gbrain jobs submit unify-types`
调用：第二个在锁获取时快速失败，并带有明确的
错误。与 `gbrain-sync` 相同的模式（v0.22.13 PR #490）。

## 审计跟踪

每次统一运行都会写入 `~/.gbrain/audit/schema-unify-YYYY-Www.jsonl`
（ISO 周轮换，镜像现有审计通道）。记录：包
标识（之前 + 之后）、每阶段计数（would_apply + applied）、
警告、完成时间戳。隐私：页面别名不会在
批量中记录（仅每规则 sample_slugs[≤10]）；用于取证调试
添加 `GBRAIN_AUDIT_FULL=1`（v0.43+ TODO；尚未连接）。

## 尚不支持的内容

- 发布门的次级沙箱（v0.43+ TODO）
- 每来源包升级（处理程序接受 `sourceId` 但
  `findPackSuccessors` 尚未通过它）
- 对规范包有分歧的跨大脑联邦挂载
- 自动回滚（今天：手动 SQL 或 `gbrain pages restore`）
- 来自生产数据的 LLM 辅助 mapping_rules 代码生成（`gbrain
  schema detect-mappings`；推迟到 v0.43+）

## 参考

- 包文件：`src/core/schema-pack/base/gbrain-base-v2.yaml`
- 清单扩展：`src/core/schema-pack/manifest-v1.ts`
- 继承者遍历器：`src/core/schema-pack/load-active.ts:findPackSuccessors`
- 登机检查：`src/core/onboard/checks.ts:checkPackUpgradeAvailable`
- 渲染允许列表：`src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS`
- 处理程序：`src/core/schema-pack/unify-types-handler.ts`
- 迁移：`src/core/migrate.ts:105`（slug_aliases 表）
- 类型分类法文档：`docs/architecture/type-taxonomy.md`
- 技能：`skills/schema-unify/SKILL.md`
