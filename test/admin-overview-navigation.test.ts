import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const overviewSource = readFileSync(join(root, 'admin/src/pages/Knowledge.tsx'), 'utf8');

describe('Admin overview navigation', () => {
  test('opens the knowledge graph from the overview hero without adding a separate control', () => {
    expect(overviewSource).toContain('className="overview-hero overview-navigation-card"');
    expect(overviewSource).toContain("onClick={() => onNavigate?.('graph')}");
    expect(overviewSource).toContain("onKeyDown={event => handleOverviewNavigationKey(event, () => onNavigate?.('graph'))}");
    expect(overviewSource).toContain('aria-label="打开知识图谱"');
  });

  test('opens the knowledge database from the knowledge total card', () => {
    expect(overviewSource).toContain('className="overview-stat-card overview-accent-violet overview-navigation-card"');
    expect(overviewSource).toContain("onClick={() => onNavigate?.('data')}");
    expect(overviewSource).toContain("onKeyDown={event => handleOverviewNavigationKey(event, () => onNavigate?.('data'))}");
    expect(overviewSource).toContain('aria-label="打开知识库"');
  });

  test('shows a knowledge health card with clickable advisor actions', () => {
    expect(overviewSource).toContain('function AdvisorHealthCard');
    expect(overviewSource).toContain('知识库健康状态');
    expect(overviewSource).toContain("api.applyAdvisor(suggestion.dispatch_id)");
    expect(overviewSource).toContain("onNavigate?.('tasks')");
  });

  test('orphan advice opens the isolated graph instead of starting an orphan scan', () => {
    const productSource = readFileSync(join(root, 'src/core/advisor/product.ts'), 'utf8');
    const adminAdvisorSource = readFileSync(join(root, 'src/commands/admin-advisor.ts'), 'utf8');
    const graphSource = readFileSync(join(root, 'admin/src/pages/KnowledgeGraph.tsx'), 'utf8');
    expect(productSource).toContain("action_label: '查看孤立知识'");
    expect(productSource).toContain("navigate: 'graph?view=isolated'");
    expect(productSource).not.toContain("action_label: '整理关系'");
    expect(adminAdvisorSource).not.toContain("startDreamRun({ phase: 'orphans' }");
    expect(graphSource).toContain("new URLSearchParams(query).get('view')");
  });
});
