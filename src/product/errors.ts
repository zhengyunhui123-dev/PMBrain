import { classifyChatError } from '../core/ai/errors';

export type ProductErrorCode = 'database_wait' | 'database_timeout' | 'model_error' | 'budget_stop' | 'user_cancel' | 'unknown';

const CODES: ProductErrorCode[] = ['database_wait', 'database_timeout', 'model_error', 'budget_stop', 'user_cancel'];

export function classifyProductError(error: unknown): { code: ProductErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const named = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (CODES.includes(named as ProductErrorCode)) return { code: named as ProductErrorCode, message };
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || /已停止生成|任务已停止|用户取消|user_stop/.test(message)) return { code: 'user_cancel', message };
  if (/费用预算|预算不足|缺少模型价格|上下文预算|task_budget|no_pricing/.test(message)) return { code: 'budget_stop', message };
  if (/数据库请求超时|数据库执行超时|database request timeout/i.test(message)) return { code: 'database_timeout', message };
  if (/尚未执行|排队等待|等待前面的操作|等待事务释放/.test(message)) return { code: 'database_wait', message };
  if (/^(?:(?:wall-clock )?timeout exceeded|aborted:\s*timeout)$/i.test(message)) return { code: 'unknown', message };
  const chat = error instanceof Error || typeof error === 'string' ? classifyChatError(error) : 'failure';
  if (['auth', 'billing', 'model_not_found', 'rate_limit', 'provider_5xx', 'network', 'timeout'].includes(chat) || /模型调用失败|模型连接|模型等待超时/.test(message)) return { code: 'model_error', message };
  return { code: 'unknown', message };
}
