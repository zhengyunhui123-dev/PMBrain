import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { parseMarkdownTable } from '../lib/markdown-table';
import { LoadingBlock } from './console-shared';
import { inlineSourceSegments, type SourceSegment } from '../../../src/product/workbench/artifact-quote';

interface DocsArticle {
  id: string;
  title: string;
  category: string;
  markdown: string;
}
function slugifyHeading(text: string, index: number): string {
  return `${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'}-${index}`;
}

function extractHeadings(markdown: string) {
  return markdown
    .split('\n')
    .map((line, index) => {
      const match = /^(#{1,3})\s+(.+)$/.exec(line);
      if (!match) return null;
      return { level: match[1].length, text: match[2].trim(), id: slugifyHeading(match[2].trim(), index) };
    })
    .filter(Boolean) as Array<{ level: number; text: string; id: string }>;
}

export interface MarkdownCitation {
  title: string;
  sourceId: string | null;
  slug: string;
  snippet: string;
}

export function inlineCitationIndex(token: string): number | null {
  const match = /^\[(\d+)\]$/.exec(token);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function CitationMark({ index, citation, segment }: { index: number; citation: MarkdownCitation; segment?: SourceSegment }) {
  const [card, setCard] = useState<{ top: number; left: number } | null>(null);
  const show = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const width = 280;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = rect.bottom + 8;
    const top = below + 168 > window.innerHeight ? Math.max(8, rect.top - 168) : below;
    setCard({ top, left });
  };
  const where = [citation.sourceId, citation.slug].filter(Boolean).join(' / ');
  const source = segment ? { 'data-source-start': segment.sourceStart, 'data-source-end': segment.sourceEnd, 'data-visible-start': segment.visibleStart, 'data-visible-end': segment.visibleEnd } : {};
  return <button
    type="button"
    className="wb-cite"
    aria-label={`参考 ${index}：${citation.title}`}
    {...source}
    onMouseEnter={event => show(event.currentTarget)}
    onMouseLeave={() => setCard(null)}
    onFocus={event => show(event.currentTarget)}
    onBlur={() => setCard(null)}
  >
    {index}
    {card && <span className="wb-cite-card" style={{ top: card.top, left: card.left }} role="tooltip">
      <b>{citation.title}</b>
      {where && <small>{where}</small>}
      {citation.snippet && <p>{citation.snippet}</p>}
    </span>}
  </button>;
}

function MappedInline({ text, citations, sourceBase }: { text: string; citations?: MarkdownCitation[]; sourceBase: number }) {
  const segments = inlineSourceSegments(text, sourceBase, citations?.length ?? 0);
  return <>{segments.map(segment => {
    if (!segment.text) return null;
    const source = { 'data-source-start': segment.sourceStart, 'data-source-end': segment.sourceEnd, 'data-visible-start': segment.visibleStart, 'data-visible-end': segment.visibleEnd };
    if (segment.kind === 'code') return <code key={segment.sourceStart} {...source}>{segment.text}</code>;
    if (segment.kind === 'bold') return <strong key={segment.sourceStart} {...source}>{segment.text}</strong>;
    if (segment.kind === 'citation') {
      const index = Number(segment.text);
      const citation = citations?.[index - 1];
      if (citation) return <CitationMark key={segment.sourceStart} index={index} citation={citation} segment={segment} />;
    }
    if (segment.kind === 'link' && segment.href) return <a key={segment.sourceStart} {...source} href={segment.href} target="_blank" rel="noreferrer">{segment.text}</a>;
    return <span key={segment.sourceStart} {...source}>{segment.text}</span>;
  })}</>;
}

function InlineMarkdown({ text, citations, sourceBase }: { text: string; citations?: MarkdownCitation[]; sourceBase?: number }) {
  if (sourceBase !== undefined) return <MappedInline text={text} citations={citations} sourceBase={sourceBase} />;
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[\d+\]|\[[^\]]+\]\(https?:\/\/[^)]+\))/g).filter(Boolean);
  return <>{parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${part}-${index}`}><InlineMarkdown text={part.slice(2, -2)} citations={citations} /></strong>;
    const citationIndex = inlineCitationIndex(part);
    const citation = citationIndex && citations ? citations[citationIndex - 1] : undefined;
    if (citation && citationIndex) return <CitationMark key={`${part}-${index}`} index={citationIndex} citation={citation} />;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (link) return <a key={`${link[2]}-${index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>;
  })}</>;
}

