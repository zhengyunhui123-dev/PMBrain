import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const unpackedRoot = join(desktopRoot, 'dist', 'win-unpacked');
const runtimeRoot = join(unpackedRoot, 'resources', 'pmbrain-runtime');
const requiredFiles = [
  join(unpackedRoot, 'PMBrain.exe'),
  join(runtimeRoot, 'bun.exe'),
  join(runtimeRoot, 'pmbrain-sidecar.js'),
  join(runtimeRoot, 'index-spch4qbq.html'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'package.json'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'vector', 'index.js'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'pglite.data'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'pglite.wasm'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'initdb.wasm'),
];

const missing = requiredFiles.filter((path) => !existsSync(path) || statSync(path).size === 0);
if (missing.length > 0) {
  console.error('Desktop package verification failed. Missing runtime files:');
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

console.log(`Desktop package verified: ${requiredFiles.length} required runtime files are present.`);
