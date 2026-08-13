import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

const expectedSkills = [
  'brain-first',
  'remember',
  'durable-writeback',
  'correction',
  'takes-review',
  'brain-ingest-gate',
  'resolve-before-asking',
  'data-loss-gate',
  'fact-check',
  'conversation-summary',
] as const;

describe('PMBrain Agent Capability Pack contract', () => {
  test('canonical registry automatically produces the four new MCP tools with correct scopes and schemas', () => {
    const defs = buildToolDefs(operations);
    const byName = new Map(operations.map((entry) => [entry.name, entry]));
    for (const name of [
      'list_take_proposals',
      'get_take_proposal',
      'accept_take_proposal',
      'reject_take_proposal',
      'patch_page',
    ]) {
      expect(defs.some((entry) => entry.name === name)).toBe(true);
      expect(byName.get(name)).toBeDefined();
    }
    expect(byName.get('list_take_proposals')?.scope).toBe('read');
    expect(byName.get('get_take_proposal')?.scope).toBe('read');
    expect(byName.get('accept_take_proposal')?.scope).toBe('write');
    expect(byName.get('reject_take_proposal')?.scope).toBe('write');
    expect(byName.get('patch_page')?.scope).toBe('write');
    expect(defs.find((entry) => entry.name === 'accept_take_proposal')?.inputSchema.required)
      .toContain('proposal_id');
    expect(defs.find((entry) => entry.name === 'patch_page')?.inputSchema.required)
      .toEqual(expect.arrayContaining(['page_slug', 'old_text', 'new_text', 'reason']));
  });

  test('stdio and HTTP MCP both consume the shared registry/tool-definition path', () => {
    const stdio = readFileSync(join(import.meta.dir, '..', 'src', 'mcp', 'server.ts'), 'utf8');
    const http = readFileSync(join(import.meta.dir, '..', 'src', 'mcp', 'http-transport.ts'), 'utf8');
    expect(stdio).toContain('buildToolDefs(operations)');
    expect(http).toContain('buildToolDefs(operations)');
  });

  test('CLI add and proposal acceptance share the canonical take writer', () => {
    const cli = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'takes.ts'), 'utf8');
    const proposals = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'take-proposals.ts'), 'utf8');
    expect(cli).toContain("import { addCanonicalTake } from '../core/canonical-takes.ts'");
    expect(cli).toContain('await addCanonicalTake(engine, {');
    expect(proposals).toContain("import { addCanonicalTake } from './canonical-takes.ts'");
    expect(proposals).toContain('await addCanonicalTake(engine, {');
  });

  test('manifest is valid, lists ten unique skills, and references only real Operations', () => {
    const packRoot = join(import.meta.dir, '..', 'agent-pack');
    const manifest = JSON.parse(readFileSync(join(packRoot, 'manifest.json'), 'utf8')) as {
      pack_version: string;
      name: string;
      skills: Array<{ name: string; path: string; required_operations: string[] }>;
    };
    expect(manifest.pack_version).toMatch(/^1\./);
    expect(manifest.name).toBe('PMBrain Agent Capability Pack');
    expect(manifest.skills.map((entry) => entry.name)).toEqual([...expectedSkills]);
    expect(new Set(manifest.skills.map((entry) => entry.name)).size).toBe(10);

    const operationNames = new Set(operations.map((entry) => entry.name));
    for (const skill of manifest.skills) {
      expect(existsSync(join(packRoot, skill.path, 'SKILL.md'))).toBe(true);
      for (const operation of skill.required_operations) {
        expect(operationNames.has(operation)).toBe(true);
      }
    }
  });
});
