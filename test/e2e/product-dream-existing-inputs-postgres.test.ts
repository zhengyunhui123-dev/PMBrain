import {assertSafeE2eDatabaseUrl} from '../helpers/db-guard';

const database=process.env.DATABASE_URL;
if(!database)throw new Error('Postgres 验收需要隔离测试数据库');
assertSafeE2eDatabaseUrl(database);
process.env.PMBRAIN_DREAM_TEST_POSTGRES='1';
await import('../product-dream-existing-inputs.serial.test');
