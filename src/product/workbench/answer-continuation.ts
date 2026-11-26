import { estimateTokens, FALLBACK_CONTEXT_TOKENS } from './context';

export const MAX_ANSWER_PARTS = 8;
export const CONTINUE_ANSWER_PROMPT = '请从中断处接着写完。先接上未完成的句子和段落，随后写齐剩下的部分。只输出新增正文，避免重写已完成的内容。';

function startsWithHeading(text: string): boolean {
  return /^#{1,6}[ \t]+\S/.test(text.trimStart());
}

export function skipsUnfinishedParagraph(text: string, part: string): boolean {
  const lastLine = text.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return lastLine.length > 20 && /[，、；：,;:]$/.test(lastLine) &&
    !/^(?:#|[-*+]|\d+[.)]|[|>])/.test(lastLine) && startsWithHeading(part);
}

export function answerContinuationContext(text: string, window = FALLBACK_CONTEXT_TOKENS): string {
  const budget = Math.min(768, Math.floor(window / 8));
  let tail = text.slice(-budget * 4);
  while (tail.length && estimateTokens(tail) > budget) tail = tail.slice(Math.ceil(tail.length * .2));
  if (tail === text) return tail;
  const sections = [...text.slice(0, text.length - tail.length).matchAll(/^#{1,6}\s+(.+)$/gm)]
    .slice(-6).map(match => match[1]!.slice(0, 48));
  return `已写正文仅保留结尾供续写。${sections.length ? `此前已写到的标题：${sections.join('、')}。` : ''}\n${tail}`;
}

export function appendAnswerPart(text: string, part: string): string {
  if (!text) return part;
  if (part === text || part.length >= 12 && text.endsWith(part)) return text;
  if (text.length >= 12 && part.startsWith(text)) return part;
  const beginning = part.trimStart();
  const ending = text.trimEnd();
  const maxOverlap = Math.min(ending.length, beginning.length, 2048);
  let addition = part;
  for (let size = maxOverlap; size >= 12; size--) {
    if (ending.endsWith(beginning.slice(0, size))) {
      addition = beginning.slice(size);
      break;
    }
  }
  const separator = startsWithHeading(addition) && !/^\r?\n/.test(addition) && !text.endsWith('\n') ? '\n\n' : '';
  return text + separator + addition;
}
