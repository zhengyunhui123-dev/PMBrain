import { XMLParser } from 'fast-xml-parser';

export type OrderedXmlNode = Record<string, unknown>;

export const orderedXmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  processEntities: true,
  trimValues: false,
});

export const objectXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  processEntities: true,
  trimValues: false,
});

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function childElements(nodes: unknown, tag: string): unknown[][] {
  if (!Array.isArray(nodes)) return [];
  const out: unknown[][] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const value = (node as OrderedXmlNode)[tag];
    if (Array.isArray(value)) out.push(value);
  }
  return out;
}

export function descendants(nodes: unknown, tag: string): unknown[][] {
  if (!Array.isArray(nodes)) return [];
  const out: unknown[][] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node as OrderedXmlNode)) {
      if (key === ':@') continue;
      if (key === tag && Array.isArray(value)) out.push(value);
      if (Array.isArray(value)) out.push(...descendants(value, tag));
    }
  }
  return out;
}

export function attributes(nodes: unknown): Record<string, unknown> {
  if (!Array.isArray(nodes)) return {};
  for (const node of nodes) {
    if (node && typeof node === 'object' && ':@' in node) {
      return ((node as OrderedXmlNode)[':@'] ?? {}) as Record<string, unknown>;
    }
  }
  return {};
}

export function orderedText(nodes: unknown, hyperlinkTargets?: Map<string, string>): string {
  if (!Array.isArray(nodes)) return '';
  let out = '';
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as OrderedXmlNode;
    if (Array.isArray(record['w:hyperlink'])) {
      const attrs = attributes([node]);
      const text = orderedText(record['w:hyperlink']);
      const target = hyperlinkTargets?.get(String(attrs['r:id'] ?? ''));
      out += target && text ? `[${text}](${target})` : text;
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === ':@') continue;
      if (key === '#text') out += String(value ?? '');
      else if (key === 'w:tab') out += '\t';
      else if (key === 'w:br' || key === 'a:br') out += '\n';
      else if (key === 'w:t' || key === 'a:t') out += orderedText(value);
      else if (Array.isArray(value)) out += orderedText(value, hyperlinkTargets);
    }
  }
  return out;
}

export function firstDescendantAttributes(nodes: unknown, tag: string): Record<string, unknown> {
  if (!Array.isArray(nodes)) return {};
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as OrderedXmlNode;
    if (tag in record) return (record[':@'] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === ':@' || !Array.isArray(value)) continue;
      const found = firstDescendantAttributes(value, tag);
      if (Object.keys(found).length > 0) return found;
    }
  }
  return {};
}
