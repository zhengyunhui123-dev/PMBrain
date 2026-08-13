import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  getAdminKnowledgeGraphGlobal,
  getAdminKnowledgeGraphIsolated,
  getAdminKnowledgeGraphMeta,
  getAdminKnowledgeGraphNeighborhood,
  searchAdminKnowledgeGraphPages,
} from '../src/commands/admin-console.ts';
import {
  KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES,
  mergeKnowledgeGraphData,
} from '../admin/src/lib/knowledge-graph.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM tags');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
});

async function seedPage(
  db: BrainEngine,
  slug: string,
  title: string,
  sourceId = 'default',
  type = 'note',
) {
  if (sourceId !== 'default') {
    await db.executeRaw(
      'INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [sourceId, sourceId],
    );
  }
  return db.putPage(slug, {
    title,
    type,
    compiled_truth: `# ${title}\n\n${title} 的正文摘要。`,
    timeline: '',
    frontmatter: {},
  }, { sourceId });
}

describe('Admin knowledge graph read model', () => {
  test('search keeps same-slug pages from different Sources distinct by page_id', async () => {
    const first = await seedPage(engine, 'notes/same', '默认知识');
    const second = await seedPage(engine, 'notes/same', '项目知识', 'project-a');

    const result = await searchAdminKnowledgeGraphPages(engine, { query: 'same' });

    expect(result.rows.map(row => row.id).sort((a, b) => a - b)).toEqual([first.id, second.id].sort((a, b) => a - b));
    expect(new Set(result.rows.map(row => `${row.source_id}:${row.slug}`)).size).toBe(2);
  });

  test('one-hop expansion returns outgoing links, backlinks, relation metadata and tags', async () => {
    const center = await seedPage(engine, 'knowledge/three-lists', '三张清单');
    const outbound = await seedPage(engine, 'knowledge/dispatch', '应急调度');
    const inbound = await seedPage(engine, 'knowledge/review', '复盘机制');
    await engine.addLinksBatch([
      {
        from_slug: center.slug,
        to_slug: outbound.slug,
        link_type: '支撑',
        context: '三张清单支撑应急调度',
        link_source: 'manual',
      },
      {
        from_slug: inbound.slug,
        to_slug: center.slug,
        link_type: '引用',
        context: '复盘机制引用三张清单',
        link_source: 'frontmatter',
        origin_slug: inbound.slug,
      },
    ]);
    await engine.executeRaw(
      'INSERT INTO tags (page_id, tag) VALUES ($1, $2), ($1, $3)',
      [center.id, '方法', '项目管理'],
    );

    const result = await getAdminKnowledgeGraphNeighborhood(engine, {
      sourceId: 'default', slug: center.slug, limit: 30,
    });

    expect(result.center_id).toBe(center.id);
    expect(result.nodes.map(node => node.id).sort((a, b) => a - b)).toEqual(
      [center.id, outbound.id, inbound.id].sort((a, b) => a - b),
    );
    expect(result.nodes.find(node => node.id === center.id)?.tags).toEqual(['方法', '项目管理']);
    expect(result.nodes.find(node => node.id === center.id)?.outgoing_count).toBe(1);
    expect(result.nodes.find(node => node.id === center.id)?.incoming_count).toBe(1);
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_page_id: center.id,
        to_page_id: outbound.id,
        link_type: '支撑',
        context: '三张清单支撑应急调度',
        link_source: 'manual',
      }),
      expect.objectContaining({
        from_page_id: inbound.id,
        to_page_id: center.id,
        link_type: '引用',
        context: '复盘机制引用三张清单',
        link_source: 'frontmatter',
      }),
    ]));
  });

  test('isolated knowledge remains visible and high fan-out is truncated at the requested limit', async () => {
    const isolated = await seedPage(engine, 'knowledge/isolated', '孤立知识');
    const isolatedResult = await getAdminKnowledgeGraphNeighborhood(engine, {
      sourceId: 'default', slug: isolated.slug, limit: 30,
    });
    expect(isolatedResult.nodes.map(node => node.id)).toEqual([isolated.id]);
    expect(isolatedResult.edges).toEqual([]);
    expect(isolatedResult.truncated).toBe(false);

    const hub = await seedPage(engine, 'knowledge/hub', '核心知识');
    for (let index = 0; index < 36; index += 1) {
      const neighbor = await seedPage(engine, `knowledge/neighbor-${index}`, `邻居 ${index}`);
      await engine.addLinksBatch([{
        from_slug: hub.slug,
        to_slug: neighbor.slug,
        link_type: '关联',
        link_source: 'manual',
      }]);
    }
    const bounded = await getAdminKnowledgeGraphNeighborhood(engine, {
      sourceId: 'default', slug: hub.slug, limit: 30,
    });
    expect(bounded.edges).toHaveLength(30);
    expect(bounded.nodes).toHaveLength(31);
    expect(bounded.truncated).toBe(true);
  });

  test('metadata exposes relation types and chooses a connected seed without loading the whole graph', async () => {
    const seed = await seedPage(engine, 'knowledge/seed', '起始知识');
    const neighbor = await seedPage(engine, 'knowledge/neighbor', '关联知识');
    await engine.addLinksBatch([{
      from_slug: seed.slug,
      to_slug: neighbor.slug,
      link_type: '包含',
      link_source: 'manual',
    }]);

    const meta = await getAdminKnowledgeGraphMeta(engine, {});
    expect(meta.relation_types).toContain('包含');
    expect(meta.seed).not.toBeNull();
    expect([seed.id, neighbor.id]).toContain(meta.seed!.id);
  });

  test('global view returns lightweight nodes, all visible relations, source filtering and honest totals', async () => {
    const first = await seedPage(engine, 'global/one', '全局一');
    const second = await seedPage(engine, 'global/two', '全局二');
    const other = await seedPage(engine, 'global/other', '其他 Source', 'project-a');
    await engine.addLinksBatch([{
      from_slug: first.slug,
      to_slug: second.slug,
      link_type: '全局关联',
      context: '全局图谱关系上下文',
      link_source: 'manual',
    }]);

    const global = await getAdminKnowledgeGraphGlobal(engine, {});
    expect(global.total_nodes).toBe(3);
    expect(global.total_edges).toBe(1);
    expect(global.nodes).toHaveLength(3);
    expect(global.edges).toHaveLength(1);
    expect(global.nodes.every(node => node.preview === '' && node.tags.length === 0)).toBe(true);
    expect(global.truncated).toBe(false);

    const scoped = await getAdminKnowledgeGraphGlobal(engine, { sourceId: other.source_id });
    expect(scoped.total_nodes).toBe(1);
    expect(scoped.total_edges).toBe(0);
    expect(scoped.nodes.map(node => node.id)).toEqual([other.id]);
  });

  test('isolated view returns only pages with no valid incoming or outgoing links and respects Source', async () => {
    const isolatedDefault = await seedPage(engine, 'isolated/default', '默认孤立页');
    const connectedA = await seedPage(engine, 'connected/a', '关联页 A');
    const connectedB = await seedPage(engine, 'connected/b', '关联页 B');
    const isolatedOther = await seedPage(engine, 'isolated/other', '其他孤立页', 'project-a');
    await engine.addLinksBatch([{
      from_slug: connectedA.slug,
      to_slug: connectedB.slug,
      link_type: '关联',
      link_source: 'manual',
    }]);

    const all = await getAdminKnowledgeGraphIsolated(engine, {});
    expect(all.total_nodes).toBe(2);
    expect(all.total_edges).toBe(0);
    expect(all.edges).toEqual([]);
    expect(all.nodes.map(node => node.id).sort((a, b) => a - b)).toEqual(
      [isolatedDefault.id, isolatedOther.id].sort((a, b) => a - b),
    );
    expect(all.nodes.every(node => node.relation_count === 0 && node.preview === '' && node.tags.length === 0)).toBe(true);

    const scoped = await getAdminKnowledgeGraphIsolated(engine, { sourceId: 'project-a' });
    expect(scoped.total_nodes).toBe(1);
    expect(scoped.nodes.map(node => node.id)).toEqual([isolatedOther.id]);
  });
});

