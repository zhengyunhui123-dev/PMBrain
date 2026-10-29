import { expect,test } from 'bun:test';
import { TaskProgressAdapter,finishTaskProgress } from '../src/product/tasks/progress-adapter.ts';
import { resumeMaintenanceCheckpoint } from '../src/product/tasks/checkpoint.ts';
import { taskStatus } from '../admin/src/product/task-presentation.ts';

test('pending native atom and concept work remains visible and retry clears the first unfinished phase',()=>{
  const adapter=new TaskProgressAdapter('dream_full');adapter.plan(['sync','extract_atoms','synthesize_concepts','embed']);
  const phases=[{phase:'sync',status:'ok',summary:'synced',details:{}},{phase:'extract_atoms',status:'warn',summary:'budget',details:{atoms_extracted:2,pages_remaining:3}},{phase:'synthesize_concepts',status:'warn',summary:'budget',details:{concepts_remaining:1}},{phase:'embed',status:'warn',summary:'budget',details:{remainingChunks:8,budgetExceeded:true}}];
  const result={status:'partial',phases};
  const view=finishTaskProgress(adapter.view,'completed',result,null);
  expect(view.steps.find(s=>s.id==='extract_atoms')?.status).toBe('pending');
  expect(view.steps.find(s=>s.id==='embed')?.status).toBe('pending');
  expect(view.metrics).toContainEqual({label:'剩余向量分块',value:8});
  const checkpoint={phases:{default:phases.map(p=>({...p,duration_ms:1}))},reports:{default:result}} as any;
  resumeMaintenanceCheckpoint(checkpoint,true,true);
  expect(checkpoint.phases.default.map((p:any)=>p.phase)).toEqual(['sync']);
});

test('deep maintenance with no ready AI phase says that AI work did not execute',()=>{
  const adapter=new TaskProgressAdapter('dream_full');adapter.plan(['synthesize','extract_atoms','synthesize_concepts','embed']);
  const view=finishTaskProgress(adapter.view,'completed',{status:'clean',phases:[
    {phase:'synthesize',status:'skipped',summary:'unset',details:{reason:'not_configured'}},
    {phase:'extract_atoms',status:'skipped',summary:'pack',details:{reason:'not_in_active_pack'}},
    {phase:'synthesize_concepts',status:'skipped',summary:'pack',details:{reason:'not_in_active_pack'}},
    {phase:'embed',status:'ok',summary:'indexed',details:{embedded:2}},
  ]},null);
  expect(view.stage).toContain('AI 提炼未执行');
  expect((view.steps.find(s=>s.id==='synthesize') as any)?.detail).toContain('未配置');
});

test('partially failed knowledge extraction reports failed documents and a partial task status',()=>{
  const adapter=new TaskProgressAdapter('dream_full');adapter.plan(['extract_atoms']);
  const result={status:'partial',phases:[{phase:'extract_atoms',status:'warn',details:{pages_processed:38,pages_remaining:12,failures:[{source:'notes/a',error:'atom_evidence_unverified'},{source:'notes/b',error:'atoms_schema_failed'}]}}]};
  const product=finishTaskProgress(adapter.view,'completed',result,null);
  expect(product.metrics).toContainEqual({label:'提炼失败资料',value:2});
  expect(product.steps.find(step=>step.id==='extract_atoms')?.detail).toContain('失败 2');
  expect(taskStatus({id:'task-1',kind:'dream_full',status:'completed',result,product} as any)).toBe('部分完成');
});

test('previously held failures remain visible when no new model call is made',()=>{
  const adapter=new TaskProgressAdapter('dream_full');adapter.plan(['extract_atoms']);
  const result={status:'partial',phases:[{phase:'extract_atoms',status:'warn',details:{pages_processed:0,pages_remaining:3,pages_held:3,failures:[]}}]};
  const product=finishTaskProgress(adapter.view,'completed',result,null);
  expect(product.metrics).toContainEqual({label:'异常步骤',value:1});
  expect(product.metrics).toContainEqual({label:'待处理失败资料',value:3});
  expect(product.failedUnits).toBe(3);
  expect(product.steps.find(step=>step.id==='extract_atoms')?.detail).toContain('3 份资料');
});
