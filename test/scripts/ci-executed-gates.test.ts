import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveBash } from '../../scripts/ci-pr-preview.ts';

for (const [file, name, gates] of [
  ['test.yml', 'test-status', ['gitleaks', 'verify', 'serial-tests', 'slow-eval-longmemeval', 'slow-entity-resolve-perf', 'test', 'desktop-runtime']],
  ['e2e.yml', 'e2e-status', ['jsonb-parity', 'tier1', 'tier2']],
] as const) {
  test(`${file} requires every execution lane even with an old success cache`, () => {
    const yaml = readFileSync(`.github/workflows/${file}`, 'utf8').replace(/\r\n/g, '\n');
    expect(yaml).not.toMatch(/needs\.[\w-]*cache-check\.outputs\.hit/);
    const block = yaml.slice(yaml.indexOf(`\n  ${name}:`));
    for (const gate of gates) expect(block).toContain(`needs.${gate}.result`);
    const run = block.split('        run: |\n')[1]?.split('\n').map(line => line.slice(10)).join('\n');
    expect(run).toBeTruthy();
    const bash = resolveBash();
    expect(bash).not.toBeNull();
    for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
      const script = run!.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, gate) => gate === gates[0] ? outcome : 'success');
      const result = spawnSync(bash!.command, ['-c', script], { encoding: 'utf8', timeout: 10000 });
      expect(result.status).toBe(outcome === 'success' ? 0 : 1);
    }
  }, 60000);
}
