import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  initializeKnowledgeSourceGit,
  inspectKnowledgeSourceDirectory,
} from '../src/main/knowledge-source-git.js';

const temporaryDirectories: string[] = [];

function makeKnowledgeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pmbrain-source-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('first-use knowledge source Git controls', () => {
  test('checking a selected directory reports its folder name without silently creating Git', () => {
    const directory = makeKnowledgeDirectory();

    const status = inspectKnowledgeSourceDirectory(directory);

    expect(status.sourceName).toBe(basename(directory));
    expect(status.path).toBe(directory);
    expect(status.gitEnabled).toBe(false);
    expect(existsSync(join(directory, '.git'))).toBe(false);
  });

  test('Git is initialized only after the explicit enable action', () => {
    const directory = makeKnowledgeDirectory();

    const status = initializeKnowledgeSourceGit(directory);

    expect(status.gitEnabled).toBe(true);
    expect(status.sourceName).toBe(basename(directory));
    expect(existsSync(join(directory, '.git'))).toBe(true);
  });
});
