# 升级和自动更新通知

## 目标

用户以对话方式收到新 GBrain 功能的通知，代理会引导他们完成升级，并进行后置升级迁移，使新版本实际工作。

## 用户获得什么

如果没有这个：GBrain 发布更新但没人知道。用户停留在具有陈旧技能和缺失功能的旧版本上。或者更糟的是，有人运行 `gbrain upgrade` 但跳过了后置升级步骤，让新代码与旧的代理行为一起运行。

有了这个：代理每天检查更新，用简洁的以利益为重点的项目符号推销升级，等待明确的许可，然后运行完整的升级流程，包括重新读取技能、运行迁移和同步模式。用户自动获得新功能。

## 实施

### 检查（cron 发起）

```
check_for_update():
  result = run("gbrain check-update --json")

  if not result.update_available:
    exit_silently()  // 不要给用户发消息

  // 推销升级 — 以他们现在可以做什么而不是改变了什么为先导
  message = compose_upgrade_message(
    current: result.current_version,
    latest: result.latest_version,
    changelog: result.changelog
  )
  send_to_user(message, respect_quiet_hours=true)
```

### 升级消息

推销升级。用户应该感觉到" hell yeah，我想要那个。" 以他们现在可以做什么而不是改变了什么的文件为先导。

```
> **GBrain v0.5.0 可用** (你在 v0.4.0 上)
>
> 新内容：
> - 你的 brain 永远不会落后。实时同步保持向量数据库自动更新，
>   因此编辑在几分钟内就会出现在搜索中
> - 新的验证运行手册在咬你之前捕获无声的失败
> - 新安装自动设置实时同步。不再有手动设置步骤
>
> 想要我升级吗？我会更新所有内容并刷新我的剧本。
>
> (回复 **yes** 升级，**not now** 跳过，**weekly** 较少检查，
> 或 **stop** 关闭更新检查)
```

### 处理响应

| 用户说 | 行动 |
|-----------|--------|
| yes / y / sure / ok / do it / upgrade | 运行完整的升级流程（如下） |
| not now / later / skip / snooze | 确认，下一周期再次检查 |
| weekly | 存储偏好，将 cron 切换到每周 |
| daily | 存储偏好，将 cron 切换回每日 |
| stop / unsubscribe / no more | 禁用 cron。告诉用户如何恢复 |

**永远不要自动升级。** 始终等待明确的确认。

### 完整升级流程（用户说 yes 后）

```
full_upgrade():
  // 第1步：更新二进制文件/包
  run("gbrain upgrade")

  // 第2步：重新读取所有更新的技能
  for skill in find("skills/*/SKILL.md"):
    read_and_internalize(skill)  // 更新的技能 = 更好的代理行为

  // 第3步：重新读取生产参考文档
  read("docs/GBRAIN_SKILLPACK.md")
  read("docs/GBRAIN_RECOMMENDED_SCHEMA.md")

  // 第4步：检查特定版本的迁移指令
  for version in range(old_version, new_version):
    migration = find(f"skills/migrations/v{version}.md")
    if migration exists:
      read_and_execute(migration)  // 按顺序，不要跳过

  // 第5步：模式同步 — 建议新的，尊重已拒绝的
  state = read("~/.gbrain/update-state.json")
  for recommendation in new_schema_recommendations:
    if recommendation not in state.declined:
      suggest_to_user(recommendation)
  update(state, new_choices)

  // 第6步：报告改变了什么
  summarize_to_user(actions_taken)
```

### 迁移文件

迁移文件位于 `skills/migrations/vX.Y.Z.md`。它们包含让新版本为现有用户工作的后置升级操作的代理指令（而不是脚本）。示例：v0.5.0 迁移设置实时同步并运行验证运行手册。

代理按版本顺序读取迁移文件并逐步执行它们。没有迁移，代理有新代码，但用户的环境还没有改变。

### Cron 注册

```
名称：gbrain-update-check
默认计划：0 9 * * *（每天上午 9 点）
每周计划：0 9 * * 1（周一上午 9 点）
提示："运行 gbrain check-update --json。如果 update_available 为 true，
  总结变更日志并给我发消息询问我是否想要升级。
  如果为 false，保持沉默。"
```

### 频率偏好

默认：每日。在代理内存中存储为 `gbrain_update_frequency: daily|weekly|off`。
也持久化在 `~/.gbrain/update-state.json` 中，以便它能在代理上下文重置后存活。

### 独立技能包用户

如果你直接加载此 SKILLPACK（复制或从 GitHub 读取）而没有安装 gbrain，你仍然可以保持最新。GBRAIN_SKILLPACK.md 和 GBRAIN_RECOMMENDED_SCHEMA.md 都有版本标记：

```bash
curl -s https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_SKILLPACK.md | head -1
# 返回：<!-- skillpack-version: X.Y.Z -->
```

如果远程版本较新，请获取完整文件并替换你的本地副本。设置每周 cron 以自动检查。

## 棘手的地方

1. **永远不要自动安装。** 升级必须始终等待用户的明确"yes"。即使 cron 在上午 9 点检测到更新并且变更日志看起来很棒，代理也会给用户发消息并等待。自动安装可能会破坏工作流、引入破坏性更改或中断正在进行的工作。

2. **迁移文件是代理指令，而不是脚本。** 它们用普通语言逐步告诉代理要做什么。它们不是要盲目执行的 bash 脚本。代理读取它们，理解上下文，并适应用户的特定环境（例如，如果用户已经配置了实时同步，则跳过步骤）。

3. **check-update 应该在每日 cron 上运行。** 不要依赖用户记住检查更新。cron 每天上午 9 点运行 `gbrain check-update --json`（尊重安静时间）。如果没有新内容，它会完全保持沉默。用户只在有值得升级的内容时才会听到更新。

## 如何验证

1. **运行 check-update 并验证检测。** 执行 `gbrain check-update --json`。验证它返回当前版本并正确报告是否有可用更新。如果 `update_available` 为 false，验证版本是否与 GitHub 上的最新版本匹配。

2. **验证迁移文件是可读的。** 列出 `skills/migrations/` 并检查每个文件是否遵循命名约定 `vX.Y.Z.md`。打开一个并验证它包含逐步的代理指令，而不是原始脚本。代理应该能够读取并执行每个步骤。

3. **端到端测试完整升级流程。** 如果有可用更新，说"yes"并观看代理执行完整流程：升级、重新读取技能、运行迁移、同步模式、报告。验证每个步骤完成并且代理报告改变了什么。

---
*属于 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
