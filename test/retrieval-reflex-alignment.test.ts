import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import {
  extractCandidates,
  extractCandidatesFromWindow,
} from '../src/core/context/entity-salience.ts';
import {
  resolveEntitiesToPointers,
  logDeliveredReflexPointers,
} from '../src/core/context/retrieval-reflex.ts';
import {
  buildReflexAddition,
  lexicalArmsEnabled,
  windowTurnCount,
} from '../src/core/context/reflex.ts';
import {
  IPC_UNAVAILABLE,
  cleanupStaleSocket,
  resolveSocketPath,
  resolveViaIpc,
  startResolveIpcServer,
} from '../src/core/context/resolve-ipc.ts';
import {
  _resetPendingVolunteerEventWritesForTests,
  awaitPendingVolunteerEventWrites,
} from '../src/core/context/volunteer-events.ts';
import { createGBrainContextEngine } from '../src/core/context-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindResolveIpcForServe } from '../src/mcp/resolve-ipc-binding.ts';

let engine: PGLiteEngine;

async function seed(
  slug: string,
  title: string,
  body: string,
  sourceId = 'default',
  type = 'person',
) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, $2, $3, $4, $5, '')`,
    [slug, sourceId, type, title, body],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  _resetPendingVolunteerEventWritesForTests();
  await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('GBrain 0.47.5.0 Retrieval Reflex alignment', () => {
  test('extracts strong, lowercase-alias and CJK candidates with separate caps', () => {
    const candidates = extractCandidates('请继续看 PMBrain，也提醒我 saoirse 和王小明的进展');
    expect(candidates.some(candidate => candidate.query === 'PMBrain' && !candidate.weak)).toBe(true);
    expect(candidates.some(candidate => candidate.query === 'saoirse' && candidate.weak)).toBe(true);
    expect(candidates.some(candidate => candidate.query === '王小明' && candidate.weak)).toBe(true);
  });

  test('rolling window keeps an assistant-introduced entity for a pronoun follow-up', () => {
    const candidates = extractCandidatesFromWindow([
      { role: 'assistant', text: 'Alice Example 负责这一轮。' },
      { role: 'user', text: '她后来怎么处理的？' },
    ]);
    expect(candidates.some(candidate => candidate.query === 'Alice Example')).toBe(true);
  });

  test('resolves title, lowercase alias, surname and CJK exact title without crossing Source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('team', 'Team') ON CONFLICT (id) DO NOTHING`,
    );
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    await seed('people/saoirse-x', 'Saoirse X', 'Saoirse is a founder.');
    await seed('people/ronan-galewright', 'Ronan Galewright', 'Ronan is an investor.');
    await seed('people/wang-xiaoming', '王小明', '王小明负责项目。');
    await seed('people/alice-team', 'Alice Example', 'Wrong Source.', 'team');
    await engine.setPageAliases('people/saoirse-x', 'default', [normalizeAlias('saoirse')]);

    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidates('Alice Example、saoirse、Galewright 和王小明现在怎么样？'),
      { maxPointers: 4 },
    );
    const refs = block?.pointers.map(pointer => `${pointer.source_id}::${pointer.slug}`) ?? [];
    expect(refs).toContain('default::people/alice-example');
    expect(refs).toContain('default::people/saoirse-x');
    expect(refs).toContain('default::people/ronan-galewright');
    expect(refs).toContain('default::people/wang-xiaoming');
    expect(refs.some(ref => ref.startsWith('team::'))).toBe(false);
  });

  test('safe synopsis does not expose private fact fences', async () => {
    await seed(
      'people/alice-example',
      'Alice Example',
      '```gbrain-facts\n{"visibility":"private","text":"SECRET_DO_NOT_LEAK"}\n```\nAlice is a founder.',
    );
    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidates('继续看 Alice Example'),
    );
    expect(block?.text).toContain('people/alice-example');
    expect(block?.text).not.toContain('SECRET_DO_NOT_LEAK');
  });

  test('context engine injects at most three pointers and keeps messages unchanged', async () => {
    for (const [slug, title] of [
      ['people/alice-example', 'Alice Example'],
      ['people/bob-example', 'Bob Example'],
      ['people/carol-example', 'Carol Example'],
      ['people/dave-example', 'Dave Example'],
    ]) {
      await seed(slug, title, `${title} summary.`);
    }
    await withEnv({ PMBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const contextEngine = createGBrainContextEngine({
        workspaceDir: tmpdir(),
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      const messages = [{ role: 'user', content: 'Alice Example、Bob Example、Carol Example、Dave Example' }];
      const result = await contextEngine.assemble({ sessionId: 'rr', messages });
      expect(result.messages).toEqual(messages);
      expect(result.systemPromptAddition).toContain('Brain pages mentioned this turn');
      expect((result.systemPromptAddition?.match(/use get_page before/g) ?? []).length).toBe(3);
    });
  });

  test('prompt-only host delivery and rolling-window slug-only suppression match GBrain', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    await withEnv({ PMBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const contextEngine = createGBrainContextEngine({
        workspaceDir: tmpdir(),
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      const promptOnly = await contextEngine.assemble({
        sessionId: 'prompt-only',
        messages: [],
        prompt: '继续看 Alice Example',
      });
      expect(promptOnly.systemPromptAddition).toContain('people/alice-example');

      const followUp = await contextEngine.assemble({
        sessionId: 'window',
        messages: [
          { role: 'assistant', content: 'Alice Example 负责这一轮。' },
          { role: 'user', content: '她后来怎么处理的？' },
        ],
      });
      expect(followUp.systemPromptAddition).toContain('people/alice-example');
    });
  });

  test('feature switches are PMBrain-first, GBrain-compatible and fail open', async () => {
    await withEnv(
      {
        PMBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS: '6',
        PMBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS: 'off',
      },
      async () => {
        expect(windowTurnCount(null)).toBe(6);
        expect(lexicalArmsEnabled(null)).toBe(false);
      },
    );
    await withEnv({ PMBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const result = await buildReflexAddition({
        workspaceDir: tmpdir(),
        currentUserText: '继续看 Alice Example',
        priorContextText: '',
        resolveEntities: async () => { throw new Error('resolver unavailable'); },
      });
      expect(result).toBeNull();
    });
  });

  test('the 1500ms hard ceiling drops a hung resolver without breaking the turn', async () => {
    await withEnv({ PMBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const started = performance.now();
      const result = await buildReflexAddition({
        workspaceDir: tmpdir(),
        currentUserText: '继续看 Alice Example',
        priorContextText: '',
        resolveEntities: () => new Promise(() => {}),
      });
      const elapsed = performance.now() - started;
      expect(result).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(elapsed).toBeLessThan(2_200);
    });
  }, 3_000);

  test('PGLite resolve IPC enforces the bound Source and logs only delivered pointers', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const directory = mkdtempSync(join(process.cwd(), '.tmp-reflex-ipc-'));
    const socketPath = resolveSocketPath(directory);
    const server = await startResolveIpcServer(
      socketPath,
      request => resolveEntitiesToPointers(engine, 'default', request.candidates, request),
      {
        boundSourceId: 'default',
        onDelivered: block => logDeliveredReflexPointers(engine, block.pointers),
      },
    );
    expect(server).not.toBeNull();
    try {
      const rejected = await resolveViaIpc(socketPath, {
        sourceId: 'team',
        candidates: extractCandidates('Alice Example'),
      });
      expect(rejected).toBe(IPC_UNAVAILABLE);

      const delivered = await resolveViaIpc(socketPath, {
        sourceId: 'default',
        candidates: extractCandidates('Alice Example'),
      });
      expect(delivered).not.toBe(IPC_UNAVAILABLE);
      if (delivered === IPC_UNAVAILABLE) throw new Error('resolve IPC unavailable');
      expect(delivered?.pointers[0]?.slug).toBe('people/alice-example');
      expect((await awaitPendingVolunteerEventWrites()).unfinished).toBe(0);
      const events = await engine.executeRaw<{ channel: string; slug: string }>(
        'SELECT channel, slug FROM context_volunteer_events',
      );
      expect(events).toEqual([{ channel: 'reflex', slug: 'people/alice-example' }]);
    } finally {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      cleanupStaleSocket(socketPath);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('desktop Sidecar binding serves the real context-engine PGLite ladder', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const homeRoot = mkdtempSync(join(process.cwd(), '.tmp-reflex-sidecar-'));
    const pmbrainHome = join(homeRoot, '.pmbrain');
    const databasePath = join(pmbrainHome, 'fixture.pglite');
    mkdirSync(pmbrainHome, { recursive: true });
    writeFileSync(
      join(pmbrainHome, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: databasePath }),
      'utf8',
    );
    await withEnv(
      {
        PMBRAIN_HOME: homeRoot,
        GBRAIN_HOME: undefined,
        PMBRAIN_RETRIEVAL_REFLEX: 'true',
      },
      async () => {
        const binding = await bindResolveIpcForServe(engine, 'default');
        expect(binding.server).not.toBeNull();
        try {
          const contextEngine = createGBrainContextEngine({ workspaceDir: process.cwd() });
          const result = await contextEngine.assemble({
            sessionId: 'desktop-sidecar',
            messages: [{ role: 'user', content: '继续看 Alice Example' }],
          });
          expect(result.systemPromptAddition).toContain('people/alice-example');
        } finally {
          binding.close();
          const deadline = Date.now() + 2_000;
          while (existsSync(binding.socketPath ?? '') && Date.now() < deadline) await Bun.sleep(10);
          expect(existsSync(binding.socketPath ?? '')).toBe(false);
        }
      },
    );
    rmSync(homeRoot, { recursive: true, force: true });
  });
});
