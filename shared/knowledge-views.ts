/** Knowledge-data view presets. Shared by Admin API and the knowledge page. */

export const KNOWLEDGE_PAGE_VIEW_TYPES = {
  materials: [
    'conversation',
    'meeting',
    'material',
    'source',
    'reference',
    'original',
    'originals',
    'cover',
    'extract_receipt',
  ],
  structured: [
    'note',
    'atom',
    'concept',
    'person',
    'project',
    'project-context',
    'project_context',
    'project-note',
    'doc',
    'skill',
  ],
  insights: [
    'take',
    'reflection',
    'pattern',
    'idea',
  ],
} as const;

export type KnowledgePageView = keyof typeof KNOWLEDGE_PAGE_VIEW_TYPES;

export const KNOWLEDGE_DATA_VIEWS = [
  'all',
  'materials',
  'structured',
  'facts',
  'insights',
  'trash',
] as const;

export type KnowledgeDataView = (typeof KNOWLEDGE_DATA_VIEWS)[number];

export const FACT_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;
export type FactKindView = (typeof FACT_KINDS)[number];

export function knowledgePageViewTypes(view: string | undefined): readonly string[] | undefined {
  if (!view) return undefined;
  return view in KNOWLEDGE_PAGE_VIEW_TYPES
    ? KNOWLEDGE_PAGE_VIEW_TYPES[view as KnowledgePageView]
    : undefined;
}
