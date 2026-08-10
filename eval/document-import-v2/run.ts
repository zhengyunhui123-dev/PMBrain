#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importOfficeFile } from '../../src/core/office-import.ts';
import { slugifyPath } from '../../src/core/sync.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  scoreDocumentImportBenchmark,
  type DocumentBenchmarkObservation,
  type DocumentBenchmarkQuestion,
} from '../../src/eval/document-import-v2/harness.ts';

interface Manifest {
  version: 1;
  corpusRoot: string;
  documents: Array<{ path: string; format: 'pdf' | 'docx' | 'pptx' | 'xlsx' }>;
  questions: DocumentBenchmarkQuestion[];
}

function loadManifest(path: string): Manifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.documents) || !Array.isArray(parsed.questions)) {
    throw new Error('Invalid document import benchmark manifest.');
  }
  if (parsed.documents.length < 35 || parsed.questions.length < 50) {
    throw new Error(`Release benchmark requires at least 35 documents and 50 questions; got ${parsed.documents.length} documents and ${parsed.questions.length} questions.`);
  }
  return parsed;
}

async function runMode(manifest: Manifest, manifestPath: string, structured: boolean, keywordOnly: boolean) {
  const root = resolve(dirname(manifestPath), manifest.corpusRoot);
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const started = performance.now();
  let chunks = 0;
  let tokenCount = 0;
  try {
    for (const document of manifest.documents) {
      const fullPath = join(root, document.path);
      if (!existsSync(fullPath)) throw new Error(`Benchmark document not found: ${fullPath}`);
      const result = await importOfficeFile(engine, fullPath, document.path, { noEmbed: keywordOnly, structured });
      if (result.status !== 'imported' && result.status !== 'skipped') {
        throw new Error(`Benchmark import failed for ${document.path}: ${result.error ?? result.status}`);
      }
      const pageChunks = await engine.getChunks(slugifyPath(document.path));
      chunks += pageChunks.length;
      tokenCount += pageChunks.reduce((sum, chunk) => sum + (chunk.token_count ?? 0), 0);
    }
    const importDurationMs = performance.now() - started;

    const observations: DocumentBenchmarkObservation[] = [];
    const normalizedQuestions = manifest.questions.map(question => ({
      ...question,
      expectedPath: slugifyPath(question.expectedPath),
    }));
    for (const question of manifest.questions) {
      const queryStarted = performance.now();
      const hits = keywordOnly
        ? await engine.searchKeyword(question.query, { limit: 5 })
        : await hybridSearch(engine, question.query, { limit: 5, expansion: false });
      const expectedSlug = slugifyPath(question.expectedPath);
      observations.push({
        questionId: question.id,
        rankedPaths: hits.map(hit => hit.slug),
        locatorMatched: !question.expectedLocator
          || hits.some(hit => hit.slug === expectedSlug && hit.chunk_text.includes(question.expectedLocator!)),
        latencyMs: performance.now() - queryStarted,
      });
    }
    return {
      mode: structured ? 'v2_structured' : 'v1_compatibility',
      search: keywordOnly ? 'keyword' : 'hybrid',
      importDurationMs,
      chunks,
      tokenCount,
      retrieval: scoreDocumentImportBenchmark(normalizedQuestions, observations),
    };
  } finally {
    await engine.disconnect();
  }
}

const benchmarkArgs = process.argv.slice(2);
const manifestArgument = benchmarkArgs.find(argument => !argument.startsWith('--'))
  ?? process.env.PMBRAIN_DOCUMENT_BENCH_MANIFEST;
if (!manifestArgument) {
  throw new Error('Usage: bun run eval:document-import-v2 <private-manifest.json> [--keyword-only]');
}
const manifestPath = resolve(manifestArgument);
const manifest = loadManifest(manifestPath);
const keywordOnly = benchmarkArgs.includes('--keyword-only');
const v1 = await runMode(manifest, manifestPath, false, keywordOnly);
const v2 = await runMode(manifest, manifestPath, true, keywordOnly);
console.log(JSON.stringify({ benchmark: 'pmbrain-structured-document-import-v2', corpus: { documents: manifest.documents.length, questions: manifest.questions.length }, v1, v2 }, null, 2));
