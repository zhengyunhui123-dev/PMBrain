/**
 * In-process drain for Dream's private child queue.
 *
 * PGLite cannot run a second Worker process while the owning process holds the
 * embedded database lock. Draining the private queue here also avoids a
 * Postgres parent/child worker-slot deadlock. This compatibility port keeps
 * PMBrain's existing subagent handler and queue state machine unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { makeSubagentHandler, RateLeaseUnavailableError } from '../minions/handlers/subagent.ts';
import type { MinionHandler, MinionJobContext } from '../minions/types.ts';
import { UnrecoverableError } from '../minions/types.ts';
import { combineAbortSignals, throwIfAborted } from '../abort-check.ts';
import {BudgetExhausted} from '../budget/budget-tracker.ts';
import { lockRenewalAudit } from '../audit/lock-renewal-audit.ts';
import { resolveLockRenewalKnobs, runLockRenewalTick } from '../minions/lock-renewal-tick.ts';

export const INLINE_LOCK_MS = 30_000;
const INLINE_ABORT_GRACE_MS = 30_000;

export async function runSubagentsInline(
  engine: BrainEngine,
  queue: MinionQueue,
  queueName: string,
  yieldDuringPhase?: () => Promise<void>,
  handler: MinionHandler = makeSubagentHandler({ engine }),
  lockMs = INLINE_LOCK_MS,
  signal?: AbortSignal,
  onProgress?:(progress:Record<string,unknown>)=>void,
): Promise<void> {
  while (true) {
    throwIfAborted(signal, '[dream] inline drain');
    await queue.promoteDelayed(queueName);
    await queue.handleStalled([], queueName);
    await queue.handleTimeouts(queueName);
    await queue.handleWallClockTimeouts(lockMs, queueName);

    const lockToken = randomUUID();
    const job = await queue.claim(lockToken, lockMs, queueName, ['subagent']);
    if (!job) {
      const rows = await engine.executeRaw<{ count: number | string }>(
        `SELECT count(*) AS count
           FROM minion_jobs
          WHERE queue = $1
            AND status IN ('active', 'waiting', 'delayed')`,
        [queueName],
      );
      if (Number(rows[0]?.count ?? 0) === 0) return;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }

    const abort = new AbortController();
    const shutdown = new AbortController();
    const context: MinionJobContext = {
      id: job.id,
      name: job.name,
      data: job.data,
      attempts_made: job.attempts_made,
      signal: combineAbortSignals(abort.signal, signal),
      deadlineAtMs: job.timeout_at?.getTime() ?? null,
      shutdownSignal: shutdown.signal,
      updateProgress: async progress => {
        await queue.updateProgress(job.id, lockToken, progress);
        if(progress&&typeof progress==='object'&&!Array.isArray(progress))onProgress?.(progress as Record<string,unknown>);
      },
      updateTokens: async tokens => {
        await queue.updateTokens(job.id, lockToken, tokens);
      },
      log: async message => {
        const value = typeof message === 'string' ? message : JSON.stringify(message);
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
                  updated_at = now()
            WHERE id = $2 AND status = 'active' AND lock_token = $3`,
          [value, job.id, lockToken],
        );
      },
      isActive: async () => {
        const rows = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs
            WHERE id = $1 AND status = 'active' AND lock_token = $2`,
          [job.id, lockToken],
        );
        return rows.length > 0;
      },
      readInbox: () => queue.readInbox(job.id, lockToken),
    };

    const timeoutMs = job.timeout_at
      ? Math.max(0, job.timeout_at.getTime() - Date.now())
      : job.timeout_ms;
    const timeout = timeoutMs != null
      ? setTimeout(() => abort.abort(new Error('timeout')), timeoutMs)
      : null;
    let finished = false;
    let renewing = false;
    const ownerId = job.data.ingest_context ? job.private_queue_owner_job_id : null;
    const renewal = {
      jobId: job.id, jobName: job.name, lockToken, lockDurationMs: lockMs,
      knobs: resolveLockRenewalKnobs(process.env, lockMs),
      lastSuccessfulRenewalAt: Date.now(), consecutiveFailures: 0,
      cancelled: () => finished || context.signal.aborted,
    };
    const renew = setInterval(() => {
      if (renewing || renewal.cancelled()) return;
      renewing = true;
      void runLockRenewalTick({
        renewLock: (id, token, duration) => ownerId === null
          ? queue.renewLock(id, token, duration)
          : queue.renewOwnedInlineJobLock(id, token, duration, ownerId),
        audit: lockRenewalAudit, now: Date.now, setTimeout,
      }, renewal).then(result => {
        if (result.kind === 'lock_lost' || result.kind === 'should_abort') {
          abort.abort(new Error('lock-renewal-failed'));
        }
      }).catch(() => abort.abort(new Error('lock-renewal-failed')))
        .finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(lockMs / 3)));
    const keepalive = yieldDuringPhase
      ? setInterval(() => { void yieldDuringPhase().catch(() => { /* best-effort */ }); }, 60_000)
      : null;

    let abortGrace: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      context.signal.throwIfAborted();
      const stopped = job.data.ingest_context ? new Promise<never>((_, reject) => {
        onAbort = () => { abortGrace = setTimeout(() => reject(context.signal.reason), INLINE_ABORT_GRACE_MS); };
        context.signal.addEventListener('abort', onAbort, { once: true });
      }) : undefined;
      const result = await (stopped ? Promise.race([handler(context), stopped]) : handler(context));
      context.signal.throwIfAborted();
      await queue.completeJob(
        job.id,
        lockToken,
        result != null
          ? (typeof result === 'object' ? result as Record<string, unknown> : { value: result })
          : undefined,
      );
    } catch (error) {
      if(error instanceof BudgetExhausted)throw error;
      if (abort.signal.reason?.message === 'lock-renewal-failed') {
        await queue.failJob(job.id, lockToken, 'ingest_lease_lost: execution lock renewal failed', 'dead', 0);
      } else if (error instanceof RateLeaseUnavailableError) {
        await queue.releaseLeaseFullJob(
          job.id,
          lockToken,
          error.message,
          1000 + Math.floor(Math.random() * 2000),
        );
      } else {
        const timedOut = abort.signal.aborted&&abort.signal.reason instanceof Error&&abort.signal.reason.message==='timeout';
        const attemptsExhausted = job.attempts_made + 1 >= job.max_attempts;
        await queue.failJob(
          job.id,
          lockToken,
          timedOut ? (job.data.ingest_context?'ingest_provider_timeout: entity subtask timeout exceeded':'timeout exceeded') : error instanceof Error ? error.message : String(error),
          timedOut || error instanceof UnrecoverableError || attemptsExhausted ? 'dead' : 'delayed',
          0,
        );
      }
    } finally {
      finished = true;
      if (onAbort) context.signal.removeEventListener('abort', onAbort);
      if (abortGrace) clearTimeout(abortGrace);
      if (timeout) clearTimeout(timeout);
      clearInterval(renew);
      if (keepalive) clearInterval(keepalive);
    }
  }
}
