import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installWritebackAgent, reconcileWritebackAgents, inspectWritebackAgents, removeWritebackAgent } from '../src/core/bootstrap/writeback-agents.ts';

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
