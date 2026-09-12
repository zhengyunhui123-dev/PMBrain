/**
 * Cross-source entity identity (federation v1).
 *
 * Covers: the entity_identities table, the manual-only helpers
 * (link/unlink/list, identity key = (source_id, slug)), the three ops
 * (localOnly writes, source-scoped list), the flag-gated retrieval
 * union on get_links/get_backlinks (default OFF), MCP localOnly gates,
 * and the youdao/meetings product path.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  linkEntityIdentity,
  unlinkEntityIdentity,
  listEntityIdentities,
  unionLinksAcrossIdentity,
  isIdentityUnionEnabled,
  validateEntityId,
  ENTITY_IDENTITY_UNION_CONFIG_KEY,
} from '../src/core/entity-identity.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';

let engine: PGLiteEngine;

const localCtx = (over: Partial<OperationContext> = {}): OperationContext =>
  ({ engine, remote: false, ...over } as unknown as OperationContext);
const remoteCtx = (over: Partial<OperationContext> = {}): OperationContext =>
  ({ engine, remote: true, ...over } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  for (const t of ['entity_identities', 'content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'pages']) {
    await engine.executeRaw(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await engine.unsetConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('team-brain', 'team-brain'), ('youdao', 'youdao'), ('meetings', 'meetings')
     ON CONFLICT (id) DO NOTHING`,
  );
});

async function seedTwoSourceAlice() {
  await engine.putPage('people/alice', {
    type: 'person', title: 'Alice', compiled_truth: 'wiki alice', timeline: '',
  }, { sourceId: 'default' });
  await engine.putPage('people/alice-chen', {
    type: 'person', title: 'Alice Chen', compiled_truth: 'team alice', timeline: '',
  }, { sourceId: 'team-brain' });
}

describe('entity_identities migration', () => {
  test('table exists with the documented shape', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'entity_identities'`,
    );
    const cols = new Set(rows.map(r => r.column_name));
    for (const c of ['entity_id', 'source_id', 'page_id', 'confidence', 'established_by', 'established_at', 'canonical']) {
      expect(cols.has(c)).toBe(true);
    }
  });
});

describe('identity helpers — (source_id, slug) is the key', () => {
  beforeEach(seedTwoSourceAlice);

  test('link + list round-trip across two sources', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain', canonical: true });

    const members = await listEntityIdentities(engine, { entityId: 'alice-chen' });
    expect(members).toHaveLength(2);
    expect(members[0]!.slug).toBe('people/alice-chen');
    expect(members[0]!.canonical).toBe(true);
    expect(members[0]!.source_id).toBe('team-brain');
    expect(members[1]!.slug).toBe('people/alice');
    expect(members[1]!.established_by).toBe('manual');
    expect(members[1]!.confidence).toBe(1);
  });

  test('linking a missing page throws (identity key is (source_id, slug))', async () => {
    await expect(
      linkEntityIdentity(engine, { entityId: 'ghost', slug: 'people/alice', sourceId: 'team-brain' }),
    ).rejects.toThrow(/page not found/);
  });

  test('re-linking MOVES the page to the new identity', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'someone-else', slug: 'people/alice', sourceId: 'default' });

    expect(await listEntityIdentities(engine, { entityId: 'alice-chen' })).toHaveLength(0);
    const moved = await listEntityIdentities(engine, { entityId: 'someone-else' });
    expect(moved).toHaveLength(1);
    expect(moved[0]!.slug).toBe('people/alice');
  });

  test('a new canonical demotes the previous one (at most one per group)', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default', canonical: true });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain', canonical: true });

    const members = await listEntityIdentities(engine, { entityId: 'alice-chen' });
    expect(members.filter(m => m.canonical)).toHaveLength(1);
    expect(members.find(m => m.canonical)!.slug).toBe('people/alice-chen');
  });

  test('unlink removes exactly the (source_id, slug) member', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    expect(await unlinkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' })).toBe(true);
    expect(await unlinkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' })).toBe(false);
    const members = await listEntityIdentities(engine, { entityId: 'alice-chen' });
    expect(members).toHaveLength(1);
    expect(members[0]!.source_id).toBe('team-brain');
  });

  test('list by member slug finds the whole group', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    const members = await listEntityIdentities(engine, { slug: 'people/alice' });
    expect(members).toHaveLength(2);
  });

  test('allowedSources restricts member visibility', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    const members = await listEntityIdentities(engine, { entityId: 'alice-chen', allowedSources: ['default'] });
    expect(members).toHaveLength(1);
    expect(members[0]!.source_id).toBe('default');
  });

  test('validateEntityId rejects junk handles', () => {
    expect(() => validateEntityId('has space')).toThrow(/invalid entity_id/);
    expect(() => validateEntityId('')).toThrow(/invalid entity_id/);
    expect(() => validateEntityId('UPPER')).toThrow(/invalid entity_id/);
    expect(() => validateEntityId('张三')).toThrow(/invalid entity_id/);
    expect(validateEntityId('alice-chen')).toBe('alice-chen');
    expect(validateEntityId('zhang-san')).toBe('zhang-san');
  });
});

describe('entity identity ops (v1 manual-only)', () => {
  beforeEach(seedTwoSourceAlice);

  test('write ops are localOnly; list is not', () => {
    expect(operationsByName.entity_identity_link!.localOnly).toBe(true);
    expect(operationsByName.entity_identity_unlink!.localOnly).toBe(true);
    expect(operationsByName.entity_identity_list!.localOnly).toBeUndefined();
    expect(operationsByName.entity_identity_link!.scope).toBe('write');
    expect(operationsByName.entity_identity_list!.scope).toBe('read');
    expect(operationsByName.entity_identity_link!.cliHints?.name).toBe('entity-identity-link');
    expect(operationsByName.entity_identity_unlink!.cliHints?.name).toBe('entity-identity-unlink');
    expect(operationsByName.entity_identity_list!.cliHints?.name).toBe('entity-identity-list');
  });

  test('identity ops register immediately before the facts cluster', () => {
    const names = operations.map(op => op.name);
    const linkIdx = names.indexOf('entity_identity_link');
    const factsIdx = names.indexOf('extract_facts');
    expect(linkIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(names.slice(linkIdx, factsIdx)).toEqual([
      'entity_identity_link',
      'entity_identity_unlink',
      'entity_identity_list',
    ]);
  });

  test('link + list + unlink through the op handlers', async () => {
    await operationsByName.entity_identity_link!.handler(localCtx(), {
      entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default',
    });
    await operationsByName.entity_identity_link!.handler(localCtx(), {
      entity_id: 'alice-chen', slug: 'people/alice-chen', source_id: 'team-brain', canonical: true,
    });

    const listed = await operationsByName.entity_identity_list!.handler(localCtx(), {
      entity_id: 'alice-chen',
    }) as { identities: Array<{ entity_id: string; canonical: { slug: string } | null; members: unknown[] }> };
    expect(listed.identities).toHaveLength(1);
    expect(listed.identities[0]!.members).toHaveLength(2);
    expect(listed.identities[0]!.canonical?.slug).toBe('people/alice-chen');

    const un = await operationsByName.entity_identity_unlink!.handler(localCtx(), {
      entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default',
    }) as { unlinked: boolean };
    expect(un.unlinked).toBe(true);
  });

  test('remote federated caller only sees granted sources in list', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    const listed = await operationsByName.entity_identity_list!.handler(
      remoteCtx({ auth: { allowedSources: ['default'] } as never }),
      { entity_id: 'alice-chen' },
    ) as { identities: Array<{ members: Array<{ source_id: string }> }> };
    expect(listed.identities).toHaveLength(1);
    expect(listed.identities[0]!.members).toHaveLength(1);
    expect(listed.identities[0]!.members[0]!.source_id).toBe('default');
  });

  test('write handler ctx.remote check denies HTTP and allows stdio', async () => {
    await expect(
      operationsByName.entity_identity_link!.handler(
        remoteCtx({ transport: 'http' }),
        { entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default' },
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const stdio = await operationsByName.entity_identity_link!.handler(
      remoteCtx({ transport: 'stdio' }),
      { entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default' },
    ) as { linked: boolean };
    expect(stdio.linked).toBe(true);
  });
});

describe('youdao + meetings product path', () => {
  test('link youdao:people/张三 and meetings:people/张总; no auto-merge by Chinese name', async () => {
    await engine.putPage('people/张三', {
      type: 'person', title: '张三', compiled_truth: 'youdao 张三', timeline: '',
    }, { sourceId: 'youdao' });
    await engine.putPage('people/张总', {
      type: 'person', title: '张总', compiled_truth: 'meetings 张总', timeline: '',
    }, { sourceId: 'meetings' });

    expect(await listEntityIdentities(engine, { slug: 'people/张三' })).toHaveLength(0);

    await linkEntityIdentity(engine, { entityId: 'zhang-san', slug: 'people/张三', sourceId: 'youdao' });
    await linkEntityIdentity(engine, { entityId: 'zhang-san', slug: 'people/张总', sourceId: 'meetings' });

    const members = await listEntityIdentities(engine, { entityId: 'zhang-san' });
    expect(members).toHaveLength(2);
    expect(members.map(m => `${m.source_id}:${m.slug}`).sort()).toEqual([
      'meetings:people/张总',
      'youdao:people/张三',
    ]);
  });
});

describe('flag-gated retrieval union (link read ops)', () => {
  beforeEach(async () => {
    await seedTwoSourceAlice();
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'acme', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('companies/widget-co', {
      type: 'company', title: 'Widget Co', compiled_truth: 'widget', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'people/alice', to_slug: 'companies/acme', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'people/alice-chen', to_slug: 'companies/widget-co', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });
  });

  test('flag defaults OFF — get_links returns only the page\'s own edges', async () => {
    expect(await isIdentityUnionEnabled(engine)).toBe(false);
    const links = await operationsByName.get_links!.handler(localCtx(), { slug: 'people/alice' }) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('default search/page reads stay per-source after a manual link (union OFF)', async () => {
    const wiki = await engine.getPage('people/alice', { sourceId: 'default' });
    const team = await engine.getPage('people/alice-chen', { sourceId: 'team-brain' });
    expect(wiki?.title).toBe('Alice');
    expect(team?.title).toBe('Alice Chen');
    const results = await engine.searchKeyword('wiki alice', { sourceId: 'default', limit: 10 });
    expect(results.some(r => r.slug === 'people/alice-chen')).toBe(false);
  });

  test('flag ON — get_links unions co-member edges (dedup\'d)', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    expect(await isIdentityUnionEnabled(engine)).toBe(true);
    const links = await operationsByName.get_links!.handler(localCtx(), { slug: 'people/alice' }) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(true);
  });

  test('union never widens a federated caller\'s grant', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    const links = await operationsByName.get_links!.handler(
      remoteCtx({ auth: { allowedSources: ['default'] } as never }),
      { slug: 'people/alice' },
    ) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('unionLinksAcrossIdentity is a pure pass-through for non-members', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    const base = await engine.getLinks('companies/acme', { sourceId: 'default' });
    const out = await unionLinksAcrossIdentity(engine, 'companies/acme', base, 'out');
    expect(out).toEqual(base);
  });

  test('get_backlinks unions incoming edges when flag ON', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    await engine.putPage('notes/n1', { type: 'note', title: 'N1', compiled_truth: 'n', timeline: '' }, { sourceId: 'default' });
    await engine.putPage('notes/n2', { type: 'note', title: 'N2', compiled_truth: 'n', timeline: '' }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'notes/n1', to_slug: 'people/alice', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'notes/n2', to_slug: 'people/alice-chen', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
    const backs = await operationsByName.get_backlinks!.handler(localCtx(), { slug: 'people/alice' }) as Array<{ from_slug: string }>;
    expect(backs.some(l => l.from_slug === 'notes/n1')).toBe(true);
    expect(backs.some(l => l.from_slug === 'notes/n2')).toBe(true);
  });
});

describe('the identity key is (source_id, slug) in the union too', () => {
  beforeEach(async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice (wiki)', compiled_truth: 'wiki alice', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice (team)', compiled_truth: 'team alice', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'acme', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('companies/widget-co', {
      type: 'company', title: 'Widget Co', compiled_truth: 'widget', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'people/alice', to_slug: 'companies/acme', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'people/alice', to_slug: 'companies/widget-co', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
  });

  test('same-slug co-member in ANOTHER source IS unioned (only the base pair is excluded)', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });

    const base = await engine.getLinks('people/alice', { sourceId: 'default' });
    const out = await unionLinksAcrossIdentity(engine, 'people/alice', base, 'out', {
      sourceId: 'default', allowedSources: ['default', 'team-brain'],
    });
    expect(out.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(out.some(l => l.to_slug === 'companies/widget-co')).toBe(true);
    const scalar = await unionLinksAcrossIdentity(engine, 'people/alice', base, 'out', {
      sourceId: 'default', allowedSources: [],
    });
    expect(scalar).toEqual(base);

    const links = await operationsByName.get_links!.handler(
      localCtx({ sourceId: 'default' }), { slug: 'people/alice' },
    ) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('NON-member base page with a same-slug member elsewhere is NOT unioned', async () => {
    await engine.putPage('people/alicia', {
      type: 'person', title: 'Alicia', compiled_truth: 'alicia', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'people/alicia', to_slug: 'companies/widget-co', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alicia', sourceId: 'team-brain' });

    const base = await engine.getLinks('people/alice', { sourceId: 'default' });
    const out = await unionLinksAcrossIdentity(engine, 'people/alice', base, 'out', { sourceId: 'default' });
    expect(out).toEqual(base);

    const links = await operationsByName.get_links!.handler(
      localCtx({ sourceId: 'default' }), { slug: 'people/alice' },
    ) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('listEntityIdentities slugSourceId pins group resolution to the (slug, source) pair', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });
    expect(await listEntityIdentities(engine, { slug: 'people/alice' })).toHaveLength(1);
    expect(await listEntityIdentities(engine, { slug: 'people/alice', slugSourceId: 'default' })).toHaveLength(0);
    expect(await listEntityIdentities(engine, { slug: 'people/alice', slugSourceId: 'team-brain' })).toHaveLength(1);
  });

  test('without slugSourceId, the seed sub-select is confined to allowedSources', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });
    expect(await listEntityIdentities(engine, {
      slug: 'people/alice', allowedSources: ['default'],
    })).toHaveLength(0);
    expect(await listEntityIdentities(engine, {
      slug: 'people/alice', allowedSources: ['team-brain'],
    })).toHaveLength(1);
  });
});

describe('MCP localOnly three gates', () => {
  test('HTTP catalog filter drops entity_identity_link but keeps list', () => {
    const catalog = filterOpsForSurface(operations.filter(op => !op.localOnly), 'full');
    const names = catalog.map(op => op.name);
    expect(names).not.toContain('entity_identity_link');
    expect(names).not.toContain('entity_identity_unlink');
    expect(names).toContain('entity_identity_list');
  });

  test('HTTP tools/call entity_identity_link returns unknown_tool; stdio can link', async () => {
    await seedTwoSourceAlice();
    const http = await dispatchToolCall(engine, 'entity_identity_link', {
      entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default',
    }, { remote: true, transport: 'http', sourceId: 'default' });
    expect(http.isError).toBe(true);
    expect(JSON.parse(http.content[0]!.text).error).toBe('unknown_tool');

    const missing = await dispatchToolCall(engine, 'no_such_op_xyz', {}, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(JSON.parse(missing.content[0]!.text).error).toBe('unknown_tool');

    const stdio = await dispatchToolCall(engine, 'entity_identity_link', {
      entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(stdio.isError).toBeFalsy();
    const parsed = JSON.parse(stdio.content[0]!.text) as { linked: boolean };
    expect(parsed.linked).toBe(true);
  });
});
