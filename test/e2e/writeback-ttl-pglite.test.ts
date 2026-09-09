import {beforeAll,afterAll,test} from 'bun:test';
import {PGLiteEngine} from '../../src/core/pglite-engine.ts';
import {verifyWritebackTtl} from '../helpers/writeback-ttl-contract.ts';
const engine=new PGLiteEngine();
beforeAll(async()=>{await engine.connect({});await engine.initSchema();},60000);
afterAll(async()=>{await engine.disconnect();});
test('PGLite 临时事实到期不召回，历史与向量保留',async()=>{await verifyWritebackTtl(engine);},60000);