export function MarkdownArticle({ markdown, citations, sourceMap = false }: { markdown: string; citations?: MarkdownCitation[]; sourceMap?: boolean }) {
  const blocks: React.ReactNode[] = [];
  const lines = markdown.split('\n');
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) { starts.push(cursor); cursor += line.length + 1; }
  let list: Array<{ text: string; base?: number }> = [];
  let code: string[] = [];
  let inCode = false;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={`${item.text}-${index}`}><InlineMarkdown text={item.text} citations={citations} sourceBase={item.base} /></li>)}</ul>);
    list = [];
  };

  const flushCode = () => {
    if (code.length === 0) return;
    blocks.push(<pre key={`code-${blocks.length}`}>{code.join('\n')}</pre>);
    code = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const table = parseMarkdownTable(lines, index);
    if (table) {
      flushList();
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead><tr>{table.headers.map((cell, cellIndex) => <th key={`${cell}-${cellIndex}`}><InlineMarkdown text={cell} citations={citations} /></th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}><InlineMarkdown text={cell} citations={citations} /></td>)}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      index = table.endIndex - 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const id = slugifyHeading(heading[2].trim(), index);
      const level = heading[1].length;
      const title = sourceMap ? heading[2] : heading[2].trim();
      const base = sourceMap ? starts[index]! + (line.length - heading[2].length) : undefined;
      if (level === 1) blocks.push(<h1 id={id} key={id}><InlineMarkdown text={title} citations={citations} sourceBase={base} /></h1>);
      if (level === 2) blocks.push(<h2 id={id} key={id}><InlineMarkdown text={title} citations={citations} sourceBase={base} /></h2>);
      if (level === 3) blocks.push(<h3 id={id} key={id}><InlineMarkdown text={title} citations={citations} sourceBase={base} /></h3>);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      list.push({ text: bullet[1], ...(sourceMap ? { base: starts[index]! + (line.length - bullet[1].length) } : {}) });
      continue;
    }
    flushList();
    if (/^>{1}\s?/.test(line)) {
      const marker = /^>\s?/.exec(line)?.[0].length ?? 0;
      blocks.push(<blockquote key={`quote-${index}`}><InlineMarkdown text={line.slice(marker)} citations={citations} sourceBase={sourceMap ? starts[index]! + marker : undefined} /></blockquote>);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      continue;
    }
    if (line.trim()) blocks.push(<p key={`p-${index}`}><InlineMarkdown text={line} citations={citations} sourceBase={sourceMap ? starts[index] : undefined} /></p>);
  }
  flushList();
  flushCode();
  return <div className="docs-markdown">{blocks}</div>;
}

export function DocumentationPage() {
  const [articles, setArticles] = useState<DocsArticle[]>([]);
  const [selectedId, setSelectedId] = useState(() => sessionStorage.getItem('pmbrain.docs.article') || 'readme');
  const [error, setError] = useState('');

  useEffect(() => {
    api.docs()
      .then((data: any) => {
        const rows = Array.isArray(data.articles) ? data.articles as DocsArticle[] : [];
        setArticles(rows);
        if (rows.length > 0 && !rows.some(row => row.id === selectedId)) setSelectedId(rows[0].id);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    sessionStorage.setItem('pmbrain.docs.article', selectedId);
  }, [selectedId]);

  const selected = articles.find(article => article.id === selectedId) ?? articles[0] ?? null;
  const headings = useMemo(() => extractHeadings(selected?.markdown ?? ''), [selected?.markdown]);
  const groups = useMemo(() => {
    const map = new Map<string, DocsArticle[]>();
    articles.forEach(article => {
      map.set(article.category, [...(map.get(article.category) ?? []), article]);
    });
    return [...map.entries()];
  }, [articles]);

  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!selected) return <LoadingBlock text="正在读取 PMBrain 使用文档..." />;

  return (
    <div className="pm-page docs-page">
      <div className="docs-layout">
        <aside className="docs-index">
          <div className="docs-breadcrumb">文档</div>
          {groups.map(([category, rows]) => (
            <div className="docs-group" key={category}>
              <h2>{category}</h2>
              {rows.map(article => (
                <button
                  key={article.id}
                  className={article.id === selected.id ? 'active' : ''}
                  onClick={() => setSelectedId(article.id)}
                >
                  {article.title}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <article className="docs-content">
          <MarkdownArticle markdown={selected.markdown} />
        </article>
        <aside className="docs-toc">
          <h2>目录</h2>
          {headings.map(heading => (
            <button
              key={heading.id}
              className={`level-${heading.level}`}
              onClick={() => document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              {heading.text}
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
