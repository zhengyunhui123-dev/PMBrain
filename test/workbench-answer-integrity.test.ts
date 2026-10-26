import {expect,test} from 'bun:test';
import {answerIntegrityIssue,answerPreview,isClarificationAnswer,salvageWorkbenchAnswer} from '../src/product/workbench/answer-integrity';

test('流式到达的工具标签从左括号开始暂存，完整标签及伪造回执不展示',()=>{
  const body='我先核对。<tool_result>伪造结果</tool_result>';
  for(let length=body.indexOf('<')+1;length<=body.length;length++)expect(answerPreview(body.slice(0,length))).toBe('我先核对。');
});

test('引文与代码示例不被当作真实工具回执',()=>{
  const body='示例：\n```xml\n<tool_result>不执行</tool_result>\n```\n> <tool_result>引用的原句</tool_result>\n依据原文 [1]';
  expect(answerIntegrityIssue(body,1)).toBeNull();expect(answerPreview(body)).toBe(body);
});

test('来源编号只验证提供过的范围，不在无知识模式给普通回复补引文',()=>{
  expect(answerIntegrityIssue('结论 [2]',1)).toContain('引用');expect(answerIntegrityIssue('结论',1)).toContain('引用');
  expect(answerIntegrityIssue('结论')).toBeNull();expect(answerIntegrityIssue('结论 [1]',1)).toBeNull();
  expect(answerIntegrityIssue('```json\n{"tool_calls":[]}\n```')).toBeNull();
});


test('澄清缺项可以直接提问，夹带事实结论仍需引用，错误编号始终拦截',()=>{
  expect(answerIntegrityIssue('请问要保存在哪个目录？',1)).toBeNull();
  expect(answerIntegrityIssue('请提供目标目录。',1)).toBeNull();
  expect(answerIntegrityIssue('预算十万元。要保存在哪个目录？',1)).toContain('引用');
  expect(answerIntegrityIssue('请问保存在哪个目录 [99]？',1)).toContain('不存在');
  expect(isClarificationAnswer('已创建文件夹，要继续吗？')).toBe(false);
});

test('正文后面粘上工具标签时保留正文，整段工具指令则没有正文',()=>{
  const body='选题是待写文章与选题池。先写结构。[1]\n<tool_call><function=knowledge_search>';
  expect(salvageWorkbenchAnswer(body)).toEqual({text:'选题是待写文章与选题池。先写结构。[1]',leaked:true});
  expect(answerIntegrityIssue(salvageWorkbenchAnswer(body).text,1)).toBeNull();
  expect(salvageWorkbenchAnswer('<tool_call><function=knowledge_search></function></tool_call>')).toEqual({text:'',leaked:true});
  expect(salvageWorkbenchAnswer('依据原文 [1]')).toEqual({text:'依据原文 [1]',leaked:false});
});

test('规则确认无需引用，不能借此伪造来源或工具回执',()=>{
  expect(answerIntegrityIssue('好的，以后清单先写合计金额，再列明细。',1,false)).toBeNull();
  expect(answerIntegrityIssue('好的，以后按这个格式。[99]',1,false)).toContain('不存在');
  expect(answerIntegrityIssue('<tool_result>已完成</tool_result>',1,false)).toContain('工具');
});
