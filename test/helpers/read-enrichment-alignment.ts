import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { readBacklinkCounts, readAdjacencyBoosts, readEffectiveDates, readContentFlags, readSalienceScores, readVersions } from '../../src/core/search/read-enrichment.ts';

export async function verifyReadEnrichment(engine: BrainEngine) {
  const q = engine.executeRaw.bind(engine);
  await q(`INSERT INTO sources (id, name) VALUES ('align-work', 'Alignment work'), ('align-other', 'Alignment other')`);
  const rows = await q<{ id: number; slug: string; source_id: string }>(`INSERT INTO pages (source_id, slug, type, title, frontmatter) VALUES
    ('align-work', 'same', 'note', 'Visible', '{}'),
    ('align-other', 'same', 'note', 'Other', '{}'),
    ('align-work', 'public', 'note', 'Public', '{}'),
    ('align-work', 'private', 'note', 'Private', '{"visibility":"private","content_flag":{"reason":"secret"}}')
    RETURNING id, slug, source_id`);
  const target = rows.find(r => r.source_id === 'align-work' && r.slug === 'same')!.id;
  const other = rows.find(r => r.source_id === 'align-other')!.id;
  const visible = rows.find(r => r.slug === 'public')!.id;
  const hidden = rows.find(r => r.slug === 'private')!.id;
  await q(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1,$4,'related','manual'),($2,$4,'related','manual'),($3,$4,'related','manual')`, [visible, hidden, other, target]);
  const scope = { sourceId: 'align-work', excludePrivate: true, takesHoldersAllowList: [] };
  expect((await readBacklinkCounts(q, [target, other], scope)).get(target)).toBe(1);
  expect((await readBacklinkCounts(q, [target, other], scope)).get(other)).toBe(0);
  expect((await readAdjacencyBoosts(q, [target, visible, hidden, other], scope)).get(target)).toEqual({ hits: 1, cross_source_hits: 0 });
  expect((await readContentFlags(q, [hidden], scope)).size).toBe(0);
  const refs = rows.map(r => ({ slug: r.slug, source_id: r.source_id }));
  expect([...(await readEffectiveDates(q, refs, scope)).keys()].sort()).toEqual(['align-work::public', 'align-work::same']);
  await q(`UPDATE pages SET emotional_weight = 100 WHERE id = $1`, [target]);
  expect((await readSalienceScores(q, refs, scope)).get('align-work::same')).toBe(0);
  expect((await readSalienceScores(q, refs, { sourceId: 'align-work' })).get('align-work::same')).toBe(500);
  await q(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight) VALUES
    ($1,1,'alignment decision','fact','self',0.9),
    ($2,1,'alignment decision','fact','self',0.9),
    ($3,1,'alignment decision','fact','self',0.9)`, [target, hidden, other]);
  const hits = await engine.searchTakes('alignment decision', { ...scope, takesHoldersAllowList: ['self'] });
  expect(hits.map(h => Number(h.page_id))).toEqual([Number(target)]);
  expect((await engine.listTakes({ ...scope, takesHoldersAllowList: ['self'] })).map(t => Number(t.page_id))).toEqual([Number(target)]);
  expect(await engine.searchTakes('alignment decision', scope)).toEqual([]);
  await q(`INSERT INTO page_versions (page_id, compiled_truth, frontmatter) VALUES
    ($1,'public snapshot','{}'), ($1,'formerly private','{"visibility":"private"}'), ($2,'foreign snapshot','{}')`, [target, other]);
  expect((await readVersions(q, 'same', { sourceIds: ['align-work'], excludePrivate: true })).map(v => v.compiled_truth)).toEqual(['public snapshot']);
  const graph = await engine.relationalFanout(['same'], { ...scope, direction: 'in' });
  expect(graph.map(r => r.slug)).toEqual(['public']);
  expect(await engine.traverseGraph('private', 2, scope)).toEqual([]);
  expect((await engine.traversePaths('same', { ...scope, direction: 'in' })).map(r => r.from_slug)).toEqual(['public']);
  await q(`UPDATE links SET origin_page_id = $1 WHERE from_page_id = $2`, [hidden, visible]);
  expect(await engine.traversePaths('same', { ...scope, direction: 'in' })).toEqual([]);
  expect((await engine.traverseGraph('public', 2, scope)).map(r => r.slug)).toEqual(['public']);
  await importFromContent(engine, 'lexical', '# Zephyr turbine\n\nZephyr turbine engineering.', { sourceId: 'align-work', noEmbed: true });
  const relaxed = await engine.searchKeyword('zephyr walrus', { sourceId: 'align-work', orFallback: true });
  expect(relaxed.length).toBeGreaterThan(0);
  expect(relaxed.every(r => r.keyword_relaxed === true)).toBe(true);
  const titles = await engine.searchTitles('zephyr walrus', { sourceId: 'align-work' });
  expect(titles.length).toBeGreaterThan(0);
  expect(titles.every(r => r.keyword_relaxed === true)).toBe(true);
}
