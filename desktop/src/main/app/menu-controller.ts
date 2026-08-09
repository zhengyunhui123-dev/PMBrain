import { app, Menu, shell } from 'electron';
import type { DesktopLogger } from '../logs.js';

export type SettingsPanel = 'basic' | 'models' | 'integrations' | 'updates' | 'system' | 'repair';

export interface AppMenuDependencies {
  openAdmin: () => Promise<void>;
  openPanel: (panel: SettingsPanel) => Promise<void>;
  openUpdates: () => Promise<void>;
  getLogger: () => DesktopLogger | null;
  reportError: (title: string, error: unknown) => void;
}

export function installAppMenu(dependencies: AppMenuDependencies): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'PMBrain',
      submenu: [
        {
          label: '打开管理控制台',
          click: () => void dependencies.openAdmin().catch(error => dependencies.reportError('无法打开管理控制台', error)),
        },
        { label: '基础配置', click: () => void dependencies.openPanel('basic') },
        { label: '模型配置', click: () => void dependencies.openPanel('models') },
        { label: 'MCP 接入', click: () => void dependencies.openPanel('integrations') },
        { label: '系统设置', click: () => void dependencies.openPanel('system') },
        { label: '软件更新', click: () => void dependencies.openUpdates() },
        { label: '软件修复', click: () => void dependencies.openPanel('repair') },
        { type: 'separator' },
        {
          label: '打开日志目录',
          click: () => {
            const logger = dependencies.getLogger();
            if (logger) void shell.showItemInFolder(logger.filePath);
          },
        },
        { type: 'separator' },
        { label: '退出 PMBrain', click: () => app.quit() },
      ],
    },
    { role: 'viewMenu', label: '视图' },
  ]));
}
