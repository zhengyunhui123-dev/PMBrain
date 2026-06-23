import React, { useState } from 'react';

/** Console run status shared across Console, TakeProposals, and SystemDiagnostic pages. */
export interface ConsoleRun {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

/** Brain page chunk shared across Console and TakeProposals pages. */
export interface BrainPageChunk {
  id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
  token_count: number | null;
  embedded: boolean;
}

/** Format a date string or null into locale string. */
export function formatDate(value: string | null, fallback = '无记录'): string {
  if (!value) return fallback;
  return new Date(value).toLocaleString();
}

/** Run output panel shared across Console, TakeProposals, and SystemDiagnostic pages. */
export function RunOutput({ run }: { run: ConsoleRun }) {
  return (
    <div className="run-output">
      <div className="pm-kv"><span>状态</span><b className={`run-${run.status}`}>{run.status}</b></div>
      <div className="pm-kv"><span>命令</span><b>{run.command.join(' ')}</b></div>
      {run.error && <div className="pm-error-text">{run.error}</div>}
      {run.stdout && <pre>{run.stdout}</pre>}
      {run.stderr && <pre className="stderr">{run.stderr}</pre>}
    </div>
  );
}

/** Info icon with popover, shared across Console and RequestLog pages. */
export function InfoIcon({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-popover-wrap">
      <button className="info-icon" onClick={() => setOpen(value => !value)} aria-label={`${title}说明`}>?</button>
      {open && (
        <span className="info-popover">
          <b>{title}</b>
          <span>{children}</span>
        </span>
      )}
    </span>
  );
}
