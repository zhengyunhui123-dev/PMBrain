import { expect, test } from 'bun:test';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';

test('Chinese role headings preserve decisions and negation verbatim', () => {
  const result = parseConversation('## 用户：\n没有批准上线，只是建议试点。\n## 助手：\n待办：周五前核对预算。');
  expect(result.messages.map(m => m.speaker)).toEqual(['用户', '助手']);
  expect(result.messages.map(m => m.text)).toEqual(['没有批准上线，只是建议试点。', '待办：周五前核对预算。']);
});

test('Chinese meeting speaker labels and continuation paragraphs', () => {
  const result = parseConversation('发言人1：暂不采购。\n先核对合同。\n说话人2：同意核对，但没有同意采购。');
  expect(result.messages.map(m => m.speaker)).toEqual(['发言人1', '说话人2']);
  expect(result.messages[0].text).toBe('暂不采购。\n先核对合同。');
  expect(result.messages[1].text).toBe('同意核对，但没有同意采购。');
});

test('fullwidth punctuation in named meeting turns', () => {
  const result = parseConversation('**张三：** 我建议试点。\n**李四：** 还没有决定。');
  expect(result.messages.map(m => m.speaker)).toEqual(['张三', '李四']);
  expect(result.messages[1].text).toBe('还没有决定。');
});

test.each(['## 会议结论\n暂未批准。\n## 风险\n预算不足。', '会议结论：暂未批准。\n风险：预算不足。'])('ordinary Chinese documents stay documents: %s', body => {
  expect(parseConversation(body).messages).toEqual([]);
});
