import {expect,test} from 'bun:test';
import {locateQuote} from '../src/core/cycle/extract-atoms.ts';

test('Chinese paragraph whitespace preserves exact source offsets',()=>{
  const source='保存原文。\n\n核对来源后发布。';
  const location=locateQuote(source,'保存原文。核对来源后发布。');
  expect(location).toEqual({start:0,end:source.length});
  expect(source.slice(location!.start,location!.end)).toBe(source);
});
test('word boundaries, changed claims and ambiguous quotes stay rejected',()=>{
  expect(locateQuote('not able','notable')).toBeNull();
  expect(locateQuote('尚未通过验收','已经通过验收')).toBeNull();
  expect(locateQuote('保存证据。保存证据。','保存证据。')).toBeNull();
});
