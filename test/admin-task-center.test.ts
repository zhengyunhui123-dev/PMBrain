import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync('admin/src/App.tsx', 'utf8');
const apiSource = readFileSync('admin/src/api.ts', 'utf8');
const dreamSource = readFileSync('admin/src/pages/Dream.tsx', 'utf8');
const taskCenterSource = readFileSync('admin/src/pages/TaskCenter.tsx', 'utf8');
const consoleSource = readFileSync('admin/src/pages/Knowledge.tsx', 'utf8');
const adminCss = readFileSync('admin/src/index.css', 'utf8');

describe('Admin 任务中心与 Dream 忙碌态', () => {
  test('任务中心位于集成导航并显示现有长任务', () => {
    expect(appSource).toContain("{ page: 'tasks', label: '任务中心', icon: 'tasks' }");
    expect(appSource).toContain('<TaskCenterPage />');
    expect(taskCenterSource).toContain('api.taskCenter()');
    expect(taskCenterSource).toContain('历史任务');
    expect(taskCenterSource).toContain('查看技术详情');
    expect(taskCenterSource).toContain('安全取消');
  });

  test('PGlite 忙碌时 Dream 页面保留任务状态和取消路径', () => {
    expect(apiSource).toContain('error.status = res.status');
    expect(apiSource).toContain('taskCenter: () => apiFetch');
    expect(dreamSource).toContain('isPgliteBusyError');
    expect(dreamSource).toContain('<DreamBusyRecovery');
    expect(dreamSource).toContain('api.cancelRun(run.id)');
  });

  test('PGLite 忙碌提示直接引导到任务中心', () => {
    expect(consoleSource).toContain('PgliteBusyNotice');
    expect(consoleSource).toContain('可去任务中心查看任务进度和取消任务。');
    expect(consoleSource).toContain('打开任务中心');
  });

  test('取消任务显示用户说明而不是把取消当成错误', () => {
    expect(taskCenterSource).toContain('任务已取消，已完成的部分已保留，不会自动回滚。');
    expect(taskCenterSource).toContain('任务已由管理员取消');
    expect(taskCenterSource).toContain('task-run-cancelled');
  });

  test('Dream 阶段执行页在深色主题使用控制台配色', () => {
    expect(adminCss).toContain('html[data-theme="dark"] .dream-page .dream-phase-rail section');
    expect(adminCss).toContain('html[data-theme="dark"] .dream-page .dream-run-mode');
    expect(adminCss).toContain('html[data-theme="dark"] .dream-page .dream-ops-diagnostics');
  });
});
