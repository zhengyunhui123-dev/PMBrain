import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkbenchAgent, WorkbenchAssistantDraft } from '../../../shared/workbench-agents';
import type { WorkbenchConversation, WorkbenchMessage, WorkbenchPending, WorkbenchToolCall } from '../../../shared/workbench';
import type { ChatRequestEvent } from '../../core/ai/chat-request-runtime';
import { requestedWorkspaceDirectory, userDirectories } from './agent-runtime';
import { readyToCreateAssistant } from './agent-tools';
import { normalizeSchedule, WorkbenchAgentStore } from './agents';
import { proposesAssistant } from './pending';

export interface AssistantSetupHooks {
  draft(input: { text: string; previous?: WorkbenchAssistantDraft; model: string; signal: AbortSignal; onRequestEvent?: (event: ChatRequestEvent) => void }): Promise<Record<string, unknown>>;
  validate(draft: WorkbenchAssistantDraft): Promise<void>;
}

type SetupAction = 'draft' | 'direct' | 'amend' | 'confirm' | 'recover' | 'cancel' | 'already' | 'missing';
const agreement = /^(?:可以|好|好的|行|同意|没问题|可以的|就这样|就按这个(?:来)?|按这个来|开始吧|建吧|确认|确认创建|就按这个创建|按这个创建|直接创建|可以创建|创建吧|开始创建|同意创建|就这样建|就这么建|现在就创建|不用问了|不用确认)$/;
const standaloneCreate = /^(?:确认创建|就按这个创建|按这个创建|直接创建|可以创建|创建吧|开始创建|同意创建|就这样建|就这么建|现在就创建)$/;

export function assistantSetupAction(conversation: WorkbenchConversation, user: WorkbenchMessage | undefined, assistant: WorkbenchAgent, retry: boolean): SetupAction | undefined {
  if (assistant.id !== 'main' || !user || user.collaborationFrom) return;
  const normalized = user.text.replace(/[\s。！？!？，,]/g, '');
  const approved = !/[？?]/.test(user.text) && agreement.test(normalized.replace(/^(?:可以|好的?|没问题)(?=就按|按这个|创建吧|建吧)/, ''));
  const pending = conversation.pending?.kind === 'assistant-create' && conversation.pending.assistantRevision === assistant.revision ? conversation.pending : undefined;
  const position = conversation.messages.findIndex(message => message.id === user.id);
  const previous = conversation.messages[position - 1];
  const reviewedReply = retry ? conversation.revisions?.at(-1)?.messages.at(-1) : previous;
  const reviewing = !!pending?.reviewMessageId && reviewedReply?.id === pending.reviewMessageId && reviewedReply.status === 'complete';
  const priorAttempt = retry && pending?.confirmedMessageId === user.id;
  const previousAttemptFailed = previous?.status === 'error' && !!pending?.confirmedMessageId && pending.confirmedMessageId === conversation.messages[position - 2]?.id;
  if (pending && (/^(?:不建了|先不建了|不用建了|取消创建(?:助手)?|不用创建(?:助手)?|不要创建(?:助手)?)$/.test(normalized) || normalized === '取消' && (reviewing || previousAttemptFailed))) return 'cancel';
  if (pending?.draft && (priorAttempt || approved && (reviewing || standaloneCreate.test(normalized) && previousAttemptFailed))) return 'confirm';
  if (approved) {
    if (retry && conversation.usedConfirm && !pending && conversation.revisions?.at(-1)?.messages.some(message => message.toolCalls?.some(call => call.name === 'assistant_create' && call.status === 'complete'))) return 'already';
    if (pending && !pending.draftId && previous?.role === 'assistant') return 'recover';
    if (reviewing && !pending?.draft) return 'missing';
    if (conversation.usedConfirm && previous?.toolCalls?.some(call => call.name === 'assistant_create' && call.status === 'complete')) return 'already';
    if (standaloneCreate.test(normalized)) return 'missing';
  }
  if (proposesAssistant(normalized) && !/怎么创建|如何创建|创建助手的方法|创建助手的步骤/.test(normalized)) {
    const direct = /^(?:请|现在|那就)?(?:确认创建|直接创建|就按这个创建|按这个创建|同意创建|开始创建|现在就创建)/.test(normalized) && readyToCreateAssistant(user.text);
    return direct ? 'direct' : 'draft';
  }
  if ((reviewing || previousAttemptFailed) && pending && (!pending.draft || /名称|名字|职责|负责|工作岗位|项目管理岗|工作步骤|工作目录|知识来源|知识库|交付格式|定时|规则|技能|改成|改为/.test(normalized))) return 'amend';
}

