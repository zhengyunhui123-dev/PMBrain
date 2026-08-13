import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  WORKBUDDY_AGENT_PACK_VERSION,
  WORKBUDDY_SKILL_SLUGS,
  WorkBuddyAdapter,
  WorkBuddyAgentPackInstaller,
} from '../src/main/integration/agent-integration/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-workbuddy-agent-pack-'));
  roots.push(root);
  return root;
}

describe('WorkBuddy Agent Pack 安装核心', () => {
  test('首次安装只写入 WorkBuddy workspace 的 Rules、5 个 Skills 与 PMBrain manifest', async () => {
    const workspace = tempWorkspace();
    const installer = new WorkBuddyAgentPackInstaller({ workspace });

    expect(await installer.getStatus()).toMatchObject({
      state: 'not_installed',
      workspace: resolve(workspace),
      packVersion: WORKBUDDY_AGENT_PACK_VERSION,
      rulesInstalled: false,
      skillsInstalled: 0,
      skillsTotal: 5,
    });

    const result = await installer.install();
    expect(result.status).toMatchObject({
      state: 'installed',
      rulesInstalled: true,
      skillsInstalled: 5,
      skillsTotal: 5,
    });
    expect(result.writtenFiles).toHaveLength(7);

    const verification = await installer.verify();
    expect(verification.valid).toBe(true);
    expect(verification.rulesReadable).toBe(true);
    expect(verification.skillsReadable).toBe(5);
    expect(verification.issues).toEqual([]);

    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(workspace, 'CODEBUDDY.md'))).toBe(false);
    expect(existsSync(join(workspace, '.codebuddy', 'rules', 'pmbrain.md'))).toBe(true);
    expect(existsSync(join(workspace, '.codebuddy', '.pmbrain-agent-pack.json'))).toBe(true);
    for (const slug of WORKBUDDY_SKILL_SLUGS) {
      expect(existsSync(join(workspace, '.codebuddy', 'skills', slug, 'SKILL.md'))).toBe(true);
    }
  });

  test('Rules 与 5 个 Skill 包含完整路由、安全边界、调试标记和业务工具流程', async () => {
    const workspace = tempWorkspace();
    const installer = new WorkBuddyAgentPackInstaller({ workspace });
    await installer.install();

    const rules = readFileSync(join(workspace, '.codebuddy', 'rules', 'pmbrain.md'), 'utf8');
    expect(rules).toContain('Brain First');
    expect(rules).toContain('alwaysApply: true');
    expect(rules).toContain('query(expand=false)');
    expect(rules).toContain('不得把查询失败理解为');
    expect(rules).toContain('明确记忆');
    expect(rules).toContain('明确记忆只写入 PMBrain');
    expect(rules).toContain('不得对同一内容重复写入');
    expect(rules).toContain('Durable Write Back');
    expect(rules).toContain('不要再对同一事实重复执行 `durable-writeback`');
    expect(rules).toContain('Correction');
    expect(rules).toContain('读取对应 `SKILL.md` 的完整说明');
    expect(rules).toContain('纠错意图优先 `correction`');
    expect(rules).toContain('不要为普通润色或闲聊无意义调用 PMBrain');

    const contents = Object.fromEntries(WORKBUDDY_SKILL_SLUGS.map((slug) => [
      slug,
      readFileSync(join(workspace, '.codebuddy', 'skills', slug, 'SKILL.md'), 'utf8'),
    ]));
    for (const slug of WORKBUDDY_SKILL_SLUGS) {
      expect(contents[slug]).toContain('agent_integration_debug');
      expect(contents[slug]).toContain('client: desktop-workbuddy');
      expect(contents[slug]).toContain('agent_integration: deep');
      expect(contents[slug]).toContain(`skill: ${slug}`);
      expect(contents[slug]).toContain('调试调用失败');
      expect(contents[slug]).not.toContain('\nversion:');
    }
    expect(contents['brain-first']).toContain('recall');
    expect(contents['brain-first']).toContain('query');
    expect(contents['brain-first']).toContain('expand: false');
    expect(contents['brain-first']).toContain('get_page');
    expect(contents.remember).toContain('优先更新已有页面');
    expect(contents.remember).toContain('put_page');
    expect(contents.remember).toContain('同一事实本轮最多执行一次有效 `put_page`');
    expect(contents.remember).toContain('不要再写 WorkBuddy 内置 memory 或其他存储');
    expect(contents.correction).toContain('原始资料错误');
    expect(contents.correction).toContain('实体串线');
    expect(contents.correction).toContain('禁止静默批量修改');
    expect(contents.correction).toContain('没有给出正确替换文本');
    expect(contents['durable-writeback']).toContain('AI 推测');
    expect(contents['durable-writeback']).toContain('不要再次触发本 Skill 或重复写入');
    expect(contents['takes-review']).toContain('take_proposals_list');
    expect(contents['takes-review']).toContain('take_proposal_accept');
    expect(contents['takes-review']).toContain('take_proposal_reject');
    expect(contents['takes-review']).toContain('不得称为 confidence');
    expect(contents['takes-review']).toContain('page_slug');
    expect(contents['takes-review']).toContain('数值 `id`');
    expect(contents['takes-review']).toContain('admin 权限');
  });

  test('重复安装完全幂等，不改写已校验的文件或 manifest', async () => {
    const workspace = tempWorkspace();
    const installer = new WorkBuddyAgentPackInstaller({ workspace });
    await installer.install();
    const adapter = new WorkBuddyAdapter({ workspace });
    const paths = adapter.paths();
    const before = new Map(paths.managedFiles.map((path) => [path, readFileSync(path, 'utf8')]));
    before.set(paths.manifest, readFileSync(paths.manifest, 'utf8'));

    const second = await installer.install();

    expect(second.status.state).toBe('installed');
    expect(second.writtenFiles).toEqual([]);
    for (const [path, content] of before) {
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
  });

  test('没有 manifest 时把同名用户文件视为冲突，拒绝静默覆盖', async () => {
    const workspace = tempWorkspace();
    const adapter = new WorkBuddyAdapter({ workspace });
    const rulesPath = adapter.paths().rules;
    const rulesDir = join(workspace, '.codebuddy', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, '.keep'), '', 'utf8');
    writeFileSync(rulesPath, '# 用户自己的规则\n', 'utf8');
    const installer = new WorkBuddyAgentPackInstaller({ workspace });

    const status = await installer.getStatus();
    expect(status.state).toBe('modified');
    expect(status.modifiedFiles).toContain('.codebuddy/rules/pmbrain.md');
    await expect(installer.install()).rejects.toThrow('用户文件');
    expect(readFileSync(rulesPath, 'utf8')).toBe('# 用户自己的规则\n');
    expect(existsSync(adapter.paths().manifest)).toBe(false);
  });

  test('缺失的受管 Skill 标记为 incomplete，更新只补回缺失文件', async () => {
    const workspace = tempWorkspace();
    const installer = new WorkBuddyAgentPackInstaller({ workspace });
    await installer.install();
    const missingPath = join(workspace, '.codebuddy', 'skills', 'remember', 'SKILL.md');
    rmSync(missingPath);

    expect(await installer.getStatus()).toMatchObject({
      state: 'incomplete',
      skillsInstalled: 4,
      missingFiles: ['.codebuddy/skills/remember/SKILL.md'],
    });

    const repaired = await installer.update();
    expect(repaired.status.state).toBe('installed');
    expect(repaired.writtenFiles).toContain('.codebuddy/skills/remember/SKILL.md');
    expect(existsSync(missingPath)).toBe(true);
  });

  test('旧 manifest 显示 update_available，安全更新到当前 Pack 版本', async () => {
    const workspace = tempWorkspace();
    const installer = new WorkBuddyAgentPackInstaller({ workspace });
    await installer.install();
    const manifestPath = new WorkBuddyAdapter({ workspace }).paths().manifest;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const rulesPath = join(workspace, '.codebuddy', 'rules', 'pmbrain.md');
    const oldRules = '# PMBrain Agent Rules\n\n旧版官方内容\n';
    writeFileSync(rulesPath, oldRules, 'utf8');
    manifest.packVersion = '0';
    manifest.files['.codebuddy/rules/pmbrain.md'] = createHash('sha256').update(oldRules).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(await installer.getStatus()).toMatchObject({
      state: 'update_available',
      installedPackVersion: '0',
      packVersion: '1',
    });

    const updated = await installer.update();
    expect(updated.status).toMatchObject({ state: 'installed', installedPackVersion: '1' });
    expect(updated.writtenFiles).toContain('.codebuddy/rules/pmbrain.md');
    expect(readFileSync(rulesPath, 'utf8')).toContain('Brain First');
    expect(readFileSync(rulesPath, 'utf8')).not.toContain('旧版官方内容');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).packVersion).toBe('1');
  });

  test('卸载删除校验通过的 PMBrain 文件，但保留用户改过的 Skill', async () => {
    const workspace = tempWorkspace();
    const installer = new WorkBuddyAgentPackInstaller({ workspace });
    await installer.install();
    const adapter = new WorkBuddyAdapter({ workspace });
    const changedSkill = join(workspace, '.codebuddy', 'skills', 'correction', 'SKILL.md');
    writeFileSync(changedSkill, '# 用户保留的纠错流程\n', 'utf8');

    expect(await installer.getStatus()).toMatchObject({
      state: 'modified',
      modifiedFiles: ['.codebuddy/skills/correction/SKILL.md'],
    });
    await expect(installer.update()).rejects.toThrow('用户修改');

    const removed = await installer.uninstall();
    expect(removed.preservedFiles).toEqual(['.codebuddy/skills/correction/SKILL.md']);
    expect(readFileSync(changedSkill, 'utf8')).toBe('# 用户保留的纠错流程\n');
    expect(existsSync(adapter.paths().rules)).toBe(false);
    expect(existsSync(adapter.paths().manifest)).toBe(false);
    expect(existsSync(join(workspace, '.codebuddy', 'skills', 'brain-first', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(workspace, '.codebuddy', 'skills', 'correction'))).toBe(true);
    expect(removed.status.state).toBe('modified');
  });

  test('干净卸载移除 PMBrain 创建的空目录，但保留用户原先存在的 WorkBuddy 目录', async () => {
    const cleanWorkspace = tempWorkspace();
    const cleanInstaller = new WorkBuddyAgentPackInstaller({ workspace: cleanWorkspace });
    await cleanInstaller.install();
    await cleanInstaller.uninstall();
    expect(existsSync(join(cleanWorkspace, '.codebuddy'))).toBe(false);

    const userWorkspace = tempWorkspace();
    const userSkillsDirectory = join(userWorkspace, '.codebuddy', 'skills');
    mkdirSync(userSkillsDirectory, { recursive: true });
    const userInstaller = new WorkBuddyAgentPackInstaller({ workspace: userWorkspace });
    await userInstaller.install();
    await userInstaller.uninstall();
    expect(existsSync(join(userWorkspace, '.codebuddy'))).toBe(true);
    expect(existsSync(userSkillsDirectory)).toBe(true);
  });

  test('adapter 只接受安全 workspace，并暴露 workspace/global config home', () => {
    const workspace = tempWorkspace();
    const homeDir = tempWorkspace();
    const adapter = new WorkBuddyAdapter({ workspace, homeDir });

    expect(adapter.workspace).toBe(resolve(workspace));
    expect(adapter.configHome).toBe(join(resolve(homeDir), '.workbuddy'));
    expect(adapter.paths().rules).toBe(join(resolve(workspace), '.codebuddy', 'rules', 'pmbrain.md'));
    expect(() => new WorkBuddyAdapter({ workspace: parse(resolve(workspace)).root })).toThrow('根目录');
    expect(() => new WorkBuddyAdapter({ workspace: '   ' })).toThrow('工作目录');
  });
});
