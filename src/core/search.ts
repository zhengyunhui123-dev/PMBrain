import type { BrainEngine } from './engine.ts';
import type { Page, PageType } from './types.ts';

export type SearchPage = Page & Record<string, unknown>;

export interface SearchPageFilters {
  type?: string;
  project?: string;
  limit?: number;
}

export async function searchPages(
  engine: BrainEngine,
  filters: SearchPageFilters = {},
): Promise<SearchPage[]> {
  const pages = await engine.listPages({
    type: filters.type as PageType | undefined,
    limit: filters.limit ?? 10_000,
  });

  return pages
    .map((page): SearchPage => ({ ...page, ...page.frontmatter }))
    .filter((page) => {
      if (filters.project && page.project !== filters.project) return false;
      return true;
    });
}
