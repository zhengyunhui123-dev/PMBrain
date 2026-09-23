/**
 * loops-extract wiring — static assertions pinning the cross-file plumbing
 * around the open-loop LLM extractor:
 *
 *   1. jobs.ts registers loops_extract + loops_scan_meetings with
 *      refreshGatewayForJob (PMBrain uses worker.register, not registerBuiltinJob).
 *   2. Kill-switch keys are known config keys; meeting/transcript/connector default OFF.
 *   3. Relational vocabulary includes owes_to / awaiting_reply_from.
 *   4. loops ops exist: open_loops is read-only and not localOnly.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeLoad } from 'js-yaml';

import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { KNOWN_LINK_TYPES } from '../src/core/search/relational-intent.ts';
import { operations } from '../src/core/operations.ts';

const REPO = path.join(import.meta.dir, '..');

describe('jobs.ts wiring', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'commands', 'jobs.ts'), 'utf8');

  test('loops_extract and loops_scan_meetings refresh the gateway then register', () => {
    expect(src).toContain("worker.register('loops_extract'");
    expect(src).toContain("worker.register('loops_scan_meetings'");
    const extractBlock = src.slice(src.indexOf("worker.register('loops_extract'"));
    expect(extractBlock.slice(0, 400)).toContain('refreshGatewayForJob');
    const scanBlock = src.slice(src.indexOf("worker.register('loops_scan_meetings'"));
    expect(scanBlock.slice(0, 400)).toContain('refreshGatewayForJob');
  });
});

describe('kill-switch config keys', () => {
  test("KNOWN_CONFIG_KEYS includes Gmail ON + adapter OFF keys", () => {
    expect(KNOWN_CONFIG_KEYS).toContain('loops.extraction_enabled');
    expect(KNOWN_CONFIG_KEYS).toContain('loops.meeting_extraction_enabled');
    expect(KNOWN_CONFIG_KEYS).toContain('loops.transcript_extraction_enabled');
    expect(KNOWN_CONFIG_KEYS).toContain('loops.connector_extraction_enabled');
  });
});

describe('relational edge vocabulary', () => {
  test("KNOWN_LINK_TYPES includes 'owes_to' and 'awaiting_reply_from'", () => {
    expect(KNOWN_LINK_TYPES.has('owes_to')).toBe(true);
    expect(KNOWN_LINK_TYPES.has('awaiting_reply_from')).toBe(true);
  });

  test('gbrain-base-v2.yaml declares both verbs as link_types', () => {
    const raw = fs.readFileSync(
      path.join(REPO, 'src', 'core', 'schema-pack', 'base', 'gbrain-base-v2.yaml'),
      'utf8',
    );
    const pack = safeLoad(raw) as { link_types?: Array<{ name: string }> };
    expect(Array.isArray(pack.link_types)).toBe(true);
    const names = pack.link_types!.map((lt) => lt.name);
    expect(names).toContain('owes_to');
    expect(names).toContain('awaiting_reply_from');
  });
});

describe('loops operations contract', () => {
  const byName = new Map(operations.map((op) => [op.name, op]));
  const openSrc = fs.readFileSync(path.join(REPO, 'src', 'core', 'ops', 'loops.ts'), 'utf8');

  test('open_loops / loops_close / loops_mute exist', () => {
    for (const name of ['open_loops', 'loops_close', 'loops_mute']) {
      expect(byName.get(name)).toBeDefined();
    }
  });

  test('open_loops is a read op and NOT localOnly; handler never scans', () => {
    const op = byName.get('open_loops')!;
    expect(op.scope).toBe('read');
    expect(op.mutating).toBeFalsy();
    expect(op.localOnly).toBeFalsy();
    expect(openSrc).not.toMatch(/runLoopsScan|applyThreadLoopVerdict|runLoopsExtract/);
  });

  test('loops_close and loops_mute are mutating write ops', () => {
    for (const name of ['loops_close', 'loops_mute']) {
      const op = byName.get(name)!;
      expect(op.scope).toBe('write');
      expect(op.mutating).toBe(true);
    }
  });
});
