import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rendererSource = readFileSync(
  resolve(import.meta.dir, '../src/renderer/src.ts'),
  'utf8',
);
const updateControllerSource = readFileSync(
  resolve(import.meta.dir, '../src/main/updates/update-controller.ts'),
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
    expect(updateControllerSource).toContain("join(process.resourcesPath, 'release-notes.md')");
    expect(updateControllerSource).toContain("join(app.getAppPath(), 'build', 'release-notes.md')");
    expect(updateControllerSource).toContain('currentReleaseNotes: this.readCurrentReleaseNotes(),');
  });
});
