# PMBrain 的知识库与 Source

PMBrain 使用一个数据库管理多个 Source。AI 修改 Source、检索范围或导入行为时，先理解
`source_id` 如何沿调用链传递，不需要先阅读整个仓库。

## 两个概念

### 知识库数据库

数据库保存页面、分块、标签、关系、向量、任务状态、权限和审计记录。运行引擎可以是
PGLite 或 Postgres，但上层使用同一个 `BrainEngine` 合同。

### Source

Source 是数据库内的资料边界。每个页面由 `(source_id, slug)` 唯一确定，因此两个 Source
可以拥有相同 slug，而不会被视为同一页面。

Source 记录可以包含：

- `id`：稳定的 Source 标识；
- `name`：界面显示名称；
- `local_path`：本地原始资料目录；
- Git 或远程来源配置；
- 归档、同步和健康状态。

## 主 Source 与 `default`

PMBrain 可以配置主 Source。调用没有显式传入 Source 时，解析器按以下顺序选择：

1. 显式 `--source` 或 API 参数；
2. `PMBRAIN_SOURCE`；
3. 当前目录向上查找 `.pmbrain-source`；
4. 与当前目录匹配的已注册 `local_path`；
5. 配置的主 Source；
6. 兼容回退 `default`。

旧版 `GBRAIN_SOURCE` 和 `.gbrain-source` 仍可读取，但新文档和新配置只使用 PMBrain 名称。

`default` 不是“把所有 Source 合并”的开关。Source 内实体优先；跨 Source 读取必须由调用者
显式限定或获得 federated read 权限，同名实体不会自动合并。

## 代码调用链

```text
CLI / Admin / MCP 参数
  → src/core/source-resolver.ts
  → src/core/sources-load.ts / sources-ops.ts
  → Operation 或 Command
  → BrainEngine（source_id + slug）
```

主要文件：

- `src/core/source-id.ts`：Source ID 规则；
- `src/core/source-resolver.ts`：默认 Source 解析；
- `src/core/sources-load.ts`：Source 配置读取；
- `src/core/sources-ops.ts`：注册、更新和远程 Source 操作；
- `src/commands/sources.ts`：CLI；
- `src/commands/serve-http.ts`：Admin Source 接口；
- `src/core/operations.ts`：MCP/Operation Source 合同。

## 数据安全边界

- 添加、同步或归档 Source 不得删除原始资料。
- 代码升级不得把多个 Source 的同名 slug 覆盖到同一路径。
- 导出全库快照时，第一层按 Source 分目录，Source 内保持原 slug 结构。
- Source 配置迁移必须脱敏，不能把凭证写入公开文件、日志或导出物。
- 涉及 Source 的数据库修改必须同时验证 PGLite 和 Postgres。
