import argparse
import json
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from core_journeys import DesktopSession

ROOT = Path(__file__).resolve().parents[2]
CLAIM = '星河项目的报告先写结论，再写依据'


class Provider(BaseHTTPRequestHandler):
    requests = []
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.reply({'object': 'list', 'data': [{'id': 'memory-fixture', 'object': 'model'}]})

    def reply(self, body, stream=False):
        data = (f'data: {json.dumps(body)}\n\ndata: [DONE]\n\n' if stream else json.dumps(body)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if stream else 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        system = '\n'.join(str(m.get('content', '')) for m in messages if m.get('role') == 'system')
        user = str(next((m.get('content', '') for m in reversed(messages) if m.get('role') == 'user'), ''))
        extract = 'extract personal-knowledge claims' in system
        if extract:
            content = json.dumps({'facts': [{'fact': CLAIM, 'kind': 'preference', 'entity': None, 'confidence': 1, 'notability': 'high', 'transient': False}] if CLAIM in user else []}, ensure_ascii=False)
        else:
            content = CLAIM + '。[1]' if '（用户已明确表达并保存）' in system else '之后生成项目报告时，我会先写结论，再写依据。本轮原文保留在对话历史中。'
        stream = body.get('stream', False)
        self.requests.append({'path': self.path, 'stream': stream, 'extract': extract, 'user': user[:100], 'response': content[:100]})
        search = not extract and '请先调用 knowledge_search' in user and not any(message.get('role') == 'tool' for message in messages)
        message = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'fixture-search', 'type': 'function', 'function': {'name': 'knowledge_search', 'arguments': json.dumps({'query': '星河项目'})}}]} if search else {'role': 'assistant', 'content': content}
        self.reply({'id': 'memory-fixture', 'object': 'chat.completion.chunk' if stream else 'chat.completion', 'created': 1, 'model': body.get('model'), 'choices': [{'index': 0, 'finish_reason': 'tool_calls' if search else 'stop', 'delta' if stream else 'message': message}], 'usage': {'prompt_tokens': 30, 'completion_tokens': 20, 'total_tokens': 50}}, stream)


