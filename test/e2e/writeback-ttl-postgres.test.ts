import {beforeAll,afterAll,test} from 'bun:test';
import {hasDatabase,setupDB,teardownDB,getEngine} from './helpers.ts';
import {verifyWritebackTtl} from '../helpers/writeback-ttl-contract.ts';
const enabled=hasDatabase();
beforeAll(async()=>{if(enabled)await setupDB();},60000);
afterAll(async()=>{if(enabled)await teardownDB();});
(enabled?test:test.skip)('Postgres 临时事实到期不召回，历史与向量保留',async()=>{await verifyWritebackTtl(getEngine());},60000);
