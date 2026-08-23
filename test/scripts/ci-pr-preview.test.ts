import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bashCandidates, bashEnv, GITHUB_TEST_PREVIEW_FILES } from '../../scripts/ci-pr-preview.ts';

const ROOT = join(import.meta.dir, '../..');

describe('GitHub Test local preview', () => {
  test('looks for Git Bash in the Windows install locations used on this machine', () => {
    const names = bashCandidates().join('\n');
    expect(names).toContain('bash');
    expect(names).toContain('Git');
    expect(names).toContain('bash.exe');
  });

  test('puts discovered Git Bash on PATH so nested bun run check:* scripts can call bash', () => {
    const env = bashEnv({ PATH: 'C:\\Windows' }, 'D:\\Program Files\\Git\\bin');
    expect(env.PATH?.startsWith('D:\\Program Files\\Git\\bin')).toBe(true);
  });

  test('always re-runs the retrieval contract files that GitHub shards 7/8 caught stale', () => {
    expect(GITHUB_TEST_PREVIEW_FILES).toContain('test/search-alias-resolved-boost.test.ts');
    expect(GITHUB_TEST_PREVIEW_FILES).toContain('test/cross-modal-phase1.test.ts');
    expect(GITHUB_TEST_PREVIEW_FILES).toContain('test/sql-ranking.test.ts');
    expect(GITHUB_TEST_PREVIEW_FILES).toContain('test/private-page-visibility.test.ts');
    expect(GITHUB_TEST_PREVIEW_FILES).toContain('test/cli-disconnect.test.ts');
    expect(GITHUB_TEST_PREVIEW_FILES).toContain('test/model-usage-generative-gate.test.ts');
    for (const file of GITHUB_TEST_PREVIEW_FILES) {
      expect(readFileSync(join(ROOT, file), 'utf8').length).toBeGreaterThan(0);
    }
  });

  test('package.json and verify dispatcher both expose the preview command', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ci:pr-preview']).toContain('ci-pr-preview.ts');
    expect(pkg.scripts.verify).toContain('run-verify.ts');
    const testing = readFileSync(join(ROOT, 'docs/TESTING.md'), 'utf8');
    expect(testing).toContain('ci:pr-preview');
  });
});
