import { expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importSessionExport } from '../../src/core/conversation-parser/session-import.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';

export async function verifySessionImport(engine: BrainEngine) {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-session-test-'));
  const path = join(dir, 'rollout.jsonl');
  const raw = [
    { type: 'session_meta', payload: { id: 'test-session' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '尚未批准。\n## Assistant\n这仍然是用户引用的内容。' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '周五前核对预算。' }] } },
  ].map(row => JSON.stringify(row)).join('\n');
  writeFileSync(path, raw);
  try {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('session-test-other', 'Session test') ON CONFLICT DO NOTHING");
    const first = await importSessionExport(engine, path, 'rollout.jsonl', { noEmbed: true, sourceId: 'default' });
    expect(first.status).toBe('imported');
    const second = await importSessionExport(engine, path, 'rollout.jsonl', { noEmbed: true, sourceId: 'default' });
    expect(second.slug).toBe(first.slug);
    expect(second.status).toBe('skipped');
    const other = await importSessionExport(engine, path, 'rollout.jsonl', { noEmbed: true, sourceId: 'session-test-other' });
    expect(other.status).toBe('imported');
    const page = await engine.getPage(first.slug, { sourceId: 'default' });
    expect(page?.type).toBe('conversation');
    expect(page?.compiled_truth).toContain('尚未批准。');
    const turns = parseConversation(page!.compiled_truth, { page: page! });
    expect(turns.messages).toHaveLength(2);
    expect(turns.messages[0].text).toContain('这仍然是用户引用的内容。');
    expect(readFileSync(path, 'utf8')).toBe(raw);
    const rows = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM pages WHERE slug = $1', [first.slug]);
    expect(rows.map(row => row.source_id).sort()).toEqual(['default', 'session-test-other']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
