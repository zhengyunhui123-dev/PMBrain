import type { BrainEngine } from '../../core/engine.ts';

const keys = [
  'embedding_multimodal', 'embedding_multimodal_model', 'embedding_image_ocr', 'embedding_image_ocr_model',
  'ocr_enabled', 'ocr_model', 'embedding_columns', 'search_embedding_column',
  'content_sanity.bytes_warn', 'content_sanity.bytes_block', 'content_sanity.junk_patterns_enabled',
  'content_sanity.disabled', 'content_sanity.junk_disposition', 'content_sanity.max_markup_ratio',
  'content_sanity.prose_check_enabled', 'dream.synthesize.session_corpus_dir',
  'dream.synthesize.meeting_transcripts_dir', 'dream.synthesize.verdict_model',
  'dream.synthesize.max_prompt_tokens', 'dream.synthesize.max_chunks_per_transcript',
  'dream.patterns.lookback_days', 'dream.patterns.min_evidence',
];
const known = new Set(keys);

export async function loadQuickConfigSnapshot(engine:BrainEngine):Promise<BrainEngine> {
  let rows:Array<{key:string;value:string}>;
  try { rows=await engine.executeRaw('SELECT key,value FROM config WHERE key=ANY($1::text[])',[keys]); }
  catch { return engine; }
  const values=new Map(rows.map(row=>[row.key,row.value]));
  return new Proxy(engine,{
    get(target,property){
      if(property==='getConfig')return async(key:string)=>known.has(key)?values.get(key)??null:target.getConfig(key);
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
}
