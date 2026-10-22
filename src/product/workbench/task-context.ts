import type { WorkbenchMessage, WorkbenchTask, WorkbenchTaskMaterial } from '../../../shared/workbench';
import { retrievalText } from './attachments';
import { classifyTurn, compactRule, isTaskAmendment, isWorkRequest, mergeTaskRules, taskNeedsSkill, wantsDirectoryCreation } from './turn-policy';

const followUp = /^(?:继续|继续做|继续写|接着做|接着写|接着|执行吧|开始吧|就按这个|按这个做|做吧|写吧|可以|好|好的|行|嗯|执行)$/;
const agreementOnly = /^(?:可以|好|好的|行|嗯|执行)$/;
const continuationCue = /继续|接着|就按这个|按这个|按刚才|还是按|执行吧|开始吧/;
const leavesCurrentTaskCue = /(?:不要|别再|不用|不再|停止)(?:再)?(?:继续|接着)|改做|换做|另做|另外做/;
const replacementCue = /改做|换做|另做|另外做/;
const parameterCue = /(?:输出|格式|篇幅|措辞|版式|字数|标题).{0,8}换成|换成(?:成|为)?(?:Markdown|markdown|MD|表格|纯文字|docx|Word)/i;

function normalizedWork(text: string): string {
  return text.replace(/\s+/g, '').replace(/[。！!？?，,]/g, '');
}

function carriedPaths(task?: WorkbenchTask): Pick<WorkbenchTask, 'managedPaths'> {
  return task?.managedPaths?.length ? { managedPaths: [...task.managedPaths] } : {};
}

export function continuesActiveTask(text: string): boolean {
  return followUp.test(normalizedWork(text));
}

export function continuesCurrentWork(text: string): boolean {
  if (continuesActiveTask(text)) return true;
  return continuationCue.test(normalizedWork(text));
}

export function carriesCurrentMethod(text: string): boolean {
  return continuesCurrentWork(text) && !leavesCurrentTaskCue.test(normalizedWork(text));
}

export function advanceTask(input: { task?: WorkbenchTask; notes?: string[]; text: string; recentUserTexts: string[]; agent: { workflow?: string; skills?: string[] }; now: string; id: () => string }): { task?: WorkbenchTask; inherited: boolean; opened: boolean } {
  const text = input.text.trim();
  const normalized = normalizedWork(text);
  const directory = /(?:刚才|刚建|新建|这个|当前|本次|该).{0,12}(?:文件夹|目录)/.test(text) ? input.task?.directory : undefined;
  const canReplace = !!input.task && replacementCue.test(normalized);
  if (canReplace && input.task) {
    const goal = compactRule(text);
    if (input.task.goal === goal) return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
    return { task: { id: input.id(), goal, constraints: [], updatedAt: input.now, ...(directory ? { directory } : {}), ...carriedPaths(input.task) }, inherited: false, opened: true };
  }
  if (wantsDirectoryCreation(text)) return { task: input.task ? { ...input.task, updatedAt: input.now } : { id: input.id(), goal: compactRule(text), constraints: [], updatedAt: input.now }, inherited: !!input.task, opened: !input.task };
  if (input.task && parameterCue.test(normalized)) {
    return { task: { ...input.task, constraints: mergeTaskRules(input.task.constraints, [compactRule(text)]), updatedAt: input.now }, inherited: true, opened: false };
  }
  if (input.task && isTaskAmendment(text)) {
    return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
  }
  if (input.task && carriesCurrentMethod(text)) return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
  if (continuesActiveTask(text)) {
    if (agreementOnly.test(normalized)) return { inherited: false, opened: false };
    const goal = [...input.recentUserTexts].reverse().find(item => classifyTurn(item) === 'chat' && taskNeedsSkill(input.agent, item));
    if (!goal) return { inherited: false, opened: false };
    return { task: { id: input.id(), goal: compactRule(goal), constraints: [...(input.notes ?? [])], updatedAt: input.now, ...carriedPaths(input.task) }, inherited: true, opened: false };
  }
  if (classifyTurn(text) === 'chat' && (isWorkRequest(text) || taskNeedsSkill(input.agent, text))) {
    const goal = compactRule(text);
    if (input.task?.goal === goal) return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
    return { task: { id: input.id(), goal, constraints: [], updatedAt: input.now, ...(directory ? { directory } : {}), ...carriedPaths(input.task) }, inherited: false, opened: true };
  }
  return { task: input.task, inherited: false, opened: false };
}

