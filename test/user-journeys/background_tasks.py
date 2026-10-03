import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError
import zipfile
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[2]
TOKEN = 'background_task_test_only_12345678901234567890'
waiting = threading.Event()
release = threading.Event()
delay = False


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def response(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.response({'object': 'list', 'data': [{'id': 'task-test', 'object': 'model'}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path.endswith('/embeddings'):
            if delay and 'Delayed synthetic embedding' in json.dumps(body.get('input')):
                waiting.set()
                release.wait(30)
            inputs = body.get('input', [])
            if not isinstance(inputs, list):
                inputs = [inputs]
            self.response({'object': 'list', 'data': [{'object': 'embedding', 'index': i, 'embedding': [1.0] + [0.0] * 1023} for i in range(len(inputs))], 'model': 'task-test', 'usage': {'prompt_tokens': 1, 'total_tokens': 1}})
        else:
            if body.get('stream'):
                chunks = [{'id': 'background-chat', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'task-test', 'choices': [{'index': 0, 'finish_reason': None, 'delta': {'role': 'assistant', 'content': '后台导入期间仍可对话'}}]}, {'id': 'background-chat', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'task-test', 'choices': [{'index': 0, 'finish_reason': 'stop', 'delta': {}}]}]
                data = (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.response({'id': 'background-chat', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'task-test', 'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': '后台导入期间仍可对话'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def run(args):
    global delay
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / 'home'
    config_dir = home / '.pmbrain'
    config_dir.mkdir(parents=True)
    materials = artifacts / 'materials'
    materials.mkdir()
    (materials / 'seed.md').write_text('# Seed\n\nbackground task acceptance seed.', encoding='utf-8')
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    config = {'engine': 'pglite', 'database_path': str(config_dir / 'db'), 'embedding_model': 'custom-openai:task-test', 'embedding_dimensions': 1024, 'chat_model': 'custom-openai:task-test', 'custom_openai_api_key': 'task-only', 'provider_base_urls': {'custom-openai': f'http://127.0.0.1:{provider.server_port}/v1'}, 'model_usage': {'embedding_enabled': True, 'generative_enabled': True}, 'desktop': {'knowledge_directory': str(materials)}}
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY')}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN': TOKEN, 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    for key in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
        env.pop(key, None)
    init = 'import {PGLiteEngine} from "./src/core/pglite-engine.ts"; import {configureGateway} from "./src/core/ai/gateway.ts"; import {loadConfig} from "./src/core/config.ts"; configureGateway({embedding_model:"custom-openai:task-test",embedding_dimensions:1024,env:{}}); const e=new PGLiteEngine(); await e.connect(loadConfig()); await e.initSchema(); await e.disconnect();'
    with (artifacts / 'init.log').open('w', encoding='utf-8') as log:
        subprocess.run([shutil.which('bun'), '--eval', init], cwd=ROOT, env=env, stdout=log, stderr=log, check=True, timeout=60)
    if args.runtime == 'bundled':
        runtime = ROOT / 'desktop/build/extraResources/pmbrain-runtime'
        entry = [str(runtime / 'bun.exe'), str(runtime / 'pmbrain-sidecar.js')]
    elif args.runtime == 'compiled':
        entry = [str(ROOT / 'bin/pmbrain.exe')]
    else:
        entry = [shutil.which('bun'), str(ROOT / 'src/cli.ts')]
    service_port = port()
    origin = f'http://127.0.0.1:{service_port}'
    opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(path, payload=None, raw=None, headers=None):
        data = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        req = Request(origin + path, data=data, headers=headers or {'Content-Type': 'application/json'})
        with opener.open(req, timeout=20) as response:
            if path == '/mcp':
                return response.read().decode('utf-8')
            return json.load(response)

    def start():
        log = (artifacts / f'service-{time.time_ns()}.log').open('w', encoding='utf-8')
        process = subprocess.Popen(entry + ['serve', '--http', '--port', str(service_port), '--suppress-bootstrap-token'], cwd=ROOT, env=env, stdout=log, stderr=log)
        deadline = time.time() + 60
        while time.time() < deadline:
            if process.poll() is not None:
                raise AssertionError('Sidecar exited before startup')
            try:
                request('/health')
                request('/admin/login', {'token': TOKEN})
                return process, log
            except Exception:
                time.sleep(.2)
        raise AssertionError('Sidecar startup timed out')

    def stop(process, log):
        process.terminate()
        process.wait(timeout=20)
        log.close()

    def finished(id):
        deadline = time.time() + 45
        while time.time() < deadline:
            result = request('/admin/api/runs/' + id)
            if result['status'] not in ['queued', 'running']:
                return result
            time.sleep(.15)
        raise AssertionError('Background task timed out: ' + id)

    process, log = start()
    try:
        accepted = request('/admin/api/import-runs', {'path': str(materials / 'seed.md')})
        seed = finished(accepted['runId'])
        assert seed['status'] == 'completed', seed
        assert seed['command'] == [], seed
        assert seed['result']['imported'] == 1
        slow_path = materials / 'slow.md'
        slow_path.write_text('# Slow\n\nDelayed synthetic embedding verifies concurrent application access.', encoding='utf-8')
        delay = True
        slow = request('/admin/api/import-runs', {'path': str(slow_path)})
        assert waiting.wait(15), 'Embedding request was not started'
        snapshot = request('/admin/api/task-center')
        assert not snapshot['pglite_busy']
        assert request('/admin/api/brain/pages/default/seed')['slug'] == 'seed'
        key = request('/admin/api/api-keys', {'name': 'background-read-only', 'scopes': ['read'], 'sourceId': 'default'})
        mcp = request('/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'get_page', 'arguments': {'slug': 'seed'}}}, headers={'Authorization': 'Bearer ' + key['token'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        assert 'acceptance seed' in json.dumps(mcp), mcp
        search = request('/mcp', {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'search', 'arguments': {'query': 'acceptance seed', 'limit': 5}}}, headers={'Authorization': 'Bearer ' + key['token'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        assert 'acceptance seed' in search, search
        conversation = request('/admin/api/workbench/conversations', {'model': 'custom-openai:task-test', 'knowledge': False})
        request('/admin/api/workbench/conversations/' + conversation['id'] + '/messages', {'text': '请确认后台任务期间仍可对话', 'knowledge': False})
        deadline = time.time() + 15
        while time.time() < deadline:
            chat = request('/admin/api/workbench/conversations/' + conversation['id'])
            if any(message['role'] == 'assistant' and '仍可对话' in message['text'] for message in chat['messages']):
                break
            time.sleep(.15)
        else:
            raise AssertionError('Chat did not finish while import was waiting')
        request('/admin/api/runs/' + slow['runId'] + '/cancel', {})
        assert finished(slow['runId'])['status'] == 'cancelled'
        delay = False
        release.set()
        try:
            request('/admin/api/brain/pages/default/slow')
            raise AssertionError('Cancelled import wrote a late page')
        except HTTPError as error:
            assert error.code == 404
        pdf = artifacts / 'office.pdf'
        document = canvas.Canvas(str(pdf))
        document.drawString(72, 720, 'Background PDF task acceptance content.')
        document.save()
        docx = artifacts / 'office.docx'
        with zipfile.ZipFile(docx, 'w') as archive:
            archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Background DOCX task acceptance.</w:t></w:r></w:p></w:body></w:document>')
        for file in [pdf, docx]:
            upload = request('/admin/api/import-upload-runs', raw=file.read_bytes(), headers={'Content-Type': 'application/octet-stream', 'x-pmbrain-filename': quote(file.name)})
            result = finished(upload['runId'])
            assert result['status'] == 'completed', result
        quick = request('/admin/api/dream-runs', {'preset': 'quick', 'dryRun': True})
        assert finished(quick['runId'])['status'] == 'completed'
        deep = request('/admin/api/dream-runs', {'preset': 'full', 'dryRun': True})
        assert finished(deep['runId'])['status'] == 'completed'
        missing = request('/admin/api/import-runs', {'path': str(materials / 'missing.md')})
        assert finished(missing['runId'])['status'] == 'failed'
        (materials / 'missing.md').write_text('# Recovered\n\nExplicit retry now imports this source.', encoding='utf-8')
        retry = request('/admin/api/runs/' + missing['runId'] + '/retry', {})
        assert finished(retry['runId'])['status'] == 'completed'
        if not args.no_browser:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel='msedge', headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                context.request.post(origin + '/admin/login', data={'token': TOKEN})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin + '/admin/#tasks')
                page.wait_for_load_state('networkidle')
                page.get_by_role('heading', name='任务中心', exact=True).wait_for()
                page.get_by_text('导入 1 · 跳过 0 · 失败 0', exact=True).first.wait_for()
                page.get_by_role('button', name='重新执行', exact=True).first.wait_for()
                page.get_by_role('button', name='查看详情', exact=True).first.click()
                page.get_by_role('heading', name='执行结果', exact=True).wait_for()
                page.screenshot(path=str(artifacts / 'tasks.png'), full_page=True)
                assert not errors, errors
                browser.close()
        stop(process, log)
        process, log = start()
        assert finished(seed['id'])['result']['imported'] == 1
        assert request('/admin/api/brain/pages/default/seed')['slug'] == 'seed'
        assert request('/admin/api/workbench/conversations/' + conversation['id'])['messages'][-1]['text'] == '后台导入期间仍可对话'
        checks = ['native_import', 'slow_model_database_read', 'concurrent_mcp_read_search', 'concurrent_chat', 'cancel_no_late_write', 'PDF', 'DOCX', 'quick', 'full_dry_run', 'explicit_retry', 'restart_history', 'restart_chat']
        if not args.no_browser:
            checks.append('task_center_browser')
        (artifacts / 'result.json').write_text(json.dumps({'runtime': args.runtime, 'passed': True, 'checks': checks}, ensure_ascii=False), encoding='utf-8')
        print('Background task journey passed: ' + args.runtime)
    finally:
        delay = False
        release.set()
        if process.poll() is None:
            stop(process, log)
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    parser.add_argument('--runtime', choices=['source', 'bundled', 'compiled'], default='source')
    parser.add_argument('--no-browser', action='store_true')
    run(parser.parse_args())
