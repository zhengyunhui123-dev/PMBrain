# RLS 与你

简短版：你的 gbrain `public` 模式中的每个表都需要启用行级安全（RLS）。如果有表未启用，`gbrain doctor` 现在会失败而非警告，并且进程退出码为 1。

本指南解释原因、遇到检查时该怎么做，以及当你确实希望某个表保持 anon key 可读取时的逃生舱。

## 为什么 RLS 重要

Supabase 通过 PostgREST 暴露 `public` 模式中的所有内容。该模式中的任何内容都可以通过 anon key 访问，而 anon key 在设计上是一个客户端密钥。如果公共表上 RLS 关闭，anon key 就可以读取它。对于任何敏感数据（身份验证令牌、聊天记录、财务数据），这是一个数据泄露向量，而不仅仅是误操作。

gbrain 的服务角色连接持有 `BYPASSRLS`，因此启用 RLS 但没有策略并不会破坏 gbrain 本身。它只是阻止 anon key 的默认读取。这就是安全姿态：对 anon key 默认拒绝，对服务角色完全访问。

## doctor 失败时的应对措施

Doctor 的消息会列出每个缺少 RLS 的表，并为每个表提供 `ALTER TABLE` 行：

```
1 table(s) WITHOUT Row Level Security: expenses_ramp.
Fix: ALTER TABLE "public"."expenses_ramp" ENABLE ROW LEVEL SECURITY;
If a table should stay readable by the anon key on purpose, see
docs/guides/rls-and-you.md for the GBRAIN:RLS_EXEMPT comment escape hatch.
```

99% 的情况下，你需要这个修复。运行 SQL。重新运行 `gbrain doctor`。完成。

## v0.26.7 — 自动 RLS 事件触发器和一次性回填

从 v0.26.7（迁移 v35）开始，gbrain 附带两项更改，消除了表可以在没有任何 RLS 的情况下存在于你的 `public` 模式中的间隙。

**1. 事件触发器。** 一个名为 `auto_rls_on_create_table` 的 Postgres DDL 事件触发器在每次新创建的 `public.*` 表上运行 `ALTER TABLE … ENABLE ROW LEVEL SECURITY`。它覆盖 `CREATE TABLE`、`CREATE TABLE AS … SELECT` 和 `SELECT … INTO` — Postgres 报告为表创建命令的每个语法。由 gbrain 本身、共享同一 Supabase 项目的其他应用（Baku、Hermes、任何应用）或人工运行原始 SQL 创建的表，在它们存在的那一刻就会启用 RLS。

非 `public` 模式（`auth`、`storage`、`realtime` 等）被明确忽略 — Supabase 管理这些，我们不应触碰它们。

**2. 一次性回填。** 当你升级到 v0.26.7 时，迁移会遍历每个现有 `public.*` 基表，如果其 RLS 关闭且注释不携带 `GBRAIN:RLS_EXEMPT` 豁免（见下文），则在每个表上启用 RLS。升级后，`gbrain doctor` 的 `rls` 检查在每个 brain 上都应该是无操作的。

### 破坏性变更：升级前请阅读此部分

如果你有故意关闭 RLS 并希望保持这种状态的公共表，则必须**在**运行 `gbrain upgrade` 到 v0.26.7 **之前**添加 `GBRAIN:RLS_EXEMPT` 注释。回填会为任何不携带下面记录的精确注释合约的公共表启用 RLS。迁移没有 `--dry-run` 标志。

搞错这一点的代价最小是一轮往返：操作员在应该豁免的表上运行 SQL 以启用 RLS，然后 `ALTER TABLE … DISABLE ROW LEVEL SECURITY` 并添加豁免注释以防止在后续 doctor 运行时再次翻转。不会丢失数据。

### 跨应用影响

如果非 gbrain 应用（Baku、Hermes、你编写的脚本、任何应用）在同一 Supabase 项目中创建表，触发器也会在这些表上启用 RLS。有两种处理方法：

1. **应用的连接角色具有 BYPASSRLS**（例如，它也使用 `postgres` 角色）。新创建的表会启用 RLS，但应用可以自由读取/写入，因为 BYPASSRLS 完全绕过策略。
2. **应用的角色不具有 BYPASSRLS。** 然后应用需要在创建表后立即添加 `CREATE POLICY`，授予自己所需的读取/写入访问权限。触发器不会添加策略 — 它只启用 RLS，保持默认拒绝姿态，直到应用的策略生效。

如果两个条件都不满足，应用将无法读取其自己新创建的表。修复在应用端，而不是 gbrain 端：要么授予 BYPASSRLS，要么提供策略。

### 如果触发器被删除会怎样？

`gbrain doctor` 包含一个新 `rls_event_trigger` 检查，验证触发器已安装并启用。如果由于任何原因（调试、迁移测试、任何原因）手动删除它，doctor 会警告并给你恢复命令：

```
gbrain apply-migrations --force-retry 35
```

