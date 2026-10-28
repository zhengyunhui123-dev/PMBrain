import {expect,test} from 'bun:test';
import {inspectLegacyChunks} from '../src/core/document/legacy-integrity';
import {TAKES_FENCE_BEGIN,TAKES_FENCE_END} from '../src/core/takes-fence';
const office=(index:number,text:string,section='段落')=>({chunk_index:index,chunk_source:'office_child',chunk_text:`Parent document: 原资料\nSection: ${section}\nLocator: ${section} · 第 1 页\n\n${text}`});
test('旧文档先归集段落再归集表格，仍能核验正文，不误删正常分块',async()=>{
  const body='# 原资料\n\n开头内容\n\n| 姓名 | 数值 |\n| --- | --- |\n| 甲 | 123 |\n\n结束内容';
  const result=await inspectLegacyChunks(body,'原资料',[office(0,'开头内容\n\n结束内容','跨行\n标题'),office(1,'姓名 | 数值 | 甲 | 123')]);expect(result).toMatchObject({invalid:[],missing:[]});
});
test('OCR表格按原 Markdown 分行及旧无前缀分块均可核验',async()=>{
  const body='已识别内容\n\n| 名称 | 类型 |\n| --- | --- |\n| 甲 | A |\n| 乙 | B |';
  const result=await inspectLegacyChunks(body,'原资料',[{chunk_index:0,chunk_source:'office_child',chunk_text:'已识别内容'},office(1,'| 名称 | 类型 |\n| --- | --- |\n| 甲 | A |'),office(2,'| 乙 | B |')]);expect(result.invalid).toEqual([]);expect(result.missing).toEqual([]);
});
test('数量不变但正文损坏时指出坏块和缺失文字',async()=>{
  const result=await inspectLegacyChunks('完整原文甲\n\n完整原文乙','原资料',[office(0,'完整原文甲'),office(1,'被改坏的文字')]);expect(result.invalid).toEqual([1]);expect(result.missing).toEqual(['完整原文乙']);
});
test('英文单词空格不是任意格式差异，拼接成另一个单词时不能通过核验',async()=>{
  const result=await inspectLegacyChunks('not able to proceed','原资料',[office(0,'notable to proceed')]);expect(result.invalid).toEqual([0]);expect(result.missing).toEqual(['not able to proceed']);
});
test('正文重复出现的相同内容已有索引时无需重复补块',async()=>{
  const result=await inspectLegacyChunks('相同文字\n\n相同文字\n\n末尾内容','原资料',[office(0,'相同文字\n\n末尾内容')]);expect(result).toMatchObject({invalid:[],missing:[]});
});
test('遗失标题可修补，private facts 和 takes 不进入修补文字',async()=>{
  const body=`# 原资料\n\n公开内容\n\n## 末尾标题\n\n${TAKES_FENCE_BEGIN}\nsecret-take\n${TAKES_FENCE_END}`;
  const result=await inspectLegacyChunks(body,'原资料',[office(0,'公开内容')]);expect(result.missing).toContain('末尾标题');expect(result.missing.join('')).not.toContain('secret-take');
});
