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
    expect(overviewSource).toContain('已向量化');
    expect(overviewSource).toContain('pages_added_last_update');
    expect(overviewSource).not.toContain('可用于 AI 搜索');
  });

  test('keeps only the compact health score on the overview and moves all actions into Run', () => {
    const appSource = readFileSync(join(root, 'admin/src/App.tsx'), 'utf8');
    expect(overviewSource).toContain('function AdvisorHealthCard');
    expect(overviewSource).toContain('function AdvisorHealthSummary');
    expect(overviewSource).toContain('知识库体检');
    expect(overviewSource).toContain("onNavigate?.('health')");
    expect(appSource).toContain("{ page: 'health', label: '知识库健康', icon: 'health' }");
    expect(appSource).toContain("page === 'health' && <KnowledgeHealthPage");
    expect(overviewSource).toContain("api.applyAdvisor(suggestion.dispatch_id)");
    expect(overviewSource).toContain("onNavigate?.('tasks')");
    expect(overviewSource).toContain('advisor.suggestions.map((suggestion)');
    expect(overviewSource).not.toContain('advisor.suggestions.slice(0, 5)');
  });

  test('offers confirmed timeline backfill from the health page', () => {
    const routeSource = readFileSync(join(root, 'src/commands/pmbrain-admin-routes.ts'), 'utf8');
    expect(overviewSource).toContain("suggestion.id === 'chronicle_coverage_gap'");
    expect(overviewSource).toContain('api.organizeChronicleHistory()');
    expect(overviewSource).toContain("item.id === 'chronicle_coverage_gap'");
    expect(overviewSource).toContain('正在生成年表事件');
    expect(overviewSource).not.toContain('近期会议已补入年表，体检结果已刷新。');
    expect(overviewSource).toContain('补入年表');
    expect(routeSource).toContain('enqueued > 0 ? await ensureAdminWorkerStarted() : null');
  });

  test('makes a manual health refresh visibly observable', () => {
    expect(overviewSource).toContain("setAdvisorNotice('正在重新检查…')");
    expect(overviewSource).toContain("refreshing ? '检查中…' : '重新检查'");
    expect(overviewSource).toContain('检查完成，当前有');
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
