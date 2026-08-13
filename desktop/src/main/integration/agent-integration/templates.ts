import type { AgentIntegration, AgentSkill } from './types.js';

export const WORKBUDDY_AGENT_PACK_VERSION = '1';

export const WORKBUDDY_SKILL_SLUGS = [
  'brain-first',
  'remember',
  'correction',
  'durable-writeback',
  'takes-review',
] as const;

export type WorkBuddySkillSlug = (typeof WORKBUDDY_SKILL_SLUGS)[number];

export const WORKBUDDY_AGENT_RULES_TEMPLATE = `---
enabled: true
alwaysApply: true
---

# PMBrain Agent Rules

> Official PMBrain Agent Pack v${WORKBUDDY_AGENT_PACK_VERSION} for WorkBuddy workspace scope.
> PMBrain 管理文件：请通过 PMBrain Desktop 安装、更新或卸载，不要把本文件当成用户全局规则。

PMBrain MCP 是唯一的数据访问通道。不得让 Skill 直接访问 PGLite/Postgres、扫描用户数据库目录，或绕过现有权限和确认机制。

## 1. Brain First

用户问题涉及项目、人物、公司、历史决策、用户过去表达过的观点、计划、任务、承诺或偏好时，在回答前优先查询 PMBrain。

- 优先使用 \`recall\` 或 \`query(expand=false)\`；调用 \`query\` 时参数形式为 \`expand: false\`。
- 需要原文、完整上下文或准确引用时，使用检索结果给出的精确 slug 调用 \`get_page\`。
- 不要一开始就使用高成本 \`query(expand=true)\`；只有直接检索结果不足且问题确实需要扩展时才升级。
- 不要为了普通问题连续无意义调用大量 MCP 工具。
- 不要为普通润色或闲聊无意义调用 PMBrain。

## 2. 不得把查询失败理解为“没有知识”

PMBrain 工具失败、超时或连接失败，只能说明工具当前不可用。明确告知用户工具失败，不得据此声称“PMBrain 中没有相关内容”。只有工具成功返回且已采用合理查询路径后，才能说明没有检索到相关内容。

## 3. 明确记忆

当用户说“记住这个”“保存一下”“以后按这个来”“这个很重要”“这是我的偏好”等明确记忆指令时，必须执行 \`remember\` Skill，通过 PMBrain 写入工具保存。优先更新已有知识对象，不制造重复页面；必要时读回验证。明确记忆只写入 PMBrain，不要复制到 WorkBuddy 内置 memory 或其他存储；\`put_page\` 成功或返回已存在后，最多读回一次并立即报告，不得对同一内容重复写入。

## 4. Durable Write Back

本轮形成明确且长期有效的决策、结论、用户偏好、承诺、项目状态变化或重要事实修正时，在合适时执行 \`durable-writeback\` Skill。用户已经明确要求“记住/保存”时只执行 \`remember\`，不要再对同一事实重复执行 \`durable-writeback\`。不要把普通闲聊、大量临时信息或 AI 自己的推测写成用户事实。

## 5. Correction

用户明确说“这个错了”“不是这样的”“我没说过这个”“你记错了”“信息已经变了”时，必须进入 \`correction\` Skill：查询记录和来源，判断错误类型，说明发现，再做低风险明确修正。涉及删除、大面积修改或来源冲突时先请求用户确认，禁止静默批量修改。

## 6. Takes Review

用户询问“最近发现了什么新观点”“有什么观点需要我审核”“看看待审核观点”时，执行 \`takes-review\` Skill。展示观点和依据；只有用户明确接受或拒绝具体条目后才改变状态。

## 7. Skill Routing

WorkBuddy workspace 的 PMBrain Skills 位于 \`.codebuddy/skills/<skill>/SKILL.md\`。匹配 Skill 时，读取对应 \`SKILL.md\` 的完整说明并按步骤执行，不要只凭 Skill 名称猜流程：

同一条消息按以下优先级只选择一个写入路由：纠错意图优先 \`correction\`，明确“记住/保存”优先 \`remember\`；两者已经处理的同一事实不得再执行 \`durable-writeback\`。\`durable-writeback\` 只处理本轮形成、但没有进入明确记忆或纠错路由的长期信息。

- \`brain-first\`：过去信息、项目、人物、决策、偏好与承诺的主动检索。
- \`remember\`：用户明确要求记住或保存。
- \`correction\`：用户指出记忆或事实错误。
- \`durable-writeback\`：本轮产生长期有效信息。
- \`takes-review\`：待审核观点的查看、接受与拒绝。

每个 Skill 的首步调试调用只是可观测性标记；调试工具失败不影响后续真实业务 MCP 工具，不能因此跳过检索、写入、纠错或审核流程。
`;

