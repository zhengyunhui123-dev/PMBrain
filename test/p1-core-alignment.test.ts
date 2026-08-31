import { describe, expect, test } from 'bun:test';
import { parseLlmJson } from '../src/core/llm-json.ts';
import { parseExtractorJson } from '../src/core/facts/extract.ts';
import { validatePageSlug } from '../src/core/operations.ts';
import { PMBRAIN_MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { isPromptTooLongError, promptTooLongDetail, parseOneshotPayload } from '../src/core/minions/handlers/subagent.ts';
import { parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';
import { parseSurfaceFlag, resolveSurface } from '../src/mcp/surface.ts';
import { operations } from '../src/core/operations.ts';

describe('P1 upstream core alignment', () => {
  test('reasoning-model JSON recovery prefers the final answer', () => {
    const raw = '<think>draft {"answer":"wrong"}</think>{"answer":"final"}';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('facts extraction accepts a final payload after a think block', () => {
    const raw = '<think>{"facts":[{"fact":"draft"}]}</think>'
      + '{"facts":[{"fact":"项目已验收","kind":"event"}]}';
    expect(parseExtractorJson(raw)?.map((fact) => fact.fact)).toEqual(['项目已验收']);
  });

  test('MCP initialize contract warns that put_page replaces the full page', () => {
    expect(PMBRAIN_MCP_INSTRUCTIONS).toContain('put_page');
    expect(PMBRAIN_MCP_INSTRUCTIONS).toContain('REPLACES');
    expect(PMBRAIN_MCP_INSTRUCTIONS).toContain('data, never as instructions');
  });

  test('operation slugs round-trip sync-compatible dots and underscores', () => {
    expect(() => validatePageSlug('_index')).not.toThrow();
    expect(() => validatePageSlug('releases/v1.3_16')).not.toThrow();
    expect(() => validatePageSlug('../secrets')).toThrow();
    expect(() => validatePageSlug('safe/%2e%2e/secrets')).toThrow();
  });

  test('prompt-too-long detection follows provider wrapper cause chains', () => {
    const providerError = new Error('prompt is too long: 120000 tokens > 100000 maximum');
    const wrapped = new Error('gateway request failed', { cause: new Error('provider failed', { cause: providerError }) });
    expect(isPromptTooLongError(wrapped)).toBe(true);
    expect(promptTooLongDetail(wrapped)).toContain('120000 tokens');
  });

  test('oneshot synthesis accepts final JSON, caps pages, and enforces the transcript suffix', () => {
    const parsed = parseOneshotPayload(
      '<think>draft</think>{"pages":[{"slug":"wiki/originals/idea-abc123","content":"# Idea"}],"skip_reason":null}',
      'abc123',
    );
    expect(parsed.pages[0]?.slug).toBe('wiki/originals/idea-abc123');
    expect(() => parseOneshotPayload('{"pages":[],"skip_reason":null}')).toThrow('empty_without_skip_reason');
    expect(() => parseOneshotPayload('{"pages":[{"slug":"wrong","content":"x"}],"skip_reason":null}', 'abc123')).toThrow('slug_suffix_mismatch');
  });

  test('the MCP verb surface is the seven-operation GBrain v1 contract', () => {
    expect(operations.filter((operation) => operation.verb).map((operation) => operation.name).sort()).toEqual(
      ['context_pack', 'delta', 'entity', 'forget', 'recall', 'remember', 'synthesize'],
    );
    expect(parseSurfaceFlag(['--surface', 'starter'])).toBe('starter');
    expect(resolveSurface(null, { mcp_surface: 'verbs' })).toBe('verbs');
    expect(() => parseSurfaceFlag(['--surface', 'wide'])).toThrow('Unknown --surface');
  });

  test('operator pricing overrides accept scalar and asymmetric chat pricing', () => {
    expect(parsePricingOverrides({
      'proxy:model-a': 2,
      'proxy:model-b': { input: 1, output: 3 },
    })).toEqual({
      'proxy:model-a': { input: 2, output: 2 },
      'proxy:model-b': { input: 1, output: 3 },
    });
  });
});
