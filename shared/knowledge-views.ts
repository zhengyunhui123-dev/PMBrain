export const KNOWLEDGE_PAGE_VIEW_TYPES = {
  insights: ['take', 'reflection', 'pattern', 'idea'],
} as const;

export const KNOWLEDGE_GENERATED_MARKERS = {
  dream_generated: ['true'],
  extracted_by: ['extract_atoms-v0.41.2.1'],
  synthesized_by: ['synthesize_concepts-v0.41'],
} as const;

export const KNOWLEDGE_MATERIAL_OUTPUT_TYPES = ['extract_receipt'] as const;
export type KnowledgePageView = 'materials' | 'structured' | 'insights';
export const KNOWLEDGE_DATA_VIEWS = ['all', 'materials', 'structured', 'facts', 'insights', 'trash'] as const;
export type KnowledgeDataView = (typeof KNOWLEDGE_DATA_VIEWS)[number];
export const FACT_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact', 'idea'] as const;
export type FactKindView = (typeof FACT_KINDS)[number];

export function knowledgePageViewTypes(view: string | undefined): readonly string[] | undefined {
  return view === 'insights' ? KNOWLEDGE_PAGE_VIEW_TYPES.insights : undefined;
}

export function knowledgePageViewAllowsType(view: string, type: string): boolean {
  const insight = (KNOWLEDGE_PAGE_VIEW_TYPES.insights as readonly string[]).includes(type);
  if (view === 'insights') return insight;
  if (view === 'materials') return !insight;
  if (view === 'structured') return !insight && !(KNOWLEDGE_MATERIAL_OUTPUT_TYPES as readonly string[]).includes(type);
  return true;
}
