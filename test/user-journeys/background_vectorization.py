import argparse
import json
import os
import shutil
import subprocess
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import background_tasks as tasks


def run(args):
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / 'home'
    materials = home / 'materials'
    materials.mkdir(parents=True)
    config_dir = home / '.pmbrain'
    config_dir.mkdir()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), tasks.Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    version = json.loads((tasks.ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version']
    config = {'engine': 'pglite', 'database_path': str(home / 'database'), 'embedding_model': 'custom-openai:task-test', 'embedding_dimensions': 1024, 'chat_model': 'custom-openai:task-test', 'custom_openai_api_key': 'task-only', 'provider_base_urls': {'custom-openai': f'http://127.0.0.1:{provider.server_port}/v1'}, 'model_usage': {'embedding_enabled': True, 'generative_enabled': True}, 'desktop': {'setup_completed': True, 'main_source_path_repair_completed': True, 'last_migrated_version': version, 'knowledge_directory': str(materials)}}
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY')}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN': tasks.TOKEN, 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    for key in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
        env.pop(key, None)
    init = 'import {PGLiteEngine} from "./src/core/pglite-engine.ts"; import {loadConfig} from "./src/core/config.ts"; import {configureGateway} from "./src/core/ai/gateway.ts"; configureGateway({embedding_model:"custom-openai:task-test",embedding_dimensions:1024,env:{}}); const e=new PGLiteEngine(); await e.connect(loadConfig()); await e.initSchema(); await e.setConfig("dream.entity_capture.enabled","false"); await e.disconnect();'
    with (artifacts / 'init.log').open('w', encoding='utf-8') as log:
        subprocess.run([shutil.which('bun'), '--eval', init], cwd=tasks.ROOT, env=env, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
    service_port = tasks.port()
    origin = f'http://127.0.0.1:{service_port}'
    runtime = tasks.ROOT / 'desktop/build/extraResources/pmbrain-runtime'
    entry = [str(runtime / 'bun.exe'), str(runtime / 'pmbrain-sidecar.js')] if args.runtime == 'bundled' else [shutil.which('bun'), str(tasks.ROOT / 'src/cli.ts')]
    process = None
    browser = None
    session = None
    log = (artifacts / 'service.log').open('w', encoding='utf-8')
    tasks.waiting.clear()
    tasks.release.clear()
    tasks.delay = True
    try:
        if not args.desktop:
            process = subprocess.Popen(entry + ['serve', '--http', '--port', str(service_port), '--suppress-bootstrap-token'], cwd=tasks.ROOT, env=env, stdout=log, stderr=log)
        with sync_playwright() as playwright:
            if args.desktop:
                from core_journeys import DesktopSession
                session = DesktopSession(playwright, artifacts, home)
                previous_env = dict(os.environ)
                try:
                    os.environ.clear()
                    os.environ.update(env)
                    page = session.start()
                finally:
                    os.environ.clear()
                    os.environ.update(previous_env)
                page.evaluate("""async () => {
                  const deadline = Date.now() + 120000;
                  while (Date.now() < deadline) {
                    const state = await window.pmbrainDesktop.getState();
                    if (state?.phase === 'ready') return;
                    if (state?.phase === 'failed') throw new Error(state.message);
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }
                  throw new Error('Desktop service did not become ready');
                }""")
                page.set_viewport_size({'width': 1440, 'height': 1000})
            else:
                browser = playwright.chromium.launch(channel='msedge', headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                context.add_init_script("localStorage.setItem('pmbrain.admin.theme-mode','dark')")
                deadline = time.monotonic() + 90
                while True:
                    try:
                        if context.request.post(origin + '/admin/login', data={'token': tasks.TOKEN}, timeout=1500).status < 400:
                            break
                    except Exception:
                        pass
                    if time.monotonic() > deadline or process.poll() is not None:
                        raise AssertionError('Synthetic service did not start')
                    time.sleep(.2)
                page = context.new_page()

            def api(path, body=None):
                if args.desktop:
                    result = page.evaluate("async ({path, body}) => window.pmbrainDesktop.productRequest({path, method:body == null ? 'GET' : 'POST', headers:{'Content-Type':'application/json'}, ...(body == null ? {} : {body:JSON.stringify(body)})})", {'path': path, 'body': body})
                    assert 200 <= result['status'] < 300, (path, result)
                    return json.loads(result['body']) if result['status'] != 204 else None
                response = context.request.get(origin + path, timeout=10000) if body is None else context.request.post(origin + path, data=body, timeout=10000)
                assert response.ok, (path, response.status, response.text())
                return response.json() if response.status != 204 else None

            def navigate(route):
                if args.desktop:
                    page.evaluate('(route) => { location.hash = route }', route)
                else:
                    page.goto(origin + '/admin/#' + route)

            def sample(busy=False):
                api('/admin/api/console/background-resources', {'bytes': 1024 ** 3, 'availableBytes': 256 * 1024 ** 2 if busy else 12 * 1024 ** 3, 'totalBytes': 16 * 1024 ** 3, 'systemIdleSeconds': 120})

            def runs():
                value = api('/admin/api/runs?summary=1')
                return value if isinstance(value, list) else value['rows']

            def until(check, label, timeout=60):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    value = check()
                    if value:
                        return value
                    time.sleep(.25)
                raise AssertionError(label)

            def vector(status=None):
                return next((row for row in runs() if row.get('searchOptimize') and (not status or row['status'] == status)), None)

            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            sample(True)
            navigate('data')
            page.get_by_role('heading', name='知识库', exact=True).wait_for()

            def upload(name, title, content):
                navigate('data')
                page.get_by_role('button', name='添加资料', exact=True).click()
                page.locator('.materials-drawer input[type=file]').set_input_files({'name': name, 'mimeType': 'text/markdown', 'buffer': f'# {title}\n\n{content}'.encode()})
                started = time.monotonic()
                page.get_by_role('button', name='导入 1 项', exact=True).click()
                imported = until(lambda: next((row for row in runs() if row['kind'] == 'import_path' and row.get('product', {}).get('material', {}).get('name') == name and row['status'] == 'completed'), None), 'Import did not finish before embeddings')
                elapsed = time.monotonic() - started
                assert '导入成功' in imported['product']['stage'], imported
                page.get_by_role('button', name='关闭添加资料', exact=True).click()
                return elapsed

            first_seconds = upload('idle-first.md', '空闲向量化测试', 'Delayed synthetic embedding verifies that original material is saved before vectors.')
            assert not tasks.waiting.is_set(), 'Busy machine should not start embeddings'
            queued = until(lambda: vector('queued'), 'Missing waiting vector task')
            assert queued['product']['name'] == '知识向量化'
            expect(page.locator('.product-task-activity')).to_contain_text('知识向量化')
            navigate('tasks')
            row = page.locator('tbody tr').filter(has_text='知识向量化').first
            expect(row).to_contain_text('等待空闲')
            page.screenshot(path=str(artifacts / 'waiting.png'), full_page=True)
            row.get_by_role('button', name='暂停', exact=True).click()
            until(lambda: vector('paused'), 'Manual pause was not saved')
            page.reload()
            row = page.locator('tbody tr').filter(has_text='知识向量化').first
            expect(row).to_contain_text('已暂停')
            sample()
            upload('idle-second.md', '暂停时继续导入', 'Another synthetic original is saved during manual pause.')
            assert vector('paused'), 'New import must preserve manual pause'
            assert not tasks.waiting.is_set()
            navigate('tasks')
            row = page.locator('tbody tr').filter(has_text='知识向量化').first
            row.get_by_role('button', name='继续', exact=True).click()
            until(lambda: (sample(), tasks.waiting.is_set())[1], 'Idle vectorization did not start')
            assert vector('running')
            page.screenshot(path=str(artifacts / 'vectorizing.png'), full_page=True)
            slow_seconds = upload('idle-third.md', '慢模型期间导入', 'The foreground remains usable while the local embedding model is slow.')
            assert not tasks.release.is_set()
            conversation = api('/admin/api/workbench/conversations', {'model': 'custom-openai:task-test', 'knowledge': False})
            api('/admin/api/workbench/conversations/' + conversation['id'] + '/messages', {'text': '请确认后台任务期间仍可对话', 'knowledge': False})
            until(lambda: any(message['role'] == 'assistant' and '仍可对话' in message['text'] for message in api('/admin/api/workbench/conversations/' + conversation['id'])['messages']), 'Chat blocked by embedding request')
            tasks.delay = False
            tasks.release.set()
            until(lambda: (sample(), vector('completed'))[1], 'Vectorization did not finish', timeout=90)
            navigate('data')
            page.reload()
            counts = {}
            for title in ['空闲向量化测试', '暂停时继续导入', '慢模型期间导入']:
                material = page.get_by_role('row', name='查看 ' + title, exact=True)
                material.wait_for()
                chunks = int(material.locator('td').nth(3).inner_text())
                embedded, total = map(int, material.locator('td').nth(4).inner_text().split('/'))
                assert chunks > 0 and embedded == total == chunks
                counts[title] = [embedded, total]
            page.screenshot(path=str(artifacts / 'completed.png'), full_page=True)
            assert not errors, errors
            (artifacts / 'result.json').write_text(json.dumps({'passed': True, 'runtime': args.runtime, 'desktop': args.desktop, 'version': version, 'import_seconds': first_seconds, 'import_during_slow_model_seconds': slow_seconds, 'vectors': counts, 'checks': ['import_success_before_vectors', 'automatic_idle_wait', 'pause_and_reload', 'new_import_preserves_pause', 'continue', 'foreground_import_and_chat_during_slow_model', 'vectors_saved_and_reloaded', 'no_page_errors']}, ensure_ascii=False, indent=2), encoding='utf-8')
            print('Background vectorization journey passed')
            if session:
                session.stop()
                session = None
            if browser:
                browser.close()
                browser = None
    finally:
        tasks.delay = False
        tasks.release.set()
        if session:
            session.stop()
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        log.close()
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    parser.add_argument('--runtime', choices=['source', 'bundled'], default='source')
    parser.add_argument('--desktop', action='store_true')
    run(parser.parse_args())
