import {expect,test} from 'bun:test';
import {workbenchEvidenceWindow} from '../src/product/workbench/evidence';

test('明确询问同日较后时刻时按原文时刻定位，不借用较早记录',()=>{
  const content='2026年6月18日11:40:26\n字段待办。\n2026年6月18日11:56:41\n平台能力仍需确认。';
  const window=workbenchEvidenceWindow(content,'6月18日11:56记录里平台能力确定了吗？','');
  expect(content.slice(window.start,window.end)).toContain('平台能力仍需确认');expect(content.slice(window.start,window.end)).not.toContain('字段待办');
});

test('原文两位年份按提问核对并保留原写法，不把次日记录混进来',()=>{
  const content='24年3月12日内部讨论\n非标品无法确认来源。\n2024年3月13日\n只到品类。';
  const window=workbenchEvidenceWindow(content,'2024年3月12日说明了什么？','只到品类。');
  expect(window.eventDate).toBe('24年3月12日');expect(content.slice(window.start,window.end)).not.toContain('只到品类');
});

test('未问日期但命中事实时携带所属记录标题，止于下一条记录',()=>{
  const content='2024年3月12日\n非标品无法确认来源，应先确认采集范围。\n2024年3月13日\n讨论分析粒度。';
  const window=workbenchEvidenceWindow(content,'为什么难采集？','非标品无法确认来源，应先确认采集范围。');
  expect(window.eventDate).toBe('2024年3月12日');expect(content.slice(window.start,window.end)).not.toContain('讨论分析粒度');
});

test('事件日期从记录标题读取，转换时间和不同年份不能充当指定事件',()=>{
  const content='> 转换时间: 2025年5月27日\n2024年5月27日\n历史方案。\n原始命中的后文说明保留实际日期。';
  const window=workbenchEvidenceWindow(content,'2025年5月27日的方案？','原始命中的后文说明保留实际日期。');
  expect(window.eventDate).toBeUndefined();expect(content.slice(window.start,window.end)).toContain('2024年5月27日');
});

test('ISO 日期记录包含跨页延续，截止到下一个真实记录',()=>{
  const content='2024-02-29\n甲。\n## 第 2 页\n乙。\n2024年3月1日\n丙。';
  const window=workbenchEvidenceWindow(content,'2024年2月29日的记录？','');
  expect(content.slice(window.start,window.end)).toBe('2024-02-29\n甲。\n## 第 2 页\n乙。\n');
  expect(window.eventDate).toBe('2024-02-29');
});

test('没有年份且同月日跨年重复时不擅自指定一个事件版本',()=>{
  const content='2024年5月27日\n甲。\n2025年5月27日\n乙。';
  expect(workbenchEvidenceWindow(content,'5月27日确定了什么？','').eventDate).toBeUndefined();
});

test('同日多条记录按原文保留，明确询问较后一条才定位最后一条',()=>{
  const content='2025年5月26日\n第一条。\n2025年5月26日\n第二条。';
  const first=workbenchEvidenceWindow(content,'2025年5月26日的记录？','');
  const last=workbenchEvidenceWindow(content,'2025年5月26日较后文案？','');
  expect(first.start).toBe(0);expect(last.start).toBe(content.lastIndexOf('2025年5月26日'));expect(last.fromEnd).toBe(true);
});
