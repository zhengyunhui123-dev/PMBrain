export const CHAT_MODEL_KEY = 'pmbrain.workbench.chatModel';
export const CHAT_MODEL_EVENT = 'pmbrain:chat-model';

export function rememberedChatModel(remembered: string, settingsModel: string, modelIds: readonly string[]): string {
  if (remembered && modelIds.includes(remembered)) return remembered;
  if (settingsModel && modelIds.includes(settingsModel)) return settingsModel;
  return modelIds[0] ?? '';
}

export function rememberChatModel(id: string) {
  if (!id) return;
  try { localStorage.setItem(CHAT_MODEL_KEY, id); } catch { return; }
  window.dispatchEvent(new CustomEvent(CHAT_MODEL_EVENT, { detail: id }));
}
