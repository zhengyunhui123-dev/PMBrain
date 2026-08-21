import { describe, expect, mock, test } from 'bun:test';
import {
  inspectDesktopPgliteRecovery,
  terminateDesktopPgliteOwnerAndRetry,
  type DesktopPgliteRecoveryDependencies,
} from '../src/main/pglite-recovery.js';

function dependencies(
  overrides: Partial<DesktopPgliteRecoveryDependencies> = {},
): DesktopPgliteRecoveryDependencies {
  return {
    setup: () => ({
      needsSetup: false,
      engine: 'pglite',
      databasePath: 'D:\\data\\brain.pglite',
    }),
    recoveryActive: () => true,
    inspectOwner: async () => ({
      state: 'active',
      pid: 37564,
      ownerType: 'desktop-sidecar',
      commandLabel: 'PMBrain Desktop sidecar',
      acquiredAt: '2026-08-21T10:00:00.000Z',
      canTerminate: true,
      message: '发现另一个 PMBrain 进程。',
    }),
    terminateOwner: async () => ({
      state: 'stale',
      pid: 37564,
      ownerType: 'desktop-sidecar',
      commandLabel: 'PMBrain Desktop sidecar',
      acquiredAt: '2026-08-21T10:00:00.000Z',
      canTerminate: false,
      message: '占用进程已退出。',
    }),
    restart: async () => 'http://127.0.0.1:3132/desktop',
    ...overrides,
  };
}

describe('desktop PGLite recovery controller', () => {
  test('only offers termination for a verified PGLite owner while recovery is active', async () => {
    const active = await inspectDesktopPgliteRecovery(dependencies());
    expect(active.canTerminate).toBe(true);
    expect(active.pid).toBe(37564);

    const postgres = await inspectDesktopPgliteRecovery(dependencies({
      setup: () => ({ needsSetup: false, engine: 'postgres' }),
    }));
    expect(postgres.canTerminate).toBe(false);
    expect(postgres.pid).toBeNull();

    const recovered = await inspectDesktopPgliteRecovery(dependencies({
      recoveryActive: () => false,
    }));
    expect(recovered.canTerminate).toBe(false);
    expect(recovered.pid).toBeNull();
  });

  test('terminates the revalidated owner before restarting the existing sidecar flow', async () => {
    const order: string[] = [];
    const terminateOwner = mock(async (_path: string, pid: number) => {
      order.push(`terminate:${pid}`);
      return {
        state: 'stale' as const,
        pid,
        ownerType: 'desktop-sidecar',
        commandLabel: 'PMBrain Desktop sidecar',
        acquiredAt: null,
        canTerminate: false,
        message: '占用进程已退出。',
      };
    });
    const restart = mock(async () => {
      order.push('restart');
      return 'http://127.0.0.1:3132/desktop';
    });

    const url = await terminateDesktopPgliteOwnerAndRetry(37564, dependencies({
      terminateOwner,
      restart,
    }));

    expect(url).toBe('http://127.0.0.1:3132/desktop');
    expect(order).toEqual(['terminate:37564', 'restart']);
    expect(terminateOwner).toHaveBeenCalledWith('D:\\data\\brain.pglite', 37564);
  });

  test('refuses stale UI actions and never falls back to killing an arbitrary PID', async () => {
    const terminateOwner = mock(async () => {
      throw new Error('should not run');
    });
    const restart = mock(async () => undefined);

    await expect(terminateDesktopPgliteOwnerAndRetry(37564, dependencies({
      recoveryActive: () => false,
      terminateOwner,
      restart,
    }))).rejects.toThrow('恢复状态已变化');

    expect(terminateOwner).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  test('does not restart when safe owner verification or termination fails', async () => {
    const restart = mock(async () => undefined);

    await expect(terminateDesktopPgliteOwnerAndRetry(37564, dependencies({
      terminateOwner: async () => {
        throw new Error('未能确认该 PID 属于 PMBrain');
      },
      restart,
    }))).rejects.toThrow('未能确认该 PID 属于 PMBrain');

    expect(restart).not.toHaveBeenCalled();
  });
});
