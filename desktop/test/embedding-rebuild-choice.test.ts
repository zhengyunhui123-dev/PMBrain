import { describe, expect, test } from 'bun:test';
import {
  chooseEmbeddingRebuild,
  waitEmbeddingRebuildChoice,
} from '../src/main/startup/embedding-rebuild-choice.js';

describe('embedding rebuild startup choice', () => {
  test('resolves the pending startup choice', async () => {
    const choice = waitEmbeddingRebuildChoice();
    chooseEmbeddingRebuild('defer');
    expect(await choice).toBe('defer');
  });

  test('ignores an invalid IPC value without discarding the pending choice', async () => {
    const choice = waitEmbeddingRebuildChoice();
    chooseEmbeddingRebuild('invalid' as 'wait');
    chooseEmbeddingRebuild('wait');
    expect(await choice).toBe('wait');
  });
});
