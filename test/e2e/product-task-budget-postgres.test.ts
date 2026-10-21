import {assertSafeE2eDatabaseUrl} from '../helpers/db-guard';
const url=process.env.DATABASE_URL??'';
assertSafeE2eDatabaseUrl(url);
process.env.PMBRAIN_BUDGET_TEST_POSTGRES='1';
await import('../task-budget.serial.test');
