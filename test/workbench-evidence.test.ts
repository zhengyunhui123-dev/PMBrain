import {expect,test} from 'bun:test';
import {workbenchEvidenceWindow} from '../src/product/workbench/evidence';

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
