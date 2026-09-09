import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {lastUserText} from '../../src/commands/hook.ts';

test('真实 Stop 输入读取本轮用户消息，服务离线仍落银行且退出成功',async()=>{
  const home=mkdtempSync(join(tmpdir(),'pmbrain-hook-'));
  const transcript=join(home,'session.jsonl');
  const payload={session_id:'test-session',transcript_path:transcript,hook_event_name:'Stop',stop_hook_active:false};
  const run=async(input:object)=>{
    const child=Bun.spawn([process.execPath,resolve('src/cli.ts'),'hook','stop','--config-dir',home,'--source','work'],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe',env:{...process.env,PMBRAIN_HOME:home,GBRAIN_HOME:home}});
    const code=await child.exited;
    expect(code).toBe(0);
  };
  try {
    writeFileSync(join(home,'config.json'),JSON.stringify({engine:'pglite',memory:{auto_writeback:'salient'}}));
    writeFileSync(transcript,JSON.stringify({type:'user',sessionId:'test-session',message:{content:'以后所有项目评审都先给结论再给依据。'}})+'\n'+JSON.stringify({type:'user',sessionId:'test-session',message:{content:[{type:'tool_result',content:'SECRET TOOL'}]}}));
    expect(lastUserText(payload)).toBe('以后所有项目评审都先给结论再给依据。');
    await run(payload);
    expect(readdirSync(join(home,'writeback-corpus'))).toHaveLength(1);
    expect(readdirSync(join(home,'writeback-corpus'))[0]).toContain('.src-work.txt');
    await run(payload);
    expect(readdirSync(join(home,'writeback-corpus'))).toHaveLength(1);
    writeFileSync(transcript,JSON.stringify({type:'user',sessionId:'test-session',message:{content:'Thanks'}}));
    await run(payload);
    expect(readdirSync(join(home,'writeback-corpus'))).toHaveLength(1);
    expect(existsSync(join(home,'brain.pglite'))).toBe(false);
  }finally{rmSync(home,{recursive:true,force:true});}
},30000);
