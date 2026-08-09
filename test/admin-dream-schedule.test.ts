import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ADMIN_DREAM_SCHEDULE_TIME,
  adminDreamScheduleDateKey,
  isAdminDreamScheduleDue,
  isValidAdminDreamScheduleTime,
} from '../src/commands/admin-dream-schedule.ts';

const ROOT = join(import.meta.dir, '..');

describe('Admin scheduled one-click organization', () => {
  test('validates a 24-hour HH:MM time', () => {
    expect(DEFAULT_ADMIN_DREAM_SCHEDULE_TIME).toBe('02:00');
    expect(isValidAdminDreamScheduleTime('00:00')).toBe(true);
    expect(isValidAdminDreamScheduleTime('23:59')).toBe(true);
    expect(isValidAdminDreamScheduleTime('24:00')).toBe(false);
    expect(isValidAdminDreamScheduleTime('2:00')).toBe(false);
  });

  test('runs once per local day at or after the selected time', () => {
    const before = new Date(2026, 6, 24, 1, 59);
    const after = new Date(2026, 6, 24, 2, 1);
    const nextDay = new Date(2026, 6, 25, 2, 1);
    const dateKey = adminDreamScheduleDateKey(after);

    expect(isAdminDreamScheduleDue({ enabled: false, time: '02:00', lastStartedDate: null }, after)).toBe(false);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: null }, before)).toBe(false);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: null }, after)).toBe(true);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: dateKey }, after)).toBe(false);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: dateKey }, nextDay)).toBe(true);
  });

  test('reuses the same quick-maintenance Dream run as the knowledge organize page', () => {
    const serveSource = [
      'src/commands/serve-http.ts',
      'src/commands/pmbrain-admin-routes.ts',
    ].map(path => readFileSync(join(ROOT, path), 'utf8')).join('\n');
    const dreamSource = readFileSync(join(ROOT, 'admin/src/pages/Dream.tsx'), 'utf8');
    expect(serveSource).toContain("app.get('/admin/api/dream/schedule'");
    expect(serveSource).toContain("app.post('/admin/api/dream/schedule'");
    expect(serveSource).toContain("engine.setConfig(ADMIN_DREAM_SCHEDULE_ENABLED_KEY");
    // Must match manual「快速维护」: startDreamRun({ preset: 'quick', ... }), not full/depth.
    expect(serveSource).toContain("preset: 'quick'");
    expect(dreamSource).toContain("runMode === 'quick'");
    expect(dreamSource).toContain("? 'quick'");
    expect(serveSource).not.toMatch(/checkScheduledDream[\s\S]*?preset:\s*'full'/);
    expect(serveSource).not.toMatch(/checkScheduledDream[\s\S]*?drainProposals:\s*true/);
    expect(serveSource).toContain('const dreamScheduleTimer = setInterval(');
  });

  test('settings UI has a daily time and a dirty-state save button', () => {
    const settingsSource = readFileSync(join(ROOT, 'admin/src/pages/Settings.tsx'), 'utf8');
    const apiSource = readFileSync(join(ROOT, 'admin/src/api.ts'), 'utf8');
    expect(settingsSource).toContain('<h2>定时一键整理</h2>');
    expect(settingsSource).toContain('快速维护');
    expect(settingsSource).toContain('type="time"');
    expect(settingsSource).toContain('!dirty || !validTime');
    expect(settingsSource).toContain('当天服务恢复后补跑');
    expect(apiSource).toContain("'/admin/api/dream/schedule'");
    expect(apiSource).toContain('DreamScheduleResponseSchema');
  });
});
