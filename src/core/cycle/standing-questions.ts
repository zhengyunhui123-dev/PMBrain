import type { BrainEngine } from '../engine.ts';
import { chat, getChatModel, isAvailable } from '../ai/gateway.ts';

export interface StandingQuestionResult {
  phase: 'standing_questions';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

export type QuestionAnswerer = (question: string, evidence: string) => Promise<string>;

export function parseStandingQuestionLines(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length > 20 || lines.some(line => line.length > 200)) return null;
  return lines;
}

function enabled(raw: string | null): boolean {
  if (raw == null) return true;
  return !['false', '0', 'no', 'off', ''].includes(raw.trim().toLowerCase());
}

function questionsFromConfig(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item.length > 0 && item.length <= 200).slice(0, 20);
  } catch {
    return [];
  }
}

function likePattern(question: string): string {
  const core = question.trim().slice(0, 24).replace(/[\\%_]/g, '');
  return `%${core}%`;
}

async function positive(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const value = Number(await engine.getConfig(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function runPhaseStandingQuestions(
  engine: BrainEngine,
  opts: { dryRun?: boolean; sourceId?: string; answer?: QuestionAnswerer; signal?: AbortSignal } = {},
): Promise<StandingQuestionResult> {
  const started = Date.now();
  try {
    if (!enabled(await engine.getConfig('cycle.standing_questions.enabled'))) {
      return { phase: 'standing_questions', status: 'skipped', duration_ms: 0, summary: '固定问题已关闭', details: { reason: 'disabled' } };
    }
    const questions = questionsFromConfig(await engine.getConfig('cycle.standing_questions.questions'));
    const cooldown = Math.max(1, Math.floor(await positive(engine, 'cycle.standing_questions.cooldown_days', 1)));
    const maxPerCycle = Math.max(1, Math.floor(await positive(engine, 'cycle.standing_questions.max_per_cycle', 5)));
    const budget = await positive(engine, 'cycle.standing_questions.budget_usd', 1);
    if (!opts.dryRun) {
      await engine.executeRaw(
        `UPDATE pinned_questions
            SET state = 'inactive', updated_at = now()
          WHERE origin = 'config'
            AND state = 'active'
            AND ($1::text IS NULL OR source_id = $1)
            AND NOT (question = ANY($2::text[]))`,
        [opts.sourceId ?? null, questions],
      );
      const sources = opts.sourceId
        ? [opts.sourceId]
        : (await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE archived = false`)).map(row => row.id);
      for (const sourceId of sources) {
        for (const question of questions) {
          await engine.executeRaw(
            `INSERT INTO pinned_questions (source_id, question, state, origin, cooldown_days)
             VALUES ($1, $2, 'active', 'config', $3)
             ON CONFLICT (source_id, origin, question)
             DO UPDATE SET state = 'active', cooldown_days = EXCLUDED.cooldown_days, updated_at = now()`,
            [sourceId, question, cooldown],
          );
        }
      }
    }
    const active = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pinned_questions
        WHERE state = 'active' AND ($1::text IS NULL OR source_id = $1)`,
      [opts.sourceId ?? null],
    );
    if (active.length === 0) {
      return { phase: 'standing_questions', status: 'skipped', duration_ms: Date.now() - started, summary: '没有固定问题', details: { reason: 'no_pins' } };
    }
    const due = await engine.executeRaw<{ id: number; source_id: string; question: string; cooldown_days: number }>(
      `SELECT id, source_id, question, cooldown_days
         FROM pinned_questions
        WHERE state = 'active'
          AND ($1::text IS NULL OR source_id = $1)
          AND (last_refresh_at IS NULL OR last_refresh_at < now() - make_interval(days => cooldown_days))
          AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(days => cooldown_days))
        ORDER BY id
        LIMIT $2`,
      [opts.sourceId ?? null, maxPerCycle],
    );
    if (due.length === 0) {
      return { phase: 'standing_questions', status: 'ok', duration_ms: Date.now() - started, summary: '固定问题都还在冷却时间内', details: { reason: 'cooldown', pins: active.length } };
    }
    if (opts.dryRun) {
      return {
        phase: 'standing_questions',
        status: 'ok',
        duration_ms: Date.now() - started,
        summary: `有 ${due.length} 个固定问题可以刷新，试运行没有写入`,
        details: { reason: 'dry_run', due: due.length, pins: active.length },
      };
    }
    if (!opts.answer && !isAvailable('chat')) {
      return {
        phase: 'standing_questions',
        status: 'skipped',
        duration_ms: Date.now() - started,
        summary: '没有可用的对话模型，固定问题没有刷新',
        details: { reason: 'no_model', due: due.length },
      };
    }
    const answer = opts.answer ?? (async (question: string, evidence: string) => {
      const result = await chat({
        model: getChatModel(),
        system: '只根据给出的页面摘录回答问题。摘录里没有的内容要写明现有页面没有足够依据。不要编造。',
        messages: [{ role: 'user', content: `问题：${question}\n\n页面摘录：\n${evidence}` }],
        maxTokens: 500,
        disableReasoning: true,
      });
      return result.text;
    });
    let refreshed = 0;
    let failed = 0;
    let spent = 0;
    for (const pin of due) {
      opts.signal?.throwIfAborted();
      if (spent >= budget) break;
      const evidenceRows = await engine.executeRaw<{ slug: string; title: string; excerpt: string }>(
        `SELECT slug, title, left(compiled_truth, 400) AS excerpt
           FROM pages
          WHERE source_id = $1
            AND deleted_at IS NULL
            AND type NOT IN ('atom', 'concept')
            AND (title ILIKE $2 OR compiled_truth ILIKE $2)
          ORDER BY updated_at DESC
          LIMIT 5`,
        [pin.source_id, likePattern(pin.question)],
      );
      const evidence = evidenceRows.map(row => `${row.title}（${row.slug}）\n${row.excerpt}`).join('\n\n') || '没有找到相关页面';
      try {
        const text = (await answer(pin.question, evidence)).trim().slice(0, 4000);
        await engine.transaction(async tx => {
          await tx.executeRaw(`DELETE FROM question_evidence WHERE question_id = $1`, [pin.id]);
          for (const row of evidenceRows) {
            await tx.executeRaw(
              `INSERT INTO question_evidence (question_id, source_id, slug, title, excerpt) VALUES ($1, $2, $3, $4, $5)`,
              [pin.id, pin.source_id, row.slug, row.title, row.excerpt],
            );
          }
          await tx.executeRaw(
            `UPDATE pinned_questions
                SET answer = $2, answer_model = $3, last_refresh_at = now(), last_attempt_at = now(), last_error = NULL, updated_at = now()
              WHERE id = $1`,
            [pin.id, text, opts.answer ? 'injected' : 'configured'],
          );
        });
        refreshed += 1;
      } catch (error) {
        failed += 1;
        await engine.executeRaw(
          `UPDATE pinned_questions SET last_attempt_at = now(), last_error = $2, updated_at = now() WHERE id = $1`,
          [pin.id, error instanceof Error ? error.message : String(error)],
        );
      }
      spent += 0.05;
    }
    return {
      phase: 'standing_questions',
      status: failed > 0 ? 'warn' : 'ok',
      duration_ms: Date.now() - started,
      summary: `刷新了 ${refreshed} 个固定问题`,
      details: { reason: 'refreshed', refreshed, failed, spent_usd: spent, pins: active.length },
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) throw error;
    return {
      phase: 'standing_questions',
      status: 'warn',
      duration_ms: Date.now() - started,
      summary: '固定问题没有刷新',
      details: { reason: 'refresh_failed', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
