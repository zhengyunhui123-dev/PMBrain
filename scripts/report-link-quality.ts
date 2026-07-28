/** Read-only relationship quality summary for Dream/RAG evaluation. */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';

const sourceArg = process.argv.indexOf('--source');
const sourceId = sourceArg >= 0 ? process.argv[sourceArg + 1] : undefined;
const config = loadConfig();
if (!config) throw new Error('No PMBrain configuration found.');

const engineConfig = toEngineConfig(config);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);

try {
  const params: unknown[] = [];
  const scope = sourceId
    ? (params.push(sourceId), `WHERE fp.source_id = $${params.length}`)
    : '';
  const totals = await engine.executeRaw<{
    total: number;
    cross_source: number;
    cross_source_qualified: number;
    missing_endpoint: number;
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE fp.source_id <> tp.source_id)::int AS cross_source,
            COUNT(*) FILTER (
              WHERE fp.source_id <> tp.source_id AND l.resolution_type = 'qualified'
            )::int AS cross_source_qualified,
            COUNT(*) FILTER (WHERE fp.id IS NULL OR tp.id IS NULL)::int AS missing_endpoint
       FROM links l
       LEFT JOIN pages fp ON fp.id = l.from_page_id
       LEFT JOIN pages tp ON tp.id = l.to_page_id
       ${scope}`,
    params,
  );
  const byType = await engine.executeRaw<{ link_type: string; count: number }>(
    `SELECT COALESCE(NULLIF(l.link_type, ''), '(untyped)') AS link_type,
            COUNT(*)::int AS count
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       ${scope}
      GROUP BY 1
      ORDER BY 2 DESC, 1`,
    params,
  );
  const crossSourceTargets = await engine.executeRaw<{ target_source_id: string; count: number }>(
    `SELECT tp.source_id AS target_source_id, COUNT(*)::int AS count
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
       ${scope}${scope ? ' AND' : ' WHERE'} fp.source_id <> tp.source_id
      GROUP BY tp.source_id
      ORDER BY count DESC, tp.source_id`,
    params,
  );
  console.log(JSON.stringify({
    source_id: sourceId ?? null,
    ...totals[0],
    cross_source_unqualified: (totals[0]?.cross_source ?? 0) - (totals[0]?.cross_source_qualified ?? 0),
    cross_source_targets: crossSourceTargets,
    by_type: byType,
  }, null, 2));
} finally {
  await engine.disconnect();
}
