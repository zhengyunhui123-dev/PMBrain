import type { BrainEngine, ChunkReadOpts, PageIdentity } from '../engine.ts';
import { currentMemoryPageSql } from './memory-projections.ts';
import { rowToChunk } from '../utils.ts';

export async function readPageIdentity(engine: Pick<BrainEngine, 'executeRaw'>, slug: string, opts?: { sourceId?: string; includeDeleted?: boolean }): Promise<PageIdentity | null> {
  const rows = await engine.executeRaw<PageIdentity>(`SELECT p.id,p.source_id,p.slug,p.content_hash,p.updated_at,p.deleted_at FROM pages p
    WHERE p.slug=$1 AND p.source_id=$2 ${opts?.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
    ${!opts?.includeDeleted && slug.startsWith('conversations/pmbrain/') ? `AND ${currentMemoryPageSql('p')}` : ''}`, [slug, opts?.sourceId ?? 'default']);
  const page = rows[0];
  return page ? { ...page, updated_at: new Date(page.updated_at), deleted_at: page.deleted_at ? new Date(page.deleted_at) : null } : null;
}

export async function readPageChunks(engine: Pick<BrainEngine, 'executeRaw'>, slug: string, opts?: ChunkReadOpts) {
  const params: unknown[] = [slug, opts?.sourceId ?? 'default'];
  const filter = ['p.slug=$1', 'p.source_id=$2'];
  if (opts?.afterChunkIndex !== undefined) {
    params.push(opts.afterChunkIndex);
    filter.push(`cc.chunk_index>$${params.length}`);
  }
  if (opts?.staleOnly) filter.push('(cc.embedding IS NULL OR cc.embedded_at IS NULL)');
  let limit = '';
  if (opts?.limit !== undefined || opts?.maxBytes !== undefined) {
    params.push(Math.max(1, Math.min(10000, Math.floor(opts?.limit ?? 100))));
    limit = `LIMIT $${params.length}`;
  }
  const columns = `cc.id,cc.page_id,cc.chunk_index,cc.chunk_text,cc.chunk_source,cc.model,cc.embedding_input_hash,cc.embedded_text_hash,
    cc.token_count,cc.embedded_at,cc.modality,cc.language,cc.symbol_name,cc.symbol_type,cc.start_line,cc.end_line,
    cc.parent_symbol_path,cc.doc_comment,cc.symbol_name_qualified,(cc.embedding IS NULL) AS embedding_is_null`;
  if (opts?.maxBytes === undefined) {
    const rows = await engine.executeRaw(`SELECT ${columns} FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE ${filter.join(' AND ')} ORDER BY cc.chunk_index ${limit}`, params);
    return rows.map(row => rowToChunk(row));
  }
  let budget = '';
  if (opts?.maxBytes !== undefined) {
    params.push(Math.max(1, Math.floor(opts.maxBytes)));
    budget = `WHERE selected.bytes<=$${params.length} OR selected.position=1`;
  }
  const rows = await engine.executeRaw(`WITH candidates AS (
    SELECT cc.id,cc.chunk_index,octet_length(cc.chunk_text) AS size FROM content_chunks cc
    JOIN pages p ON p.id=cc.page_id WHERE ${filter.join(' AND ')} ORDER BY cc.chunk_index ${limit}
  ), selected AS (
    SELECT id,SUM(size) OVER (ORDER BY chunk_index) AS bytes,ROW_NUMBER() OVER (ORDER BY chunk_index) AS position FROM candidates
  ) SELECT ${columns}
    FROM selected JOIN content_chunks cc ON cc.id=selected.id ${budget} ORDER BY cc.chunk_index`, params);
  return rows.map(row => rowToChunk(row));
}
