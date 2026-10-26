import type { WorkbenchPlaybook, WorkbenchSchedule } from '../../../shared/workbench-agents';
import { compactRule, instructional } from './turn-policy';

export const EVIDENCE_GAP_TEXT = '这次没有查到可用材料。没有写完整稿，也没有沿用以前的成果。';
export const CURRENT_EVIDENCE_RULE = '这一次的事实只来自这次检索和用户这次给出的材料。更早的对话、已保存的记忆和上一份成果都不是本期事实。回答先说明查到了什么。没有查到材料时，只说明没有材料并停止，不要写完整稿，也不要沿用以前的成果。';
export const SCHEDULE_STOP = '只使用这次查到的本期资料。没有查到材料时说明没有材料并停止，不要沿用上一份成果。';
const saveCue = /就按这次的存下来|按这次的存下来|按这次存下来|存成做法|以后按这次/;
const skillSaveCue = /保存为技能|存成技能|存为技能|转成技能|转为技能/;
const skillConfirmCue = /确认创建这个技能|确认保存技能|就按这个创建技能|就按这个保存技能|可以创建这个技能/;
const evidenceCue = /周报|报销|报告|本周|本期|做法|还是按|生成本/;

export function wantsSavedPlaybook(text: string): boolean {
  return saveCue.test(text.replace(/\s+/g, ''));
}

export function wantsSavedSkill(text: string): boolean {
  return skillSaveCue.test(text.replace(/\s+/g, ''));
}

export function confirmsSkillDraft(text: string): boolean {
  return skillConfirmCue.test(text.replace(/\s+/g, ''));
}

export function wantsSkillDraft(text: string): boolean {
  const value = text.replace(/\s+/g, '');
  if (skillSaveCue.test(value) || skillConfirmCue.test(value)) return false;
  return /技能/.test(value) && /创建|新建|生成|做一个|建一个|建个/.test(value);
}

export function wantsMethodSkill(text: string): boolean {
  const value = text.replace(/\s+/g, '');
  if (skillSaveCue.test(value) || skillConfirmCue.test(value) || wantsSkillDraft(text)) return false;
  return /按照?这次的方法.*以后都这么做|以后都按这次的方法|按照这次的方法以后/.test(value);
}

export function wantsSkillFix(text: string): boolean {
  const value = text.replace(/\s+/g, '');
  if (skillSaveCue.test(value) || skillConfirmCue.test(value) || wantsSkillDraft(text) || wantsMethodSkill(text)) return false;
  return /改进这个技能|纠正这个技能|更新这个技能|技能改成|按这次的纠正/.test(value);
}

export function confirmsNamedSkill(text: string, displayName: string): boolean {
  const value = text.replace(/\s+/g, '');
  const name = displayName.replace(/\s+/g, '');
  if (name.length < 2 || !/确认执行/.test(value)) return false;
  return value.includes(`确认执行${name}`) || value.includes(`确认执行技能${name}`) || value.includes(`确认执行「${name}」`);
}

function skillMethod(displayName: string, detail: string): string {
  return [
    '## 要保证的结果',
    `- 按「${displayName}」完成，并保存可以再次打开的结果。`,
    '## 工作步骤',
    `1. ${detail}`,
    '2. 只使用已授权的检索、阅读和文件保存。知识整理仍调用原来的整理任务，不另写一套。',
    '## 交付',
    '- 说明做了什么、依据是什么、文件保存在哪里。',
    '## 不要这样做',
    '- 不要编造资料。没有确认时不要修改知识库。',
    '## 怎么检查',
    `- 用户再说「${displayName}」时应命中这个技能。`,
    '- 步骤里的工具必须是当前助手真能调用的工具。',
  ].join('\n').slice(0, 16000);
}

export function skillDraftFromRequest(text: string): { displayName: string; description: string; triggers: string[]; tools: string[]; steps: string } | undefined {
  const named = text.replace(/\s+/g, '').match(/(?:创建|新建|生成|做|建)(?:一个|个)?([^，。,；;]{2,30}?)技能/);
  const displayName = named?.[1]?.replace(/^(?:帮我|请你|请|给我|为我)/, '').replace(/^(?:一个|个)/, '') ?? '';
  if (displayName.length < 2 || displayName.length > 40) return undefined;
  const tail = text.split(/技能/).slice(1).join('技能').replace(/^[\s，,：:]+/, '').trim();
  const detail = tail.length >= 4 ? tail : `按「${displayName}」的要求完成。先检索已授权资料，再整理结果并保存文件。缺少材料就说明，不要编造。`;
  return { displayName, description: `${displayName}。按用户确认的步骤完成并保存结果。`.slice(0, 240), triggers: [displayName], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], steps: skillMethod(displayName, detail) };
}