function skillTemplate(slug: WorkBuddySkillSlug, description: string, body: string): AgentSkill {
  return {
    slug,
    relativePath: `.codebuddy/skills/${slug}/SKILL.md`,
    content: `---\nname: ${slug}\ndescription: ${description}\n---\n\n${body.trim()}\n`,
  };
}

export const WORKBUDDY_SKILL_TEMPLATES: Readonly<Record<WorkBuddySkillSlug, AgentSkill>> = {
  'brain-first': skillTemplate(
    'brain-first',
    '用户询问过去信息、项目、人物、公司、决策、计划、任务、承诺或偏好时，先从 PMBrain 获取依据再回答。',
    `# Brain First

## 何时使用

用户的问题涉及过去信息、项目、人物、公司、历史决策、计划、任务、承诺、用户观点或偏好。普通润色、翻译、寒暄等不依赖历史知识的任务不要触发。

## 流程

0. **首步记录路由（best effort）**：先调用 \`agent_integration_debug\`，参数：

   \`\`\`yaml
   client: desktop-workbuddy
   agent_integration: deep
   skill: brain-first
   \`\`\`

   调试调用失败或工具暂不可用时，继续下面的实际业务工具流程；不得把调试失败当成 PMBrain 没有知识。
1. 从用户原话判断涉及的实体、主题、时间和 Source 线索，不擅自改写成猜测的关键词。
2. 对近期事实或热记忆优先调用 \`recall\`；一般问题调用 \`query\` 并显式传 \`expand: false\`。
3. 如果直接结果弱或为空，可用原始措辞做一次有针对性的 \`search\`；不要无意义连续调用大量工具，也不要直接升级到 \`expand: true\`。
4. 需要原文、完整页面或精确引用时，从检索结果复制精确 slug 调用 \`get_page\`，不得凭标题猜 slug。
5. 只基于成功返回的内容作答，区分 PMBrain 记录、用户本轮陈述和你的推断。

## 失败边界

工具失败、超时或连接失败表示 PMBrain 当前不可用，不表示“PMBrain 没有相关内容”。明确说明失败并停止臆断。`,
  ),
  remember: skillTemplate(
    'remember',
    '用户明确说记住、保存、以后按此执行或声明重要偏好时，把值得长期保存的信息写入 PMBrain。',
    `# Remember

## 触发

“记住”“保存这个”“以后按这个”“这个很重要”“这是我的偏好”等明确记忆意图。

## 流程

0. **首步记录路由（best effort）**：先调用 \`agent_integration_debug\`，参数：

   \`\`\`yaml
   client: desktop-workbuddy
   agent_integration: deep
   skill: remember
   \`\`\`

   调试调用失败不影响实际业务工具；继续完成查重、写入和验证。
1. 提取用户明确要求保存的原话、对象、适用范围和时间，不把 AI 推测混入用户事实。
2. 先用 \`recall\`、\`query\` 或 \`search\` 查找最合适的已有页面/知识对象。
3. 命中已有对象时先用 \`get_page\` 读取完整内容，优先更新已有页面，不制造重复页面。
4. 通过 PMBrain MCP \`put_page\` 写入；保留原有有效内容、来源和上下文，不直接访问数据库。同一事实本轮最多执行一次有效 \`put_page\`；返回已创建、已更新或已跳过均进入验证，不要用相同内容重试。
5. 最多调用一次 \`get_page\` 或检索工具读回，确认信息可查询且没有意外覆盖。验证成功后立即停止工具调用并报告完成；不要再写 WorkBuddy 内置 memory 或其他存储。
6. 如果写入目标、来源冲突或改动范围不明确，先询问用户，不擅自删除或批量改写。`,
  ),
  correction: skillTemplate(
    'correction',
    '用户指出记录错误、否认曾说过某事或说明信息已变化时，定位来源并安全纠正。',
    `# Correction

## 触发

“这个错了”“不是这样的”“我没说过”“你记错了”“这个信息已经变了”等明确纠错表达。

## 流程

0. **首步记录路由（best effort）**：先调用 \`agent_integration_debug\`，参数：

   \`\`\`yaml
   client: desktop-workbuddy
   agent_integration: deep
   skill: correction
   \`\`\`

   调试调用失败不影响实际业务工具；仍需查记录、查来源并完成安全纠错。
1. 用用户原话及相关实体调用 \`recall\`、\`query(expand=false)\` 或 \`search\`，找出具体错误记录。
2. 从结果复制精确 slug，用 \`get_page\` 读取记录、来源和关联上下文。
3. 判断错误属于哪一类：原始资料错误、AI 抽取错误、旧信息、重复知识、实体串线、无来源推断。
4. 向用户说明找到的具体记录、来源和判断；不要只回复“好的”。
5. 对目标唯一、低风险且用户修正明确的内容，通过 \`put_page\` 更新已有页面，并保留必要的变更上下文。若“这个”无法唯一定位，或用户只否认旧内容但没有给出正确替换文本，先追问，不得猜测写入。
6. 涉及删除、大面积修改、多个页面、原始资料或来源冲突时，先列明影响并请求确认。禁止静默批量修改，禁止修改原始资料。
7. 修正后再次 \`get_page\` 或检索，确认修正生效，并检查明显受影响的关联知识；不做未经确认的连带批改。`,
  ),
  'durable-writeback': skillTemplate(
    'durable-writeback',
    '当本轮产生长期有效的决策、偏好、承诺、状态变化或明确新事实时，选择性写回 PMBrain。',
    `# Durable Writeback

## 何时使用

本轮明确形成长期有效的决策、结论、用户偏好、承诺、项目状态变化或重要新事实。不是“每句话都记”。

用户已经明确要求“记住/保存”时由 \`remember\` 处理；如果本轮同一事实已经通过 \`remember\` 保存，不要再次触发本 Skill 或重复写入。

## 流程

0. **首步记录路由（best effort）**：先调用 \`agent_integration_debug\`，参数：

   \`\`\`yaml
   client: desktop-workbuddy
   agent_integration: deep
   skill: durable-writeback
   \`\`\`

   调试调用失败不影响实际业务工具；继续判断、查重和写回。
1. 区分用户明确确认的信息与 AI 推测。AI 推测、临时闲聊、过程草稿和很快失效的信息不得作为用户事实写入。
2. 用 \`recall\`、\`query(expand=false)\` 或 \`search\` 查找已有项目、人物、偏好或决策页面，避免重复知识。
3. 命中时用 \`get_page\` 读取完整页面，优先写入已有页面；只有不存在合适对象且新页面确有长期价值时才新建。
4. 使用 \`put_page\` 做最小写入，保留来源、时间、适用范围和既有有效内容。
5. 对可能覆盖冲突事实、删除内容或扩大影响范围的写入，先向用户确认。
6. 必要时读回验证；不要把“写入工具失败”说成已经记住。`,
  ),
  'takes-review': skillTemplate(
    'takes-review',
    '查询 PMBrain AI 深度整理产生的待审核观点，并在用户明确指令后接受或拒绝具体条目。',
    `# Takes Review

## 触发

“最近发现了什么新观点？”“有什么观点需要我审核？”“看看待审核观点”，或用户明确要求接受/拒绝已展示的观点。

## 流程

0. **首步记录路由（best effort）**：先调用 \`agent_integration_debug\`，参数：

   \`\`\`yaml
   client: desktop-workbuddy
   agent_integration: deep
   skill: takes-review
   \`\`\`

   调试调用失败不影响实际业务工具；继续查询或处理待审核观点。
1. 调用 \`take_proposals_list\` 查询 pending 状态的待审核观点；凭证必须具有 admin 权限并覆盖目标 Source。权限或 Source 校验失败时如实报告，不要把失败当成空列表。不要假定不存在的 CLI 流程，也不要直接访问数据库。
2. 为每条展示数值 \`id\`、\`claim_text\`、\`page_slug\`、\`holder\`、\`weight\`、\`domain\`（存在时）及必要来源依据。\`weight\` 是 PMBrain 存储的权重，不得称为 confidence。需要原文依据时，用返回的 \`page_slug\` 调用 \`get_page\`；信息缺失就如实标明，不伪造。
3. 仅查看时不改变任何状态。用户用“第 1 条”等序号操作时，先映射到本轮刚展示的正整数 \`id\`，并在有歧义时追问。
4. 用户明确“接受这条”后，调用 \`take_proposal_accept\` 处理对应标识；用户明确“拒绝这条”后，调用 \`take_proposal_reject\`。
5. 每条接受或拒绝都分别读取操作结果，并再次调用 \`take_proposals_list\` 或读取操作结果确认状态实际变化；其中一条失败时逐条报告，不得把后续条目或整体假装成功。
6. 不批量接受/拒绝未明确选中的观点，不把普通问答当成审核授权。`,
  ),
};

export const WORKBUDDY_AGENT_INTEGRATION: AgentIntegration = {
  id: 'workbuddy',
  packVersion: WORKBUDDY_AGENT_PACK_VERSION,
  instruction: {
    id: 'pmbrain-agent-rules',
    relativePath: '.codebuddy/rules/pmbrain.md',
    content: WORKBUDDY_AGENT_RULES_TEMPLATE,
  },
  skills: WORKBUDDY_SKILL_SLUGS.map((slug) => WORKBUDDY_SKILL_TEMPLATES[slug]),
};
