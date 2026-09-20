import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('GBrain 能力成熟度准入', () => {
  test('本轮吸收项全部进入成熟度台账', () => {
    const ledger = read('项目管理/GBrain能力成熟度台账.md');
    for (let pr = 1; pr <= 12; pr += 1) expect(ledger).toContain(`PR${pr}`);
    for (const level of ['稳定', 'Beta', '实验', '研发工具', '未完成']) {
      expect(ledger).toContain(`| ${level} |`);
    }
    expect(ledger).toContain('稳定不等于必须吸收');
    expect(ledger).toContain('PMBrain 主要的中文用户');
  });

  test('非稳定能力不进入普通菜单或常驻自动化', () => {
    const app = read('admin/src/App.tsx');
    const settings = read('admin/src/pages/Settings.tsx');
    const serve = read('src/commands/serve-http.ts');
    const desktop = read('desktop/src/renderer/index.html');
    expect(app).not.toContain("page: 'connectors', label: '数据连接'");
    expect(app).not.toContain("page: 'chronicle', label: '时间线'");
    expect(app).not.toContain("page: 'config', label: '模型'");
    expect(app).not.toContain("page: 'waiting', label: '待我处理'");
    expect(settings).not.toContain('自动生成时间线');
    expect(settings).not.toContain('自动识别待办');
    expect(serve).not.toContain('startProductAutomation');
    expect(desktop).not.toContain('data-target="connections"');
  });
});