export function needsCurrentEvidence(text: string): boolean {
  const value = text.replace(/\s+/g, '');
  const preferenceQuestion = /(?:偏好|习惯|风格|格式要求|长期规则)(?:是什么|有哪些|是怎样的|是什么样的)[？?。.]?$/.test(value)
    && !/[，,；;\n]/.test(text) && !/生成|撰写|制作|输出|写一|帮我写|替我写|给我写/.test(value);
  return evidenceCue.test(value) && !preferenceQuestion;
}

function pieces(text: string): string[] {
  return text.split(/\n+|。|；|;/).map(compactRule).filter(part => part.length >= 4);
}

export function compilePlaybook(input: { name: string; workflow?: string; standingRules?: string[]; deliveryFormat?: 'markdown' | 'docx'; recentUserTexts: string[]; now?: string }): WorkbenchPlaybook {
  const recent = input.recentUserTexts.map(compactRule).filter(text => text && !wantsSavedPlaybook(text) && instructional(text));
  const steps: string[] = [];
  for (const step of [...pieces(input.workflow ?? ''), ...recent]) {
    if (steps.length >= 8) break;
    if (!steps.includes(step)) steps.push(step);
  }
  if (!steps.length) steps.push('先检索本期资料，再只根据查到的内容写');
  const topic = /周报/.test(`${input.name}${input.workflow ?? ''}${recent.join('')}`) ? '写周报' : /报销/.test(`${input.name}${recent.join('')}`) ? '处理报销' : /报告/.test(`${input.name}${recent.join('')}`) ? '写报告' : '按已存做法工作';
  const checks = ['没有依据就不写', ...(input.standingRules ?? []).map(compactRule).filter(rule => rule && rule !== '没有依据就不写' && /不要|只写|依据|不能编造/.test(rule))].slice(0, 4);
  return normalizePlaybook({
    name: input.name,
    when: `用户让${input.name}${topic}时`,
    inputs: '本期知识库里与这次任务相关的资料。不使用上一份成果里的完成项。',
    steps,
    checks: checks.join('；'),
    output: input.deliveryFormat === 'markdown' ? 'Markdown' : 'Word 文档',
    approval: '资料不足时只说明没有材料，并等用户确认后再写。',
    updatedAt: input.now,
  });
}

export function normalizePlaybook(input: unknown, now = new Date().toISOString()): WorkbenchPlaybook {
  if (!input || typeof input !== 'object') throw new Error('做法无效');
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, label: string, max = 240) => {
    const next = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!next || next.length > max) throw new Error(`${label}无效`);
    return next;
  };
  if (!Array.isArray(raw.steps)) throw new Error('做法步骤需为 1–8 条');
  const steps = [...new Set(raw.steps.map(step => text(step, '步骤')))];
  if (!steps.length || steps.length > 8) throw new Error('做法步骤需为 1–8 条');
  return {
    name: text(raw.name, '做法名称', 40),
    when: text(raw.when, '适用时机'),
    inputs: text(raw.inputs, '所需资料'),
    steps,
    checks: text(raw.checks, '核对方式', 500),
    output: text(raw.output, '交付'),
    approval: text(raw.approval, '确认边界', 500),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : now,
  };
}

export function playbookPrompt(playbook: WorkbenchPlaybook): string {
  return `<playbook>\n名称：${playbook.name}\n什么时候用：${playbook.when}\n需要的资料：${playbook.inputs}\n步骤：\n${playbook.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n怎么核对：${playbook.checks}\n交付：${playbook.output}\n需要人确认：${playbook.approval}\n</playbook>`;
}

export function scheduledTaskPrompt(agent: { schedule?: WorkbenchSchedule; playbook?: WorkbenchPlaybook | null }, slot: string): string {
  const prompt = agent.schedule?.prompt.trim() || '按已存做法完成本期工作';
  const playbook = agent.playbook;
  const method = playbook ? `\n按已存做法「${playbook.name}」执行。\n步骤：${playbook.steps.join('；')}\n核对：${playbook.checks}\n交付：${playbook.output}\n确认边界：${playbook.approval}` : '';
  const tail = `\n${SCHEDULE_STOP}`;
  let body = `${prompt}\n报告周期截止时间：${slot}。按资料中的实际事件日期区分本期完成、推进中和计划。${method}`;
  if (body.length + tail.length > 8000) body = body.slice(0, 8000 - tail.length);
  return body + tail;
}

function clip(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (!chars.length) return '';
  return chars.length <= 28 ? chars.join('') : `${chars.slice(0, 28).join('')}…`;
}