describe('Knowledge graph client-side bounds', () => {
  test('deduplicates nodes and edges while preserving existing graph data', () => {
    const baseNode = {
      id: 1, slug: 'a', title: 'A', source_id: 'default', source_name: 'default', type: 'note',
      preview: '', tags: [], updated_at: '2026-08-12', outgoing_count: 1, incoming_count: 0, relation_count: 1,
    };
    const nextNode = { ...baseNode, id: 2, slug: 'b', title: 'B' };
    const edge = {
      id: 10, from_page_id: 1, to_page_id: 2, link_type: '关联', context: '', link_source: 'manual',
    };
    const merged = mergeKnowledgeGraphData(
      { nodes: [baseNode], edges: [] },
      { center_id: 1, nodes: [baseNode, nextNode], edges: [edge], truncated: false, limit: 30 },
    );
    const mergedAgain = mergeKnowledgeGraphData(merged, {
      center_id: 1, nodes: [baseNode, nextNode], edges: [edge], truncated: false, limit: 30,
    });
    expect(mergedAgain.nodes.map(node => node.id)).toEqual([1, 2]);
    expect(mergedAgain.edges.map(item => item.id)).toEqual([10]);
  });

  test('caps visible nodes and drops edges whose endpoints are outside the cap', () => {
    const nodes = Array.from({ length: KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES + 20 }, (_, index) => ({
      id: index + 1,
      slug: `node-${index + 1}`,
      title: `Node ${index + 1}`,
      source_id: 'default',
      source_name: 'default',
      type: 'note',
      preview: '',
      tags: [],
      updated_at: '2026-08-12',
      outgoing_count: 1,
      incoming_count: 0,
      relation_count: 1,
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      id: index + 1,
      from_page_id: 1,
      to_page_id: node.id,
      link_type: '关联',
      context: '',
      link_source: 'manual',
    }));
    const merged = mergeKnowledgeGraphData({ nodes: [], edges: [] }, {
      center_id: 1, nodes, edges, truncated: true, limit: 30,
    });
    const ids = new Set(merged.nodes.map(node => node.id));
    expect(merged.nodes).toHaveLength(KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES);
    expect(merged.edges.every(edge => ids.has(edge.from_page_id) && ids.has(edge.to_page_id))).toBe(true);
  });
});

