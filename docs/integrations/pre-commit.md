# Brain 仓库的 Pre-commit 钩子（v0.22.4+）

`gbrain frontmatter install-hook` 在你的 brain 源的仓库中安装一个 git pre-commit 钩子，该钩子针对暂存的 `.md` 和 `.mdx` 文件运行 `gbrain frontmatter validate`。格式错误的 frontmatter 会阻止提交。使用 `git commit --no-verify` 绕过。

## 钩子捕获的内容

与 `frontmatter-guard` 技能和 `gbrain doctor` 的 `frontmatter_integrity` 子检查报告相同的七个验证类：

| 代码              | 捕获的内容                                                     |
|-------------------|---------------------------------------------------------------------|
| `MISSING_OPEN`    | 文件不以 `---` 开头                                       |
| `MISSING_CLOSE`   | 第一个标题之前没有关闭的 `---`                               |
| `YAML_PARSE`      | YAML 解析失败（语法或结构）                          |
| `SLUG_MISMATCH`   | frontmatter 中的 `slug:` 与路径派生的 slug 不匹配              |
| `NULL_BYTES`      | 内容中任何地方的二进制损坏（`\x00`）                  |
| `NESTED_QUOTES`   | `title: "outer "inner" outer"` 破坏 YAML 的形状               |
| `EMPTY_FRONTMATTER` | `---` ... `---` 之间没有任何有意义的内容                   |

## 安装

对于所有已注册为 git 仓库的源：

```bash
gbrain frontmatter install-hook
```

对于一个源：

```bash
gbrain frontmatter install-hook --source <id>
```

用于强制覆盖现有 pre-commit 钩子（写入 `.bak`）：

```bash
gbrain frontmatter install-hook --force
```

钩子位于 `<source>/.githooks/pre-commit`。如果 `core.hooksPath` 未设置，安装还会运行 `git config core.hooksPath .githooks`，以便无需手动 git 配置即可接收钩子。

## 绕过

标准 git 逃生舱口：

```bash
git commit --no-verify
```

这会跳过所有 pre-commit 钩子。谨慎使用 — 下次用户运行 `gbrain doctor` 时，问题会出现。

## 卸载

```bash
gbrain frontmatter install-hook --uninstall
```

如果在安装期间保存了 `.bak`，它会恢复为活动钩子。否则钩子会被干净地移除。

## 没有安装 gbrain 的机器上的行为

钩子脚本检查 `$PATH` 上的 `gbrain`。缺少时，它会向 stderr 打印一行警告并以退出码 0 退出 — 仅仅因为开发人员尚未在本地安装 gbrain，提交就不会被阻止。一旦安装了 gbrain，钩子就会恢复阻止格式错误的页面。

## 对于下游 agent 分叉

如果你的 OpenClaw 在不是 brain 仓库本身的宿主仓库中包装 gbrain，你可能需要单独的钩子策略：

- **Brain 仓库就是宿主仓库**（gbrain 技能和 brain 页面在一个仓库中）：
  通过 `gbrain frontmatter install-hook` 如上安装。
- **Brain 仓库是单独的已注册源**（例如 `~/brain` 注册为源，宿主仓库是 `~/agent-fork`）：仅安装在 brain 仓库中；
  agent-fork 代码不需要此钩子。
- **Brain 仓库是自动生成的**（例如由写入
  存储桶的同步守护程序）：完全跳过钩子；改为通过
  `import { writeBrainPage } from 'gbrain/brain-writer'`（计划在
  更高版本中；目前 CLI 是表面）在写入器处设置网关。

## 它如何融入更广泛的 frontmatter 管道

```
agent 写入页面          git 提交                 doctor 扫描
       ↓                          ↓                          ↓
[源内容]   →  [pre-commit 钩子验证]   →  [frontmatter_integrity 检查]
       ↓                          ↓                          ↓
  磁盘上的原始文件       阻止格式错误的提交     显示现有问题
                                                             ↓
                                                  `gbrain frontmatter validate
                                                   <source-path> --fix`
                                                   （写入 .bak 备份）
```

钩子是写入时网关；doctor 是审计网关；CLI 是修复工具。它们共享 `parseMarkdown(..., {validate:true})` 作为什么算作格式错误的单一事实来源。

---
*是 [GBrain 文档](../../README.md) 的一部分。*
