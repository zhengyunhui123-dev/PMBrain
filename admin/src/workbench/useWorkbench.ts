import { useEffect, useRef, useState } from 'react';
import { defaultAssistant, type KnowledgeAssistantSettings, type WorkbenchConversation, type WorkbenchModel } from '../../../shared/workbench';
import { filePayload } from './composer-attachments';
import { productFetch } from '../lib/product-fetch';

type ConversationRow = Omit<WorkbenchConversation, 'messages'> & { messageCount: number; running: boolean };
export async function workbenchRequest<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await productFetch(`/admin/api/workbench${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let result: { error?: string };
  try { result = await response.json(); }
  catch { throw new Error(response.ok ? '服务返回的内容无法解析。' : `请求失败：${response.status}`); }
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result as T;
}
export function mergePolledConversation(current: WorkbenchConversation | undefined, next: WorkbenchConversation): WorkbenchConversation {
  if (!current || current.id !== next.id) return next;
  const previous = new Map(current.messages.map(message => [message.id, message]));
  return {
    ...next,
    messages: next.messages.map(message => {
      const older = previous.get(message.id);
      if (!older?.attachments?.length || !message.attachments?.length) return message;
      const saved = new Map(older.attachments.map(item => [item.id, item]));
      return {
        ...message,
        attachments: message.attachments.map(item => {
          const prior = saved.get(item.id);
          if (!prior) return item;
          const preview = item.preview || prior.preview;
          const text = item.text || prior.text;
          return { ...item, ...(preview ? { preview } : {}), ...(text ? { text } : {}) };
        }),
      };
    }),
  };
}
export function useWorkbench() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [models, setModels] = useState<WorkbenchModel[]>([]);
  const [conversation, setConversation] = useState<WorkbenchConversation>();
  const [model, setModel] = useState('');
  const [knowledge, setKnowledge] = useState(true);
  const [assistant, setAssistant] = useState<KnowledgeAssistantSettings>(defaultAssistant);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const active = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const refresh = async () => {
    const result = await workbenchRequest<{ conversations: ConversationRow[] }>('/conversations');
    if (mounted.current) setRows(result.conversations);
  };
  useEffect(() => {
    mounted.current = true; let cancelled = false;
    Promise.all([workbenchRequest<{ conversations: ConversationRow[] }>('/conversations'), workbenchRequest<{ models: WorkbenchModel[] }>('/models'), workbenchRequest<KnowledgeAssistantSettings>('/assistant')]).then(([history, available, settings]) => {
      if (cancelled) return;
      setRows(history.conversations); setModels(available.models); setAssistant(settings);
      const preferred = settings.model && available.models.some(item => item.id === settings.model) ? settings.model : available.models[0]?.id ?? '';
      setModel(preferred); setKnowledge(settings.knowledge); setLoaded(true);
    }).catch(reason => { if (!cancelled) { setError(String(reason.message || reason)); setLoaded(true); } });
    const refreshModels = () => { void workbenchRequest<{ models: WorkbenchModel[] }>('/models').then(result => { if (!cancelled) setModels(result.models); }).catch(reason => { if (!cancelled) setError(String(reason.message || reason)); }); };
    window.addEventListener('pmbrain:models-updated', refreshModels);
    return () => { cancelled = true; mounted.current = false; window.removeEventListener('pmbrain:models-updated', refreshModels); };
  }, []);
  const running = conversation?.messages.some(message => message.status === 'running') ?? false;
  useEffect(() => {
    if (!running || !conversation) return;
    const id = conversation.id; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}?lite=1`);
        if (stopped || active.current !== id) return;
        setConversation(current => mergePolledConversation(current, next));
        if (next.messages.some(m => m.status === 'running')) timer = setTimeout(poll, 200);
        else await refresh();
      } catch (reason) { if (!stopped) { setError(reason instanceof Error ? reason.message : String(reason)); timer = setTimeout(poll, 2500); } }
    };
    timer = setTimeout(poll, 150);
    return () => { stopped = true; clearTimeout(timer); };
  }, [conversation?.id, running]);
  const select = async (id?: string) => {
    active.current = id; setConversation(undefined); setError('');
    if (!id) return;
    setPending(true);
    try { const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}`); if (active.current === id) { setConversation(next); setModel(next.model); setKnowledge(next.knowledge); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const send = async (text: string, retry = false, editMessageId?: string, files?: { id: string; name: string; file?: File; saved?: boolean; mime?: string }[], attachmentsHydrated = false) => {
    if (pending || running) return false;
    setPending(true); setError('');
    let createdId: string | undefined;
    try {
      let id = conversation?.id;
      if (!id) { const created = await workbenchRequest<WorkbenchConversation>('/conversations', { model, knowledge }); id = created.id; createdId = id; active.current = id; setConversation(created); }
      const attachments = files ? await Promise.all(files.map(file => filePayload(file))) : undefined;
      const attachmentFields = editMessageId
        ? { editMessageId, attachments: attachments ?? [], attachmentsHydrated }
        : (attachments?.some(item => item.data || item.keep) ? { attachments } : {});
      const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}/messages`, { text, model, knowledge, retry, ...attachmentFields });
      if (active.current === id) setConversation(next);
      try { await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      return id;
    } catch (reason) {
      if (createdId) {
        try {
          await workbenchRequest(`/conversations/${createdId}?emptyOnly=true`, undefined, 'DELETE');
          if (active.current === createdId) { active.current = undefined; setConversation(undefined); }
        } catch {
          try {
            const saved = await workbenchRequest<WorkbenchConversation>(`/conversations/${createdId}`);
            if (active.current === createdId) setConversation(saved);
          } catch {}
        }
      }
      setError(reason instanceof Error ? reason.message : String(reason)); return false;
    }
    finally { setPending(false); }
  };
  const action = async (kind: 'cancel' | 'delete' | 'rename', title?: string) => {
    if (!conversation) return;
    const id = conversation.id; setError(''); setPending(true);
    try {
      if (kind === 'delete') { await workbenchRequest(`/conversations/${id}`, undefined, 'DELETE'); await select(); }
      else { const next = kind === 'cancel' ? await workbenchRequest<WorkbenchConversation>(`/conversations/${id}/cancel`, {}) : await workbenchRequest<WorkbenchConversation>(`/conversations/${id}`, { title }, 'PATCH'); if (active.current === id) setConversation(next); }
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const saveAssistant = async (value: KnowledgeAssistantSettings) => {
    const saved = await workbenchRequest<KnowledgeAssistantSettings>('/assistant', value, 'PUT');
    setAssistant(saved);
    if (!conversation) {
      if (saved.model && models.some(item => item.id === saved.model)) setModel(saved.model);
      setKnowledge(saved.knowledge);
    }
    return saved;
  };
  return { rows, models, conversation, model, setModel, knowledge, setKnowledge, assistant, saveAssistant, error, setError, loaded, pending, running, select, send, action };
}
