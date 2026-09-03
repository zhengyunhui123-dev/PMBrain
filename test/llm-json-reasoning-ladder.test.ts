import { describe, expect, test } from 'bun:test';
import { parseLlmJson } from '../src/core/llm-json.ts';
import { parseExtractorJson } from '../src/core/facts/extract.ts';
import { parseAtomsResponse } from '../src/core/cycle/extract-atoms.ts';
import { parseLlmJson as parseConversationLlmJson } from '../src/core/conversation-parser/llm-base.ts';

describe('parseLlmJson — reasoning ladder', () => {
  test('recovers the ANSWER, not the draft inside a closed <think> block', () => {
    const raw = '<think>I will answer {"answer":"draft"} probably</think>{"answer":"final"}';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('recovers when the reasoning block was truncated and never closed', () => {
    const raw = '{"answer":"final"}<think>ran out of budget {"b"';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('is case-insensitive about the tag', () => {
    const raw = '<THINK>draft {"answer":"draft"}</THINK>{"answer":"final"}';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('recovers an array payload', () => {
    const raw = '<think>maybe [1,2] ?</think>[3,4]';
    expect(parseLlmJson<number[]>(raw, { array: true })).toEqual([3, 4]);
  });

  test('is a ladder, not a pre-filter: valid JSON containing "<think>" is untouched', () => {
    const raw = '{"note":"the <think> tag is literal here"}';
    expect(parseLlmJson<{ note: string }>(raw)).toEqual({
      note: 'the <think> tag is literal here',
    });
  });

  test('still returns null when there is no JSON at all', () => {
    expect(parseLlmJson('<think>only reasoning, no answer</think>')).toBeNull();
    expect(parseLlmJson('')).toBeNull();
  });

  test('conversation-parser reuses the same ladder', () => {
    const raw = '<think>draft {"a":0}</think>{"a":1}';
    expect(parseConversationLlmJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });
});

describe('extractors route through the ladder', () => {
  test('facts extractor parses a think-wrapped payload instead of reporting malformed', () => {
    const raw = '<think>candidates: {"facts":[{"fact":"draft"}]}</think>' +
      '{"facts":[{"fact":"Nathan coaches swimming","kind":"identity","notability":"high"}]}';
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    expect(parsed![0]!.fact).toBe('Nathan coaches swimming');
  });

  test('atoms extractor parses a think-wrapped array instead of returning empty', () => {
    const raw = '<think>I could emit [ "draft" ]</think>[{"title":"Water","atom_type":"insight","body":"Water is wet"}]';
    const atoms = parseAtomsResponse(raw);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.title).toBe('Water');
  });
});
