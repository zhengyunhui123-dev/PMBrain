import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

function op(name: string) {
  const found = operations.find(o => o.name === name);
  if (!found) throw new Error(`op not registered: ${name}`);
  return found;
}

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: { engine: 'pglite' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

async function seedFixture() {
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);

  await engine.putPage('secret/beta-doc', {
    type: 'note',
    title: 'Beta doc',
    compiled_truth: 'Visible only to beta federated readers.',
    frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('secret/beta-doc', {
    type: 'note',
    title: 'Default shadow doc',
    compiled_truth: 'Default source shadow with same slug.',
    frontmatter: {},
  });
  await engine.putPage('shared/dup', {
    type: 'note',
    title: 'Alpha duplicate',
    compiled_truth: 'Alpha duplicate slug.',
    frontmatter: {},
  }, { sourceId: 'alpha' });
  await engine.putPage('shared/dup', {
    type: 'note',
    title: 'Beta duplicate',
    compiled_truth: 'Beta duplicate slug.',
    frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('secret/beta-target', {
    type: 'note',
    title: 'Beta target',
    compiled_truth: 'Target in beta.',
    frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('default/only-doc', {
    type: 'note',
    title: 'Default only target',
    compiled_truth: 'Target outside beta grant.',
    frontmatter: {},
  });

  await engine.addTag('secret/beta-doc', 'beta-confidential', { sourceId: 'beta' });
  await engine.addTag('secret/beta-doc', 'beta-tag', { sourceId: 'beta' });
  await engine.addTag('secret/beta-doc', 'default-secret-tag');
  await engine.addTag('shared/dup', 'alpha-only', { sourceId: 'alpha' });
  await engine.addTag('shared/dup', 'beta-only', { sourceId: 'beta' });

  await engine.addLink('secret/beta-doc', 'secret/beta-target', 'inside beta', 'mentions', 'markdown', undefined, undefined, {
    fromSourceId: 'beta',
    toSourceId: 'beta',
  });
  await engine.addLink('secret/beta-doc', 'default/only-doc', 'outside target', 'mentions', 'markdown', undefined, undefined, {
    fromSourceId: 'beta',
    toSourceId: 'default',
  });
  await engine.addLink('secret/beta-target', 'secret/beta-doc', 'inside backlink', 'mentions', 'markdown', undefined, undefined, {
    fromSourceId: 'beta',
    toSourceId: 'beta',
  });
  await engine.addLink('default/only-doc', 'secret/beta-doc', 'outside backlink', 'mentions', 'markdown', undefined, undefined, {
    fromSourceId: 'default',
    toSourceId: 'beta',
  });
  await engine.addLink('secret/beta-doc', 'secret/beta-target', 'outside origin', 'frontmatter', 'frontmatter', 'default/only-doc', 'related', {
    fromSourceId: 'beta',
    toSourceId: 'beta',
    originSourceId: 'default',
  });

  await engine.addTimelineEntry('secret/beta-doc', {
    date: '2026-06-01',
    source: 'fixture',
    summary: 'beta event',
    detail: 'event visible to beta readers',
  }, { sourceId: 'beta' });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedFixture();
});

describe('federated by-slug read scope', () => {
  test('get_page resolves same-slug tags from the concrete page source', async () => {
    const page = await op('get_page').handler(ctx({
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'alpha',
        allowedSources: ['alpha', 'beta'],
      },
    }), { slug: 'secret/beta-doc' }) as { source_id?: string; tags?: string[] };

    expect(page.source_id).toBe('beta');
    expect(page.tags).toEqual(['beta-confidential', 'beta-tag']);
    expect(page.tags).not.toContain('default-secret-tag');
  });

  test('get_tags uses federated sourceIds and unions duplicate slugs', async () => {
    const betaTags = await op('get_tags').handler(ctx({
      auth: { token: 'test', clientId: 'test', scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha', 'beta'] },
    }), { slug: 'secret/beta-doc' }) as string[];
    expect(betaTags).toEqual(['beta-confidential', 'beta-tag']);

    const alphaOnly = await op('get_tags').handler(ctx({
      auth: { token: 'test', clientId: 'test', scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha'] },
    }), { slug: 'secret/beta-doc' }) as string[];
    expect(alphaOnly).toEqual([]);

    const dupTags = await engine.getTags('shared/dup', { sourceIds: ['alpha', 'beta'] });
    expect(dupTags).toEqual(['alpha-only', 'beta-only']);
  });

  test('links and backlinks require every endpoint to be inside the federated grant', async () => {
    const federated = ctx({
      sourceId: 'alpha',
      auth: { token: 'test', clientId: 'test', scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha', 'beta'] },
    });

    const links = await op('get_links').handler(federated, { slug: 'secret/beta-doc' }) as Array<{ to_slug: string; link_source?: string; origin_slug?: string | null }>;
    expect(links.map(l => l.to_slug).sort()).toEqual(['secret/beta-target', 'secret/beta-target']);
    expect(links.find(l => l.to_slug === 'default/only-doc')).toBeUndefined();
    expect(links.find(l => l.link_source === 'frontmatter')?.origin_slug ?? null).toBeNull();

    const backlinks = await op('get_backlinks').handler(federated, { slug: 'secret/beta-doc' }) as Array<{ from_slug: string }>;
    expect(backlinks.map(l => l.from_slug)).toEqual(['secret/beta-target']);
    expect(backlinks.find(l => l.from_slug === 'default/only-doc')).toBeUndefined();
  });

  test('remote scalar sourceId is promoted to sourceIds for link reads only', async () => {
    const remoteScalarLinks = await op('get_links').handler(ctx({ sourceId: 'beta', remote: true }), { slug: 'secret/beta-doc' }) as Array<{ to_slug: string }>;
    expect(remoteScalarLinks.map(l => l.to_slug).sort()).toEqual(['secret/beta-target', 'secret/beta-target']);

    const trustedLocalLinks = await op('get_links').handler(ctx({ sourceId: 'beta', remote: false }), { slug: 'secret/beta-doc' }) as Array<{ to_slug: string }>;
    expect(trustedLocalLinks.map(l => l.to_slug).sort()).toEqual(['default/only-doc', 'secret/beta-target', 'secret/beta-target']);
  });

  test('timeline accepts sourceIds through operation and engine paths', async () => {
    const allowed = await op('get_timeline').handler(ctx({
      auth: { token: 'test', clientId: 'test', scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha', 'beta'] },
    }), { slug: 'secret/beta-doc' }) as Array<{ summary: string }>;
    expect(allowed.map(e => e.summary)).toEqual(['beta event']);

    const denied = await op('get_timeline').handler(ctx({
      auth: { token: 'test', clientId: 'test', scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha'] },
    }), { slug: 'secret/beta-doc' }) as Array<{ summary: string }>;
    expect(denied).toEqual([]);

    const direct = await engine.getTimeline('secret/beta-doc', { sourceIds: ['alpha', 'beta'] });
    expect(direct.map(e => e.summary)).toEqual(['beta event']);
  });
});
