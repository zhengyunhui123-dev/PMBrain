import {expect,test} from 'bun:test';
import {nextSettingsOrigin,settingsReturnTarget} from '../admin/src/product/settings-nav';

test('settings preserve the entering page and query while categories change',()=>{
  const source='tasks?run=task-42';
  expect(nextSettingsOrigin(source,'settings-dream',null)).toBe(source);
  expect(nextSettingsOrigin('settings-dream','settings-models',source)).toBe(source);
  expect(settingsReturnTarget(source,'create?intent=import')).toBe(source);
});
test('a later visit records its own origin and direct settings retain the creation return',()=>{
  expect(nextSettingsOrigin('graph?focus=abc','settings-models','dream')).toBe('graph?focus=abc');
  expect(settingsReturnTarget(null,'create?intent=organize')).toBe('create?intent=organize');
  expect(settingsReturnTarget('settings-dream',null)).toBe('home');
  expect(settingsReturnTarget(null,null)).toBe('home');
});
