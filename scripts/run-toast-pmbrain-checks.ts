import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const repair = 'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-3\\brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: repair });
await engine.initSchema();

const wiki = await engine.getPage('wiki/skills/_brain-filing-rules');
const novel = await engine.getPage('youdao/刘慈欣作品全集v1.0/1长篇科幻小说/06三体');
const sources = await engine.executeRaw('SELECT id, name FROM sources ORDER BY id');
const search = await engine.searchKeyword('三体', { limit: 5 });
let recall: unknown = null;
try {
  recall = await engine.executeRaw(
    `SELECT id, entity_slug, kind FROM facts WHERE expired_at IS NULL LIMIT 5`,
  );
} catch (error) {
  recall = error instanceof Error ? error.message : String(error);
}
const schema = await engine.executeRaw(`SELECT value FROM config WHERE key = 'schema_version'`);
const gin = await engine.executeRaw(`
  SELECT c.relname
  FROM pg_class c
  JOIN pg_am am ON am.oid = c.relam
  WHERE am.amname = 'gin' AND c.relkind = 'i'
  ORDER BY 1
`);

console.log(JSON.stringify({
  wikiTitle: wiki?.title ?? null,
  wikiLen: wiki?.compiled_truth?.length ?? 0,
  novelTitle: novel?.title ?? null,
  novelLen: novel?.compiled_truth?.length ?? 0,
  sources,
  search: search.map(row => ({ slug: row.slug, title: (row as { title?: string }).title })),
  recall,
  schema,
  gin,
}, null, 2));

await engine.disconnect();
