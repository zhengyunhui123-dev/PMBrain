# AGENTS.md

## 阅读顺序

1. AGENTS.md
2. CLAUDE.md
3. skills/
4. wiki/

## 信任边界

* Local = Trusted
* Agent = Semi Trusted
* Public = Untrusted

Agent 不允许：

* 删除原始资料
* 覆盖 Wiki
* 批量修改知识库

## 常见入口

* 架构：CLAUDE.md
* 技能：skills/
* 知识库：wiki/
* 原始资料：sources/

## 工作原则

* 先检索再回答
* 优先更新 Wiki
* 不修改原始资料
* 保持知识链接完整
