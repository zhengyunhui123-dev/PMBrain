export const DEFAULT_PRODUCT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DREAM_TASK_TIMEOUT_KEY = 'dream.task_timeout_ms';

export function parseTaskTimeout(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647 ? number : null;
}
