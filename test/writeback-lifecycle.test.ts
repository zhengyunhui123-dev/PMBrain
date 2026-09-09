import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWritebackHookCommand, installWritebackAgent, reconcileWritebackAgents, inspectWritebackAgents, removeWritebackAgent } from '../src/core/bootstrap/writeback-agents.ts';

test('接入先验证 MCP，关闭只移除自己的内容，并保留其他 Hook', async () => {
  const root=mkdtempSync(join(tmpdir(),'pmbrain-wb-'));
  const paths={codexHome:join(root,'codex'),claudeHome:join(root,'claude'),home:join(root,'brain')};
  mkdirSync(paths.claudeHome,{recursive:true});
  writeFileSync(join(paths.claudeHome,'CLAUDE.md'),'用户指令\r\n');
  writeFileSync(join(paths.claudeHome,'settings.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'keep-me'}]}]}}));
  const opts={...paths,agent:'claude' as const,sourceId:'default',serveUrl:'http://127.0.0.1:3210/mcp',mode:'salient' as const,ttl:'3d',visibility:'world' as const,command:'pmbrain hook stop'};
  try {
    expect(()=>installWritebackAgent({...opts,mcpConfirmed:false})).toThrow();
    expect(readFileSync(join(paths.claudeHome,'CLAUDE.md'),'utf8')).toBe('用户指令\r\n');
    installWritebackAgent({...opts,mcpConfirmed:true});
    installWritebackAgent({...opts,mcpConfirmed:true});
    expect(inspectWritebackAgents(paths).find(a=>a.agent==='claude')?.hook).toBe('installed');
    reconcileWritebackAgents({...paths,mode:'off',ttl:'3d',visibility:'world'});
    expect(readFileSync(join(paths.claudeHome,'CLAUDE.md'),'utf8')).toBe('用户指令\r\n');
    expect(JSON.parse(readFileSync(join(paths.claudeHome,'settings.json'),'utf8')).hooks.Stop).toEqual([{hooks:[{type:'command',command:'keep-me'}]}]);
    installWritebackAgent({...opts,mcpConfirmed:true});
    removeWritebackAgent({...paths,agent:'claude'});
    expect(inspectWritebackAgents(paths).find(a=>a.agent==='claude')?.registered).toBe(false);
    expect(readFileSync(join(paths.claudeHome,'CLAUDE.md'),'utf8')).toBe('用户指令\r\n');
    writeFileSync(join(paths.claudeHome,'settings.json'),'{broken');
    expect(()=>installWritebackAgent({...opts,mcpConfirmed:true})).toThrow();
    expect(readFileSync(join(paths.claudeHome,'CLAUDE.md'),'utf8')).toBe('用户指令\r\n');
    mkdirSync(paths.codexHome,{recursive:true});
    writeFileSync(join(paths.codexHome,'AGENTS.override.md'),'override');
    expect(()=>installWritebackAgent({...opts,agent:'codex',mcpConfirmed:true})).toThrow('AGENTS.override.md');
    expect(existsSync(join(paths.codexHome,'AGENTS.md'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Codex 深度接入同时安装 SessionEnd 兜底和信任记录，自检能发现信任漂移', () => {
  const root=mkdtempSync(join(tmpdir(),'pmbrain-codex-wb-'));
  const paths={codexHome:join(root,'codex'),claudeHome:join(root,'claude'),home:join(root,'brain')};
  mkdirSync(paths.codexHome,{recursive:true});
  writeFileSync(join(paths.codexHome,'AGENTS.md'),'用户指令\n');
  writeFileSync(join(paths.codexHome,'config.toml'),'model = "test"\n');
  writeFileSync(join(paths.codexHome,'hooks.json'),JSON.stringify({hooks:{SessionEnd:[{hooks:[{type:'command',command:'keep-me',timeout:3}]}]}}));
  const opts={...paths,agent:'codex' as const,sourceId:'default',serveUrl:'http://127.0.0.1:3210/mcp',mode:'salient' as const,ttl:'3d',visibility:'world' as const,command:'pmbrain hook session-end --harness codex'};
  try {
    installWritebackAgent({...opts,mcpConfirmed:true});
    installWritebackAgent({...opts,mcpConfirmed:true});
    const hooks=JSON.parse(readFileSync(join(paths.codexHome,'hooks.json'),'utf8'));
    expect(hooks.hooks.SessionEnd).toHaveLength(2);
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toBe('keep-me');
    expect(inspectWritebackAgents(paths).find(a=>a.agent==='codex')?.hook).toBe('installed');
    const configPath=join(paths.codexHome,'config.toml');
    const config=readFileSync(configPath,'utf8');
    expect(config).toContain('model = "test"');
    expect(config).toContain('pmbrain:codex-writeback-trust');
    writeFileSync(configPath,config.replace(/trusted_hash = .+/, 'trusted_hash = "sha256:broken"'));
    const drift=inspectWritebackAgents(paths).find(a=>a.agent==='codex');
    expect(drift?.hook).toBe('untrusted');
    expect(drift?.issue).toContain('未获得匹配的信任记录');
    reconcileWritebackAgents({...paths,mode:'off',ttl:'3d',visibility:'world'});
    const after=JSON.parse(readFileSync(join(paths.codexHome,'hooks.json'),'utf8'));
    expect(after.hooks.SessionEnd).toEqual([{hooks:[{type:'command',command:'keep-me',timeout:3}]}]);
    expect(readFileSync(configPath,'utf8')).toBe('model = "test"\n');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('Windows Codex Hook 标记位于可执行命令体内', () => {
  if(process.platform!=='win32')return;
  const command=buildWritebackHookCommand('default','session-end');
  expect(command).toContain('powershell.exe -NoProfile -NonInteractive -Command');
  expect(command).toContain('pmbrain hook session-end --harness codex');
  expect(command).toContain("'--detached'");
});
