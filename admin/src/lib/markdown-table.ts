export interface MarkdownTableBlock {
  headers: string[];
  rows: string[][];
  endIndex: number;
}

export function markdownTableCellSources(line: string): Array<{ text: string; start: number; end: number }> {
  const cells: Array<{ text: string; start: number; end: number }> = [];
  let from = line.length - line.trimStart().length;
  let end = line.trimEnd().length;
  if (line[from] === '|') from += 1;
  if (line[end - 1] === '|' && line[end - 2] !== '\\') end -= 1;
  const append = (to: number) => {
    const raw = line.slice(from, to);
    const start = from + raw.length - raw.trimStart().length;
    const stop = Math.max(start, to - raw.length + raw.trimEnd().length);
    cells.push({ text: line.slice(start, stop), start, end: stop });
  };
  for (let index = from; index < end; index += 1) {
    if (line[index] === '\\' && line[index + 1] === '|') index += 1;
    else if (line[index] === '|') { append(index); from = index + 1; }
  }
  append(end);
  return cells;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseMarkdownTable(lines: string[], startIndex: number): MarkdownTableBlock | null {
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];
  if (!headerLine?.includes('|') || !separatorLine?.includes('|')) return null;

  const headers = splitTableRow(headerLine);
  const separators = splitTableRow(separatorLine);
  if (headers.length < 2 || separators.length !== headers.length) return null;
  if (!separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;

  const rows: string[][] = [];
  let endIndex = startIndex + 2;
  while (endIndex < lines.length && lines[endIndex].trim() && lines[endIndex].includes('|')) {
    const cells = splitTableRow(lines[endIndex]);
    rows.push(headers.map((_, index) => cells[index] ?? ''));
    endIndex += 1;
  }
  return { headers, rows, endIndex };
}
