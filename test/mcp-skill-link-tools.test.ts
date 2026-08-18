import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('mcp.skills_dir', join(process.cwd(), 'skills'));
});

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

describe('MCP skill catalog', () => {
  test('list_skills and get_skill expose confined workspace prose locally', async () => {
    const listed = await operationsByName.list_skills.handler(context(), {}) as {
      count: number;
      skills: Array<{ name: string; triggers?: string[] }>;
      instructions?: { how_to_use: string[]; fetch_op: string };
    };
    expect(listed.count).toBeGreaterThan(0);
    expect(listed.instructions?.fetch_op).toBe('get_skill');
    expect(listed.instructions?.how_to_use.some(step => step.includes('list_skills'))).toBe(true);
    const name = listed.skills[0]!.name;
    const detail = await operationsByName.get_skill.handler(context(), { name }) as {
      name: string;
      body: string;
      client_guidance?: { protocol: string[] };
    };
    expect(detail.name).toBe(name);
    expect(detail.body.length).toBeGreaterThan(0);
    expect(detail.client_guidance?.protocol.length).toBeGreaterThan(0);
  });

  test('default publication turns on only when the owner has not opted out', async () => {
    const { ensureDefaultSkillPublication } = await import('../src/core/skill-catalog.ts');
    expect(await ensureDefaultSkillPublication(engine, {})).toBe('enabled');
    expect(await ensureDefaultSkillPublication(engine, {})).toBe('already');
    await engine.setConfig('mcp.publish_skills', 'false');
    expect(await ensureDefaultSkillPublication(engine, {})).toBe('opted_out');
  });

  test('remote calls fail closed until publication is explicitly enabled', async () => {
    await expect(
      operationsByName.list_skills.handler(context({ remote: true }), {}),
    ).rejects.toThrow(/disabled/i);
    await engine.setConfig('mcp.publish_skills', 'true');
    const listed = await operationsByName.list_skills.handler(context({ remote: true }), {}) as {
      count: number;
    };
    expect(listed.count).toBeGreaterThan(0);
  });

  test('get_skill rejects path-shaped names', async () => {
    await expect(
      operationsByName.get_skill.handler(context(), { name: '../CLAUDE.md' }),
    ).rejects.toThrow(/plain catalog name/i);
  });
});

describe('list_link_sources', () => {
  test('returns source-scoped provenance counts in deterministic order', async () => {
    await engine.putPage('links/a', {
      type: 'note',
      title: 'A',
      compiled_truth: 'A',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('links/b', {
      type: 'note',
      title: 'B',
      compiled_truth: 'B',
      timeline: '',
      frontmatter: {},
    });
    await engine.addLink('links/a', 'links/b', '', 'related', 'manual');
    await engine.addLink('links/a', 'links/b', '', 'cites', 'mentions');

    const rows = await operationsByName.list_link_sources.handler(context(), {}) as Array<{
      link_source: string | null;
      count: number;
    }>;
    expect(rows.map(row => row.link_source)).toContain('manual');
    expect(rows.map(row => row.link_source)).toContain('mentions');
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.count).toBeGreaterThanOrEqual(rows[i]!.count);
    }
  });
});
