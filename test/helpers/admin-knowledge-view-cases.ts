import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { listAdminBrainPages } from '../../src/commands/admin-console.ts';

export async function verifyKnowledgeViews(engine: BrainEngine) {
  const cases = [
    ['import-note', 'note', {}, 'materials'],
    ['import-person', 'person', { imported_from: 'markdown-greenfield' }, 'materials'],
    ['import-project', 'project', {}, 'materials'],
    ['custom-document', 'proposal', {}, 'materials'],
    ['unknown-generator', 'note', { generated_by: 'unknown-script' }, 'materials'],
    ['dream-note', 'note', { dream_generated: true }, 'structured'],
    ['dream-person', 'person', { dream_generated: true }, 'structured'],
    ['dream-project', 'project', { dream_generated: true, imported_from: 'markdown-greenfield' }, 'structured'],
    ['atom', 'atom', { extracted_by: 'extract_atoms-v0.41.2.1' }, 'structured'],
    ['concept', 'concept', { synthesized_by: 'synthesize_concepts-v0.41' }, 'structured'],
    ['receipt', 'extract_receipt', { dream_generated: true }, 'materials'],
    ['insight', 'idea', { dream_generated: true }, 'insights'],
    ['old-insight', 'take', {}, 'insights'],
  ] as const;
  for (const [slug, type, frontmatter] of cases) {
    await engine.putPage(`view-test/${slug}`, { title: slug, type, frontmatter, compiled_truth: 'test', timeline: '' });
  }
  for (const view of ['materials', 'structured', 'insights'] as const) {
    const result = await listAdminBrainPages(engine, { view, q: 'view-test/', limit: '40' });
    expect(result.rows.map(row => row.slug).sort()).toEqual(cases.filter(row => row[3] === view).map(row => `view-test/${row[0]}`).sort());
    expect(result.total).toBe(result.rows.length);
  }
  const imported = await listAdminBrainPages(engine, { view: 'materials', type: 'note', q: 'view-test/' });
  expect(imported.rows.map(row => row.slug).sort()).toEqual(['view-test/import-note', 'view-test/unknown-generator']);
  expect((await listAdminBrainPages(engine, { view: 'structured', source: 'nonexistent' })).total).toBe(0);
  for (let i = 0; i < 12; i++) {
    await engine.putPage(`view-test/paged-${i}`, { title: `paged-${i}`, type: 'note', frontmatter: { dream_generated: true }, compiled_truth: 'test', timeline: '' });
  }
  const first = await listAdminBrainPages(engine, { view: 'structured', q: 'view-test/', page: '1' });
  const second = await listAdminBrainPages(engine, { view: 'structured', q: 'view-test/', page: '2' });
  expect(first.total).toBe(17);
  expect(second.total).toBe(17);
  expect(first.rows.length).toBe(10);
  expect(second.rows.length).toBe(7);
  expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(17);
}
