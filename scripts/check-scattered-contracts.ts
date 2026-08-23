#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function extractKnobsHashVersion(source: string): number {
  const match = source.match(/export\s+const\s+KNOBS_HASH_VERSION\s*=\s*(\d+)\s*;/);
  if (!match) throw new Error('KNOBS_HASH_VERSION export was not found');
  return Number(match[1]);
}

export function extractFunctionArity(source: string, name: string): number {
  const start = source.search(new RegExp(`export\\s+function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`${name} export was not found`);
  const open = source.indexOf('(', start);
  let depth = 0;
  let brace = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '{') brace += 1;
    else if (char === '}') brace -= 1;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        const params = source.slice(open + 1, index);
        let arity = 0;
        let nested = 0;
        let current = '';
        for (const item of params) {
          if (item === '{' || item === '(' || item === '[') nested += 1;
          else if (item === '}' || item === ')' || item === ']') nested -= 1;
          if (item === ',' && nested === 0) {
            if (current.trim()) arity += 1;
            current = '';
            continue;
          }
          current += item;
        }
        if (current.trim()) arity += 1;
        return arity;
      }
    }
  }
  throw new Error(`${name} signature was not closed`);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
  return files;
}

export function collectScatteredContractFailures(root: string): string[] {
  const version = extractKnobsHashVersion(
    readFileSync(join(root, 'src', 'core', 'search', 'mode.ts'), 'utf8'),
  );
  const arity = extractFunctionArity(
    readFileSync(join(root, 'src', 'core', 'search', 'sql-ranking.ts'), 'utf8'),
    'buildVisibilityClause',
  );
  const failures: string[] = [];
  for (const file of walk(join(root, 'test'))) {
    const rel = relative(root, file).replace(/\\/g, '/');
    if (rel.endsWith('test/scripts/check-scattered-contracts.test.ts')) continue;
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/KNOBS_HASH_VERSION\)\.to(?:Be|Equal)\((\d+)\)/g)) {
      if (Number(match[1]) !== version) {
        failures.push(`${rel}: KNOBS_HASH_VERSION pinned to ${match[1]}, source is ${version}`);
      }
    }
    for (const match of content.matchAll(/buildVisibilityClause\.length\)\.to(?:Be|Equal)\((\d+)\)/g)) {
      if (Number(match[1]) !== arity) {
        failures.push(`${rel}: buildVisibilityClause.length pinned to ${match[1]}, function arity is ${arity}`);
      }
    }
  }
  return failures;
}

export function collectOneShotPgliteExitFailures(root: string): string[] {
  const disconnect = readFileSync(join(root, 'src', 'core', 'cli-disconnect.ts'), 'utf8');
  const cli = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
  const preview = readFileSync(join(root, 'scripts', 'ci-pr-preview.ts'), 'utf8');
  const workflow = readFileSync(join(root, '.github', 'workflows', 'test.yml'), 'utf8');
  const failures: string[] = [];
  if (!disconnect.includes("engine.kind === 'pglite'")) {
    failures.push('src/core/cli-disconnect.ts must force-exit PGLite one-shot commands without waiting on db.close()');
  }
  if (!disconnect.includes('releaseOwnershipWithoutClose')) {
    failures.push('src/core/cli-disconnect.ts must release the PGLite file lock before force-exit');
  }
  if (!cli.includes('await disconnectCliEngine(engine, command)')) {
    failures.push('src/cli.ts must close one-shot commands through disconnectCliEngine');
  }
  if (!preview.includes('test/cli-disconnect.test.ts')) {
    failures.push('scripts/ci-pr-preview.ts must run test/cli-disconnect.test.ts so packaged PGLite hang regressions are caught locally');
  }
  if (!workflow.includes('cli-import-exit.serial.test.ts')) {
    failures.push('.github/workflows/test.yml must keep the packaged sidecar import-exit test in desktop-runtime');
  }
  return failures;
}

export function checkScatteredContracts(root = join(import.meta.dir, '..')): void {
  const failures = [
    ...collectScatteredContractFailures(root),
    ...collectOneShotPgliteExitFailures(root),
  ];
  if (failures.length > 0) {
    throw new Error(
      'Scattered contract pins drifted from source:\n- ' +
        failures.join('\n- ') +
        '\nUpdate every leftover toBe() in the same change as the source constant.',
    );
  }
  console.log('[check:scattered-contracts] retrieval and one-shot PGLite exit pins match source');
}

if (import.meta.main) checkScatteredContracts();
