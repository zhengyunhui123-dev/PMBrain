/**
 * 产品经理可读的测试说明：
 * 只有知识源真的带着未安装的配套技能包、且 nag 台账还允许提醒时，才出现建议。
 * 没有台账、远程 MCP、或已经装过同一版本，都不能编造这条建议。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectUninstalledBrainPack } from '../src/core/advisor/collect-uninstalled-brain-pack.ts';
import { saveState, SKILLPACK_STATE_SCHEMA_VERSION, type SkillpackStateEntry } from '../src/core/skillpack/state.ts';
import { saveNagState, SKILLPACK_NAG_SCHEMA_VERSION, DEFAULT_NAG_CEILING, type NagEntry } from '../src/core/skillpack/nag-state.ts';
import { deriveBrainId } from '../src/core/skillpack/brain-resident-locate.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'pmbrain-nag-home-'));
}

function ctx(engine: unknown, over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine: engine as AdvisorContext['engine'],
    config: {} as AdvisorContext['config'],
    version: '1.3.65',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-16T00:00:00Z'),
    remote: false,
    ...over,
  };
}

const PACK_NAME = 'acme-pack';
const PACK_VERSION = '1.2.0';

function makePackDir(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-brainpack-'));
  mkdirSync(join(dir, 'skills', 'acme-skill'), { recursive: true });
  writeFileSync(
    join(dir, 'skillpack.json'),
    JSON.stringify({
      api_version: 'gbrain-skillpack-v1',
      name: PACK_NAME,
      version: PACK_VERSION,
      description: 'test pack',
      author: 'alice-example',
      license: 'MIT',
      homepage: 'https://example.com/acme-pack',
      gbrain_min_version: '0.36.0',
      skills: ['skills/acme-skill'],
      brain_resident: true,
      ...over,
    }),
  );
  return dir;
}

function sourceRow(localPath: string | null, id = 'wiki') {
  return {
    id,
    name: id,
    local_path: localPath,
    last_commit: null,
    last_sync_at: null,
    config: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    archived: false,
  };
}

function sourcesEngine(rows: unknown[], counter = { calls: 0 }): { engine: BrainEngine; counter: { calls: number } } {
  const engine = {
    executeRaw: async () => {
      counter.calls++;
      return rows;
    },
  } as unknown as BrainEngine;
  return { engine, counter };
}

function installedEntry(version: string): SkillpackStateEntry {
  return {
    name: PACK_NAME,
    version,
    author: 'alice-example',
    source: '/tmp/somewhere',
    source_kind: 'local',
    pinned_commit: null,
    tarball_sha256: null,
    tier: 'local',
    scaffolded_at: '2026-01-01T00:00:00Z',
    workspace: '/tmp/workspace',
    skill_slugs: ['skills/acme-skill'],
  };
}

function nagEntry(packDir: string, over: Partial<NagEntry> = {}): NagEntry {
  return {
    brain_id: deriveBrainId(null, packDir),
    source_id: 'wiki',
    pack_name: PACK_NAME,
    pack_version: PACK_VERSION,
    prompted_at: '2026-01-01T00:00:00Z',
    declined_count: 0,
    suppressed: false,
    ...over,
  };
}

describe('collect-uninstalled-brain-pack', () => {
  test('uninstalled brain-resident pack → one info finding, not applyable', async () => {
    await withEnv({ PMBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      const out = await collectUninstalledBrainPack.collect(ctx(engine));
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe(`uninstalled_brain_pack:wiki:${PACK_NAME}`);
      expect(out[0]!.workspace_dependent).toBe(true);
      expect(out[0]!.fix.dispatch_id).toBeUndefined();
      expect(out[0]!.fix.command_argv).toEqual(['pmbrain', 'skillpack', 'scaffold', packDir]);
    });
  });

  test('exact-version install ledger suppresses the finding', async () => {
    await withEnv({ PMBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [installedEntry(PACK_VERSION)] });
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });

  test('nag ceiling reached for this pack version suppresses the finding', async () => {
    await withEnv({ PMBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      saveNagState({
        schema_version: SKILLPACK_NAG_SCHEMA_VERSION,
        entries: [nagEntry(packDir, { declined_count: DEFAULT_NAG_CEILING, suppressed: true })],
      });
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });

  test('remote ctx never invents a workspace finding', async () => {
    await withEnv({ PMBRAIN_HOME: emptyHome() }, async () => {
      const { engine, counter } = sourcesEngine([sourceRow(makePackDir())]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine, { remote: true }))).toEqual([]);
      expect(counter.calls).toBe(0);
    });
  });

  test('non-resident packs and missing ledgers do not invent findings', async () => {
    await withEnv({ PMBRAIN_HOME: emptyHome() }, async () => {
      const noManifest = mkdtempSync(join(tmpdir(), 'pmbrain-nomanifest-'));
      const nonResident = makePackDir({ brain_resident: false });
      const { engine } = sourcesEngine([
        sourceRow(null, 'pathless'),
        sourceRow(noManifest, 'bare'),
        sourceRow(nonResident, 'registry-style'),
      ]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });
});
