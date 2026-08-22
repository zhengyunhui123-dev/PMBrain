import type { ConsoleRun } from './shared';

export interface RunRecoveryDescription {
  kind: 'command_completed_reconnect_failed' | 'command_not_started_handoff_failed';
  badge: string;
  title: string;
  summary: string;
}

const RECONNECT_AFTER_COMMAND = 'Command finished, but database reconnection failed:';
const HANDOFF_BEFORE_COMMAND = 'Command did not start because database handoff failed:';

export function describeRunRecovery(run: ConsoleRun): RunRecoveryDescription | null {
  const error = run.error ?? '';
  if (run.status !== 'failed') return null;

  if (error.includes(RECONNECT_AFTER_COMMAND)) {
    return {
      kind: 'command_completed_reconnect_failed',
      badge: '连接恢复失败',
      title: '知识整理已执行，数据库连接恢复超时',
      summary: '整理子命令已经结束；失败发生在桌面服务重新接管 PGLite 时，不代表本地模型执行失败。已产生的整理成果不会自动删除。',
    };
  }

  if (error.includes(HANDOFF_BEFORE_COMMAND)) {
    return {
      kind: 'command_not_started_handoff_failed',
      badge: '未启动',
      title: '数据库交接失败，知识整理尚未启动',
      summary: '桌面服务未能在启动前安全释放 PGLite，因此整理命令尚未开始，也没有执行本地模型。',
    };
  }

  return null;
}
