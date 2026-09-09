import type { BrainEngine } from '../engine.ts';

export interface ResolveCycleDateOpts {
  explicitDate?: string;
  now?: () => Date;
  systemTimeZone?: () => string | undefined;
  warn?: (message: string) => void;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function utcDate(instant = new Date()): string {
  return instant.toISOString().slice(0, 10);
}

function formatDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export async function resolveCycleDate(
  engine: Pick<BrainEngine, 'getConfig'>,
  opts: ResolveCycleDateOpts = {},
): Promise<string> {
  if (opts.explicitDate) return opts.explicitDate;
  const configured = (await engine.getConfig('cycle.timezone'))?.trim();
  const instant = opts.now?.() ?? new Date();
  const systemTimeZone = opts.systemTimeZone?.()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';

  if (configured) {
    try {
      return formatDateInTimeZone(instant, configured);
    } catch {
      const fallback = (() => {
        try {
          formatDateInTimeZone(instant, systemTimeZone);
          return systemTimeZone;
        } catch {
          return 'UTC';
        }
      })();
      (opts.warn ?? (message => process.stderr.write(`${message}\n`)))(
        `[dream] invalid cycle.timezone "${configured}"; using ${fallback}`,
      );
      return formatDateInTimeZone(instant, fallback);
    }
  }

  try {
    return formatDateInTimeZone(instant, systemTimeZone);
  } catch {
    return formatDateInTimeZone(instant, 'UTC');
  }
}