export function activityLine(messages: Array<{ role: string; text?: string; status?: string; evidenceGap?: boolean; artifacts?: Array<{ title?: string }>; savedPlaybook?: string; savedSkill?: string; ruleNotice?: string; toolCalls?: Array<{ name: string; status: string; output?: string }> }>, running: boolean): string {
  if (running) return '正在处理';
  const assistant = [...messages].reverse().find(message => message.role === 'assistant' && message.status !== 'running' && message.status !== 'error' && message.status !== 'cancelled');
  if (!assistant) return '';
  if (assistant.evidenceGap) return '没有查到本期材料';
  const title = assistant.artifacts?.find(item => item.title)?.title;
  if (title) return clip(`已保存${title}`);
  if (assistant.savedSkill) return '已存成技能';
  if (assistant.savedPlaybook) return '已存成做法';
  for (const call of [...(assistant.toolCalls ?? [])].reverse()) {
    if (call.status !== 'complete' || (call.name !== 'assistant_create' && call.name !== 'assistant_update') || !call.output) continue;
    try {
      const output = JSON.parse(call.output) as { name?: string; created?: boolean; updated?: boolean };
      if (output.name && (output.created || output.updated)) return clip(`已准备好${output.name}`);
    } catch { continue; }
  }
  if (assistant.ruleNotice && !assistant.ruleNotice.startsWith('已撤销')) return clip(assistant.ruleNotice);
  return clip(visibleAssistantText(assistant.text ?? '', assistant.toolCalls, { savedSkill: assistant.savedSkill, recap: true }));
}

export type WorkbenchHonesty = { savedSkill?: string; recap?: boolean };
type HonestyCall = { name: string; status: string; output?: string };

function compactText(text: string): string {
  return text.replace(/\s+/g, '');
}

function parseOutputs(calls: HonestyCall[] | undefined, names: string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const call of calls ?? []) {
    if (call.status !== 'complete' || !call.output || !names.includes(call.name)) continue;
    try {
      const output = JSON.parse(call.output);
      if (output && typeof output === 'object') rows.push(output as Record<string, unknown>);
    } catch {}
  }
  return rows;
}

function assistantPersisted(calls: HonestyCall[] | undefined, kind?: 'created' | 'updated'): boolean {
  for (const output of parseOutputs(calls, ['assistant_create', 'assistant_update'])) {
    if (typeof output.name !== 'string') continue;
    if (kind === 'created' && output.created) return true;
    if (kind === 'updated' && output.updated) return true;
    if (!kind && (output.created || output.updated)) return true;
  }
  return false;
}

function artifactReceipts(calls?: HonestyCall[]) {
  return parseOutputs(calls, ['artifact_save', 'artifact_revise']).filter(output => output.saved === true || typeof output.path === 'string' || typeof output.id === 'string');
}

function submitReceipt(calls?: HonestyCall[]) {
  return parseOutputs(calls, ['task_submit']).some(output => output.submitted === true);
}

function organizeReceipt(calls?: HonestyCall[]) {
  return parseOutputs(calls, ['knowledge_organize']).some(output => typeof output.task_id === 'string' || typeof output.message === 'string');
}

