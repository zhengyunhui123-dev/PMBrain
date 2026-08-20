import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureKnowledgeDirectory } from '../src/main/startup/knowledge-directory.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('knowledge directory preparation', () => {
  test('creates a missing directory recursively before source registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-knowledge-directory-'));
    roots.push(root);
    const target = join(root, 'Documents', 'PMBrain');

    expect(existsSync(target)).toBe(false);
    await ensureKnowledgeDirectory(target);
    expect(existsSync(target)).toBe(true);
  });

  test('does not overwrite a file at the configured directory path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-knowledge-directory-'));
    roots.push(root);
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'keep this file');

    await expect(ensureKnowledgeDirectory(blocker)).rejects.toBeDefined();
  });
});
