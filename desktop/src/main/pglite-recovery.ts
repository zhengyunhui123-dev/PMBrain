import {
  inspectPgliteOwner,
  terminatePgliteOwner,
  type PgliteOwnerStatus,
} from '../../../src/core/pglite-owner-control.js';

export interface DesktopPgliteRecoverySetup {
  needsSetup: boolean;
  engine: 'pglite' | 'postgres';
  databasePath?: string;
}

export interface DesktopPgliteRecoveryDependencies {
  setup: () => DesktopPgliteRecoverySetup;
  recoveryActive: () => boolean;
  inspectOwner?: (databasePath: string) => Promise<PgliteOwnerStatus>;
  terminateOwner?: (databasePath: string, expectedPid: number) => Promise<PgliteOwnerStatus>;
  restart: () => Promise<string | undefined>;
}

function unavailable(message: string): PgliteOwnerStatus {
  return {
    state: 'unavailable',
    pid: null,
    ownerType: null,
    commandLabel: null,
    acquiredAt: null,
    canTerminate: false,
    message,
  };
}

function configuredPglitePath(
  dependencies: DesktopPgliteRecoveryDependencies,
): string | null {
  const setup = dependencies.setup();
  if (setup.needsSetup || setup.engine !== 'pglite') return null;
  const path = setup.databasePath?.trim();
  return path || null;
}

export async function inspectDesktopPgliteRecovery(
  dependencies: DesktopPgliteRecoveryDependencies,
): Promise<PgliteOwnerStatus> {
  if (!dependencies.recoveryActive()) {
    return unavailable('PMBrain 本地服务已不在故障恢复状态。');
  }
  const databasePath = configuredPglitePath(dependencies);
  if (!databasePath) {
    return unavailable('当前配置没有可恢复的 PGLite 数据库占用进程。');
  }
  const inspectOwner = dependencies.inspectOwner ?? inspectPgliteOwner;
  return inspectOwner(databasePath);
}

export async function terminateDesktopPgliteOwnerAndRetry(
  expectedPid: number,
  dependencies: DesktopPgliteRecoveryDependencies,
): Promise<string | undefined> {
  if (!dependencies.recoveryActive()) {
    throw new Error('PMBrain 恢复状态已变化，未执行结束操作。请查看当前服务状态。');
  }
  const databasePath = configuredPglitePath(dependencies);
  if (!databasePath) {
    throw new Error('当前不是可恢复的 PGLite 配置，未执行结束操作。');
  }
  const terminateOwner = dependencies.terminateOwner ?? terminatePgliteOwner;
  await terminateOwner(databasePath, expectedPid);
  return dependencies.restart();
}
