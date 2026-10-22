export type ModelVisionCapability = 'supported' | 'unsupported' | 'unknown';

export function modelVisionCapability(model: string, baseUrl?: string, capabilities: readonly string[] = [], vision?: boolean): ModelVisionCapability {
  let host = '';
  try { host = new URL(baseUrl ?? '').hostname.toLowerCase(); } catch {}
  if (['api.siliconflow.cn', 'api.siliconflow.com'].includes(host)) {
    if (/^deepseek-ai\/DeepSeek-V4-(?:Flash|Pro)$/i.test(model)) return 'unsupported';
    if (/^deepseek-ai\/DeepSeek-V4\.1-Flash$/i.test(model)) return 'supported';
  }
  if (vision === false) return 'unsupported';
  return vision === true || capabilities.includes('vision') ? 'supported' : 'unknown';
}
