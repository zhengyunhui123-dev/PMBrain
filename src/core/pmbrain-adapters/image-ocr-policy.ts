import type { BrainEngine } from '../engine.ts';

export const IMAGE_OCR_ENABLED_KEY = 'dream.image_ocr.enabled';
export const IMAGE_OCR_MAX_IMAGES_KEY = 'dream.image_ocr.max_images';
export const IMAGE_OCR_COST_CAP_KEY = 'dream.image_ocr.cost_cap_cny';
export const DEFAULT_IMAGE_OCR_MAX_IMAGES = 20;
export const DEFAULT_IMAGE_OCR_COST_CAP_CNY = 2;
export const IMAGE_BACKLOG_REASON = '图片任务已移出深度整理主队列。文本资料继续整理；需要识图时请在设置里单独开启图片识别。';
const DOCUMENT_OCR_TASK = 'pmbrain-document-ocr';

export function imageOcrSwitchOn(value: string | null | undefined): boolean {
  return value === 'true';
}

export function parseImageOcrMaxImages(value: unknown): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 10_000 ? number : DEFAULT_IMAGE_OCR_MAX_IMAGES;
}

export function parseImageOcrCostCap(value: unknown): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 && number <= 10_000 ? number : DEFAULT_IMAGE_OCR_COST_CAP_CNY;
}

export async function imageOcrAdmission(engine: BrainEngine, image: boolean | undefined): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (image !== true) return { ok: true };
  if (!imageOcrSwitchOn(await engine.getConfig(IMAGE_OCR_ENABLED_KEY))) return { ok: false, reason: '图片识别未开启' };
  const maxImages = parseImageOcrMaxImages(await engine.getConfig(IMAGE_OCR_MAX_IMAGES_KEY));
  const costCap = parseImageOcrCostCap(await engine.getConfig(IMAGE_OCR_COST_CAP_KEY));
  const [row] = await engine.executeRaw<{ count: string; spent: string }>(`SELECT count(*) FILTER (WHERE status NOT IN ('completed','failed','dead','cancelled'))::text AS count,
    COALESCE(sum(CASE WHEN result ? 'costCny' THEN (result->>'costCny')::numeric ELSE 0 END),0)::text AS spent
    FROM minion_jobs WHERE name=$1 AND COALESCE(data->'task'->'input'->'ocrOnly'->>'image','')='true'`, [DOCUMENT_OCR_TASK]);
  if (Number(row?.count ?? 0) >= maxImages) return { ok: false, reason: `图片识别已达到 ${maxImages} 张上限` };
  if (Number(row?.spent ?? 0) >= costCap) return { ok: false, reason: `图片识别已达到费用上限 ¥${costCap}` };
  return { ok: true };
}
