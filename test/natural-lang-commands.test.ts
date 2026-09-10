import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCliEntry } from '../src/commands/natural-lang/commands.ts';

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

describe('natural language CLI entry', () => {
  test('packaged sidecar reuses its bundled Bun runtime', () => {
    process.argv[1] = join(tmpdir(), 'PMBrain', 'resources', 'runtime', 'pmbrain-sidecar.js');

    expect(resolveCliEntry()).toEqual([process.execPath, process.argv[1]]);
  });
});
