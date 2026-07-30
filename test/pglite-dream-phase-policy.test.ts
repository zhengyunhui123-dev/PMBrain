import { describe, expect, test } from 'bun:test';
import { isPgliteWorkerPhaseUnsupported } from '../src/core/cycle.ts';

describe('PGLite Dream phase 1 compatibility policy', () => {
  test('only synthesize and patterns are skipped on PGLite', () => {
    expect(isPgliteWorkerPhaseUnsupported('pglite', 'synthesize')).toBe(true);
    expect(isPgliteWorkerPhaseUnsupported('pglite', 'patterns')).toBe(true);
    expect(isPgliteWorkerPhaseUnsupported('pglite', 'extract')).toBe(false);
  });

  test('Postgres keeps all phases available', () => {
    expect(isPgliteWorkerPhaseUnsupported('postgres', 'synthesize')).toBe(false);
    expect(isPgliteWorkerPhaseUnsupported('postgres', 'patterns')).toBe(false);
  });
});