重新运行迁移 v35 是幂等的 — 它会 `DROP EVENT TRIGGER IF EXISTS` 并干净地重新创建。

### 为什么不用 FORCE ROW LEVEL SECURITY？

Postgres 有两个 RLS 拨盘。`ENABLE` 阻止 anon/已验证用户；`FORCE` 还阻止表所有者，除非他们持有 BYPASSRLS。我们仅使用 `ENABLE`，与 `src/schema.sql`、迁移 v24 和 v29 中的姿态匹配。`FORCE` 会将非 BYPASSRLS 应用拒之于其自己新创建的表之外（触发器函数继承调用者的角色，而不是 gbrain 角色）— 这违背了上述跨应用共存故事。如果你想要特定 gbrain 拥有的表上的深度防御 `FORCE`，请在自己的迁移中显式添加；gbrain 的自动 RLS 默认不选择加入。

## 1% 的情况：故意豁免

有时公共表应该可以由 anon key 读取。支持公共仪表板的分析视图。只读参考表。提供自己的前端并故意使用 anon key 进行读取的插件。

gbrain 有一个逃生舱。它故意设置得很麻烦。这就是功能。

### 格式

```sql
-- 在 psql 中，以 BYPASSRLS 角色连接（例如 postgres）：
COMMENT ON TABLE public.your_table IS
  'GBRAIN:RLS_EXEMPT reason=<为什么这故意让 anon 可读>';
```

规则：

- 注释值必须以 `GBRAIN:RLS_EXEMPT` 开头（区分大小写）。
- 它必须包含 `reason=` 后跟至少 4 个字符的理由。
- 没有其他选项，配置文件中没有复选框，没有环境变量。只有 Postgres 表注释才算数。
- 如果表上的 RLS 也关闭（为了让 anon key 实际读取，必须如此），你还需要显式地 `ALTER TABLE ... DISABLE ROW LEVEL SECURITY;`。仅禁用是不够的；注释告诉 doctor 这是故意的。

### 示例

```sql
ALTER TABLE public.expenses_ramp DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses_ramp IS
  'GBRAIN:RLS_EXEMPT reason=analytics-only, anon-readable ok, owner=garry, 2026-04-22';
```

之后，`gbrain doctor` 报告：

```
rls: ok — RLS enabled on 20/21 public tables (1 explicitly exempt: expenses_ramp)
```

注意，后续每次运行都会按名称重新枚举你的豁免。这是故意的。逃生舱不是一次性签字，而是重复提醒。如果你想知道哪些表是开放的，运行 `gbrain doctor`。

## 为什么是 SQL 而不是 CLI 子命令

gbrain 不提供 `gbrain rls-exempt add <table>` 命令。CLI 命令会让代理悄无声息地将表打开给 anon 读取。psql 中的注释要求强制操作员在 SQL 中输入理由，这是：

- 在 shell 历史记录中可见。
- 在 git 跟踪的模式转储中可见。
- 在下次恢复时在 `pg_dump` 输出中可见。
- 在每次运行时在 `gbrain doctor` 输出中可见。

代理仍然可以运行 SQL，但无法在用户看不到操作的情况下这样做。这就是"用血写下来"的设计。

## 稍后审计豁免

要查看当前数据库中的每个豁免：

```sql
SELECT
  c.relname AS table_name,
  obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND obj_description(c.oid, 'pg_class') LIKE 'GBRAIN:RLS_EXEMPT%';
```

如果那个列表比你记得签字批准的要长，那就是信号。

## 移除豁免

只需删除注释并重新启用 RLS：

```sql
ALTER TABLE public.expenses_ramp ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses_ramp IS NULL;
```

`gbrain doctor` 停止将表列为豁免，并像其他任何表一样重新检查它。

## PGLite

如果你使用 PGLite（零配置默认值），doctor 完全跳过此检查：PGLite 是嵌入式、单用户，并且前面没有 PostgREST。公共模式暴露风险不存在。你会看到：

```
rls: ok — Skipped (PGLite — no PostgREST exposure, RLS not applicable)
```

如果你稍后迁移到 Supabase 或自托管 Postgres，检查会开始运行，并标记任何在没有 RLS 的情况下过来的表。

## 自托管 Postgres

如果你运行 Postgres 且前面没有 PostgREST，anon key 暴露不适用。但 gbrain 仍然会因缺少 RLS 而使检查失败，因为：

- 框架是"所有公共表上的 RLS"是 gbrain 安全不变量，而不是特定于 Supabase 的变通方法。
- `ALTER TABLE ... ENABLE RLS` 修复在任何 Postgres 上都是无害的：它只约束非 bypass 角色，而 gbrain 不使用这些角色。
- 如果你稍后将 PostgREST 或类似工具放在前面，防护已经到位。

如果这个框架不适合你的部署，请提交带有详细信息的 issue，以便我们决定是否证明自托管豁免模式是合理的。
