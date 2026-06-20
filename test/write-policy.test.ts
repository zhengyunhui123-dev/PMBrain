import { describe, expect, test } from 'bun:test';
import {
  applyWritePolicyToSlug,
  resolvePolicyPageFilePath,
  sourceWritePolicy,
} from '../src/core/write-policy.ts';

describe('source write policy', () => {
  test('prefixes bare slugs only', () => {
    const policy = sourceWritePolicy({
      write_policy: {
        default_prefix: 'output/agent-notes',
      },
    });

    expect(applyWritePolicyToSlug('codex-note', policy)).toBe('output/agent-notes/codex-note');
    expect(applyWritePolicyToSlug('wiki/existing', policy)).toBe('wiki/existing');
    expect(applyWritePolicyToSlug('output/qa/existing', policy)).toBe('output/qa/existing');
  });

  test('kind prefix overrides default prefix', () => {
    const policy = sourceWritePolicy({
      write_policy: {
        default_prefix: 'output/agent-notes',
        kind_prefixes: {
          qa: 'output/qa',
        },
      },
    });

    expect(applyWritePolicyToSlug('where-to-file', policy, 'qa')).toBe('output/qa/where-to-file');
    expect(applyWritePolicyToSlug('where-to-file', policy, 'note')).toBe('output/agent-notes/where-to-file');
  });

  test('does not change unconfigured sources', () => {
    expect(applyWritePolicyToSlug('codex-note', null)).toBe('codex-note');
  });

  test('resolves default-source disk path with policy', () => {
    const policy = sourceWritePolicy({
      write_policy: {
        default_prefix: 'output/agent-notes',
      },
    });

    const normalized = resolvePolicyPageFilePath('D:/duwu', 'codex-note', 'default', policy)
      .replace(/\\/g, '/');
    expect(normalized).toBe('D:/duwu/output/agent-notes/codex-note.md');
  });
});
