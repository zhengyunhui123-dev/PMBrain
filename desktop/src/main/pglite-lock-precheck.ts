/**
 * PGLite lock precheck — 在启动 sidecar 之前检测数据库是否被其他
 * PMBrain 进程持有（旧桌面端残留、托盘实例、命令行 CLI）。
 *
 * 背景（2026-07-31 发布测试实测）：老用户 + PGLite 升级迁移失败的根因
 * 是锁竞争——另一个 PMBrain 进程持有 brain.pglite 时，sidecar 要等满
 * 30 秒锁超时，且错误文本不匹配不可重试列表，还会再重启重试 3 轮，
 * 用户最长等约 2 分钟才看到失败页。预检把这一路径缩短到毫秒级，并
 * 给出可操作的指引（退出哪个 PID）。
 *
 * 只读检测，绝不删除锁目录、绝不结束任何进程：
 *  - 无锁 / 锁损坏 / PID 已死 → 放行（sidecar 的 stale 清理会处理）
 *  - PID 存活且非本进程 → 返回 blocked + 中文指引，由调用方决定展示
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PgliteLockPrecheckResult {
  blocked: boolean;
  holderPid?: number;
  message?: string;
}

export function precheckPgliteLock(databasePath: string | null | undefined): PgliteLockPrecheckResult {
  if (!databasePath) return { blocked: false };
  const lockFile = join(databasePath, '.gbrain-lock', 'lock');
  if (!existsSync(lockFile)) return { blocked: false };

  let data: { pid?: unknown; acquired_at?: unknown; command?: unknown };
  try {
    data = JSON.parse(readFileSync(lockFile, 'utf-8'));
  } catch {
    // 损坏的锁文件交给 sidecar 的 stale 清理逻辑处理，不拦启动。
    return { blocked: false };
  }

  const pid = typeof data.pid === 'number' ? data.pid : NaN;
  if (!Number.isInteger(pid) || pid <= 0) return { blocked: false };
  if (pid === process.pid) return { blocked: false };

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  // 持有进程已退出：残留锁会被 sidecar 的 stale 检测自动清理，不拦。
  if (!alive) return { blocked: false };

  const since = typeof data.acquired_at === 'number'
    ? new Date(data.acquired_at).toLocaleString('zh-CN')
    : '未知时间';
  const command = typeof data.command === 'string' && data.command.trim()
    ? data.command.trim()
    : '未知命令';

  return {
    blocked: true,
    holderPid: pid,
    message:
      `检测到另一个 PMBrain 进程正在使用本地数据库（PID ${pid}，启动于 ${since}）：\n${command}\n\n` +
      `请先退出该 PMBrain 实例（其他窗口、托盘图标或命令行），再点击「重新启动服务」。\n` +
      `PGLite 数据库路径：${databasePath}`,
  };
}
