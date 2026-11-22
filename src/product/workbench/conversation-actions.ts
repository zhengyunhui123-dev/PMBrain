import type { WorkbenchCitation } from '../../../shared/workbench';

export function conversationMarkdown(input: { assistantName: string; messages: Array<{ role: string; text: string; citations?: WorkbenchCitation[]; attachments?: Array<{ name: string }> }> }) {
  const body = input.messages.map(message => {
    const references = (message.citations ?? []).map((citation, index) => `[${index + 1}] ${citation.title} · ${citation.kind === 'memory' ? '已保存的记忆' : `${citation.sourceId ?? ''} / ${citation.slug}`}`).join('\n');
    const files = (message.attachments ?? []).map(file => file.name).join('、');
    return [`## ${message.role === 'user' ? '你' : input.assistantName}`, message.text, files ? `附件：${files}` : '', references ? `参考资料\n${references}` : ''].filter(Boolean).join('\n\n');
  });
  return [`# ${input.assistantName} · 对话记录`, ...body].join('\n\n');
}
export function translationFollowUp(text: string) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const target = cjk >= letters ? '英文' : '中文';
  return `请把我上一条回答翻译成${target}。专有名词、数字、路径和引用编号保持原样。不要新增事实。`;
}
export function quotedDraft(text: string) {
  const body = text.trim().slice(0, 2000);
  if (!body) return '';
  return `> ${body.replace(/\n/g, '\n> ')}\n\n`;
}
export function usageLabel(events: Array<{ inputTokens?: number; outputTokens?: number }> | undefined) {
  if (!events?.length) return null;
  let input = 0;
  let output = 0;
  let known = false;
  for (const event of events) {
    if (typeof event.inputTokens === 'number') { input += event.inputTokens; known = true; }
    if (typeof event.outputTokens === 'number') { output += event.outputTokens; known = true; }
  }
  return known ? `本次输入 ${input} / 输出 ${output} Token` : null;
}
