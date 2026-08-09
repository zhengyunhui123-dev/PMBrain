#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LATEST_VERSION } from '../src/core/migrate.ts';

const root = join(import.meta.dir, '..');
const adminDist = join(root, 'admin', 'dist');
const outputPath = join(root, 'release-manifest.json');

function readPackageVersion(path: string): string {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (typeof value.version !== 'string' || !value.version.trim()) {
    throw new Error(`Missing version in ${path}`);
  }
  return value.version;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files.sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));
}

function hashAdminBuild(): { sha256: string; assetCount: number } {
  if (!existsSync(join(adminDist, 'index.html'))) {
    throw new Error('admin/dist is missing; run `bun run build:admin` first');
  }
  const hash = createHash('sha256');
  const files = walk(adminDist);
  for (const file of files) {
    const rel = relative(adminDist, file).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), assetCount: files.length };
}

const coreVersion = readPackageVersion(join(root, 'package.json'));
const desktopVersion = readPackageVersion(join(root, 'desktop', 'package.json'));
const admin = hashAdminBuild();
const manifest = {
  schemaVersion: 1,
  product: 'PMBrain',
  core: { version: coreVersion },
  desktop: { version: desktopVersion },
  admin: { buildSha256: admin.sha256, assetCount: admin.assetCount },
  database: { latestSchemaVersion: LATEST_VERSION },
  sidecar: { version: coreVersion },
};

const content = `${JSON.stringify(manifest, null, 2)}\n`;
const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
if (current === content) {
  console.log(`[build-release-manifest] up to date (${admin.sha256.slice(0, 12)})`);
} else {
  writeFileSync(outputPath, content, 'utf8');
  console.log(`[build-release-manifest] wrote ${outputPath} (${admin.sha256.slice(0, 12)})`);
}
