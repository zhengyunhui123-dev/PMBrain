export interface RecommendedSkill {
  slug: string;
  description: string;
}

/** Current-state list shared by post-install and the recurring Advisor check. */
export const RECOMMENDED: RecommendedSkill[] = [
  { slug: 'cold-start', description: 'START HERE. Fill a new brain from consented personal data or offline archives.' },
  { slug: 'book-mirror', description: 'FLAGSHIP. Take any book (EPUB/PDF), produce a personalized two-column chapter-by-chapter analysis. Left column preserves the chapter; right column maps every idea to your life using brain context.' },
  { slug: 'article-enrichment', description: 'Turn raw article dumps into structured pages with executive summary, verbatim quotes, key insights, why-it-matters.' },
  { slug: 'strategic-reading', description: 'Read a book / article / case study through ONE specific problem-lens. Output: applied playbook with do / avoid / watch-for.' },
  { slug: 'concept-synthesis', description: 'Deduplicate raw concept stubs into a tiered intellectual map (T1 Canon to T4 Riff). Trace idea evolution across years.' },
  { slug: 'perplexity-research', description: 'Brain-augmented web research. Sends brain context to the search so it focuses on what is NEW vs already-known.' },
  { slug: 'archive-crawler', description: 'Universal archivist for personal file archives. REFUSES to run without a gbrain.yml allow-list — safe-by-default.' },
  { slug: 'academic-verify', description: 'Trace a research claim through publication → methodology → raw data → independent replication. Verdict-shaped brain page.' },
  { slug: 'brain-pdf', description: 'Render any brain page to publication-quality PDF via the gstack make-pdf binary.' },
  { slug: 'voice-note-ingest', description: 'Capture voice notes with EXACT-PHRASING preservation (never paraphrased). Routes content to the right page types.' },
];

export function currentRecommendedSet(): RecommendedSkill[] {
  return RECOMMENDED;
}
