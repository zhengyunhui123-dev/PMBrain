import type { AdvisorFinding, AdvisorReport, AdvisorSeverity } from './types.ts';

const BAR = '='.repeat(72);
const SEV_LABEL: Record<AdvisorSeverity, string> = { critical: 'CRITICAL', warn: 'WARN', info: 'INFO' };

function fixLine(f: AdvisorFinding): string | null {
  if (!f.fix.command_argv || f.fix.command_argv.length === 0) return null;
  return f.fix.command_argv.join(' ');
}

export function renderAdvisorReport(report: AdvisorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(BAR);
  lines.push(`pmbrain advisor - ${report.findings.length} thing${report.findings.length === 1 ? '' : 's'} worth attention (pmbrain ${report.version})`);
  lines.push(BAR);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('Nothing pressing - this brain looks healthy. Re-run `pmbrain advisor` any time.');
    lines.push(BAR);
    lines.push('');
    return lines.join('\n');
  }
  for (const f of report.findings) {
    lines.push(`[${SEV_LABEL[f.severity]}] ${f.title}`);
    if (f.detail) for (const wl of wrap(f.detail, 68, '    ')) lines.push(wl);
    const fl = fixLine(f);
    if (fl) lines.push(`    fix: ${fl}`);
    lines.push('');
  }
  lines.push('ACTION FOR THE AGENT:');
  lines.push('  1. Show this list to the user, highest-severity first.');
  lines.push('  2. Ask before running any fix. The user owns these decisions.');
  lines.push('');
  lines.push(BAR);
  lines.push('');
  return lines.join('\n');
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    const next = current === indent ? indent + word : current + ' ' + word;
    if (next.length > width + indent.length) {
      lines.push(current.trimEnd());
      current = indent + word;
    } else {
      current = next;
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines;
}
