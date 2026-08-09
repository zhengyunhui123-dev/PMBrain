import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SetupInfo } from '../config-manager.js';
import type { SidecarState } from '../sidecar-manager.js';
import type { UpdateState } from '../update-manager.js';

const SECRET_KEY = /(api.?key|token|password|secret|authorization|cookie|credential|database.?url)/i;
const MAX_LOG_BYTES = 512 * 1024;

export interface DiagnosticBundleInput {
  createdAt?: Date;
  desktopVersion: string;
  releaseManifest?: unknown;
  setup: SetupInfo;
  sidecarState: SidecarState | null;
  updateState: UpdateState | null;
  logPath?: string;
  doctor?: unknown;
  overview?: unknown;
  personalPaths?: string[];
}

export interface DiagnosticBundleResult {
  fileName: string;
  files: string[];
  data: Buffer;
}

function replacePersonalPaths(value: string, paths: string[]): string {
  return paths
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((text, path, index) => text.split(path).join(`<PATH_${index + 1}>`), value);
}

export function redactDiagnosticText(value: string, personalPaths: string[] = []): string {
  return replacePersonalPaths(value, personalPaths)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export function redactDiagnosticValue(value: unknown, personalPaths: string[] = []): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value, personalPaths);
  if (Array.isArray(value)) return value.map(item => redactDiagnosticValue(item, personalPaths));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactDiagnosticValue(item, personalPaths);
  }
  return output;
}

async function readLogTail(path?: string): Promise<string> {
  if (!path) return '';
  try {
    const data = await readFile(path);
    return data.subarray(Math.max(0, data.length - MAX_LOG_BYTES)).toString('utf8');
  } catch (error) {
    return `[log unavailable] ${error instanceof Error ? error.message : String(error)}`;
  }
}

function json(value: unknown, personalPaths: string[]): string {
  return `${JSON.stringify(redactDiagnosticValue(value, personalPaths), null, 2)}\n`;
}

export async function buildDiagnosticBundle(input: DiagnosticBundleInput): Promise<DiagnosticBundleResult> {
  const createdAt = input.createdAt ?? new Date();
  const personalPaths = [
    input.setup.configPath,
    input.setup.defaults.databasePath,
    input.setup.defaults.knowledgeDirectory,
    input.setup.current.databasePath ?? '',
    input.setup.current.knowledgeDirectory ?? '',
    ...(input.personalPaths ?? []),
  ];
  const rawLog = await readLogTail(input.logPath);
  const safeLog = redactDiagnosticText(rawLog, personalPaths);
  const sidecarLog = safeLog.split(/\r?\n/).filter(line => /\[(sidecar|health|runtime)\]/i.test(line)).join('\n');
  const recentErrors = safeLog.split(/\r?\n/).filter(line => /(error|failed|fatal|exception|timeout)/i.test(line)).slice(-200);
  const setupStatus = {
    needsSetup: input.setup.needsSetup,
    configPath: input.setup.configPath,
    engine: input.setup.current.engine,
    databasePath: input.setup.current.databasePath,
    databaseConfigured: input.setup.current.databaseConfigured,
    knowledgeDirectory: input.setup.current.knowledgeDirectory,
    knowledgeSourceId: input.setup.current.knowledgeSourceId,
    lastMigratedVersion: input.setup.current.lastMigratedVersion,
  };
  const modelStatus = {
    chatModel: input.setup.current.chatModel,
    embeddingModel: input.setup.current.embeddingModel,
    embeddingDimensions: input.setup.current.embeddingDimensions,
    generativeEnabled: input.setup.current.generativeEnabled,
    keyStatus: input.setup.current.keyStatus,
    overview: input.overview,
  };

  const zip = new JSZip();
  zip.file('version.json', json({ desktopVersion: input.desktopVersion, release: input.releaseManifest ?? null }, personalPaths));
  zip.file('doctor.json', json(input.doctor ?? { status: 'unavailable' }, personalPaths));
  zip.file('desktop.log', safeLog || '[empty]\n');
  zip.file('sidecar.log', sidecarLog || '[no sidecar log lines]\n');
  zip.file('database-status.json', json(setupStatus, personalPaths));
  zip.file('model-status.json', json(modelStatus, personalPaths));
  zip.file('mcp-status.json', json({ sidecar: input.sidecarState }, personalPaths));
  zip.file('update-status.json', json(input.updateState ?? { status: 'unavailable' }, personalPaths));
  zip.file('recent-errors.json', json({ rows: recentErrors }, personalPaths));
  zip.file('README.txt', 'PMBrain diagnostic bundle. Secrets and configured personal paths are redacted. No database or knowledge content is included.\n');
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const stamp = createdAt.toISOString().replace(/[-:]/g, '').slice(0, 15);
  return {
    fileName: `pmbrain-diagnostic-${stamp}.zip`,
    files: Object.keys(zip.files).sort(),
    data,
  };
}

export function diagnosticDisplayName(path: string): string {
  return basename(path);
}
