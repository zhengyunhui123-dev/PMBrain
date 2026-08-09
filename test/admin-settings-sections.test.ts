import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const consoleSource = readFileSync(join(process.cwd(), 'admin/src/pages/Sources.tsx'), 'utf8');
const settingsSource = readFileSync(join(process.cwd(), 'admin/src/pages/Settings.tsx'), 'utf8');
const appSource = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
const styles = readFileSync(join(process.cwd(), 'admin/src/index.css'), 'utf8');
const desktopRenderer = readFileSync(join(process.cwd(), 'desktop/src/renderer/src.ts'), 'utf8');

describe('Admin settings information architecture', () => {
  test('Admin settings are split into four useful service-focused sections', () => {
    for (const label of [
      '常规设置',
      '知识库设置',
      '知识整理设置',
      '导入与向量化',
    ]) {
      expect(settingsSource).toContain(`label: '${label}'`);
    }
    expect(appSource).toContain('aria-label="设置"');
    expect(appSource).toContain('className={`nav-item nav-subitem');
    expect(appSource).toContain("'settings-general'");
    expect(appSource).toContain("'settings-knowledge'");
    expect(appSource).toContain("'settings-dream'");
    expect(appSource).toContain("'settings-import'");
    expect(appSource).not.toContain("'settings-models'");
    expect(settingsSource).not.toContain("label: '模型配置'");
    expect(settingsSource).not.toContain('className="settings-menu"');
    expect(settingsSource).toContain("section === 'knowledge'");
    expect(settingsSource).toContain("section === 'dream'");
    expect(settingsSource).toContain("section === 'import'");
    expect(settingsSource).not.toContain("section === 'models'");
    expect(settingsSource).not.toContain("section === 'system'");
    expect(settingsSource).not.toContain('<h2>系统与更新</h2>');
  });

  test('desktop-only controls are omitted from Admin settings', () => {
    expect(settingsSource).not.toContain('开机启动和关闭窗口行为属于桌面应用权限');
    expect(settingsSource).not.toContain('不会尝试修改 Windows 登录启动项');
    expect(settingsSource).not.toContain('版本更新记录');
    expect(desktopRenderer).toContain('本版本暂无更新记录');
    expect(desktopRenderer).toContain('renderReleaseNotes(update.releaseNotes)');
  });

  test('source Git actions match repository state and do not expose CLI output', () => {
    expect(consoleSource).toContain("source.git_repo ? '提交更改' : '创建 Git'");
    expect(consoleSource).toContain('{source.local_path && (');
    expect(consoleSource).toContain('将包含新增、修改和删除的文件');
    expect(consoleSource).not.toContain('同步复用 PMBrain CLI');
    expect(consoleSource).not.toContain("run?.kind === 'sync_source'");
  });

  test('desktop layout uses compact sidebar subitems and a single content area', () => {
    expect(styles).toContain('.nav-section-settings');
    expect(styles).toContain('.nav-subitem');
    expect(styles).toContain('.settings-content-standalone');
    expect(styles).not.toContain('.settings-menu');
    expect(styles).toContain('.sidebar::-webkit-scrollbar');
    expect(styles).toContain('scrollbar-width: none');
    expect(styles).toContain('flex-wrap: nowrap');
  });
});
