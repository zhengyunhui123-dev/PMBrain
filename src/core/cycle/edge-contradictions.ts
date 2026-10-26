import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { chat, getChatModel, isAvailable } from '../ai/gateway.ts';

const STATE_TYPES = ['works_at', 'founded', 'advises', 'employed_by', 'member_of'];
const NON_EMPLOYER_TYPES = ['conversation', 'email', 'source', 'note', 'inbox'];

export interface EdgeContradictionResult {
  phase: 'edge_contradictions';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

export type EdgeJudge = (prompt: string) => Promise<string>;

interface EdgeRow {
  from_id: number;
  source_id: string;
  from_slug: string;
  from_title: string;
  from_type: string;
  link_type: string;
  to_id: number;
  to_slug: string;
  to_title: string;
  to_type: string;
}

function hash16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function nonEmployer(row: { to_type: string; to_slug: string }): boolean {
  return NON_EMPLOYER_TYPES.includes(row.to_type) || /^(conversations|emails|notes|inbox)\//.test(row.to_slug);
}

async function modeOf(engine: BrainEngine): Promise<'propose' | 'off' | 'apply'> {
  const raw = (await engine.getConfig('dream.edge_contradictions.mode'))?.trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'apply') return 'apply';
  return 'propose';
}

export async function runPhaseEdgeContradictions(
  engine: BrainEngine,
  opts: { dryRun?: boolean; sourceId?: string; judge?: EdgeJudge; signal?: AbortSignal } = {},
): Promise<EdgeContradictionResult> {
  const started = Date.now();
  try {
    const mode = await modeOf(engine);
    if (mode === 'off') {
      return { phase: 'edge_contradictions', status: 'skipped', duration_ms: 0, summary: '关系矛盾检查已关闭', details: { reason: 'disabled' } };
    }
    const budget = Number(await engine.getConfig('dream.edge_contradictions.budget_usd'));
    const maxUsd = Number.isFinite(budget) && budget > 0 ? budget : 1;
    const maxSubjectsRaw = Number(await engine.getConfig('dream.edge_contradictions.max_subjects'));
    const maxSubjects = Number.isFinite(maxSubjectsRaw) && maxSubjectsRaw >= 1 ? Math.floor(maxSubjectsRaw) : 200;
    const rows = await engine.executeRaw<EdgeRow>(
      `SELECT f.id AS from_id, f.source_id, f.slug AS from_slug, f.title AS from_title, f.type AS from_type,
              l.link_type, t.id AS to_id, t.slug AS to_slug, t.title AS to_title, t.type AS to_type
         FROM links l
         JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
         JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
        WHERE l.link_type = ANY($2::text[])
          AND ($1::text IS NULL OR f.source_id = $1)
          AND NOT (
            l.link_type = 'works_at' AND (
              f.type <> 'person' OR t.type = ANY($3::text[])
            )
          )
        ORDER BY f.id, l.link_type, t.id
        LIMIT 2000`,
      [opts.sourceId ?? null, STATE_TYPES, NON_EMPLOYER_TYPES],
    );
    const groups = new Map<string, EdgeRow[]>();
    for (const row of rows) {
      if (row.link_type === 'works_at' && (row.from_type !== 'person' || nonEmployer(row))) continue;
      const key = `${row.from_id}\u0000${row.link_type}`;
      const list = groups.get(key) ?? [];
      if (!list.some(item => item.to_id === row.to_id)) list.push(row);
      groups.set(key, list);
    }
    const subjects = [...groups.values()].filter(list => list.length >= 2).slice(0, maxSubjects);
    if (subjects.length === 0) {
      return {
        phase: 'edge_contradictions',
        status: 'skipped',
        duration_ms: Date.now() - started,
        summary: '没有发现互相冲突的关系',
        details: { reason: 'no_work', mode, apply_not_ported: mode === 'apply' },
      };
    }
    if (!opts.dryRun && !opts.judge && !isAvailable('chat')) {
      return {
        phase: 'edge_contradictions',
        status: 'skipped',
        duration_ms: Date.now() - started,
        summary: '没有可用的对话模型，关系矛盾只记录了待检查数量',
        details: { reason: 'no_model', candidates: subjects.length, mode },
      };
    }
    let proposed = 0;
    let spent = 0;
    let failed = 0;
    const judge = opts.judge ?? (async (prompt: string) => {
      const result = await chat({
        model: getChatModel(),
        system: '你只判断同一主体的两条已有关系哪一条更值得留下。不要改写页面。只返回 JSON：{"choice":"a"|"b"|"unclear","reason":"一句理由"}。',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        disableReasoning: true,
      });
      return result.text;
    });
    for (const group of subjects) {
      opts.signal?.throwIfAborted();
      if (spent >= maxUsd) break;
      const [first] = group;
      if (!first) continue;
      const targets = [...group].sort((left, right) => left.to_id - right.to_id);
      for (let index = 0; index < targets.length - 1 && index < 3; index += 1) {
        const a = targets[index];
        const b = targets[index + 1];
        if (!a || !b || spent >= maxUsd) break;
        const evidence = hash16(`${first.from_id}|${first.link_type}|${a.to_id}|${b.to_id}`);
        const existing = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM link_edge_proposals
            WHERE from_page_id = $1 AND a_to_page_id = $2 AND b_to_page_id = $3 AND link_type = $4 AND evidence_hash = $5
            LIMIT 1`,
          [first.from_id, a.to_id, b.to_id, first.link_type, evidence],
        );
        if (existing.length > 0) continue;
        if (opts.dryRun) {
          proposed += 1;
          continue;
        }
        let rationale = 'unclear';
        try {
          const text = await judge([
            `主体：${first.from_title}（${first.from_slug}，${first.from_type}）`,
            `关系：${first.link_type}`,
            `A：${a.to_title}（${a.to_slug}，${a.to_type}）`,
            `B：${b.to_title}（${b.to_slug}，${b.to_type}）`,
          ].join('\n'));
          rationale = text.trim().slice(0, 1000) || 'unclear';
        } catch (error) {
          failed += 1;
          rationale = error instanceof Error ? error.message : String(error);
        }
        spent += 0.02;
        await engine.executeRaw(
          `INSERT INTO link_edge_proposals
             (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status, rationale, model)
           VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8)
           ON CONFLICT (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash) DO NOTHING`,
          [first.source_id, first.from_id, a.to_id, b.to_id, first.link_type, evidence, rationale, opts.judge ? 'injected' : 'configured'],
        );
        proposed += 1;
      }
    }
    return {
      phase: 'edge_contradictions',
      status: failed > 0 ? 'warn' : 'ok',
      duration_ms: Date.now() - started,
      summary: opts.dryRun ? `发现 ${proposed} 组待确认关系，试运行没有写入` : `记下 ${proposed} 组待确认关系，没有改动页面或已有关系`,
      details: { reason: 'proposed', proposed, failed, spent_usd: spent, mode, apply_not_ported: true, dry_run: opts.dryRun === true },
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) throw error;
    return {
      phase: 'edge_contradictions',
      status: 'warn',
      duration_ms: Date.now() - started,
      summary: '关系矛盾检查没有完成，已有页面和关系保持不变',
      details: { reason: 'check_failed', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
