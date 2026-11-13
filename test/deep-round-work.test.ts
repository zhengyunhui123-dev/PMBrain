import { expect, test } from 'bun:test';
import { mixRoundWork } from '../src/core/pmbrain-adapters/deep-round-work';
import { maintenanceFailure } from '../src/product/tasks/maintenance-orchestration';

test('先做新资料，给积压保留十份，空余额度可以互补', () => {
  const fresh = Array.from({ length: 65 }, (_, index) => `new-${index}`);
  const older = Array.from({ length: 60 }, (_, index) => `old-${index}`);
  const selected = mixRoundWork(fresh, older, 50);
  expect(selected).toHaveLength(50);
  expect(selected.slice(0, 5)).toEqual([...fresh.slice(0, 4), older[0]]);
  expect(selected.filter(value => value.startsWith('old-'))).toEqual(older.slice(0, 10));
  expect(mixRoundWork([], older, 50)).toEqual(older.slice(0, 50));
  expect(mixRoundWork(fresh, older.slice(0, 2), 50).filter(value => value.startsWith('new-'))).toHaveLength(48);
});

test('局部模型输出失败保留部分完成，数据库和模型故障仍报失败', () => {
  const details = { isolated_output_failures: true, stop_reason: 'ingest_validation', page_failures: [{ reason: '证据缺失' }] };
  const phase = { phase: 'capture_entities', status: 'warn', details };
  expect(maintenanceFailure({ status: 'partial', phases: [phase] })).toBeNull();
  expect(maintenanceFailure({ status: 'partial', phases: [{ ...phase, error: { message: '数据库不可用' } }] })).toContain('数据库不可用');
  expect(maintenanceFailure({ status: 'partial', phases: [{ ...phase, details: { ...details, isolated_output_failures: false } }] })).toBeNull();
  expect(maintenanceFailure({ status: 'partial', phases: [{ ...phase, details: { ...details, stop_reason: 'parse', page_failures: [{ reason: 'ingest invalid output' }] } }] })).toContain('ingest invalid output');
  expect(maintenanceFailure({ status: 'partial', phases: [{ phase: 'capture_entities', status: 'warn', error: { message: '具体错误：timeout exceeded' }, details: { stop_reason: 'failure', pages_processed: 2, pages_remaining: 1833, page_failures: [{ reason: 'timeout exceeded' }] } }] })).toBeNull();
  expect(maintenanceFailure({ status: 'partial', phases: [{ phase: 'capture_entities', status: 'warn', details: { stop_reason: 'timeout', pages_processed: 2, pages_remaining: 1833, page_failures: [{ reason: 'timeout exceeded' }] } }] })).toBeNull();
  expect(maintenanceFailure({ status: 'partial', phases: [{ phase: 'capture_entities', status: 'warn', details: { stop_reason: 'ingest_validation', pages_processed: 62, pages_remaining: 1779, page_failures: [{ reason: 'ingest invalid output: ingest ambiguous existing entity: default:projects/gbrain, default:projects/pmbrain' }] } }] })).toBeNull();
});

test('先前有成果不能掩盖后续数据库故障或网络故障', () => {
  for (const [reason, message] of [
    ['failure', 'column "missing_column" does not exist'],
    ['failure', 'connection terminated unexpectedly'],
    ['network', 'ingest_provider_network: socket disconnected'],
  ]) {
    const phase = { phase: 'capture_entities', status: 'warn', error: { message }, details: { stop_reason: reason, pages_processed: 1, pages_remaining: 2, page_failures: [{ reason: message }] } };
    expect(maintenanceFailure({ status: 'partial', phases: [phase] })).toContain(message);
  }
  const phase = { phase: 'capture_entities', status: 'warn', details: { stop_reason: 'failure', pages_processed: 1, page_failures: [{ reason: 'timeout exceeded' }, { reason: 'connection terminated unexpectedly' }] } };
  expect(maintenanceFailure({ status: 'partial', phases: [phase] })).not.toBeNull();
});
