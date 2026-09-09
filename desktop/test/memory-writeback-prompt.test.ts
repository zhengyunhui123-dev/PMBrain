import {test,expect} from 'bun:test';
import {askWritebackOnce} from '../src/main/system/memory-writeback-prompt.js';

test('以后再说只标记，第二次和共享模式不弹；选择保存到 Core',async()=>{
  const state={mode:'off' as const,enabled:false,ttl:'3d',notice_shown:false,visibility:'world' as const,agents:[],issues:[]};
  let prompts=0;const saves:unknown[]=[];
  const opts={shared:false,read:async()=>state,save:async(value:any)=>{saves.push(value);state.notice_shown=true;},choose:async()=>{prompts++;return 3;}};
  await askWritebackOnce(opts);await askWritebackOnce(opts);
  expect(prompts).toBe(1);expect(saves).toEqual([{notice_shown:true}]);
  state.notice_shown=false;await askWritebackOnce({...opts,shared:true});expect(prompts).toBe(1);
  for(const [choice,mode] of ['off','salient','all'].entries()){
    state.notice_shown=false;await askWritebackOnce({...opts,choose:async()=>choice});expect(saves.at(-1)).toEqual({mode,notice_shown:true});
  }
});
