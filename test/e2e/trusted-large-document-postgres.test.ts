/**
 * Behavioral Postgres parity for Trusted Large Document Mode.
 * Run with DATABASE_URL pointing at an isolated test database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importTrustedStructuredContent, type ParentSectionInput } from '../../src/core/import-file.ts';
import { isEmbedSkipped } from '../../src/core/embed-skip.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
let engine: PostgresEngine;
const slug = 'tests/trusted-large-document-postgres';

function sections(): ParentSectionInput[] {
  return Array.from({ length: 120 }, (_, index) => ({
    title: `Chapter ${index + 1}`,
    locator: `page ${index + 1}`,
    text: `section-${index}-` + 'p'.repeat(5_000),
  }));
}

function content(parentSections: ParentSectionInput[]): string {
  return [
    '---',
    'type: source',
    'title: "Postgres large document"',
    'document_structured: true',
    '---',
    '',
    '# Postgres large document',
    '',
    ...parentSections.flatMap(section => [`## ${section.title}`, section.text, '']),
  ].join('\n');
}

describe.skipIf(skip)('Trusted Large Document Mode - Postgres parity', () => {
  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
    await engine.executeRaw(`DELETE FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
  });

  afterAll(async () => {
    if (!engine) return;
    await engine.executeRaw(`DELETE FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
    await engine.disconnect();
  });

  test('stores a >500KB structured page and its section chunks without embed_skip', async () => {
    const parentSections = sections();
    const result = await importTrustedStructuredContent(engine, slug, content(parentSections), {
      noEmbed: true,
      sourceId: 'default',
      parentSections,
    });
    expect(result.status).toBe('imported');
    expect(result.largeDocument?.phase).toBe('completed');
    expect(result.largeDocument?.chunksTotal).toBe(120);
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(isEmbedSkipped(page!.frontmatter)).toBe(false);
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    expect(chunks).toHaveLength(120);
    expect(chunks[0].chunk_text).toContain('Locator: page 1');
  });
});
