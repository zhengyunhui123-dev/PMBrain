import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import { createHash } from 'node:crypto';

export function taskModelFingerprint(): string {
  const config = loadConfig();
  const fields = Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => /model|embedding|ocr|rerank|expansion|provider|api_key/.test(key) || key === 'chat_fallback_chain'));
  return createHash('sha256').update(JSON.stringify([fields, (config?.desktop as Record<string, unknown> | undefined)?.model_services])).digest('hex');
}

function checkpointPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid task checkpoint');
  const config = loadConfig();
  const brain = createHash('sha256').update(JSON.stringify([config?.engine, config?.database_path, config?.database_url])).digest('hex').slice(0, 24);
  return join(gbrainPath('task-artifacts'), `${brain}-job-${id}.jsonl`);
}

export async function appendTaskCheckpoint(id: number, file: Record<string, unknown>): Promise<void> {
  await mkdir(gbrainPath('task-artifacts'), { recursive: true });
  await appendFile(checkpointPath(id), `${JSON.stringify(file)}\n`, { mode: 0o600 });
}

export async function readTaskCheckpoint(id: number): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(checkpointPath(id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
