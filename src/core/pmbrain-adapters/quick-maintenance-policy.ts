import type { BrainEngine } from '../engine.ts';
import { buildGazetteer, type Gazetteer } from '../by-mention.ts';
import { readMentionPolicy } from '../mentions/policy.ts';

export const QUICK_MAINTENANCE_EXCLUDED_PATH = '((^|/)([.]pmbrain|[.]gbrain|[.]git|node_modules|backups?|备份)(/|$))|(^output/(agent-notes|wiki-compile|wiki-health|qa)(/|$))|([.](bak|backup)([.]|$))';

export async function buildQuickMaintenanceGazetteer(engine: BrainEngine): Promise<Gazetteer> {
  const policy = await readMentionPolicy(engine);
  const extended = { ...policy, typeAdds: [...new Set([...policy.typeAdds, 'project'])] };
  const gazetteer = await buildGazetteer(engine, { policy: extended, strict: true });
  const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
    `SELECT slug, source_id FROM pages WHERE deleted_at IS NULL AND type = ANY($1::text[])
      AND slug !~* $2 AND replace(COALESCE(source_path, ''), chr(92), '/') !~* $2`,
    [['person', 'company', 'organization', 'project'], QUICK_MAINTENANCE_EXCLUDED_PATH],
  );
  const allowed = new Set(rows.map(row => `${row.source_id}\0${row.slug}`));
  return new Map([...gazetteer].flatMap(([key, entries]) => {
    const retained = entries.filter(entry => allowed.has(`${entry.source_id}\0${entry.slug}`));
    return retained.length ? [[key, retained] as const] : [];
  }));
}
