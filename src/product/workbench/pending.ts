import { createHash } from 'node:crypto';
import type { WorkbenchPending } from '../../../shared/workbench';
import { readyToCreateAssistant } from './agent-tools';

const bareAgreement = /^(?:可以|好|好的|行|嗯|执行)$/;
const pureCreateConfirm = /^(?:确认创建|就按这个创建|直接创建|可以创建|创建吧|开始创建|同意创建|就这样建|就这么建|现在就创建|不用问了|不用确认)$/;
const reviseCue = /改|修订|第二节|刚才那份|那份成果|这份成果/;
const replacementCue = /改做|换做|另做|另外做/;

export function pendingFingerprint(parts: string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function decidePending(input: {
  retry?: boolean;
  text: string;
  pending?: WorkbenchPending;
  usedConfirm?: string;
  currentArtifactId?: string;
  artifacts: Array<{ id: string; familyId: string; title: string; revision: number; createdAt: string }>;
  now: string;
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
  const pending = input.pending?.kind === 'artifact-choice' && input.pending.fingerprint === choiceFingerprint ? input.pending : input.pending?.kind === 'assistant-create' ? input.pending : undefined;
  if (pending?.kind === 'artifact-choice') {
    const named = pending.options?.filter(item => text.includes(item.id) || text.includes(item.title)) ?? [];
    if (named.length === 1) return { action: 'continue', clearPending: true, currentArtifactId: named[0]!.id };
    if (bareAgreement.test(normalized)) return { action: 'hold', text: '还不能确定改哪一份。请点名成果标题。单独说可以不会改文件。', pending };
  }
  if (pending?.kind === 'assistant-create' && bareAgreement.test(normalized)) return { action: 'hold', text: '创建助手还需要明确说确认创建、就按这个创建或直接创建。', pending };
  if (!pending && input.usedConfirm && pureCreateConfirm.test(normalized)) return { action: 'hold', text: '刚才的创建确认已经用过。要再创建一个助手，请把新的名称和职责再说一次。' };
  if (readyToCreateAssistant(text) && pending?.kind === 'assistant-create') return { action: 'continue', clearPending: true, usedConfirm: pending.fingerprint };
  const wantsRevise = reviseCue.test(normalized) && !replacementCue.test(normalized);
  if (wantsRevise && !input.currentArtifactId && !pending && options.length > 1) {
    const next: WorkbenchPending = { kind: 'artifact-choice', fingerprint: choiceFingerprint, prompt: text, options, createdAt: input.now };
    const list = options.map(item => `${item.title}（第 ${item.revision} 版）`).join('；');
    return { action: 'hold', text: `现在有多份成果，还不能确定改哪一份：${list}。请点名一份的标题。`, pending: next };
  }
  if (/创建|建立|新增一个助手|建一个助手|建个助手/.test(normalized) && !readyToCreateAssistant(text)) {
    return { action: 'continue', pending: { kind: 'assistant-create', fingerprint: pendingFingerprint([text]), prompt: text, createdAt: input.now } };
  }
  return { action: 'continue' };
}
