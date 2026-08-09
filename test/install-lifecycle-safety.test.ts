import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageJsonPath = join(import.meta.dir, '..', 'package.json');

describe('dependency installation safety', () => {
  test('bun install cannot run PMBrain lifecycle hooks', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(
        pkg.scripts?.[hook],
        `${hook} runs during dependency installation and must stay absent; database setup and migrations require an explicit PMBrain command`,
      ).toBeUndefined();
    }
  });
});
