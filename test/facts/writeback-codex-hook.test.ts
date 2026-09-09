import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Codex SessionEnd 只捕获真实用户消息，路径丢失时按会话号找回', async () => {
  const root=mkdtempSync(join(tmpdir(),'pmbrain-codex-hook-'));
  const home=join(root,'brain');
  const codexHome=join(root,'codex');
  const day=join(codexHome,'sessions','2026','09','09');
  const sessionId='01a0841c-6125-7d10-98cd-b15f7db62dfb';
  const transcript=join(day,`rollout-test-${sessionId}.jsonl`);
  mkdirSync(day,{recursive:true});
  mkdirSync(home,{recursive:true});
  writeFileSync(join(home,'config.json'),JSON.stringify({engine:'pglite',memory:{auto_writeback:'all'}}));
  const rows=[
    {type:'session_meta',payload:{session_id:sessionId,cwd:'D:/project'}},
    {type:'event_msg',payload:{type:'user_message',message:'以后给项目复盘时先列结论，再列证据。'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<agents_md>quoted instructions</agents_md>'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['agents_md.instructions']}}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'PMBrain 的版本发布必须保留精确 SHA 验收。'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']}}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'谢谢'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']}}},
  ];
  writeFileSync(transcript,rows.map(row=>JSON.stringify(row)).join('\n'));
  const run=async(payload:object,detached=false)=>{
    const child=Bun.spawn([process.execPath,resolve('src/cli.ts'),'hook','session-end','--config-dir',home,'--source','work','--harness','codex',...(detached?['--detached']:[])],{stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe',env:{...process.env,PMBRAIN_HOME:root,CODEX_HOME:codexHome}});
    expect(await child.exited).toBe(0);
  };
  try {
    await run({session_id:sessionId,transcript_path:transcript,hook_event_name:'SessionEnd'});
    for(let attempt=0;attempt<100;attempt++){
      const count=existsSync(join(home,'writeback-corpus'))?readdirSync(join(home,'writeback-corpus')).filter(name=>name.endsWith('.txt')).length:0;
      if(count===2)break;
      await Bun.sleep(50);
    }
    expect(readdirSync(join(home,'writeback-corpus')).filter(name=>name.endsWith('.txt'))).toHaveLength(2);
    await run({session_id:sessionId,transcript_path:null,hook_event_name:'SessionEnd'},true);
    expect(readdirSync(join(home,'writeback-corpus')).filter(name=>name.endsWith('.txt'))).toHaveLength(2);
    const outside=join(root,'outside.jsonl');
    writeFileSync(outside,JSON.stringify(rows[1]));
    await run({session_id:'different-session',transcript_path:outside,hook_event_name:'SessionEnd'},true);
    expect(readdirSync(join(home,'writeback-corpus')).filter(name=>name.endsWith('.txt'))).toHaveLength(2);
    expect(existsSync(join(home,'brain.pglite'))).toBe(false);
  } finally { rmSync(root,{recursive:true,force:true}); }
},30000);
