import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setWritebackMode,stampWritebackNoticeShown,getWritebackStatus} from '../src/core/facts/writeback-set.ts';
import {runConfig} from '../src/commands/config.ts';
import {withEnv} from './helpers/with-env.ts';

test('设置与 CLI 共用双写，失败恢复，关闭清理且保留 TTL',async()=>{
  const home=mkdtempSync(join(tmpdir(),'pmbrain-wb-config-'));
  const dir=join(home,'.pmbrain');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'config.json'),JSON.stringify({engine:'pglite',memory:{auto_writeback:'off'}}));
  const db=new Map<string,string>();let fail=false;
  const engine={getConfig:async(k:string)=>db.get(k)??null,setConfig:async(k:string,v:string)=>{if(fail){fail=false;throw Error('DB down');}db.set(k,v);},unsetConfig:async(k:string)=>Number(db.delete(k))} as any;
  try{
    await withEnv({PMBRAIN_HOME:home,CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude')},async()=>{
      expect((await getWritebackStatus(engine)).enabled).toBe(false);
      await stampWritebackNoticeShown(engine);expect(db.has('memory.auto_writeback')).toBe(false);
      await setWritebackMode(engine,'salient',{ttl:'12h'});
      await setWritebackMode(engine,'all');expect(db.get('memory.auto_writeback_transient_ttl')).toBe('12h');
      fail=true;let failed=false;try{await setWritebackMode(engine,'salient');}catch{failed=true;}
      expect(failed).toBe(true);expect(db.get('memory.auto_writeback')).toBe('all');
      expect(JSON.parse(readFileSync(join(dir,'config.json'),'utf8')).memory.auto_writeback).toBe('all');
      await runConfig(engine,['set','memory.auto_writeback','off']);
      expect(db.get('memory.auto_writeback')).toBe('off');
      expect(JSON.parse(readFileSync(join(dir,'config.json'),'utf8')).memory.auto_writeback).toBe('off');
    });
  }finally{rmSync(home,{recursive:true,force:true});}
});
