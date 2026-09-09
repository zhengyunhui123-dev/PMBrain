import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('personal', 'Personal') ON CONFLICT (id) DO NOTHING`,
  );
});

const atoms = [
  { slug: 'atoms/a1', source_id: 'personal', title: 'A1', body: 'b1', concept_refs: ['theme'] },
  { slug: 'atoms/a2', source_id: 'personal', title: 'A2', body: 'b2', concept_refs: ['theme'] },
];

describe('synthesize_concepts Source scope', () => {
  test('writes page, receipt, rollup and evidence links under the cycle Source', async () => {
    for (const atom of atoms) {
      await engine.putPage(atom.slug, {
        type: 'atom',
        title: atom.title,
        compiled_truth: atom.body,
        timeline: '',
        frontmatter: { concepts: ['theme'] },
      }, { sourceId: 'personal' });
    }

    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(result.status).toBe('ok');

    const pageSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'concepts/theme'`,
    );
    expect(pageSources.map(row => row.source_id)).toEqual(['personal']);

    const receiptSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id
         FROM pages
        WHERE type = 'extract_receipt'
          AND frontmatter->>'kind' = 'concepts'`,
    );
    expect(receiptSources.length).toBeGreaterThan(0);
    expect(receiptSources.every(row => row.source_id === 'personal')).toBe(true);

    const rollupSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM extract_rollup_7d WHERE kind = 'concepts'`,
    );
    expect(rollupSources.length).toBeGreaterThan(0);
    expect(rollupSources.every(row => row.source_id === 'personal')).toBe(true);

    const linkSources = await engine.executeRaw<{
      from_source_id: string;
      to_source_id: string;
      origin_source_id: string;
    }>(
      `SELECT f.source_id AS from_source_id,
              t.source_id AS to_source_id,
              o.source_id AS origin_source_id
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE o.slug = 'concepts/theme'`,
    );
    expect(linkSources.length).toBeGreaterThan(0);
    expect(linkSources.every(row =>
      row.from_source_id === 'personal' &&
      row.to_source_id === 'personal' &&
      row.origin_source_id === 'personal')).toBe(true);
  }, 120_000);
});

describe('synthesize_concepts concept-provenance edges', () => {
  const memberSlugs = ['atoms/a1', 'atoms/a2'];

  async function seedThemeAtoms(): Promise<void> {
    for (const atom of atoms) {
      await engine.putPage(atom.slug, {
        type: 'atom',
        title: atom.title,
        compiled_truth: atom.body,
        timeline: '',
        frontmatter: { concepts: ['theme'] },
      }, { sourceId: 'personal' });
    }
  }

  async function provenanceRows(): Promise<Array<{ link_type: string; from_slug: string; to_slug: string }>> {
    return engine.executeRaw(
      `SELECT l.link_type, f.slug AS from_slug, t.slug AS to_slug
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE l.link_source = 'concept-provenance'`,
    );
  }

  test('writes synthesized_from and synthesizes edges under the cycle Source', async () => {
    await seedThemeAtoms();
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(result.status).toBe('ok');

    const rows = await provenanceRows();
    const fromConcept = rows.filter(row => row.link_type === 'synthesized_from');
    const fromAtom = rows.filter(row => row.link_type === 'synthesizes');
    expect(fromConcept.map(row => row.to_slug).sort()).toEqual([...memberSlugs]);
    expect(fromConcept.every(row => row.from_slug === 'concepts/theme')).toBe(true);
    expect(fromAtom.map(row => row.from_slug).sort()).toEqual([...memberSlugs]);
    expect(fromAtom.every(row => row.to_slug === 'concepts/theme')).toBe(true);
  }, 120_000);

  test('re-running the phase does not duplicate provenance edges', async () => {
    await seedThemeAtoms();
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect((await provenanceRows()).length).toBe(4);
    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(second.status).toBe('ok');
    expect((await provenanceRows()).length).toBe(4);
  }, 120_000);

  test('dry-run writes zero provenance edges', async () => {
    await seedThemeAtoms();
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      sourceId: 'personal',
      dryRun: true,
    });
    expect(result.details?.concepts_written).toBe(1);
    expect(await provenanceRows()).toEqual([]);
  }, 120_000);
});
