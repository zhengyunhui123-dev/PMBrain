export const DRAFT_STORAGE_KEY = 'pmbrain.workbench.drafts.v1';
export interface StoredDraft { text: string; token: string; assistantId: string; conversationId: string }

export function readDraftMap(raw: string | null): Record<string, StoredDraft> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, Partial<StoredDraft>>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => item && typeof item.text === 'string' && typeof item.token === 'string' && typeof item.assistantId === 'string' ? [[key, { text: item.text, token: item.token, assistantId: item.assistantId, conversationId: typeof item.conversationId === 'string' ? item.conversationId : '' }]] : []));
  } catch { return {}; }
}

export function draftKey(conversationId: string | undefined, assistantId: string) {
  return conversationId || `new:${assistantId}`;
}

export function appendDraft(map: Record<string, StoredDraft>, key: string, addition: string, assistantId: string, conversationId: string): Record<string, StoredDraft> {
  const current = map[key]?.text ?? '';
  const text = current.trim() ? `${current.replace(/\s+$/, '')}\n${addition}` : addition;
  return writeDraft(map, key, text, assistantId, conversationId);
}

export function writeDraft(map: Record<string, StoredDraft>, key: string, text: string, assistantId: string, conversationId: string, token = ''): Record<string, StoredDraft> {
  const current = map[key];
  return { ...map, [key]: { text, token: current?.token || token || `${key}:${assistantId}`, assistantId, conversationId } };
}

export function clearDraftIfUnchanged(map: Record<string, StoredDraft>, key: string, token: string, text: string): Record<string, StoredDraft> {
  const current = map[key];
  if (!current || current.token !== token || current.text !== text) return map;
  return { ...map, [key]: { ...current, text: '' } };
}