function namedValue(text: string) {
  return /(?:名字|名称)(?:叫|为|是|[：:])\s*([^，,。！？!?；;\r\n]{1,100})/.exec(text)?.[1]?.trim().replace(/(?:就行|就可以|吧)$/, '');
}

function renameOnly(text: string) {
  const match = /^(?:名称|名字)(?:(?:换下|换一下|改一下)[，,\s]*(?:叫|为)|(?:叫|改成|改为|换成|换为))\s*([^，,。！？!?；;\r\n]{1,100})[。！!]*$/.exec(text.trim());
  return match?.[1]?.trim().replace(/(?:就行|就可以|吧)$/, '');
}

function cleanDraft(value: Record<string, unknown>, requirements: string, assistant: WorkbenchAgent, previous?: WorkbenchAssistantDraft): WorkbenchAssistantDraft | undefined {
  const string = (key: string, limit: number) => typeof value[key] === 'string' ? value[key].trim().slice(0, limit) : undefined;
  const lines = requirements.split('\n');
  const name = [...lines].reverse().map(line => renameOnly(line) || namedValue(line)).find(Boolean) || string('name', 80) || previous?.name;
  if (!name) return;
  const allowedPaths = new Set(lines.flatMap(userDirectories).map(path => resolve(path)));
  const readDirectories = (Array.isArray(value.readDirectories) ? value.readDirectories : previous?.readDirectories ?? [])
    .filter((path): path is string => typeof path === 'string' && allowedPaths.has(resolve(path))).slice(0, 20);
  const workspaceDirectory = [...lines].reverse().map(requestedWorkspaceDirectory).find(Boolean);
  const selectedSources = Array.isArray(value.sourceIds) ? value.sourceIds.filter((id): id is string => typeof id === 'string' && assistant.sourceIds.includes(id) && requirements.includes(id)) : [];
  const sourceIds = selectedSources.length ? [...new Set(selectedSources)] : previous?.sourceIds ?? [assistant.sourceIds[0] ?? assistant.memorySourceId ?? 'default'];
  const schedule = /定时|每周|每日|每天|每月|周[一二三四五六日天].{0,8}\d/.test(requirements)
    ? normalizeSchedule(value.schedule === undefined ? previous?.schedule : value.schedule) : undefined;
  const skills = /技能/.test(requirements) && Array.isArray(value.skills) ? value.skills.filter((skill): skill is string => typeof skill === 'string').slice(0, 12) : previous?.skills ?? [];
  return {
    name, description: string('description', 500) || previous?.description || '',
    systemPrompt: string('systemPrompt', 8000) ?? previous?.systemPrompt ?? '',
    workflow: string('workflow', 8000) ?? previous?.workflow ?? '',
    knowledge: /知识库|知识来源/.test(requirements) && typeof value.knowledge === 'boolean' ? value.knowledge : previous?.knowledge ?? assistant.knowledge,
    sourceIds, readDirectories, ...(workspaceDirectory ? { workspaceDirectory } : {}),
    deliveryFormat: /markdown|docx|word|交付格式/i.test(requirements) && (value.deliveryFormat === 'docx' || value.deliveryFormat === 'markdown') ? value.deliveryFormat : previous?.deliveryFormat ?? assistant.deliveryFormat,
    skills, ...(schedule ? { schedule } : {}),
  };
}

function preview(draft: WorkbenchAssistantDraft) {
  return [
    `**创建草稿 · ${draft.name}**`,
    ...[draft.description && `**职责**　${draft.description}`, draft.systemPrompt && `**规则**　${draft.systemPrompt}`, draft.workflow && `**工作步骤**　${draft.workflow}`].filter(Boolean),
    `**知识来源**　${draft.knowledge ? draft.sourceIds.join('、') : '已关闭'}`,
    `**工作目录**　${draft.workspaceDirectory ?? '未设置，可创建后再选择'}`,
    ...(draft.readDirectories.length ? [`**附加资料目录**　${draft.readDirectories.join('、')}`] : []),
    `**交付格式**　${draft.deliveryFormat === 'docx' ? 'Word' : 'Markdown'}`,
    ...(draft.skills.length ? [`**技能**　${draft.skills.join('、')}`] : []),
    ...(draft.schedule ? [`**定时任务**　${draft.schedule.enabled ? `每周${draft.schedule.weekdays.map(day => '日一二三四五六'[day]).join('、')} ${draft.schedule.time}（${draft.schedule.timezone === 'Asia/Shanghai' ? '北京时间' : draft.schedule.timezone}），${draft.schedule.prompt}` : '未启用'}`] : []),
    '可以继续修改，回复「可以」即可创建。',
  ].join('\n\n');
}

