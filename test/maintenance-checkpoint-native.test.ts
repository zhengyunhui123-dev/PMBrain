import { expect, test } from 'bun:test';
import { retireAutomaticCapture, resumeMaintenanceCheckpoint } from '../src/product/tasks/checkpoint.ts';
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

test('task timeout rejects invalid and overflowing timer values',()=>{
  for(const value of [null,undefined,'',0,-1,1.5,NaN,Infinity,2147483648,'wrong'])expect(parseTaskTimeout(value)).toBeNull();
  expect(parseTaskTimeout('420000')).toBe(420000);
});
