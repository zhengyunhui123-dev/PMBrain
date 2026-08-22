#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMetricGlossaryMarkdown } from '../src/core/eval/metric-glossary.ts';
import { textsEquivalentIgnoringLineEndings } from './normalize-admin-dist.ts';

export function glossaryIsFresh(committed: string, generated: string): boolean {
  return textsEquivalentIgnoringLineEndings(committed, generated);
}

export function checkEvalGlossary(root = join(import.meta.dir, '..')): void {
  const path = join(root, 'docs', 'eval', 'METRIC_GLOSSARY.md');
  const committed = readFileSync(path, 'utf8');
  const generated = renderMetricGlossaryMarkdown();
  if (glossaryIsFresh(committed, generated)) {
    console.log('✓ docs/eval/METRIC_GLOSSARY.md is fresh');
    return;
  }
  console.error('ERROR: docs/eval/METRIC_GLOSSARY.md is stale after line-ending normalization.');
  console.error('To regenerate: bun run scripts/generate-metric-glossary.ts');
  process.exit(1);
}

if (import.meta.main) checkEvalGlossary();