export async function runAssistantSetup(input: {
  action: SetupAction; agent: WorkbenchAgent; user: WorkbenchMessage; reply: WorkbenchMessage; conversation: WorkbenchConversation;
  model: string; signal: AbortSignal; hooks: AssistantSetupHooks; store: WorkbenchAgentStore; save: () => void; onRequestEvent?: (event: ChatRequestEvent) => void;
}) {
  const { action, agent, user, reply, conversation, model, signal, hooks, store, save } = input;
  const pending = conversation.pending?.kind === 'assistant-create' ? conversation.pending : undefined;
  if (action === 'cancel' || action === 'already' || action === 'missing') {
    if (action === 'cancel') delete conversation.pending;
    reply.text = action === 'cancel' ? '已取消这次创建。' : action === 'already' ? '这次创建已处理过，可在「我的助手」查看。' : '请告诉我助手的名称和主要职责。';
    reply.status = 'complete';
    return;
  }
  let next = pending;
  if (action !== 'confirm') {
    const previous = action === 'amend' ? pending?.draft : undefined;
    const recover = action === 'recover' && pending ? conversation.messages.filter(message => message.role === 'user' && message.id !== user.id && message.createdAt >= pending.createdAt && !agreement.test(message.text.replace(/[\s。！？!？，,]/g, ''))).map(message => message.text) : [];
    const requirements = [...new Set(action === 'recover' ? [pending?.prompt ?? '', ...recover] : [action === 'amend' ? pending?.prompt ?? '' : '', user.text])].filter(Boolean).join('\n').slice(-16000);
    const newName = action === 'amend' && previous ? renameOnly(user.text) : undefined;
    reply.stage = '正在整理助手草稿';
    save();
    const value = newName ? { ...previous, name: newName } : await hooks.draft({ text: action === 'amend' && previous ? user.text : requirements, previous, model, signal, onRequestEvent: input.onRequestEvent });
    signal.throwIfAborted();
    const draft = cleanDraft(value, requirements, agent, previous);
    const draftId = randomUUID();
    next = { kind: 'assistant-create', fingerprint: draftId, draftId, prompt: requirements, createdAt: user.createdAt, assistantRevision: agent.revision, reviewMessageId: reply.id, ...(draft ? { draft } : {}) } satisfies WorkbenchPending;
    conversation.pending = next;
    if (action !== 'direct' || !draft) {
      reply.text = draft ? preview(draft) : '这个助手叫什么，主要负责什么工作？';
      reply.status = 'complete';
      return;
    }
  }
  if (!next?.draft || !next.draftId) throw new Error('当前没有可创建的助手草稿');
  next.confirmedMessageId = user.id;
  const draft = next.draft;
  const call: WorkbenchToolCall = { id: randomUUID(), name: 'assistant_create', status: 'running', input: JSON.stringify({ name: draft.name }), startedAt: new Date().toISOString() };
  reply.stage = '正在创建助手';
  reply.toolCalls = [call];
  save();
  try {
    let created = store.list().find(row => row.id === next.draftId);
    if (!created) {
      await hooks.validate(draft);
      signal.throwIfAborted();
      created = store.create({ ...draft }, next.draftId);
    }
    call.status = 'complete';
    call.output = JSON.stringify({ id: created.id, name: created.name, revision: created.revision, created: true, skills: created.skills, sourceIds: created.sourceIds, readDirectories: created.readDirectories, workspaceDirectory: created.workspaceDirectory, deliveryFormat: created.deliveryFormat, schedule: created.schedule, workflowConfigured: !!created.workflow });
    reply.text = `已创建「${created.name}」，可在「我的助手」中打开。`;
    reply.status = 'complete';
    conversation.usedConfirm = next.fingerprint;
    delete conversation.pending;
  } catch (error) {
    call.status = signal.aborted ? 'cancelled' : 'error';
    call.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    call.completedAt = new Date().toISOString();
    save();
  }
}
