import { createHash } from 'node:crypto';
import type { WorkbenchPending } from '../../../shared/workbench';
import { readyToCreateAssistant, readyToDeleteAssistant } from './agent-tools';

const bareAgreement = /^(?:可以|好|好的|行|嗯|执行)$/;
const pureCreateConfirm = /^(?:确认创建|就按这个创建|直接创建|可以创建|创建吧|开始创建|同意创建|就这样建|就这么建|现在就创建|不用问了|不用确认)$/;
const reviseCue = /改|修订|第二节|刚才那份|那份成果|这份成果/;
const replacementCue = /改做|换做|另做|另外做/;

export function pendingFingerprint(parts: string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function proposesAssistant(text: string): boolean {
  if (/(?:不用|不要|别再|别|取消|停止).{0,6}(?:创建|建立|新增)/.test(text)) return false;
  const target = /(?:创建|建立|新增|建一个|建个)(?:一个|个)?(.{0,24})/.exec(text);
  return !!target?.[1]?.includes('助手');
}

function proposesDelete(text: string): boolean {
  if (/(?:不用|不要|别再|别|取消|停止).{0,6}(?:删除|去掉|移除)/.test(text)) return false;
  return /(?:删除|去掉|移除).{0,12}助手|把.{0,24}助手.{0,8}(?:删除|去掉|移除)/.test(text);
}

function pendingIsCurrent(pending: WorkbenchPending, input: { assistantId?: string; assistantRevision?: number; taskId?: string }, choiceFingerprint: string): boolean {
  if (pending.assistantRevision === undefined || pending.assistantRevision !== input.assistantRevision) return false;
  if (pending.kind === 'assistant-create' || pending.kind === 'assistant-delete') return input.assistantId === 'main';
  return pending.fingerprint === choiceFingerprint;
}

export function decidePending(input: {
  retry?: boolean;
  text: string;
  pending?: WorkbenchPending;
  usedConfirm?: string;
  currentArtifactId?: string;
  artifacts: Array<{ id: string; familyId: string; title: string; revision: number; createdAt: string }>;
  now: string;
  assistantId?: string;
  assistantRevision?: number;
  taskId?: string;
  assistantSetupManaged?: boolean;
}): { action: 'continue' | 'hold'; text?: string; pending?: WorkbenchPending; clearPending?: boolean; currentArtifactId?: string; usedConfirm?: string } {
  if (input.retry) return { action: 'continue' };
  const text = input.text.trim();
  const normalized = text.replace(/\s+/g, '').replace(/[。！!？?，,]/g, '');
  const latest = new Map<string, { id: string; title: string; revision: number; createdAt: string }>();
  for (const row of input.artifacts) {
    const current = latest.get(row.familyId);
    if (!current || row.revision > current.revision || (row.revision === current.revision && row.createdAt > current.createdAt)) latest.set(row.familyId, row);
  }
  const options = [...latest.values()].map(row => ({ id: row.id, title: row.title, revision: row.revision }));
  const choiceFingerprint = pendingFingerprint(options.map(item => item.id));
  const stored = input.assistantSetupManaged && input.pending?.kind === 'assistant-create' ? undefined : input.pending;
  const pending = stored && pendingIsCurrent(stored, input, choiceFingerprint) ? stored : undefined;
  const stamp = { assistantRevision: input.assistantRevision, ...(input.taskId ? { taskId: input.taskId } : {}) };
  const dropStale = stored && !pending ? { clearPending: true as const } : {};
  if (pending?.kind === 'artifact-choice') {
    const named = pending.options?.filter(item => text.includes(item.id) || text.includes(item.title)) ?? [];
    if (named.length === 1) return { action: 'continue', clearPending: true, currentArtifactId: named[0]!.id };
    if (bareAgreement.test(normalized)) return { action: 'hold', text: '还不能确定改哪一份。请点名成果标题。单独说可以不会改文件。', pending };
  }
  if (pending?.kind === 'assistant-create' && proposesAssistant(normalized) === false && /(?:不用|不要|别再|别|取消|停止).{0,6}(?:创建|建立|新增)/.test(normalized)) return { action: 'continue', clearPending: true };
  if (pending?.kind === 'assistant-create' && bareAgreement.test(normalized)) return { action: 'hold', text: '创建助手还需要明确说确认创建、就按这个创建或直接创建。', pending };
  if (pending?.kind === 'assistant-delete' && proposesDelete(normalized) === false && /(?:不用|不要|别再|别|取消|停止).{0,6}(?:删除|去掉|移除)/.test(normalized)) return { action: 'continue', clearPending: true };
  if (pending?.kind === 'assistant-delete' && bareAgreement.test(normalized)) return { action: 'hold', text: '删除助手还需要明确说确认删除或直接删除。对话记录和工作成果仍会保留。', pending };
  if (!input.assistantSetupManaged && !pending && input.usedConfirm && pureCreateConfirm.test(normalized)) return { action: 'hold', text: '刚才的创建确认已经用过。要再创建一个助手，请把新的名称和职责再说一次。', ...dropStale };
  if (readyToCreateAssistant(text) && pending?.kind === 'assistant-create') return { action: 'continue', usedConfirm: pending.fingerprint };
  if (readyToCreateAssistant(text)) return { action: 'continue', ...dropStale };
  if (readyToDeleteAssistant(text) && pending?.kind === 'assistant-delete') return { action: 'continue', usedConfirm: pending.fingerprint };
  if (readyToDeleteAssistant(text) && pending?.kind !== 'assistant-create') return { action: 'continue', ...dropStale };
  const wantsRevise = reviseCue.test(normalized) && !replacementCue.test(normalized);
  if (wantsRevise && !input.currentArtifactId && !pending && options.length > 1) {
    const next: WorkbenchPending = { kind: 'artifact-choice', fingerprint: choiceFingerprint, prompt: text, options, createdAt: input.now, ...stamp };
    const list = options.map(item => `${item.title}（第 ${item.revision} 版）`).join('；');
    return { action: 'hold', text: `现在有多份成果，还不能确定改哪一份：${list}。请点名一份的标题。`, pending: next };
  }
  if (!input.assistantSetupManaged && input.assistantId === 'main' && proposesAssistant(normalized) && !readyToCreateAssistant(text)) {
    return { action: 'continue', pending: { kind: 'assistant-create', fingerprint: pendingFingerprint([text, String(input.assistantRevision ?? '')]), prompt: text, createdAt: input.now, ...stamp } };
  }
  if (input.assistantId === 'main' && proposesDelete(normalized) && !readyToDeleteAssistant(text)) {
    return { action: 'continue', pending: { kind: 'assistant-delete', fingerprint: pendingFingerprint([text, String(input.assistantRevision ?? '')]), prompt: text, createdAt: input.now, ...stamp } };
  }
  return { action: 'continue', ...dropStale };
}
