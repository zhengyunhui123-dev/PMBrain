import { describe, expect, test } from 'bun:test';
import { disconnectCliEngine } from '../src/core/cli-disconnect.ts';

describe('one-shot CLI disconnect deadline', () => {
  test('keeps the normal clean disconnect path', async () => {
    let disconnected = false;
    const outcome = await disconnectCliEngine({
      async disconnect() {
        disconnected = true;
      },
    }, 'import', { deadlineMs: 50 });

    expect(outcome).toBe('disconnected');
    expect(disconnected).toBe(true);
  });

  test('forces an already-completed import child to exit when disconnect wedges', async () => {
    const warnings: string[] = [];
    const exits: number[] = [];
    const outcome = await disconnectCliEngine({
      disconnect: () => new Promise<void>(() => {}),
    }, 'import', {
      deadlineMs: 10,
      exitCode: 7,
      forceExit: code => { exits.push(code); },
      warn: message => { warnings.push(message); },
    });

    expect(outcome).toBe('forced_exit');
    expect(exits).toEqual([7]);
    expect(warnings[0]).toContain('import completed');
    expect(warnings[0]).toContain('engine.disconnect() did not return');
  });
});
