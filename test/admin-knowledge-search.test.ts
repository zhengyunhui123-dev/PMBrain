import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAdminKnowledgeSearchMode,
  runAdminKnowledgeSearch,
} from '../src/commands/admin-knowledge-search.ts';

const ROOT = join(import.meta.dir, '..');

describe('Admin knowledge workbench search modes', () => {
  test('accepts only keyword and semantic modes', () => {
    expect(isAdminKnowledgeSearchMode('keyword')).toBe(true);
    expect(isAdminKnowledgeSearchMode('semantic')).toBe(true);
    expect(isAdminKnowledgeSearchMode('think')).toBe(false);
    expect(isAdminKnowledgeSearchMode('hybrid')).toBe(false);
  });

  test('returns document locator separately from the readable snippet', async () => {
    const engine = {
      searchKeyword: async () => [{
        slug: 'docs/plan.pdf', title: 'Plan', type: 'source', score: 1,
        source_id: 'default', page_id: 1, chunk_id: 2,
        chunk_text: 'Parent document: Plan\nSection: 启动条件\nLocator: 第三章 > 3.1 · 第 18 页\n\n当库存低于阈值时启动。',
      }],
    } as any;
    const result = await runAdminKnowledgeSearch(engine, { query: '启动条件', mode: 'keyword' });
    expect(result.results[0].locator).toBe('第三章 > 3.1 · 第 18 页');
    expect(result.results[0].snippet).toBe('当库存低于阈值时启动。');
  });

  test('serve exposes knowledge-search API and does not route workbench search through think', () => {
    const serveSource = readFileSync(join(ROOT, 'src/commands/pmbrain-admin-routes.ts'), 'utf8');
    const helperSource = readFileSync(join(ROOT, 'src/commands/admin-knowledge-search.ts'), 'utf8');
    expect(serveSource).toContain("app.post('/admin/api/knowledge-search'");
    expect(serveSource).toContain('runAdminKnowledgeSearch');
    expect(helperSource).toContain("mode === 'keyword'");
    expect(helperSource).toContain('searchKeyword');
    expect(helperSource).toContain('hybridSearch');
    expect(helperSource).toContain('expansion: false');
  });

  test('workbench search button supports keyword/semantic toggle and calls knowledgeSearch', () => {
    const consoleSource = [
      'admin/src/pages/Import.tsx',
      'admin/src/pages/import/import-support.tsx',
    ].map(path => readFileSync(join(ROOT, path), 'utf8')).join('\n');
    const apiSource = readFileSync(join(ROOT, 'admin/src/api.ts'), 'utf8');
    expect(apiSource).toContain("apiFetch('/admin/api/knowledge-search'");
    expect(consoleSource).toContain("type KnowledgeSearchMode = 'keyword' | 'semantic'");
    expect(consoleSource).toContain('api.knowledgeSearch');
    expect(consoleSource).toContain('关键词搜索');
    expect(consoleSource).toContain('语义搜索');
    expect(consoleSource).toContain('search-mode-badge');
    expect(consoleSource).toContain("loadKnowledgeSearchMode(): KnowledgeSearchMode");
    // Direct search must not call think anymore
    expect(consoleSource).not.toMatch(/kind === 'search'[\s\S]{0,400}startThinkRun/);
  });
});
