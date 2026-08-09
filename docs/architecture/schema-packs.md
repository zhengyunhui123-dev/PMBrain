# PMBrain Schema 包

Schema 包描述知识库允许的页面类型、目录前缀、关系动词和类型推断规则。它是可选的
结构约束，不替代 Source 边界，也不会授权 PMBrain 自动改写用户资料。

机器合同和解析实现位于 `src/core/schema-pack/`。

## 内置包

- `gbrain-base`：兼容既有安装的基础类型集合。
- `gbrain-recommended`：面向项目与个人知识管理的扩展类型集合，来源文件为
  `src/core/schema-pack/base/gbrain-recommended.yaml`。

这些 `gbrain-*` 名称属于已有数据和包清单的兼容标识，不代表 AI 应读取上游 GBrain 文档。

```powershell
pmbrain schema list
pmbrain schema show
pmbrain schema active
pmbrain schema validate
pmbrain schema use gbrain-recommended
```

自定义包保存在当前 PMBrain 配置目录下的 `schema-packs/<name>/pack.yaml`。旧安装可能仍从
`.gbrain` 兼容目录读取；不要仅为改名移动或重建用户包。

## 选择顺序

活动包由显式命令参数、进程配置、Source/仓库配置和用户配置共同决定，最后回退到
`gbrain-base`。需要确认实际结果时运行 `pmbrain schema active`，不要根据某一份配置文件猜测。

## 创建和检查

```powershell
pmbrain schema init my-pack
pmbrain schema fork gbrain-base my-pack
pmbrain schema validate my-pack
pmbrain schema diff gbrain-base my-pack
pmbrain schema lint
```

先用 `validate` 和 `diff` 检查，再由用户显式运行 `schema use`。Schema 变更可能影响页面
类型推断和 Dream 行为，但不应自动批量回填、迁移或删除已有页面。

## 回退

```powershell
pmbrain schema downgrade --to gbrain-base
pmbrain schema active
```

回退只恢复活动包选择。涉及页面内容、关系或数据库回填的操作必须单独获得用户授权，
并同时验证 PGLite 与 Postgres。

## 包格式兼容

清单继续使用现有 API 标识：

- `gbrain-schema-pack-v1`
- `gbrain-skillpack-v1`

这些值是序列化合同，不能作为品牌文案直接替换。修改格式时必须先检查旧包兼容性和
`src/core/schema-pack/types.ts` 的真实约束。
