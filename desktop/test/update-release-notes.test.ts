import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rendererSource = readFileSync(
  resolve(import.meta.dir, '../src/renderer/src.ts'),
  'utf8',
);
const mainSource = readFileSync(
  resolve(import.meta.dir, '../src/main/index.ts'),
  'utf8',
);

describe('desktop release notes rendering', () => {
  test('uses the installed version and notes when no update is available', () => {
    expect(rendererSource).toContain(
      'const displayVersion = update.availableVersion ?? update.currentVersion;',
    );
    expect(rendererSource).toContain(
      'const hasReleaseNotes = Boolean(update.releaseNotes?.trim());',
    );
    expect(rendererSource).toContain('releaseNotes.hidden = !hasReleaseNotes;');
  });

  test('reads the packaged release notes when initializing the updater', () => {
    expect(mainSource).toContain("join(process.resourcesPath, 'release-notes.md')");
    expect(mainSource).toContain("join(app.getAppPath(), 'build', 'release-notes.md')");
    expect(mainSource).toContain('currentReleaseNotes: readCurrentReleaseNotes(),');
  });
});
