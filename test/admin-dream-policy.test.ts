import { describe, expect, test } from 'bun:test';
import {
  LOCAL_OLLAMA_DREAM_MAX_PAGES,
  normalizeAdminDreamRequest,
} from '../src/commands/admin-dream-policy.ts';

describe('Admin Dream execution policy', () => {
  test('local Ollama handles proposal pages in a small batch and never drains the whole backlog', () => {
    const request = normalizeAdminDreamRequest({
      phase: 'propose_takes',
      maxPages: 100,
      drainProposals: true,
      windowSeconds: 3600,
    }, {
      engine: 'pglite',
      chatModel: 'ollama:gemma4',
    });

    expect(request.maxPages).toBe(LOCAL_OLLAMA_DREAM_MAX_PAGES);
    expect(request.drainProposals).toBe(false);
    expect(request.windowSeconds).toBeUndefined();
  });

  test('non-local proposal draining is capped at one hour and remains one phase', () => {
    const request = normalizeAdminDreamRequest({
      phase: 'propose_takes',
      drainProposals: true,
      windowSeconds: 7200,
    }, {
      engine: 'postgres',
      chatModel: 'anthropic:claude-sonnet-4-6',
    });

    expect(request.phase).toBe('propose_takes');
    expect(request.preset).toBeUndefined();
    expect(request.windowSeconds).toBe(3600);
  });

  test('PGLite Admin preserves the full Dream preset for sequential execution', () => {
    const request = normalizeAdminDreamRequest({ preset: 'full' }, {
      engine: 'pglite',
      chatModel: 'anthropic:claude-sonnet-4-6',
    });

    expect(request).toEqual({ preset: 'full' });
  });

  test('local Ollama keeps the full Dream preset but bounds the expensive proposal phase', () => {
    const request = normalizeAdminDreamRequest({
      preset: 'full',
      maxPages: 100,
      drainProposals: false,
    }, {
      engine: 'pglite',
      chatModel: 'ollama:gemma4',
    });

    expect(request.preset).toBe('full');
    expect(request.phase).toBeUndefined();
    expect(request.maxPages).toBe(LOCAL_OLLAMA_DREAM_MAX_PAGES);
    expect(request.drainProposals).toBe(false);
  });
});