def run(args):
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / 'home'
    config_dir = home / '.pmbrain'
    config_dir.mkdir(parents=True)
    materials = home / 'materials'
    materials.mkdir()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    version = json.loads((ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version']
    config = {'engine': 'pglite', 'database_path': str(home / 'database'), 'chat_model': 'custom-openai:memory-fixture', 'custom_openai_api_key': 'synthetic-only', 'provider_base_urls': {'custom-openai': f'http://127.0.0.1:{provider.server_port}/v1'}, 'memory': {'auto_writeback': 'off'}, 'desktop': {'setup_completed': True, 'main_source_path_repair_completed': True, 'last_migrated_version': version, 'knowledge_directory': str(materials)}}
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY') and key not in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'CODEX_HOME': str(home / 'codex'), 'CLAUDE_CONFIG_DIR': str(home / 'claude'), 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    init = 'import {PGLiteEngine} from "./src/core/pglite-engine.ts"; import {loadConfig} from "./src/core/config.ts"; const e=new PGLiteEngine(); await e.connect(loadConfig()); await e.initSchema(); await e.setConfig("dream.entity_capture.enabled","false"); await e.setConfig("memory.auto_writeback","off"); await e.setConfig("facts.extraction_model","custom-openai:memory-fixture"); await e.disconnect();'
    with (artifacts / 'init.log').open('w', encoding='utf-8') as log:
        subprocess.run([shutil.which('bun'), '--eval', init], cwd=ROOT, env=env, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
    result = {'version': version, 'checks': []}
    try:
        with sync_playwright() as playwright:
            session = DesktopSession(playwright, artifacts, home)
            previous_env = dict(os.environ)
            try:
                os.environ.clear()
                os.environ.update(env)
                page = session.start()
            finally:
                os.environ.clear()
                os.environ.update(previous_env)
            try:
                page.evaluate('''async () => {
                  const deadline = Date.now() + 120000;
                  while (Date.now() < deadline) {
                    const state = await window.pmbrainDesktop.getState();
                    if (state?.phase === 'ready') return;
                    if (state?.phase === 'failed') throw new Error(state.message);
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }
                  throw new Error('Desktop service not ready');
                }''')
                page.set_viewport_size({'width': 1440, 'height': 1000})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))

                def api(path, body=None, method=None):
                    response = page.evaluate('''async ({path, body, method}) => window.pmbrainDesktop.productRequest({path, method:method || (body == null ? 'GET' : 'POST'), headers:{'Content-Type':'application/json'}, ...(body == null ? {} : {body:JSON.stringify(body)})})''', {'path': path, 'body': body, 'method': method})
                    assert 200 <= response['status'] < 300, (path, response)
                    return json.loads(response['body'])

                def until(check, label, timeout=50):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        value = check()
                        if value:
                            return value
                        time.sleep(.2)
                    raise AssertionError(label)

                def settings():
                    page.evaluate("location.hash = 'settings-system'")
                    page.locator('#panel-system').wait_for(state='visible')
                    expect(page.locator('#memory-mode-off')).to_be_enabled()

                def choose(mode):
                    if not page.locator(f'#memory-mode-{mode}').is_checked():
                        page.locator(f'#memory-mode-{mode}-card').click()
                        expect(page.locator('#memory-save-note')).to_contain_text('已保存')
                    expect(page.locator(f'#memory-mode-{mode}')).to_be_checked()
                    state = page.evaluate('window.pmbrainDesktop.getMemoryWriteback()')
                    assert state['mode'] == mode, state
                    assert api('/admin/api/workbench/memory')['mode'] == mode

                def conversation(text, knowledge=False):
                    row = api('/admin/api/workbench/conversations', {'knowledge': knowledge})
                    api(f"/admin/api/workbench/conversations/{row['id']}/messages", {'text': text, 'knowledge': knowledge})
                    return row['id']

                def completed(identity):
                    def check():
                        row = api(f'/admin/api/workbench/conversations/{identity}')
                        if len(row['messages']) >= 2 and row['messages'][-1]['status'] in ['error', 'cancelled']:
                            raise AssertionError(row['messages'][-1].get('error', 'answer cancelled'))
                        return row if len(row['messages']) >= 2 and row['messages'][-1]['status'] == 'complete' and row['messages'][0].get('memory', {}).get('status') in ['off', 'complete'] else None
                    return until(check, 'conversation memory did not settle')

                settings()
                expect(page.locator('#save-system-settings')).to_have_count(0)
                state_before = page.evaluate('window.pmbrainDesktop.getState()')
                choose('salient')
                assert not any(agent['registered'] or agent['block'] == 'present' for agent in page.evaluate('window.pmbrainDesktop.getMemoryWriteback()')['agents'])
                page.reload()
                settings()
                expect(page.locator('#memory-mode-salient')).to_be_checked()
                result['checks'].append('无外部客户端也可即时开启，刷新与知识助手设置一致')
                first = completed(conversation('以后' + CLAIM))
                assert len(first['messages'][0]['memory']['factIds']) == 1, first
                second = completed(conversation('星河项目的报告偏好是什么？', True))
                assert CLAIM in second['messages'][-1]['text'], second
                assert any(c.get('factId') == first['messages'][0]['memory']['factIds'][0] for c in second['messages'][-1].get('citations', [])), second
                assert second['messages'][0]['memory'].get('taskId') is None
                result['checks'].append('对话自动保存事实，新对话召回并提供出处；纯问题不建记忆任务')
                page.evaluate("location.hash = 'assistant'")
                page.get_by_role('button', name='助手配置', exact=True).click()
                page.get_by_role('button', name='职责与规则', exact=True).click()
                page.get_by_role('button', name='记忆、模型参数与上下文', exact=True).click()
                dialog = page.get_by_role('dialog', name='知识库助手设置', exact=True)
                dialog.get_by_role('button', name='知识库', exact=False).click()
                expect(dialog.get_by_label('长期记忆', exact=True)).to_have_value('salient')
                page.evaluate("window.pmbrainDesktop.saveMemoryWriteback({ mode: 'all' })")
                dialog.get_by_role('button', name='基础信息', exact=False).click()
                dialog.get_by_label('助手描述').fill('记忆与连接验收助手')
                dialog.get_by_role('button', name='保存', exact=True).click()
                expect(dialog).not_to_be_visible()
                assert api('/admin/api/workbench/memory')['mode'] == 'all'
                result['checks'].append('助手配置保存不覆盖其他入口刚更新的记忆开关')
                settings()
                choose('all')
                choose('off')
                third = completed(conversation('以后星河项目每周一开会'))
                assert third['messages'][0]['memory']['status'] == 'off'
                result['checks'].append('三种模式热切换，关闭后新对话不自动写入')
                state_after = page.evaluate('window.pmbrainDesktop.getState()')
                for key in ['pid', 'port', 'startedAt']:
                    if key in state_before:
                        assert state_after.get(key) == state_before[key], (key, state_before, state_after)
                assert state_after['phase'] == 'ready'
                startup_count = sum(path.read_text(encoding='utf-8').count('Starting sidecar on') for path in (home / 'electron-user-data' / 'logs').glob('pmbrain-*.log'))
                assert startup_count == 1, startup_count
                choose('salient')
                original_theme = page.evaluate('window.pmbrainDesktop.getTheme()')['source']
                for theme in ['light', 'dark', original_theme]:
                    state = page.evaluate('(theme) => window.pmbrainDesktop.setTheme(theme)', theme)
                    expect(page.locator('.desktop-settings')).to_have_attribute('data-theme', state['resolved'])
                    expect(page.locator('html')).to_have_attribute('data-theme', state['resolved'])
                    def readable():
                        colors = page.locator('#memory-mode-off-card').evaluate("card => [getComputedStyle(card).backgroundColor, getComputedStyle(card.querySelector('b')).color]")
                        luminance = []
                        for color in colors:
                            channels = [float(value) / 255 for value in re.findall(r'[\d.]+', color)[:3]]
                            luminance.append(sum(weight * (channel / 12.92 if channel <= .04045 else ((channel + .055) / 1.055) ** 2.4) for weight, channel in zip([.2126, .7152, .0722], channels)))
                        return (max(luminance) + .05) / (min(luminance) + .05) >= 4.5
                    until(readable, f'{theme} theme text contrast below 4.5', timeout=5)
                    page.screenshot(path=str(artifacts / f'network-memory-{theme}.png'), full_page=True)
                result['checks'].append('设置卡片与桌面主题一致，浅色、深色和系统模式可切换')
                page.screenshot(path=str(artifacts / 'network-memory.png'), full_page=True)
                result['checks'].append('设置保存过程本地服务未重启')
                assert not errors, errors
                result['pageErrors'] = errors
                result['conversationId'] = first['id']
                result['factId'] = first['messages'][0]['memory']['factIds'][0]
                result['status'] = 'passed'
            finally:
                session.stop()
    finally:
        provider.shutdown()
        provider.server_close()
        (artifacts / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        (artifacts / 'provider-requests.json').write_text(json.dumps(Provider.requests, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    run(parser.parse_args())
