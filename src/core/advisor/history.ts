import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { gbrainPath } from '../config.ts';
import type { AdvisorReport } from './types.ts';

export const ADVISOR_HISTORY_MAX = 100;

export interface AdvisorRunSnapshot {
  ts: string;
  version: string;
  worst: AdvisorReport['worst'];
  finding_ids: string[];
}

export function advisorHistoryPath(): string {
  return gbrainPath('advisor-history.jsonl');
}

function readSnapshots(path: string): AdvisorRunSnapshot[] {
  if (!existsSync(path)) return [];
  const out: AdvisorRunSnapshot[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AdvisorRunSnapshot);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function appendAdvisorRun(
  report: AdvisorReport,
  opts: { path?: string } = {},
): AdvisorRunSnapshot | null {
  const path = opts.path ?? advisorHistoryPath();
  const prior = readSnapshots(path);
  const last = prior.length > 0 ? prior[prior.length - 1]! : null;
  const snap: AdvisorRunSnapshot = {
    ts: report.generated_at,
    version: report.version,
    worst: report.worst,
    finding_ids: report.findings.map((finding) => finding.id),
  };
  mkdirSync(dirname(path), { recursive: true });
  if (prior.length >= ADVISOR_HISTORY_MAX) {
    const keep = prior.slice(Math.floor(ADVISOR_HISTORY_MAX / 2));
    const tmp = path + '.tmp';
    writeFileSync(tmp, [...keep, snap].map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o644 });
    renameSync(tmp, path);
  } else {
    appendFileSync(path, JSON.stringify(snap) + '\n');
  }
  return last;
}

export function summarizeDeltas(prior: AdvisorRunSnapshot | null, current: AdvisorReport): string {
  if (!prior) return '';
  const before = new Set(prior.finding_ids);
  const now = new Set(current.findings.map((finding) => finding.id));
  const added = [...now].filter((id) => !before.has(id));
  const resolved = [...before].filter((id) => !now.has(id));
  if (added.length === 0 && resolved.length === 0) return '';
  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} new since last run`);
  if (resolved.length) parts.push(`${resolved.length} resolved`);
  return `(${parts.join(', ')})`;
}
