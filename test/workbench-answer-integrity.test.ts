import {expect,test} from 'bun:test';
import {answerIntegrityIssue,answerPreview} from '../src/product/workbench/answer-integrity';

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
