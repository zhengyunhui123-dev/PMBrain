export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';

export type DocumentSectionType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'image'
  | 'slide';

export interface DocumentLocator {
  page?: number;
  slide?: number;
  sheet?: string;
  table?: number;
  range?: string;
  headingPath?: string[];
}

export interface DocumentTable {
  headers: string[];
  rows: string[][];
}

export interface DocumentSection {
  id: string;
  type: DocumentSectionType;
  heading?: string;
  level?: number;
  text?: string;
  table?: DocumentTable;
  locator?: DocumentLocator;
}

export interface DocumentMetadata {
  parser: string;
  local: true;
  structured: boolean;
  fallback?: string;
  pageCount?: number;
  slideCount?: number;
  sheetCount?: number;
  tableCount: number;
  imageCount: number;
  pagesNeedingOcr?: number[];
  ocrUsed: boolean;
  ocrProvider?: string;
}
export interface StructuredDocument {
  title: string;
  format: DocumentFormat;
  sections: DocumentSection[];
  metadata: DocumentMetadata;
}

export interface DocumentParseOptions {
  structured?: boolean;
  ocrPage?: (page: number, image: Buffer, mime: string) => Promise<string>;
}

export interface DocumentImportSummary {
  parser: string;
  structured: boolean;
  local: boolean;
  fallback?: string;
  sections: number;
  tables: number;
  images: number;
  pagesNeedingOcr: number;
  ocrUsed: boolean;
  ocrProvider?: string;
}
