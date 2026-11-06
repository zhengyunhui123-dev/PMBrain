export const DEFAULT_PRODUCT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DREAM_TASK_TIMEOUT_KEY = 'dream.task_timeout_ms';
export const DEEP_ORGANIZE_PHASE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
export const SLEEP_INTERRUPT_REASON = '因休眠中断，点继续';

export function parseTaskTimeout(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647 ? number : null;
}

export function isUnboundedDeepOrganize(input: { preset?: string | null } | null | undefined): boolean {
  return input?.preset === 'full';
}

export function timeoutLimitMessage(timeoutMs: number): string {
  const hours = Math.max(1, Math.round(timeoutMs / 3_600_000));
  return `达到 ${hours} 小时上限，已保留完成结果，可以继续未完成部分。`;
}
