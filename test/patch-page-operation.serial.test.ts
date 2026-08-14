import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let root = '';
let brainDir = '';
const slug = 'wiki/preferences/privacy';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'pmbrain-patch-page-'));
  brainDir = join(root, 'brain');
  mkdirSync(join(brainDir, 'wiki', 'preferences'), { recursive: true });
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [brainDir, 'default']);
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function context(): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

function patchOp() {
  const found = operations.find((entry) => entry.name === 'patch_page');
  if (!found) throw new Error('patch_page operation missing');
  return found;
}

async function seed(content: string): Promise<void> {
  await engine.putPage(slug, {
    title: 'Privacy', type: 'note', compiled_truth: content, timeline: '', frontmatter: {},
  });
  writeFileSync(
    join(brainDir, `${slug}.md`),
    `---\ntitle: Privacy\ntype: note\n---\n\n${content}\n`,
    'utf8',
  );
}

describe('patch_page — precise canonical correction', () => {
  test('replaces exactly once through the canonical page writer and verifies DB plus Markdown', async () => {
    await seed('The user prefers cloud-first tools.');
    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      const result = await patchOp().handler(context(), {
        page_slug: slug,
        old_text: 'cloud-first',
        new_text: 'local-first',
        reason: 'User corrected the stored preference',
      }) as any;
      expect(result).toMatchObject({ status: 'patched', matches: 1, verified: true });
    });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('local-first');
    expect(readFileSync(join(brainDir, `${slug}.md`), 'utf8')).toContain('local-first');

    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      await patchOp().handler(context(), {
        page_slug: slug,
        old_text: ' tools',
        new_text: '',
        reason: 'Remove one obsolete word without broad deletion',
      });
    });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth.trim())
      .toBe('The user prefers local-first.');
  });

  test('rejects zero matches, multiple matches, empty old_text, large deletion, and broad replacement', async () => {
    await seed('same phrase, same phrase, and a stable ending.');
    await expect(patchOp().handler(context(), {
      page_slug: slug, old_text: 'missing', new_text: 'new', reason: 'correction',
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(patchOp().handler(context(), {
      page_slug: slug, old_text: 'same phrase', new_text: 'new', reason: 'correction',
    })).rejects.toMatchObject({ code: 'ambiguous' });
    await expect(patchOp().handler(context(), {
      page_slug: slug, old_text: '', new_text: 'new', reason: 'correction',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    const large = 'A'.repeat(2500) + ' keep';
    await seed(large);
    await expect(patchOp().handler(context(), {
      page_slug: slug, old_text: 'A'.repeat(2500), new_text: '', reason: 'remove everything',
    })).rejects.toMatchObject({ code: 'permission_denied' });

    await expect(patchOp().handler(context(), {
      page_slug: slug,
      old_text: 'A'.repeat(2500),
      new_text: 'B'.repeat(2500),
      reason: 'replace almost the whole page',
    })).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
