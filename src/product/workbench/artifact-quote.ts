export interface ArtifactQuoteTarget {
  text: string;
  assistantId: string;
  conversationId: string;
  artifactId: string;
  revision: number;
}

export interface SourceSegment {
  sourceStart: number;
  sourceEnd: number;
  visibleStart: number;
  visibleEnd: number;
  text: string;
  kind: 'plain' | 'code' | 'bold' | 'citation' | 'link';
  href?: string;
}

const inlineToken = /(\\\||`[^`]+`|\*\*[^*]+\*\*|\[\d+\]|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;

export function inlineSourceSegments(text: string, base: number, citationCount = 0): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlineToken)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push(plainSegment(text.slice(cursor, index), base + cursor));
    const part = match[0];
    const start = base + index;
    const end = start + part.length;
    if (part === '\\|') segments.push({ sourceStart: start, sourceEnd: end, visibleStart: start + 1, visibleEnd: end, text: '|', kind: 'plain' });
    else if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) segments.push({ sourceStart: start, sourceEnd: end, visibleStart: start + 1, visibleEnd: end - 1, text: part.slice(1, -1), kind: 'code' });
    else if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) segments.push({ sourceStart: start, sourceEnd: end, visibleStart: start + 2, visibleEnd: end - 2, text: part.slice(2, -2), kind: 'bold' });
    else if (/^\[\d+\]$/.test(part)) {
      const number = Number(part.slice(1, -1));
      if (citationCount >= number) segments.push({ sourceStart: start, sourceEnd: end, visibleStart: start + 1, visibleEnd: end - 1, text: part.slice(1, -1), kind: 'citation' });
      else segments.push(plainSegment(part, start));
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
      if (link) segments.push({ sourceStart: start, sourceEnd: end, visibleStart: start + 1, visibleEnd: start + 1 + link[1].length, text: link[1], kind: 'link', href: link[2] });
      else segments.push(plainSegment(part, start));
    }
    cursor = index + part.length;
  }
  if (cursor < text.length) segments.push(plainSegment(text.slice(cursor), base + cursor));
  return segments.filter(segment => segment.text.length || segment.sourceEnd > segment.sourceStart);
}

function plainSegment(text: string, start: number): SourceSegment {
  return { sourceStart: start, sourceEnd: start + text.length, visibleStart: start, visibleEnd: start + text.length, text, kind: 'plain' };
}

export function markdownSourceSegments(content: string, citationCount = 0): SourceSegment[] {
  const segments: SourceSegment[] = [];
  const lines = content.split('\n');
  let offset = 0;
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) inCode = !inCode;
    else if (inCode) segments.push(plainSegment(line, offset));
    else {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      const bullet = /^[-*]\s+/.exec(line);
      const quote = /^>\s?/.exec(line);
      if (heading) {
        const marker = line.length - heading[2].length;
        segments.push(...inlineSourceSegments(heading[2], offset + marker, citationCount));
      } else if (bullet) segments.push(...inlineSourceSegments(line.slice(bullet[0].length), offset + bullet[0].length, citationCount));
      else if (quote) segments.push(...inlineSourceSegments(line.slice(quote[0].length), offset + quote[0].length, citationCount));
      else if (line.trim()) segments.push(...inlineSourceSegments(line, offset, citationCount));
    }
    offset += line.length + 1;
  }
  return segments;
}

export function mappedSourceOffset(segment: Pick<SourceSegment, 'sourceStart' | 'sourceEnd' | 'visibleStart' | 'visibleEnd'>, textOffset: number, boundary: 'start' | 'end', wholeVisible: boolean): number {
  const visibleLength = Math.max(0, segment.visibleEnd - segment.visibleStart);
  const offset = Math.max(0, Math.min(textOffset, visibleLength));
  if (boundary === 'start') return offset === 0 && wholeVisible ? segment.sourceStart : segment.visibleStart + offset;
  return offset >= visibleLength && wholeVisible ? segment.sourceEnd : segment.visibleStart + offset;
}

export function selectionSourceRange(start: SourceSegment, startOffset: number, end: SourceSegment, endOffset: number): { start: number; end: number } {
  const same = start.sourceStart === end.sourceStart && start.sourceEnd === end.sourceEnd;
  const startWhole = startOffset <= 0 && (!same || endOffset >= end.visibleEnd - end.visibleStart);
  const endWhole = endOffset >= end.visibleEnd - end.visibleStart && (!same || startOffset <= 0);
  const from = mappedSourceOffset(start, startOffset, 'start', startWhole);
  const to = mappedSourceOffset(end, endOffset, 'end', endWhole);
  return from <= to ? { start: from, end: to } : { start: to, end: from };
}

export function sourceRangeForRenderedSelection(content: string, rendered: string, occurrence = 0, citationCount = 0): { start: number; end: number } {
  const pieces = markdownSourceSegments(content, citationCount);
  const spans: Array<{ plainStart: number; segment: SourceSegment }> = [];
  let plain = '';
  for (const segment of pieces) {
    if (!segment.text) continue;
    spans.push({ plainStart: plain.length, segment });
    plain += segment.text;
  }
  let found = -1;
  let seen = 0;
  let search = 0;
  while (rendered && search <= plain.length) {
    const index = plain.indexOf(rendered, search);
    if (index < 0) break;
    if (seen === occurrence) { found = index; break; }
    seen += 1;
    search = index + 1;
  }
  if (found < 0) throw new Error('选中的文字不在这份成果里');
  const locate = (index: number, boundary: 'start' | 'end') => {
    if (boundary === 'end' && index > 0) {
      const previous = [...spans].reverse().find(span => span.plainStart < index);
      if (previous && index <= previous.plainStart + previous.segment.text.length) return { segment: previous.segment, offset: index - previous.plainStart };
    }
    const span = spans.find(item => index >= item.plainStart && index < item.plainStart + item.segment.text.length) ?? spans.at(-1);
    if (!span) throw new Error('选中的文字不在这份成果里');
    return { segment: span.segment, offset: Math.max(0, index - span.plainStart) };
  };
  const start = locate(found, 'start');
  const end = locate(found + rendered.length, 'end');
  return selectionSourceRange(start.segment, start.offset, end.segment, end.offset);
}

function quoteText(input: { id: string; revision?: number; title: string; content?: string; start?: number; end?: number; selected?: string; assistantId?: string; conversationId?: string }): ArtifactQuoteTarget {
  const revision = input.revision && input.revision > 0 ? input.revision : 1;
  const selected = input.selected ?? '';
  const text = input.start !== undefined && input.end !== undefined
    ? `请修改成果 ${input.id} 的第 ${revision} 版「${input.title}」，只改第 ${input.start + 1}–${input.end} 字这一段，其他不动：\n${input.content?.slice(input.start, input.end) ?? ''}`
    : `请修改成果 ${input.id} 的第 ${revision} 版「${input.title}」。没点名的段落保持原样。`;
  return { text, assistantId: input.assistantId ?? '', conversationId: input.conversationId ?? '', artifactId: input.id, revision };
}

export function quoteArtifactSelection(input: { id: string; revision?: number; title: string; content: string; selected?: string; occurrence?: number; citationCount?: number; sourceStart?: number; sourceEnd?: number; assistantId?: string; conversationId?: string }): ArtifactQuoteTarget {
  let start = input.sourceStart;
  let end = input.sourceEnd;
  if (start === undefined || end === undefined) {
    const selected = input.selected?.trim() ?? '';
    if (!selected || selected.length > 2000) throw new Error('选中的文字不在这份成果里');
    if ((input.occurrence ?? 0) === 0 && input.content.includes(selected)) {
      start = input.content.indexOf(selected);
      end = start + selected.length;
    } else {
      const mapped = sourceRangeForRenderedSelection(input.content, selected, input.occurrence ?? 0, input.citationCount ?? 0);
      start = mapped.start;
      end = mapped.end;
    }
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > input.content.length || end <= start) throw new Error('选中的文字不在这份成果里');
  const slice = input.content.slice(start, end);
  if (!slice || slice.length > 2000) throw new Error('选中的文字不在这份成果里');
  return quoteText({ ...input, start, end, selected: slice });
}

export function quoteArtifact(input: { id: string; revision?: number; title: string; assistantId?: string; conversationId?: string }): ArtifactQuoteTarget {
  return quoteText(input);
}
