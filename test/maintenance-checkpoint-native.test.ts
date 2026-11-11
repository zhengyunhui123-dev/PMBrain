import { expect, test } from 'bun:test';
import {maintenanceFailure} from '../src/product/tasks/maintenance-orchestration.ts';
import { resumeDeepOrganizeCheckpoint, retireAutomaticCapture, resumeMaintenanceCheckpoint } from '../src/product/tasks/checkpoint.ts';
import type { MaintenanceCheckpoint } from '../src/product/tasks/types.ts';
import type { PhaseResult } from '../src/core/cycle.ts';
import { parseTaskTimeout } from '../src/product/tasks/timeout.ts';

test('legacy capture failure is archived while native completed phases survive retry and serialization',()=>{
  const phase=(name:PhaseResult['phase'],status:PhaseResult['status']):PhaseResult=>({phase:name,status,summary:name,duration_ms:12,details:{}});
  const lint=phase('lint','warn'),sync=phase('sync','ok'),capture=phase('capture_entities','warn');
  const report={status:'partial',phases:[lint,sync,capture]};
  const checkpoint:MaintenanceCheckpoint={phases:{one:[lint,sync,capture]},reports:{one:report},captureRequests:{one:['notes/a']},captureWindows:{one:capture}};
  retireAutomaticCapture(checkpoint);resumeMaintenanceCheckpoint(checkpoint,true,true);
  expect(checkpoint.phases.one).toEqual([lint,sync]);
  expect(checkpoint.reports.one).toBeUndefined();
  expect(checkpoint.retiredCapture?.one.report).toEqual(report);
  expect(checkpoint.retiredCapture?.one.phases).toContainEqual(capture);
  expect(checkpoint.captureRequests?.one).toEqual(['notes/a']);
  expect(checkpoint.captureWindows?.one).toBeUndefined();
  const saved=JSON.parse(JSON.stringify(checkpoint));retireAutomaticCapture(saved);
  expect(saved).toEqual(checkpoint);
  saved.phases.one.push(phase('embed','fail'));resumeMaintenanceCheckpoint(saved,true,true);
  expect(saved.phases.one).toEqual([lint,sync]);
});

test('a finished deep organize reopens the earliest stage that still has pending knowledge',()=>{
  const sync:PhaseResult={phase:'sync',status:'ok',summary:'已同步',duration_ms:1,details:{}};
  const extract:PhaseResult={phase:'extract_atoms',status:'warn',summary:'引用无法核对',duration_ms:1,details:{pages_remaining:1,failures:[{error:'atom_evidence_unverified'}]}};
  const review:PhaseResult={phase:'orphans',status:'ok',summary:'完成',duration_ms:1,details:{}};
  const checkpoint:MaintenanceCheckpoint={
    phases:{default:[sync,extract,review]},reports:{default:{status:'partial'}},deepAtomPlans:{default:['notes/invalid-evidence']},
    deepProgress:{stage:'done',stages:[
      {id:'check',status:'completed',durationMs:1,result:'',detail:''},
      {id:'knowledge',status:'partial',durationMs:1,result:'',detail:''},
      {id:'review',status:'completed',durationMs:1,result:'',detail:''},
    ],scan:{scanned:1,unchanged:0,complete:true}},
  };
  resumeDeepOrganizeCheckpoint(checkpoint,Date.now());
  expect(checkpoint.deepProgress?.stage).toBe('knowledge');
  expect(checkpoint.deepProgress?.stages.map(stage=>stage.id)).toEqual(['check']);
  expect(checkpoint.phases.default).toEqual([sync]);
  expect(checkpoint.deepAtomPlans).toBeUndefined();
  expect(checkpoint.reports.default).toBeUndefined();
});

test('an interrupted deep organize keeps earlier pending knowledge closed',()=>{
  const extract:PhaseResult={phase:'extract_atoms',status:'warn',summary:'额度已用完',duration_ms:1,details:{pages_remaining:1218}};
  const checkpoint:MaintenanceCheckpoint={
    phases:{default:[extract]},reports:{},
    deepProgress:{stage:'review',stages:[{id:'knowledge',status:'partial',durationMs:1,result:'保留原回执',detail:''}],scan:{scanned:1,unchanged:0,complete:true},current:{elapsedMs:120_000,startedAt:new Date().toISOString()}},
  };
  resumeDeepOrganizeCheckpoint(checkpoint,Date.now());
  expect(checkpoint.deepProgress?.stage).toBe('review');
  expect(checkpoint.phases.default).toEqual([extract]);
});

test('task timeout rejects invalid and overflowing timer values',()=>{
  for(const value of [null,undefined,'',0,-1,1.5,NaN,Infinity,2147483648,'wrong'])expect(parseTaskTimeout(value)).toBeNull();
  expect(parseTaskTimeout('420000')).toBe(420000);
});

test('retry reopens a saved report with failed files and keeps completed source reports',()=>{
  const sync:PhaseResult={phase:'sync',status:'warn',summary:'一份资料未完成',duration_ms:1,details:{failedFiles:1}};
  const finished={status:'partial',phases:[]};
  const checkpoint:MaintenanceCheckpoint={phases:{one:[sync],done:[]},reports:{one:{status:'partial',phases:[sync]},done:finished}};
  resumeMaintenanceCheckpoint(checkpoint,false,true);
  expect(checkpoint.reports.one).toBeUndefined();
  expect(checkpoint.phases.one).toEqual([]);
  expect(checkpoint.reports.done).toBe(finished);
});

test('retry preserves informational warnings but reruns errors and incomplete stages',()=>{
  const lint:PhaseResult={phase:'lint',status:'warn',summary:'格式提示',duration_ms:1,details:{issues:1}};
  const sync:PhaseResult={phase:'sync',status:'ok',summary:'已同步',duration_ms:1,details:{}};
  for(const details of [{ner_error:'temporary error'},{by_mention_error:'temporary error'},{relation_backfill_error:'temporary error'},{pages_remaining:2}]){
    const extract:PhaseResult={phase:'extract',status:'warn',summary:'未完成',duration_ms:1,details};
    if(!('pages_remaining' in details))expect(maintenanceFailure({status:'partial',phases:[lint,sync,extract]})).toBe('实体摄入失败：temporary error');
    expect(maintenanceFailure({status:'failed',phases:[{phase:'extract_facts',status:'fail',error:{message:'new row for relation "facts" violates check constraint "facts_kind_check"'}}]})).toBe('提炼事实失败：new row for relation "facts" violates check constraint "facts_kind_check"');
    expect(maintenanceFailure({status:'partial',phases:[lint,sync]})).toBeNull();
    const checkpoint:MaintenanceCheckpoint={phases:{one:[lint,sync,extract]},reports:{one:{status:'partial'}}};
    resumeMaintenanceCheckpoint(checkpoint,true,true);
    expect(checkpoint.phases.one).toEqual([lint,sync]);
  }
});
