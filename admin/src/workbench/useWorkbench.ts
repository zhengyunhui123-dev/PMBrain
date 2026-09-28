import { useEffect, useRef, useState } from 'react';
import type { WorkbenchConversation, WorkbenchModel } from '../../../shared/workbench';
import { productFetch } from '../lib/product-fetch';

type ConversationRow = Omit<WorkbenchConversation, 'messages'> & { messageCount: number; running: boolean };
export async function workbenchRequest<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await productFetch(`/admin/api/workbench${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result as T;
}
export function useWorkbench() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [models, setModels] = useState<WorkbenchModel[]>([]);
  const [conversation, setConversation] = useState<WorkbenchConversation>();
  const [model, setModel] = useState('');
  const [knowledge, setKnowledge] = useState(true);
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
    Promise.all([workbenchRequest<{ conversations: ConversationRow[] }>('/conversations'), workbenchRequest<{ models: WorkbenchModel[] }>('/models')]).then(([history, available]) => {
      if (cancelled) return;
      setRows(history.conversations); setModels(available.models); setModel(available.models[0]?.id ?? ''); setLoaded(true);
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
        const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}`);
        if (stopped || active.current !== id) return;
        setConversation(next);
        if (next.messages.some(m => m.status === 'running')) timer = setTimeout(poll, 700);
        else await refresh();
      } catch (reason) { if (!stopped) { setError(reason instanceof Error ? reason.message : String(reason)); timer = setTimeout(poll, 2500); } }
    };
    timer = setTimeout(poll, 500);
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
  const send = async (text: string, retry = false) => {
    if (pending || running) return false;
    setPending(true); setError('');
    try {
      let id = conversation?.id;
      if (!id) { const created = await workbenchRequest<WorkbenchConversation>('/conversations', { model, knowledge }); id = created.id; active.current = id; }
      const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}/messages`, { text, model, knowledge, retry });
      if (active.current === id) setConversation(next);
      await refresh(); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
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
  return { rows, models, conversation, model, setModel, knowledge, setKnowledge, error, setError, loaded, pending, running, select, send, action };
}
