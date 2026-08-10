import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { normalizeDocumentText } from '../normalize.ts';
import type { DocumentFormat, StructuredDocument } from '../types.ts';
import { parseDocxDocument } from './docx.ts';
import { parsePptxDocument } from './pptx.ts';

function findOfficeCommand(): string | null {
  for (const name of ['soffice', 'libreoffice']) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const found = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).map(line => line.trim()).find(Boolean);
      if (found) return found;
    } catch { /* try next */ }
  }
  if (process.platform === 'win32') {
    for (const path of [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ]) {
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function convertedPath(filePath: string, outputDir: string, extension: 'docx' | 'pptx'): string {
  return join(outputDir, `${basename(filePath, extname(filePath))}.${extension}`);
}

function convertWithLibreOffice(filePath: string, outputDir: string, extension: 'docx' | 'pptx'): string | null {
  const command = findOfficeCommand();
  if (!command) return null;
  execFileSync(command, ['--headless', '--convert-to', extension, '--outdir', outputDir, filePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const output = convertedPath(filePath, outputDir, extension);
  return existsSync(output) ? output : null;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function extractViaOfficeCom(filePath: string, kind: 'word' | 'powerpoint'): string {
  const script = kind === 'word' ? String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:PMBRAIN_OFFICE_FILE
$app = $null
$document = $null
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  $app.DisplayAlerts = 0
  $document = $app.Documents.Open($path, $false, $true, $false)
  [Console]::Write($document.Content.Text)
} finally {
  if ($document -ne $null) { try { $document.Close($false) | Out-Null } catch {} }
  if ($app -ne $null) { try { $app.Quit() | Out-Null } catch {} }
}` : String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:PMBRAIN_OFFICE_FILE
$app = $null
$presentation = $null
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $app = New-Object -ComObject PowerPoint.Application
  $presentation = $app.Presentations.Open($path, $true, $true, $false)
  $sections = New-Object System.Collections.Generic.List[string]
  for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($shape in $presentation.Slides.Item($slideIndex).Shapes) {
      try {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
          $value = $shape.TextFrame.TextRange.Text.Trim()
          if ($value) { $lines.Add($value) }
        }
      } catch {}
    }
    if ($lines.Count -gt 0) { $sections.Add("Slide $slideIndex" + [Environment]::NewLine + ($lines -join [Environment]::NewLine)) }
  }
  [Console]::Write($sections -join ([Environment]::NewLine + [Environment]::NewLine))
} finally {
  if ($presentation -ne $null) { try { $presentation.Close() } catch {} }
  if ($app -ne $null) { try { $app.Quit() } catch {} }
}`;
  try {
    return normalizeDocumentText(execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script),
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PMBRAIN_OFFICE_FILE: filePath },
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Legacy ${kind} import requires LibreOffice or Microsoft Office on Windows: ${detail}`);
  }
}

function plainDocument(filePath: string, format: DocumentFormat, text: string, parser: string): StructuredDocument {
  return {
    title: basename(filePath, extname(filePath)),
    format,
    sections: [{ id: 'legacy-1', type: 'paragraph', text, locator: {} }],
    metadata: { parser, local: true, structured: false, tableCount: 0, imageCount: 0, ocrUsed: false },
  };
}

export async function parseLegacyWordDocument(filePath: string): Promise<StructuredDocument> {
  const temp = mkdtempSync(join(tmpdir(), 'pmbrain-word-'));
  try {
    const converted = convertWithLibreOffice(filePath, temp, 'docx');
    if (converted) {
      const document = await parseDocxDocument(converted);
      document.metadata.fallback = `legacy ${extname(filePath).slice(1)} converted locally to docx`;
      return document;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (process.platform === 'win32') return plainDocument(filePath, 'docx', extractViaOfficeCom(filePath, 'word'), 'windows-word-com');
  throw new Error('Legacy Word import requires LibreOffice, or Microsoft Word on Windows.');
}

export async function parseLegacyPresentationDocument(filePath: string): Promise<StructuredDocument> {
  const temp = mkdtempSync(join(tmpdir(), 'pmbrain-ppt-'));
  try {
    const converted = convertWithLibreOffice(filePath, temp, 'pptx');
    if (converted) {
      const document = await parsePptxDocument(converted);
      document.metadata.fallback = 'legacy ppt converted locally to pptx';
      return document;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (process.platform === 'win32') return plainDocument(filePath, 'pptx', extractViaOfficeCom(filePath, 'powerpoint'), 'windows-powerpoint-com');
  throw new Error('Legacy PowerPoint import requires LibreOffice, or Microsoft PowerPoint on Windows.');
}
