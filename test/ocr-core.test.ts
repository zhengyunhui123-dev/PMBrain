import { describe, expect, test } from 'bun:test';
import { OCR_PROMPT_VERSION, OCR_RECEIPT_VERSION, shouldRefreshOcrReceipt, type OcrReceipt } from '../src/core/ocr.ts';

function receipt(overrides: Partial<OcrReceipt> = {}): OcrReceipt {
  return {
    version: OCR_RECEIPT_VERSION,
    promptVersion: OCR_PROMPT_VERSION,
    sourceHash: 'hash-a',
    model: 'openai:gpt-4o-mini',
    candidates: 2,
    attempted: 2,
    succeeded: 2,
    failed: 0,
    failedItems: [],
    status: 'complete',
    processedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('OCR maintenance receipt', () => {
  test('keeps a completed unchanged receipt current', () => {
    expect(shouldRefreshOcrReceipt(receipt(), 'hash-a', 'openai:gpt-4o-mini')).toBe(false);
  });

  test('refreshes unchanged files after failure or model replacement', () => {
    expect(shouldRefreshOcrReceipt(receipt({ status: 'partial', failed: 1, failedItems: [2] }), 'hash-a', 'openai:gpt-4o-mini')).toBe(true);
    expect(shouldRefreshOcrReceipt(receipt(), 'hash-a', 'google:gemini-3.5-flash')).toBe(true);
  });
});
