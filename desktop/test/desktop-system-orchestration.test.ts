import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const main = readdirSync(resolve('src/main'), { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts'))
  .sort()
  .map(path => readFileSync(resolve('src/main', path), 'utf8'))
  .join('\n');
const sidecar = readFileSync(resolve('src/main/sidecar-manager.ts'), 'utf8');
const gateway = readFileSync(resolve('src/main/lan-mcp-gateway.ts'), 'utf8');
const integrationManager = readFileSync(resolve('src/main/integration-manager.ts'), 'utf8');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
const setupController = readFileSync(resolve('src/main/startup/setup-controller.ts'), 'utf8');
const databaseController = readFileSync(resolve('src/main/database/database-upgrade.ts'), 'utf8');
const backupController = readFileSync(resolve('src/main/database/pglite-backup.ts'), 'utf8');
const sidecarController = readFileSync(resolve('src/main/sidecar/sidecar-controller.ts'), 'utf8');
const lanController = readFileSync(resolve('src/main/network/lan-controller.ts'), 'utf8');
const sharedAccessController = readFileSync(resolve('src/main/integration/shared-access-controller.ts'), 'utf8');
const trayController = readFileSync(resolve('src/main/app/tray-controller.ts'), 'utf8');

describe('desktop system orchestration contracts', () => {
  test('keeps the original sidecar private and exposes sharing through the desktop gateway', () => {
    expect(sidecar).toContain("'--bind', '127.0.0.1'");
    expect(sidecar).not.toContain("'--bind', '0.0.0.0'");
    expect(main).toContain('new LanMcpGateway');
    expect(main).toContain('sharedIp');
    expect(main).toContain('不会自动切换到其他网卡');
  });

  test('uses the sidecar as the only MCP tool and permission authority', () => {
    expect(gateway).not.toContain('SHARED_MCP_READ_TOOL_NAMES');
    expect(gateway).not.toContain('SHARED_MCP_WRITE_TOOL_NAMES');
    expect(gateway).not.toContain('SHARED_MCP_TOOL_SET');
    expect(gateway).not.toContain('filterToolsListResponse');
    expect(integrationManager).not.toContain('SHARED_MCP_TOOL_NAMES');
  });

  test('opens the current log in the system file manager instead of the default folder handler', () => {
    expect(main).toContain('shell.showItemInFolder(logger.filePath)');
    expect(main).not.toContain('shell.openPath(logger.directory)');
  });

  test('Postgres 用户升级时仍先准备数据库并执行原有迁移流程', () => {
    expect(setupController).toMatch(/async applyOnce[\s\S]*?ensureRuntimeReady\(\)[\s\S]*?hadRunningSidecar[\s\S]*?saveSetup\(payload\)/);
    expect(setupController).toMatch(/saveSetup\(payload\)[\s\S]*?prepareConfiguredDatabase\(\)[\s\S]*?needsDesktopMigration/);
    expect(databaseController).toContain('saveDetectedDockerContainerName');
    expect(databaseController).toContain('runCliChecked(this.dependencies.runtime(), DESKTOP_MIGRATION_ARGS)');
  });

  test('PGLite 用户升级时只由 sidecar 打开数据库，健康后才记录升级完成', () => {
    expect(main).toContain("setup.current.engine === 'pglite'");
    expect(databaseController).toMatch(/async migrateConfiguredInstallation[\s\S]*?engine === 'pglite'[\s\S]*?pgliteBackup\.ensureUpgradeBackup[\s\S]*?return true;[\s\S]*?DESKTOP_MIGRATION_ARGS/);
    expect(sidecarController).toMatch(/migrateConfiguredInstallation\(\)[\s\S]*?this\.start\(false\)[\s\S]*?engine === 'pglite'\)[\s\S]*?markDesktopMigration/);
    expect(main).toContain('PGLite 数据库路径：${databasePath}');
  });

  test('PGLite 迁移前完成冷备和恢复验证，失败时显示备份而不自动覆盖', () => {
    expect(backupController).toContain('async ensureUpgradeBackup');
    expect(backupController).toContain("'pglite-backup',");
    expect(backupController).toContain("'create',");
    expect(backupController).toContain("'--target-version', this.dependencies.appVersion()");
    expect(databaseController).toContain('pgliteBackup.ensureUpgradeBackup(setup.current.databasePath)');
    expect(setupController).toMatch(/migrationRequired = needsDesktopMigration[\s\S]*?engine === 'pglite'[\s\S]*?pgliteBackup\.ensureUpgradeBackup[\s\S]*?needsEmbeddingDimensionProbe/);
    expect(main).toContain('升级前冷备已验证并保留');
    expect(main).toContain('PMBrain 不会自动覆盖当前数据库');
    expect(backupController).toContain("process.platform === 'win32' ? databasePath.toLowerCase() : databasePath");
    expect(backupController).toMatch(/backupByVersion\.has\(key\)[\s\S]*?pendingBackupPath = cached/);
    expect(backupController).toMatch(/pendingBackupPath = null;[\s\S]*?runCliChecked\(this\.dependencies\.runtime\(\), \[/);
  });

  test('软件修复只通过 CLI 读取已验证的 PGLite 备份清单', () => {
    expect(main).toContain("'desktop:list-pglite-upgrade-backups'");
    expect(preload).toContain("'desktop:list-pglite-upgrade-backups'");
    expect(backupController).toMatch(/listUpgradeBackups[\s\S]*?'pglite-backup',[\s\S]*?'list',[\s\S]*?'--path'/);
    expect(main).not.toContain('restorePgliteUpgradeBackup');
    expect(main).not.toContain('deletePgliteUpgradeBackup');
  });

  test('桌面启动阶段不自动启动 Supervisor、Worker、Dream 或 Autopilot', () => {
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]jobs['"], ['"]supervisor['"], ['"]start['"]/);
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]worker['"]/);
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]dream['"]/);
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]autopilot['"]/);
  });

  test('wires native system settings, tray behavior, autostart, and shared credentials through IPC', () => {
    for (const channel of [
      'desktop:get-system-settings',
      'desktop:save-system-settings',
      'desktop:get-shared-access',
      'desktop:create-shared-integration',
      'desktop:revoke-shared-integration',
    ]) {
      expect(main).toContain(channel);
      expect(preload).toContain(channel);
    }
    expect(main).toContain('new Tray');
    expect(main).toContain("closeBehavior === 'quit'");
    expect(main).toContain('app.setLoginItemSettings');
    expect(main).toContain('dialog.showMessageBox');
  });

  test('fails closed across network changes and untrusted renderer navigation', () => {
    expect(main).toContain('共享不会自动恢复');
    expect(main).toContain('selectedAddressWasUnavailable');
    expect(main).toContain('sharedResumeRequired');
    expect(main).toContain('selectedCandidate?.recommended');
    expect(main).toContain('markSharedResumeRequired(true)');
    expect(main).toContain("webContents.on('will-navigate'");
    expect(main).toContain("webContents.on('will-redirect'");
    expect(main).toContain('isTrustedDesktopShellUrl');
    expect(main).toContain('registerTrustedHandler');
    expect(main).toContain('handlers.assertTrustedSender(event)');
    expect(main).toContain('系统偏好已保存，但局域网共享入口未能启动');
    expect(main).toContain("url.hostname === '127.0.0.1' || url.hostname === 'localhost'");
  });

  test('returns to native desktop panels and reconciles the database main source before saving', () => {
    expect(trayController).toContain('click: this.dependencies.openDesktop');
    expect(trayController).toContain("tray.on('double-click', this.dependencies.openDesktop)");
    expect(main).toContain("'/admin/api/brain/overview'");
    expect(main).toContain('payload.knowledgeSourceChanged === false');
    expect(setupController).toContain('this.applyOnce(effectivePayload');
  });

  test('serializes gateway transitions and keeps service startup single-flight', () => {
    expect(lanController).toContain('transitionQueue');
    expect(lanController).toContain('transitionGeneration');
    expect(lanController).toContain('queueTransition');
    expect(lanController).toContain('stopNow');
    expect(sidecarController).toContain('lifecycleQueue');
    expect(sidecarController).toContain('queueTransition');
    expect(sidecarController).toContain('readyPromise');
    expect(sidecarController).toContain('startupPromise');
  });

  test('only rebuilds embeddings after explicit desktop confirmation', () => {
    expect(main).toContain('saved.embeddingModelChanged');
    expect(main).toContain('saved.embeddingModelActivated');
    expect(main).toContain("'--empty-only'");
    expect(main).toContain('payload.confirmEmbeddingRebuild !== true');
    expect(main).toContain("'--force-reembed'");
    expect(main).toContain("['embed', '--stale', '--catch-up', '--json']");
    expect(main).toContain('(result.total_chunks ?? 0) - (result.embedded ?? 0)');
    expect(main).toContain('if (!embeddingSwitchCommitted) restoreConfig(saved.snapshot)');
    expect(main).toContain('Dream 不会自行触发模型迁移');
  });

  test('never repairs or clears vectors during ordinary desktop startup', () => {
    expect(main).not.toContain('reconcileConfiguredEmbeddingIndex');
    expect(main).toMatch(
      /const migrationRequired = await this\.dependencies\.migrateConfiguredInstallation\(\);[\s\S]*?setup\.current\.engine !== 'pglite'[\s\S]*?this\.start\(false\)[\s\S]*?setup\.current\.engine === 'pglite'/,
    );
  });

  test('模型保存时仅 Postgres 独立执行迁移，PGLite 等 sidecar 健康后完成升级记录', () => {
    expect(main).toContain("title: '正在验证向量模型'");
    expect(main).toContain("title: '正在保存模型配置'");
    expect(main).toContain("title: '正在准备搜索索引'");
    expect(setupController).toContain('migrationRequired = needsDesktopMigration(app.getVersion())');
    expect(setupController).toMatch(/if \(migrationRequired && saved\.config\.engine !== 'pglite'\) \{[\s\S]*?runCliChecked\(this\.dependencies\.runtime\(\), DESKTOP_MIGRATION_ARGS\)/);
    expect(setupController).toMatch(/this\.dependencies\.sidecar\.start\(false\)[\s\S]*?if \(migrationRequired && saved\.config\.engine === 'pglite'\)/);
    expect(main).not.toContain("title: '正在应用数据库迁移'");
  });

  test('allows credential listing and revocation while keeping creation behind the live gateway', () => {
    expect(sharedAccessController).toMatch(/async read\(\)[\s\S]*requireSidecar/);
    expect(sharedAccessController).toMatch(/async revoke[\s\S]*requireSidecar/);
    expect(sharedAccessController).toMatch(/async create[\s\S]*requireGateway/);
  });
});
