#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.txt']);

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

export function normalizeAdminDist(root = join(import.meta.dir, '..')): number {
  const dist = join(root, 'admin', 'dist');
  if (!existsSync(dist)) throw new Error('admin/dist is missing; build the Admin app first');

  let changed = 0;
  for (const file of walk(dist)) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const current = readFileSync(file, 'utf8');
    const normalized = normalizeLineEndings(current);
    if (current === normalized) continue;
    writeFileSync(file, normalized, 'utf8');
    changed += 1;
    console.log(`[normalize-admin-dist] normalized ${relative(root, file)}`);
  }
  console.log(`[normalize-admin-dist] ${changed} file(s) changed`);
  return changed;
}

if (import.meta.main) normalizeAdminDist();
