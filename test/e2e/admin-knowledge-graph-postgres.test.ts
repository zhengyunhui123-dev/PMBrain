import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  getAdminKnowledgeGraphNeighborhood,
  searchAdminKnowledgeGraphPages,
} from '../../src/commands/admin-console.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('Admin knowledge graph — PostgreSQL parity', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('project-a', 'Project A')");
    await engine.putPage('knowledge/center', {
      title: '中心知识', type: 'concept', compiled_truth: '# 中心知识', timeline: '', frontmatter: {},
    });
    await engine.putPage('knowledge/center', {
      title: '同名项目知识', type: 'concept', compiled_truth: '# 同名项目知识', timeline: '', frontmatter: {},
    }, { sourceId: 'project-a' });
    await engine.putPage('knowledge/neighbor', {
      title: '关联知识', type: 'note', compiled_truth: '# 关联知识', timeline: '', frontmatter: {},
    });
    await engine.addLinksBatch([{
      from_slug: 'knowledge/center',
      to_slug: 'knowledge/neighbor',
      link_type: '支撑',
      context: '中心知识支撑关联知识',
      link_source: 'manual',
    }]);
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('keeps page identity source-scoped and returns the same one-hop edge shape as PGLite', async () => {
    const search = await searchAdminKnowledgeGraphPages(engine, { query: 'center' });
    expect(search.rows).toHaveLength(2);
    expect(new Set(search.rows.map(row => row.id)).size).toBe(2);

    const neighborhood = await getAdminKnowledgeGraphNeighborhood(engine, {
      sourceId: 'default', slug: 'knowledge/center', limit: 30,
    });
    expect(neighborhood.nodes).toHaveLength(2);
    expect(neighborhood.edges).toEqual([
      expect.objectContaining({ link_type: '支撑', context: '中心知识支撑关联知识', link_source: 'manual' }),
    ]);
  });
});
