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
  const tag = /<\/?(?:tool[_-]?(?:call|result)|function[_-]?(?:call|result)|excerpt_range)(?=[\s>:])|<\|(?:tool|function)\|>/i.exec(visible);
  if (tag) return tag.index;
  try {
    const value = JSON.parse(visible);
    if (value && (Array.isArray(value.tool_calls) || typeof value.name === 'string' && value.arguments && typeof value.arguments === 'object')) return 0;
  } catch {}
  return -1;
}

export function answerPreview(text: string): string {
  const protocol = answerProtocolOffset(text);
  if (protocol >= 0) return text.slice(0, protocol);
  const partial = /<[\/|a-z_:\- ]*$/i.exec(outsideExamples(text, true));
  return partial ? text.slice(0, partial.index) : text;
}

export function answerIntegrityIssue(text: string, citationCount?: number): string | null {
  if (/request (?:was|is|has been) rejected|considered high risk|safety policy|请求被拒绝|无法协助/i.test(text)) return null;
  if (answerProtocolOffset(text) >= 0) return '模型把工具指令或工具回执写进了正文；这些文字不能证明工具已执行。';
  if (citationCount === undefined) return null;
  const references = [...outsideExamples(text, false).matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
  if (references.some(number => number < 1 || number > citationCount)) return '回答引用了本轮来源中不存在的编号。';
  if (citationCount > 0 && !references.length) return '回答缺少对应资料的正文引用编号。';
  return null;
}