describe('Knowledge graph Admin surface contract', () => {
  const appSource = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
  const pageSource = readFileSync(join(process.cwd(), 'admin/src/pages/KnowledgeGraph.tsx'), 'utf8');

  test('places 知识图谱 immediately after 知识库 and exposes read-only exploration controls', () => {
    expect(appSource.indexOf("page: 'graph', label: '知识图谱'")).toBeGreaterThan(
      appSource.indexOf("page: 'data', label: '知识库'"),
    );
    expect(pageSource).toContain('搜索知识');
    expect(pageSource).toContain('展开关系');
    expect(pageSource).toContain('查看完整知识');
    expect(pageSource).toContain('显示方向');
    expect(pageSource).toContain('局部图谱');
    expect(pageSource).toContain('全局图谱');
    expect(pageSource).toContain('孤立页');
    expect(pageSource).toContain('requestFullscreen()');
    expect(pageSource).toContain('exitFullscreen()');
    expect(pageSource).toContain('onNodeHover');
    expect(pageSource).toContain('activeNeighborIds');
    expect(pageSource).toContain('globalScale >= 2.2');
    expect(pageSource).toContain('Math.log2');
    expect(pageSource).toContain("viewMode !== 'local' ? 45 : 80");
    expect(pageSource).toContain('pauseAnimation()');
    expect(pageSource).not.toContain('KNOWLEDGE CONSTELLATION');
    expect(pageSource).not.toContain('graph-empty-orbit');
    expect(pageSource).not.toContain('createRadialGradient');
    expect(pageSource).not.toContain('Ask Yoda');
    expect(pageSource).not.toContain('删除知识');
  });
});