export function noteTask(task: WorkbenchTask, input: { messageId: string; opened: boolean; inherited: boolean; constraint?: string }): WorkbenchTask {
  const note = input.constraint || (input.opened ? '提出任务' : input.inherited ? '继续当前任务' : '补充');
  const sources = (input.opened ? [] : [...(task.sources ?? [])]).filter(item => item.messageId !== input.messageId || item.note !== note);
  sources.push({ messageId: input.messageId, note });
  const origin = sources.find(item => item.note === '提出任务');
  const tail = sources.slice(-11);
  const next: WorkbenchTask = { ...task, sources: origin && !tail.includes(origin) ? [origin, ...tail] : sources.slice(-12), updatedAt: task.updatedAt };
  if (input.opened) {
    delete next.decisions;
    delete next.openItems;
    delete next.deliveries;
    delete next.currentArtifactId;
    delete next.materials;
  }
  return next;
}

export function taskUserTexts(messages: WorkbenchMessage[], task: WorkbenchTask | undefined, currentMessageId: string): string[] {
  const origin = task?.sources?.find(item => item.note === '提出任务')?.messageId;
  let start = origin ? messages.findIndex(message => message.id === origin) : -1;
  if (start < 0 && task) start = messages.findLastIndex(message => message.role === 'user' && compactRule(message.text) === task.goal);
  if (task && start < 0) {
    const ids = new Set(task.sources?.map(item => item.messageId) ?? []);
    return messages.filter(message => message.role === 'user' && message.id !== currentMessageId && ids.has(message.id)).map(message => message.text);
  }
  return messages.slice(Math.max(0, start)).filter(message => message.role === 'user' && message.id !== currentMessageId).map(message => message.text);
}

export function rememberTaskMaterials(task: WorkbenchTask, message: { id: string; attachments?: Array<{ id: string; name: string }> } | undefined, opened: boolean): WorkbenchTask {
  const kept: WorkbenchTaskMaterial[] = opened ? [] : [...(task.materials ?? [])];
  for (const item of message?.attachments ?? []) {
    const name = item.name?.trim();
    if (!item.id || !name || kept.some(row => row.ref === item.id)) continue;
    kept.push({ messageId: message!.id, kind: 'attachment', ref: item.id, name });
  }
  const next = { ...task };
  if (kept.length) next.materials = kept.slice(-40);
  else delete next.materials;
  return next;
}

export function compileTaskBrief(task?: WorkbenchTask, evidence = false, current?: { id: string; revision: number; title: string; format: string; hash: string }): string {
  if (!task?.goal?.trim()) return '';
  const lines = [`目标：${task.goal}`];
  if (task.directory) lines.push(`本次工作文件夹：${task.directory.path}。后续成果保存到此目录。`);
  if (task.constraints.length) lines.push(`这次的限制：${task.constraints.join('；')}`);
  if (task.decisions?.length) lines.push(`已决定：${task.decisions.join('；')}`);
  if (task.openItems?.length) lines.push(`未决：${task.openItems.join('；')}`);
  if (task.deliveries?.length) lines.push(`交付：${task.deliveries.join('；')}`);
  if (task.currentArtifactId && current?.id === task.currentArtifactId) lines.push(`当前成果：${current.id}，第 ${current.revision} 版，${current.title}，${current.format}，哈希 ${current.hash}。修改这份时调用 artifact_revise，并带上这个编号和哈希。`);
  else if (task.currentArtifactId) lines.push(`当前成果：${task.currentArtifactId}。修改前先用 artifact_read 读取编号和哈希。`);
  if (task.materials?.length) lines.push(`任务材料：${task.materials.map(item => `${item.name}（${item.kind} ${item.ref}，消息 ${item.messageId}${item.range ? `，范围 ${item.range}` : ''}）`).join('；')}。这些材料不随最近来源丢掉。按最初那张图核对时用最早一份图片材料。`);
  if (task.sources?.length) lines.push(`来源：${task.sources.map(item => `${item.note}（${item.messageId}）`).join('；')}`);
  const label = evidence
    ? '这是当前任务的结构摘要，权威低于用户原话、当前规则和本期引用。它不是本期工作事实。'
    : '这是当前任务的结构摘要，权威低于用户原话、当前规则和本期引用。';
  return `\n<task_brief>\n${label}\n用户本轮明确的改稿和交付要求可临时调整长期工作规则，仅限当前任务；不能扩大资料来源或工具权限。\n${lines.join('\n')}\n</task_brief>`;
}

export function retrievalQuery(messages: Array<Pick<WorkbenchMessage, 'role' | 'text' | 'attachments'>>, task?: Pick<WorkbenchTask, 'goal'>): string {
  const users = messages.filter(item => item.role === 'user');
  if (!task?.goal?.trim()) return users.slice(-4).map(item => retrievalText(item)).filter(Boolean).join('\n').trim();
  const latest = users.at(-1);
  const raw = latest?.text.trim() ?? '';
  const goal = task.goal.trim();
  if (!raw || raw === goal || continuesActiveTask(raw)) return goal.slice(0, 2000);
  return `${goal}\n${retrievalText(latest!)}`.trim().slice(0, 2000);
}
