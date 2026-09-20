import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { isTruthy } from '../core/connectors/config-keys.ts';
import { maybeDispatchConnectorSyncs } from './autopilot-fanout.ts';
import { localDateKey, runAdminProductOp } from './admin-product-surfaces.ts';

export const PRODUCT_AUTOMATION_CHECK_MS = 5 * 60_000;

export function productAutomationSlot(now = new Date()): string {
  const minute = Math.floor(now.getUTCMinutes() / 15) * 15;
  return `${now.toISOString().slice(0, 13)}:${String(minute).padStart(2, '0')}`;
}

export async function runProductAutomationTick(
  engine: BrainEngine,
  queue = new MinionQueue(engine),
  now = new Date(),
): Promise<{ connectors: string[]; google: string[]; waiting: boolean; chronicle: boolean }> {
  const slot = productAutomationSlot(now);
  const connectorResult = await maybeDispatchConnectorSyncs(engine, queue, {
    slot,
    timeoutMs: 30 * 60_000,
    jsonMode: false,
  });
  const google: string[] = [];
  if (isTruthy(await engine.getConfig('connectors.google.auto_sync'))) {
    const sources = await engine.listAllSources();
    for (const source of sources.filter((item) => item.config?.kind === 'google')) {
      const last = source.last_sync_at?.getTime() ?? 0;
      if (now.getTime() - last < 24 * 60 * 60_000) continue;
      const job = await queue.add(
        'sync',
        { sourceId: source.id, noPull: true, noEmbed: true, noExtract: true },
        {
          queue: 'default',
          idempotency_key: `product-google-sync:${source.id}:${slot}`,
          timeout_ms: 30 * 60_000,
          max_attempts: 2,
          maxPending: 1,
        },
      );
      if ((job as { coalesced?: boolean }).coalesced !== true) google.push(source.id);
    }
  }
  let waiting = false;
  if (isTruthy(await engine.getConfig('loops.meeting_scan_auto'))) {
    const job = await queue.add(
      'loops_scan_meetings',
      { lane: 'all' },
      {
        queue: 'default',
        idempotency_key: `product-waiting:${slot}`,
        timeout_ms: 30 * 60_000,
        max_attempts: 2,
        maxPending: 1,
      },
    );
    waiting = (job as { coalesced?: boolean }).coalesced !== true;
  }
  let chronicle = false;
  if (isTruthy(await engine.getConfig('auto_chronicle'))) {
    const today = localDateKey(now);
    if (await engine.getConfig('chronicle.product_last_run_date') !== today) {
      await runAdminProductOp(engine, 'chronicle_backfill', { since: today });
      await engine.setConfig('chronicle.product_last_run_date', today);
      chronicle = true;
    }
  }
  return { connectors: connectorResult.dispatched, google, waiting, chronicle };
}

export function startProductAutomation(engine: BrainEngine): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runProductAutomationTick(engine);
    } catch (error) {
      console.error(`[product-automation] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), PRODUCT_AUTOMATION_CHECK_MS);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
