const FINAL_ANSWER_DIRECTION = '现在直接根据已获得的资料给出有引用的中文回答；证据不足的部分明确说明，不再调用工具，不编造资料。';
export const WORKBENCH_FINAL_ANSWER_PROMPT = `本轮资料收集已结束。${FINAL_ANSWER_DIRECTION}`;
export const WORKBENCH_DRAFT_ECHO_ISSUE = '模型复述了回答指令，未给出正文。';

function normalizedDraftText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[。.!！]+$/, '');
}

const draftDirections = [FINAL_ANSWER_DIRECTION, WORKBENCH_FINAL_ANSWER_PROMPT].map(normalizedDraftText);

export function isWorkbenchDraftInstructionEcho(text: string): boolean {
  return draftDirections.includes(normalizedDraftText(text));
}

function outsideExamples(text: string, quotes: boolean): string {
  let fence: { marker: string; length: number } | undefined;
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const hidden = Boolean(fence || marker || quotes && /^\s*>/.test(line));
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined;
    }
    return hidden ? ' '.repeat(line.length) : line;
  }).join('\n');
}

export function answerProtocolOffset(text: string): number {
  const visible = outsideExamples(text, true);
  const tag = /<\/?(?:tool[_-]?(?:call|result)|function[_-]?(?:call|result)|excerpt_range)(?=[\s>:])|<\|(?:tool|function)\|>|<\/?[｜|]{1,2}DSML[｜|]{1,2}/i.exec(visible);
  if (tag) return tag.index;
  try {
    const value = JSON.parse(visible);
    if (value && (Array.isArray(value.tool_calls) || typeof value.name === 'string' && value.arguments && typeof value.arguments === 'object')) return 0;
  } catch {}
  return -1;
}

export function answerPreview(text: string): string {
  if (text.length <= WORKBENCH_FINAL_ANSWER_PROMPT.length + 24) {
    const draft = normalizedDraftText(text);
    if (draftDirections.some(direction => direction.startsWith(draft))) return '';
  }
  const protocol = answerProtocolOffset(text);
  if (protocol >= 0) return text.slice(0, protocol);
  const partial = /<[\/|a-z_:\- ]*$/i.exec(outsideExamples(text, true));
  return partial ? text.slice(0, partial.index) : text;
}

export function salvageWorkbenchAnswer(text: string): { text: string; leaked: boolean } {
  const leaked = answerProtocolOffset(text) >= 0;
  if (!leaked) return { text, leaked: false };
  return { text: answerPreview(text).trim(), leaked: true };
}

export function isClarificationAnswer(text: string): boolean {
  if (/(?:已|已经)(?:成功)?(?:创建|新建|建立|生成|保存|写入|复制|修改|完成)|(?:创建|保存|写入|复制|修改)(?:成功|完成)/.test(text)) return false;
  const sentences = text.trim().match(/[^。！？.!?\n]+[。！？.!?]?/g) ?? [];
  return sentences.length > 0 && sentences.every(sentence => /[?？]$/.test(sentence.trim()) || /^(?:请|麻烦)(?:先)?(?:提供|补充|确认|选择|告诉我)/.test(sentence.trim()));
}

export function answerIntegrityIssue(text: string, citationCount?: number, requireCitation = true, citations?: ReadonlyArray<{ title: string; slug: string }>): string | null {
  if (isWorkbenchDraftInstructionEcho(text)) return WORKBENCH_DRAFT_ECHO_ISSUE;
  if (/request (?:was|is|has been) rejected|considered high risk|safety policy|请求被拒绝|无法协助/i.test(text)) return null;
  if (answerProtocolOffset(text) >= 0) return '模型把工具指令或工具回执写进了正文；这些文字不能证明工具已执行。';
  if (citationCount === undefined) return null;
  const references = [...outsideExamples(text, false).matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
  if (references.some(number => number < 1 || number > citationCount)) return '回答引用了本轮来源中不存在的编号。';
  for (const match of outsideExamples(text, true).matchAll(/^\s*\[(\d+)\]\s*[:：]?\s*(.+)$/gm)) {
    const declared = Number(match[1]);
    const label = match[2]!;
    const matches = citations?.flatMap((item, index) => label.includes(item.slug) || label.startsWith(item.title) ? [index + 1] : []) ?? [];
    if (matches.length === 1 && matches[0] !== declared) return `引用 [${declared}] 的来源名称与本轮编号不符，该来源实际编号是 [${matches[0]}]。请沿用本轮来源表的编号，不自行重新编号。`;
  }
  if (requireCitation && !isClarificationAnswer(text) && citationCount > 0 && !references.length) return '回答缺少对应资料的正文引用编号。';
  return null;
}
