import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST_VERSION } from '../src/core/migrate.ts';

const root = join(import.meta.dir, '..');

describe('release manifest', () => {
  test('identifies the exact Core, Desktop, Admin, schema and Sidecar release parts', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8'));
    const core = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const desktop = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: 'PMBrain',
      core: { version: core.version },
      desktop: { version: desktop.version },
      database: { latestSchemaVersion: LATEST_VERSION },
      sidecar: { version: core.version },
    });
    expect(manifest.admin.buildSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.admin.assetCount).toBeGreaterThan(1);
  });
});