function unverifiedCreateName(text: string): string | undefined {
  const named = /(?:^|\n)\s*(?:[-*•]\s*)?名称[:：]\s*([^\n]{1,40})/.exec(text);
  if (named?.[1]) {
    const value = named[1].replace(/[`*_]/g, '').trim();
    if (value) return value;
  }
  const compact = compactText(text);
  const success = /「?([\u4e00-\u9fffA-Za-z0-9]{1,20}助手)」?已创建成功/.exec(compact);
  return success?.[1] || undefined;
}

function claimsUnverifiedAssistantCreate(text: string): boolean {
  const compact = compactText(text);
  if (/(?:已创建成功|创建成功|创建结果)/.test(compact) && /助手/.test(compact)) return true;
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text) && /(?:revision|版本)/.test(compact) && /名称/.test(compact);
}

function claimsUnverifiedAssistantUpdate(text: string): boolean {
  return /(?:助手)?(?:已更新成功|已调整成功)|配置已更新|已更新配置/.test(compactText(text));
}

function claimsUnverifiedSkill(text: string): boolean {
  return /(?:已创建技能|技能已创建成功|已保存为技能|已把.{0,30}存成技能)/.test(compactText(text));
}

function claimsUnverifiedSubmit(text: string): boolean {
  return /(?:已交给|已经交给).{0,20}助手|任务已提交|已把任务交给/.test(compactText(text));
}

function claimsOrganizeComplete(text: string): boolean {
  return /(?:知识|深度|AI)?整理已经完成|已经完成(?:知识|深度)?整理|整理任务已经完成/.test(compactText(text));
}

export function claimsUnverifiedFileSave(text: string): boolean {
  const compact = compactText(text);
  if (/\/admin\/api\/workbench\/artifacts\/[a-f0-9]{16,}\/download/i.test(text)) return true;
  if (/(?:已生成并)?已保存为(?:Word|docx|Markdown|md)(?:文件|文稿)?/i.test(compact)) return true;
  if (/文件已(?:成功)?(?:保存|落地|写入)/.test(compact)) return true;
  if (/已保存到/.test(compact) && /(?:\.docx|\.md|docx|Word|工作成果|本地)/i.test(compact)) return true;
  if (/(?:可以直接下载|保存的已经是docx)/i.test(compact)) return true;
  return false;
}

export function retryableUnverifiedActions(text: string, calls?: HonestyCall[]): Array<'save' | 'update' | 'submit' | 'organize'> {
  const missing: Array<'save' | 'update' | 'submit' | 'organize'> = [];
  if (claimsUnverifiedFileSave(text) && !artifactReceipts(calls).length) missing.push('save');
  if (claimsUnverifiedAssistantUpdate(text) && !assistantPersisted(calls, 'updated')) missing.push('update');
  if (claimsUnverifiedSubmit(text) && !submitReceipt(calls)) missing.push('submit');
  if (claimsOrganizeComplete(text) && !organizeReceipt(calls)) missing.push('organize');
  return missing;
}

function rewriteUnverifiedSave(text: string, calls?: HonestyCall[]): string {
  if (!claimsUnverifiedFileSave(text) || artifactReceipts(calls).length) return text;
  const allowed = new Set(artifactReceipts(calls).flatMap(row => [row.id, row.path, row.download].filter((item): item is string => typeof item === 'string')));
  let next = text.replace(/\/admin\/api\/workbench\/artifacts\/[a-f0-9]+\/download/gi, url => {
    const id = /artifacts\/([a-f0-9]+)\//i.exec(url)?.[1];
    return id && allowed.has(id) ? url : '';
  });
  next = next.replace(/(?:^|\n)\s*(?:\*\*)?(?:文件|下载|路径)[:：][^\n]*/g, '');
  next = next.replace(/[^\n。！？]*已保存为(?:Word|docx|Markdown)[^\n。！？]*[。！？]?/gi, '');
  next = next.replace(/[^\n。！？]*文件已(?:成功)?(?:保存|落地|写入)[^\n。！？]*[。！？]?/g, '');
  next = next.replace(/\n{3,}/g, '\n\n').trim();
  const notice = '文件还没有真正保存到「工作成果」里。请再发送一次保存要求，或先选定工作目录。';
  return next ? `${next}\n\n${notice}` : notice;
}

export function visibleAssistantText(text: string, calls?: HonestyCall[], honesty?: WorkbenchHonesty): string {
  for (const call of calls ?? []) {
    if (call.status !== 'complete' || !call.output || (call.name !== 'assistant_create' && call.name !== 'assistant_update')) continue;
    try {
      const output = JSON.parse(call.output) as { id?: string; name?: string; revision?: number; created?: boolean; updated?: boolean };
      if (!output.name || !(output.created || output.updated)) continue;
      const leaked = (output.id && text.includes(output.id)) || (output.revision != null && new RegExp(`(?:revision|版本)\\s*[:：]?\\s*${output.revision}`).test(text));
      if (leaked) return '';
    } catch { continue; }
  }
  if (!assistantPersisted(calls, 'created') && claimsUnverifiedAssistantCreate(text)) {
    const name = unverifiedCreateName(text);
    const who = name && name.length <= 40 ? name : '这个助手';
    return `${who}还没有真正创建，所以左侧列表里还看不到它。请回复「确认创建」，创建完成后就会出现在「我的助手」。`;
  }
  if (!honesty?.savedSkill && claimsUnverifiedSkill(text)) {
    return '技能还没有真正保存。请回复「确认创建这个技能」后才会出现在技能列表里。';
  }
  if (honesty?.recap) return text;
  if (!assistantPersisted(calls, 'updated') && claimsUnverifiedAssistantUpdate(text)) {
    return '助手配置还没有真正改掉。请说明要改什么，确认后再保存。';
  }
  if (!submitReceipt(calls) && claimsUnverifiedSubmit(text)) {
    return '任务还没有真正交给专用助手。任务中心里看不到这次提交。';
  }
  if (claimsOrganizeComplete(text)) {
    if (organizeReceipt(calls)) {
      const next = text.replace(/(?:知识|深度|AI)?整理已经完成|已经完成(?:知识|深度)?整理|整理任务已经完成/g, '已提交到任务中心');
      return /任务中心/.test(next) ? next : `${next}\n请在任务中心查看实际结果。`;
    }
    return '知识整理还没有提交到任务中心。请明确说「开始整理知识」或「确认执行深度知识整理」。';
  }
  return rewriteUnverifiedSave(text, calls);
}
