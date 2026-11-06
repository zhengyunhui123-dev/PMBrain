import type { BrainEngine } from '../../core/engine';
import type { TaskProductProgress } from '../../../shared/task-progress';

export class QuickVectorProgress {
  readonly startedAt=Date.now();
  private constructor(private rows:Map<string,{total:number;completed:number}>,readonly windowMs:number){}
  static async load(engine:BrainEngine,sourceId:string,slugs:string[],windowMs:number){
    const rows=await engine.executeRaw<{slug:string;total:number;completed:number}>(`SELECT p.slug,count(c.id)::int AS total,
      count(c.id) FILTER(WHERE c.embedding IS NOT NULL AND (c.embedded_text_hash IS NULL OR c.embedded_text_hash=md5(c.chunk_text)))::int AS completed
      FROM pages p LEFT JOIN content_chunks c ON c.page_id=p.id WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL GROUP BY p.id,p.slug`,[sourceId,slugs]);
    return new QuickVectorProgress(new Map(rows.map(row=>[row.slug,{total:Number(row.total),completed:Number(row.completed)}])),windowMs);
  }
  page(slug:string,completed:number){const row=this.rows.get(slug);if(row)row.completed=Math.max(row.completed,Math.min(row.total,completed));}
  complete(slug:string){const row=this.rows.get(slug);if(row)row.completed=row.total;}
  snapshot(windowEnded=false):NonNullable<TaskProductProgress['vectorTotals']>{
    const rows=[...this.rows.values()];
    return {total:rows.reduce((sum,row)=>sum+row.total,0),completed:rows.reduce((sum,row)=>sum+row.completed,0),pages:rows.length,
      completedPages:rows.filter(row=>row.completed>=row.total).length,windowMs:this.windowMs,windowElapsedMs:Math.min(this.windowMs,Date.now()-this.startedAt),windowEnded};
  }
}
