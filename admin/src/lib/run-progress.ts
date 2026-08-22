import type { ConsoleRun } from '../../../shared/contracts/common.ts';

const ONLINE_SLOW_HINT_THRESHOLD_MS = 30_000;
const LOCAL_CHAT_PROVIDERS = new Set(['ollama', 'llama-server']);

export interface RunProgressPresentation {
  label: string;
  meta: string | null;
  explanation: string | null;
  active: boolean;
  localModel: boolean;
}

export function formatRunDuration(value: number): string {
  const milliseconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (milliseconds < 1_000) return '不到 1 秒';
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

export function isLocalChatModel(model: string | null | undefined): boolean {
  const provider = model?.split(':', 1)[0]?.trim().toLowerCase();
  return Boolean(provider && LOCAL_CHAT_PROVIDERS.has(provider));
}

function timestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function elapsedMs(run: ConsoleRun, now: number): number {
  if (run.durationMs !== null && Number.isFinite(run.durationMs)) return Math.max(0, run.durationMs);
  const started = Date.parse(run.startedAt);
  const ended = run.completedAt ? Date.parse(run.completedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0;
  return Math.max(0, ended - started);
}

export function describeRunProgress(
  run: ConsoleRun,
  chatModel: string | null | undefined,
  now = Date.now(),
): RunProgressPresentation {
  const active = run.status === 'queued' || run.status === 'running';
  const usesChatModel = run.kind === 'search_brain';
  const localModel = usesChatModel && isLocalChatModel(chatModel);
  const elapsed = elapsedMs(run, now);

  if (run.status === 'queued') {
    return {
      label: '等待执行',
      meta: `正在等待可用执行资源 · 已用时 ${formatRunDuration(elapsed)}`,
      explanation: localModel
        ? '本地模型会使用本机 CPU/GPU；首次加载模型或当前系统负载较高时，开始生成前可能需要等待。'
        : null,
      active,
      localModel,
    };
  }

  if (run.status === 'running') {
    return {
      label: '正在进行中',
      meta: `${localModel ? '本地模型正在生成' : '正在生成'} · 已用时 ${formatRunDuration(elapsed)}`,
      explanation: localModel
        ? '本地模型由本机 CPU/GPU 计算；首次加载、模型较大或检索上下文较长时会更慢，请耐心等待。'
        : usesChatModel && elapsed >= ONLINE_SLOW_HINT_THRESHOLD_MS
          ? '在线模型响应较慢，可能受网络波动、服务排队或检索上下文较长影响。'
          : null,
      active,
      localModel,
    };
  }

  const completedAt = timestamp(run.completedAt);
  const ending = run.status === 'completed' ? '完成于' : run.status === 'failed' ? '失败于' : '结束于';
  const label = run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : '已取消';
  return {
    label,
    meta: completedAt ? `${ending} ${completedAt} · 用时 ${formatRunDuration(elapsed)}` : `用时 ${formatRunDuration(elapsed)}`,
    explanation: null,
    active,
    localModel,
  };
}
