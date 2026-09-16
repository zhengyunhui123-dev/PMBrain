import { KNOWLEDGE_GENERATED_MARKERS, KNOWLEDGE_MATERIAL_OUTPUT_TYPES, KNOWLEDGE_PAGE_VIEW_TYPES } from '../../shared/knowledge-views.ts';

export function adminKnowledgeViewFilter(view: string | undefined, params: (string | number)[]): string | undefined {
  if (view !== 'materials' && view !== 'structured' && view !== 'insights') return undefined;
  const bind = (value: string) => { params.push(value); return `$${params.length}`; };
  const insight = `p.type IN (${KNOWLEDGE_PAGE_VIEW_TYPES.insights.map(bind).join(', ')})`;
  if (view === 'insights') return insight;
  const materialOutput = `p.type IN (${KNOWLEDGE_MATERIAL_OUTPUT_TYPES.map(bind).join(', ')})`;
  const generated = Object.entries(KNOWLEDGE_GENERATED_MARKERS).map(([key, values]) =>
    `COALESCE(p.frontmatter->>'${key}', '') IN (${values.map(bind).join(', ')})`,
  ).join(' OR ');
  const structured = `(NOT (${materialOutput}) AND (${generated}))`;
  return `NOT (${insight}) AND ${view === 'materials' ? `NOT ${structured}` : structured}`;
}
