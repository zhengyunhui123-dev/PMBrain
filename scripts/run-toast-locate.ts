import { diagnosePgliteToast } from '../src/core/pglite-toast-repair.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const staging = 'D:\\backups\\.toast-forensic-20260908T214800Z\\diagnose-live\\brain.pglite';

const report = await diagnosePgliteToast({
  stagingPath: staging,
  productionPath: production,
  forensicWalReset: false,
});

console.log(JSON.stringify({
  status: report.status,
  table: report.baseTable,
  column: report.column,
  row: report.row,
  toast: report.toast,
  repairability: report.repairability,
  recommendedAction: report.recommendedAction,
  chunks: report.toastChunks,
  error: report.error,
  steps: report.steps,
}, null, 2));
