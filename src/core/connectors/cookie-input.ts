export function normalizeConnectorCookieInput(input: string | undefined): string {
  const pasted = input?.trim() ?? '';
  if (!pasted) return '';
  const lines = pasted.split(/\r?\n/);
  const cookieLine = lines.find((line) => /^\s*cookie\s*:/i.test(line));
  if (cookieLine) return cookieLine.replace(/^\s*cookie\s*:\s*/i, '').trim();
  if (/^\s*cookie\s*:/i.test(pasted)) return pasted.replace(/^\s*cookie\s*:\s*/i, '').trim();
  return pasted;
}
