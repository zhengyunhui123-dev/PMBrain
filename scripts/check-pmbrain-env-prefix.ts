#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const productRoots = ['admin/src', 'desktop/src', 'shared'];
const compatibilityOwners = new Set([
  'desktop/src/main/config-manager.ts',
  'desktop/src/main/cli-runner.ts',
]);
const violations: string[] = [];

function walk(path: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) output.push(...walk(full));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(name)) output.push(full);
  }
  return output;
}

for (const productRoot of productRoots) {
  for (const path of walk(join(root, productRoot))) {
    const rel = relative(root, path).replace(/\\/g, '/');
    if (compatibilityOwners.has(rel)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/GBRAIN_[A-Z0-9_]+/.test(line)) violations.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (violations.length > 0) {
  console.error('[check:pmbrain-env] Product code introduced legacy-only GBRAIN_* names.');
  console.error('Use PMBRAIN_* as the public name and keep any GBRAIN_* fallback inside a compatibility owner.');
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('[check:pmbrain-env] OK');
