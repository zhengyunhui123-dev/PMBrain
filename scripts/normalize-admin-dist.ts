#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

export const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.txt', '.md', '.ts']);

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function normalizeAdminText(value: string, extension: string): string {
  const normalized = normalizeLineEndings(value);
  if (extension.toLowerCase() !== '.html') return normalized;
  // Vite may preserve a whitespace-only line left by the removed source
  // module script differently across Windows runners. Canonicalize the
  // generated root/body boundary so build hashes remain platform-stable.
  return normalized.replace(
    /(<div id="root"><\/div>)\n[ \t]*\n(?=<\/body>)/g,
    '$1\n',
  );
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

export function textsEquivalentIgnoringLineEndings(left: string, right: string): boolean {
  return normalizeLineEndings(left) === normalizeLineEndings(right);
}

function listedFiles(root: string): Map<string, string> {
  if (statSync(root).isFile()) return new Map([[basename(root), root]]);
  return new Map(walk(root).map(file => [relative(root, file).replace(/\\/g, '/'), file]));
}

function compareFilePair(left: string, right: string, label: string): string[] {
  const extension = extname(right).toLowerCase() || extname(left).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return textsEquivalentIgnoringLineEndings(readFileSync(left, 'utf8'), readFileSync(right, 'utf8'))
      ? []
      : [`text differs: ${label}`];
  }
  return readFileSync(left).equals(readFileSync(right)) ? [] : [`binary differs: ${label}`];
}

export function compareGeneratedTrees(leftRoot: string, rightRoot: string): string[] {
  if (!existsSync(leftRoot) && !existsSync(rightRoot)) return [];
  if (!existsSync(leftRoot)) return [`missing ${leftRoot}`];
  if (!existsSync(rightRoot)) return [`missing ${rightRoot}`];
  if (statSync(leftRoot).isFile() && statSync(rightRoot).isFile()) {
    return compareFilePair(leftRoot, rightRoot, basename(rightRoot));
  }
  const leftFiles = listedFiles(leftRoot);
  const rightFiles = listedFiles(rightRoot);
  const mismatches: string[] = [];
  for (const rel of new Set([...leftFiles.keys(), ...rightFiles.keys()])) {
    const left = leftFiles.get(rel);
    const right = rightFiles.get(rel);
    if (!left) {
      mismatches.push(`only in right: ${rel}`);
      continue;
    }
    if (!right) {
      mismatches.push(`only in left: ${rel}`);
      continue;
    }
    const extension = extname(rel).toLowerCase();
    if (TEXT_EXTENSIONS.has(extension)) {
      if (!textsEquivalentIgnoringLineEndings(readFileSync(left, 'utf8'), readFileSync(right, 'utf8'))) {
        mismatches.push(`text differs: ${rel}`);
      }
      continue;
    }
    if (!readFileSync(left).equals(readFileSync(right))) mismatches.push(`binary differs: ${rel}`);
  }
  return mismatches;
}

export function normalizeAdminDist(root = join(import.meta.dir, '..')): number {
  const dist = join(root, 'admin', 'dist');
  if (!existsSync(dist)) throw new Error('admin/dist is missing; build the Admin app first');

  let changed = 0;
  for (const file of walk(dist)) {
    const extension = extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const current = readFileSync(file, 'utf8');
    const normalized = normalizeAdminText(current, extension);
    if (current === normalized) continue;
    writeFileSync(file, normalized, 'utf8');
    changed += 1;
    console.log(`[normalize-admin-dist] normalized ${relative(root, file)}`);
  }
  console.log(`[normalize-admin-dist] ${changed} file(s) changed`);
  return changed;
}

if (import.meta.main) normalizeAdminDist();
