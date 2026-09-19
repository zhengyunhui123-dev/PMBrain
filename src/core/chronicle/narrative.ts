// v0.42.x — Life Chronicle (#2390) narrative rendering (Phase A.6 delight).
// Pure function: turn timeline projection rows into a readable prose day-by-day
// summary (the `--narrative` flag on `pmbrain day`). No SQL, no I/O.
import type { ChronicleTimelineRow } from '../types.ts';

function preferChinese(lang?: string): boolean {
  const raw = lang ?? process.env.LANG ?? process.env.LC_ALL ?? '';
  return /zh|cn|chinese/i.test(raw);
}

export function renderTimelineNarrative(rows: ChronicleTimelineRow[], lang?: string): string {
  const zh = preferChinese(lang);
  if (!rows.length) return zh ? '该时间窗口没有事件。' : 'No events in this window.';
  const byDate = new Map<string, ChronicleTimelineRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const lines: string[] = [];
  for (const [date, rs] of byDate) {
    const items = rs
      .map((r) => (r.kind ? `${r.summary} (${r.kind})` : r.summary))
      .join(zh ? '；' : '; ');
    lines.push(zh
      ? `${date} — ${rs.length} 件：${items}`
      : `${date} — ${rs.length} event${rs.length === 1 ? '' : 's'}: ${items}`);
  }
  return lines.join('\n');
}
