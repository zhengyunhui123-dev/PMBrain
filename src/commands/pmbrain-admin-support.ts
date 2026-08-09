import { readFile, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { isImageFilePath, isMarkdownFilePath, isOfficeFilePath } from '../core/sync.ts';

const ADMIN_README_CANDIDATES = [
  new URL('../../README.md', import.meta.url),
  new URL('../README.md', import.meta.url),
  new URL('./README.md', import.meta.url),
];

export const ADMIN_DOCS_EMPTY_MARKDOWN = '暂无';

export const ADMIN_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const ADMIN_DREAM_SCHEDULE_CHECK_MS = 30_000;
export const ADMIN_DREAM_SCHEDULE_ENABLED_KEY = 'dream.schedule.enabled';
export const ADMIN_DREAM_SCHEDULE_TIME_KEY = 'dream.schedule.time';
export const ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY = 'dream.schedule.last_started_date';

export type AdminUploadFileKind = 'markdown' | 'office' | 'image';

/**
 * Validate an untrusted browser-supplied basename without rewriting it.
 * The encoded header carries only a display basename; the server chooses the
 * parent directory, so a rejected name can never redirect the upload.
 */
export function normalizeAdminUploadFilename(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Upload filename is required');
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).normalize('NFC');
  } catch {
    throw new Error('Upload filename is invalid');
  }
  if (!decoded || decoded.length > 180 || decoded.trim() !== decoded) {
    throw new Error('Upload filename is invalid');
  }
  if (decoded === '.' || decoded === '..' || decoded.startsWith('.') || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(decoded)) {
    throw new Error('Upload filename is invalid');
  }
  if (/[. ]$/.test(decoded)) throw new Error('Upload filename is invalid');
  const stem = decoded.split('.')[0]!.toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error('Upload filename is reserved');
  }
  return decoded;
}

export function classifyAdminUploadFilename(fileName: string): AdminUploadFileKind {
  const lower = fileName.toLowerCase();
  if (isMarkdownFilePath(fileName)) return 'markdown';
  if (isOfficeFilePath(lower)) return 'office';
  if (isImageFilePath(lower)) return 'image';
  throw new Error(`Unsupported file type: ${extname(fileName).toLowerCase() || '(none)'}`);
}

export function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function queryFlag(value: unknown, fallback: boolean): boolean {
  const raw = firstQueryValue(value)?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error('Upload option must be true or false');
}

export async function removeAdminUploadTempDir(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (e) {
    console.error('[admin-upload] Temporary-file cleanup failed:', e instanceof Error ? e.message : e);
  }
}

export async function loadAdminReadmeMarkdown(
  candidates: URL[] = ADMIN_README_CANDIDATES,
): Promise<{ markdown: string; source: 'file' | 'missing'; path?: string }> {
  for (const candidate of candidates) {
    try {
      return {
        markdown: await readFile(candidate, 'utf8'),
        source: 'file',
        path: candidate.toString(),
      };
    } catch {
      // Packaged desktop runtimes may not include repository README.md.
    }
  }
  return { markdown: ADMIN_DOCS_EMPTY_MARKDOWN, source: 'missing' };
}

