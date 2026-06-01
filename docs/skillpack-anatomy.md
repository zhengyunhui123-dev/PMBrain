# Skillpack解剖

第三方gbrain skillpack外观的规范单页参考。位于`examples/skillpack-reference/`的参考pack是此页面描述的实时工件；克隆其树，您就有一个10/10的起点。

## 树

```
my-skillpack/
├── skillpack.json                # 清单（声明的cathedral字段）
├── skills/
│   └── <skill-slug>/
│       ├── SKILL.md              # frontmatter + body, 代理可读
│       └── routing-eval.jsonl    # >= 5个意图固定trigger -> skill
├── runbooks/
│   └── bootstrap.md              # scaffold后显示（不是执行器）
├── test/
│   └── *.test.ts                 # bun:test单元测试
├── e2e/
│   └── *.test.ts                 # 集成测试, gated on DATABASE_URL
├── evals/
│   └── *.judge.json              # LLM-judge评估配置（每个>= 3个案例）
├── CHANGELOG.md                  # Keep-a-Changelog形状
├── LICENSE                       # SPDX匹配文本
├── README.md
└── .gitignore
```

`gbrain skillpack init <name>`搭建此确切的树，预先填充在`gbrain skillpack doctor . --quick`上立即得分10/10的存根。用真实内容替换存根，在编辑之间运行doctor，然后`gbrain skillpack pack`生成一个确定性的`<name>-<version>.tgz`准备好发布到注册表。

## 代理如何使用scaffolded pack

在`gbrain skillpack scaffold <source>`落地文件之后：

1. 用户的代理在启动或每条消息时遍历`skills/*/SKILL.md` frontmatter并读取每个pack的`triggers:`数组。
2. 当用户输入匹配触发器时，代理从头到尾读取该SKILL.md body作为上下文指令。
3. gbrain在scaffold之后显示一次`runbooks/bootstrap.md`但**不**自动执行它。代理决定是否遍历这些步骤。这是codex T1供应链加固：自动遍历器将允许恶意pack在安装时变异用户的brain，这就是npm postinstall攻击的发生方式。

## Doctor如何对pack评分

十个二进制维度。每个都由`src/core/skillpack/rubric.ts`中的纯函数检查，并返回`{passed, detail, fix_hint}`。Doctor按顺序遍历它们并打印分数 + 每维度状态 + 每次失败的粘贴就绪修复。

<!-- BEGIN auto-generated:rubric -->

### 核心维度（5；必须全部通过才能在任何层级发布）

| # | 名称 | 描述 | 自动修复 |
|---|------|-------------|--------------|
| 1 | `manifest_valid` | skillpack.json通过v1模式验证器 | 否 |
| 2 | `skills_have_skill_md` | 每个列出的skill都有SKILL.md，具有有效的frontmatter（name, description, triggers) | 否 |
| 3 | `routing_evals_present` | 每个skill都有routing-eval.jsonl，具有>= 5个意图 | 是 |
| 4 | `skills_have_unique_triggers` | 此pack中没有两个skill共享确切的触发短语（MECE） | 否 |
| 5 | `changelog_present_and_current` | CHANGELOG.md存在并包含当前版本的条目 | 是 |

### 质量徽章（5；赚取层级资格）

| # | 名称 | 描述 | 自动修复 |
|---|------|-------------|--------------|
| 6 | `unit_tests_present` | pack声明unit_tests[]，具有至少一个匹配测试文件 | 是 |
| 7 | `e2e_tests_present` | pack声明e2e_tests[]，具有至少一个匹配测试文件 | 是 |
| 8 | `llm_eval_present` | pack声明llm_evals[]，具有>= 1个包含>= 3个案例的文件 | 是 |
| 9 | `bootstrap_runbook_present` | pack声明runbooks.bootstrap并且文件非空 | 是 |
| 10 | `license_present` | LICENSE文件存在于pack根目录（信息徽章） | 是 |

_从`src/core/skillpack/rubric.ts`由`bun run scripts/build-skillpack-anatomy.ts`生成。_

<!-- END auto-generated:rubric -->

## 层级资格

| 层级 | 要求 |
|------|-------------|
| `endorsed` | 所有5个核心 + 所有5个徽章，加上注册表仓库中Garry的`endorsements.json`覆盖 |
| `community` | 所有5个核心 + >= 3个5徽章。PR合并时的默认层级。 |
| `experimental` | 所有5个核心 + < 3个徽章 |
| `blocked` | 任何核心维度失败 |

## CLI参考（第三方路径）

```bash
# 发布者侧
gbrain skillpack init my-pack         # scaffold树
gbrain skillpack doctor my-pack       # 查看分数 + 修复提示
gbrain skillpack doctor my-pack --fix --yes  # 自动搭建缺失的部分
gbrain skillpack pack my-pack         # 确定性tarball + SHA-256

# 消费者侧
gbrain skillpack search <query>       # 浏览注册表
gbrain skillpack info <name>          # 显示完整的pack元数据
gbrain skillpack scaffold <source>    # owner/repo, https, ./dir, ./*.tgz
gbrain skillpack registry --url X     # 指向自定义注册表
```

## 另见

- `examples/skillpack-reference/` — 实时10/10参考pack
- `docs/designs/SKILLPACK_REGISTRY_V1_SPEC.md` — 战略规范和决策
- `docs/guides/skillpacks-as-scaffolding.md` — v0.36 scaffold/参考模型
