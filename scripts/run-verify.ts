#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { bashEnv, missingBashMessage, resolveBash } from './ci-pr-preview.ts';

const root = join(import.meta.dir, '..');
const bash = resolveBash();
if (!bash) {
  console.error(missingBashMessage().replaceAll('[ci-pr-preview]', '[verify]'));
  process.exit(1);
}

const result = spawnSync(bash.command, ['scripts/run-verify-parallel.sh', ...process.argv.slice(2)], {
  cwd: root,
  env: bashEnv(process.env, bash.dir),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
