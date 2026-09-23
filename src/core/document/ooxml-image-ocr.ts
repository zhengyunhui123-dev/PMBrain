import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import JSZip from 'jszip';
import type { DocumentParseOptions, StructuredDocument } from './types.ts';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

export async function appendOoxmlImageOcr(
  filePath: string,
  document: StructuredDocument,
  opts: DocumentParseOptions,
): Promise<StructuredDocument> {
  if (!opts.ocrPage) return document;
  const prefix = document.format === 'docx' ? 'word/media/' : document.format === 'pptx' ? 'ppt/media/' : 'xl/media/';
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const media = Object.keys(zip.files)
    .filter(name => !zip.files[name].dir && name.startsWith(prefix) && MIME_BY_EXTENSION[extname(name).toLowerCase()])
    .sort();
  if (media.length === 0) return document;

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const warnings: string[] = [];
  let model: string | undefined;
  for (const [index, name] of media.entries()) {
    const entry = zip.file(name);
    if (!entry) continue;
    const result = await opts.ocrPage(index + 1, Buffer.from(await entry.async('uint8array')), MIME_BY_EXTENSION[extname(name).toLowerCase()]);
    model ??= result.model ?? undefined;
    if (result.status === 'success') {
      attempted++;
      succeeded++;
      document.sections.push({
        id: `${document.format}-ocr-${index + 1}`,
        type: 'image',
        heading: `图片文字 ${index + 1}`,
        text: result.text,
        locator: {},
      });
    } else if (result.status === 'failed') {
      attempted++;
      failed++;
      warnings.push(`${name}: ${result.message ?? '图片识别失败'}`);
    } else {
      skipped++;
      if (result.message) warnings.push(`${name}: ${result.message}`);
    }
  }
  document.metadata.imageCount = Math.max(document.metadata.imageCount, media.length);
  document.metadata.ocrUsed = succeeded > 0;
  document.metadata.ocrProvider = model;
  document.metadata.ocrAttempted = attempted;
  document.metadata.ocrSucceeded = succeeded;
  document.metadata.ocrFailed = failed;
  document.metadata.ocrSkipped = skipped;
  document.metadata.ocrWarnings = warnings;
  return document;
}
