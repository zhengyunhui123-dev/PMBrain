import type { Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Validate an Admin success response before it crosses the HTTP boundary.
 * Contract failures are server bugs: log the schema details and return a
 * stable 500 instead of shipping a shape the current Admin cannot consume.
 */
export function sendAdminContract<T>(
  res: Response,
  schema: ZodType<T>,
  payload: unknown,
  status = 200,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error('[admin contract] response validation failed', parsed.error.issues);
    res.status(500).json({ error: 'admin_response_contract_violation' });
    return;
  }
  res.status(status).json(parsed.data);
}
