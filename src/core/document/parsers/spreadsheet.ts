import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import * as XLSX from 'xlsx';
import { cleanCell } from '../normalize.ts';
import type { DocumentSection, StructuredDocument } from '../types.ts';

const MAX_REGION_ROWS = 200;
const MAX_REGION_CHARACTERS = 30_000;

interface RowWithIndex {
  values: string[];
  row: number;
}

function fillMergedCells(sheet: XLSX.WorkSheet, rows: unknown[][]): void {
  for (const merge of sheet['!merges'] ?? []) {
    const value = rows[merge.s.r]?.[merge.s.c];
    if (value == null || String(value).trim() === '') continue;
    for (let row = merge.s.r; row <= merge.e.r; row++) {
      rows[row] ??= [];
      for (let column = merge.s.c; column <= merge.e.c; column++) {
        rows[row][column] = value;
      }
    }
  }
}

function splitRegions(rows: unknown[][]): RowWithIndex[][] {
  const initial: RowWithIndex[][] = [];
  let current: RowWithIndex[] = [];
  const flush = () => {
    if (current.length) initial.push(current);
    current = [];
  };
  rows.forEach((row, index) => {
    const values = row.map(cleanCell);
    if (!values.some(Boolean)) flush();
    else current.push({ values, row: index + 1 });
  });
  flush();

  const regions: RowWithIndex[][] = [];
  for (const region of initial) {
    let chunk: RowWithIndex[] = [];
    let characters = 0;
    for (const row of region) {
      const size = row.values.join('|').length;
      if (chunk.length > 1 && (chunk.length >= MAX_REGION_ROWS || characters + size > MAX_REGION_CHARACTERS)) {
        regions.push(chunk);
        chunk = [];
        characters = 0;
      }
      chunk.push(row);
      characters += size;
    }
    if (chunk.length) regions.push(chunk);
  }
  return regions;
}

function regionRange(region: RowWithIndex[]): string {
  const width = Math.max(...region.map(row => row.values.length), 1);
  return `A${region[0].row}:${XLSX.utils.encode_col(width - 1)}${region.at(-1)!.row}`;
}

export function parseSpreadsheetDocument(filePath: string): StructuredDocument {
  // Use PMBrain's explicit filesystem boundary. XLSX.readFile relies on a
  // CommonJS require('fs') probe that disappears in the bundled Bun sidecar.
  const extension = extname(filePath).toLowerCase();
  const delimitedText = extension === '.csv' || extension === '.tsv';
  const workbook = XLSX.read(
    delimitedText ? readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '') : readFileSync(filePath),
    {
      type: delimitedText ? 'string' : 'buffer',
      cellDates: true,
      dense: false,
      ...(extension === '.tsv' ? { FS: '\t' } : {}),
    },
  );
  const sections: DocumentSection[] = [];
  let index = 0;
  let tableCount = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
    });
    fillMergedCells(sheet, rows);
    for (const region of splitRegions(rows)) {
      tableCount++;
      const width = Math.max(...region.map(row => row.values.length), 1);
      const normalized = region.map(row => {
        const values = row.values.slice(0, width);
        while (values.length < width) values.push('');
        return values;
      });
      const range = regionRange(region);
      sections.push({
        id: `xlsx-${++index}`,
        type: 'table',
        heading: `Sheet：${sheetName} · Table ${tableCount}`,
        table: { headers: normalized[0], rows: normalized.slice(1) },
        locator: { sheet: sheetName, table: tableCount, range, headingPath: [sheetName] },
      });
    }
  }

  return {
    title: basename(filePath, extname(filePath)),
    format: 'xlsx',
    sections,
    metadata: {
      parser: 'pmbrain-spreadsheet-v2',
      local: true,
      structured: true,
      sheetCount: workbook.SheetNames.length,
      tableCount,
      imageCount: 0,
      ocrUsed: false,
    },
  };
}
