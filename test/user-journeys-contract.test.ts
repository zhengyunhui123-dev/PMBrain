import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('core user journeys cover packaged Desktop openability', () => {
  test('CI launches the unpacked Windows app, not source electron.exe', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/core-user-journeys.yml'), 'utf8');
    expect(workflow).toContain('core_journeys.py --packaged');
    expect(workflow).toContain('timeout-minutes: 40');
  });

  test('the journey waits for import completion instead of a stale progress prefix', () => {
    const script = readFileSync(join(ROOT, 'test/user-journeys/core_journeys.py'), 'utf8');
    expect(script).toContain('--packaged');
    expect(script).toContain('win-unpacked');
    expect(script).toContain("run-pill");
    expect(script).toContain('已完成');
    expect(script).toContain('正在导入');
    expect(script).toContain('pills.at(-1)');
    expect(script).toContain('build:sidecar');
    expect(script).toContain('build:dir');
    expect(script).not.toContain('importButton?.disabled');
  });

  test('the embedding switch journey explicitly chooses the continue-rebuild path', () => {
    const script = readFileSync(join(ROOT, 'test/user-journeys/core_journeys.py'), 'utf8');
    expect(script).toContain('page.locator("#setup-wait-actions").wait_for(state="visible"');
    expect(script).toContain('page.locator("#setup-wait-continue").click()');
  });
});
