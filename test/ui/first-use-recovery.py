import argparse
import json
import threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect


def run(url, output):
    script = (Path(__file__).parent / 'fixtures/first-use.js').read_text(encoding='utf-8')
    checks = []
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)

        def page_for(options):
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script('window.PMBRAIN_TEST_OPTIONS = ' + json.dumps(options) + ';\n' + script)
            return page

        page = page_for({'failSetup': True})
        page.goto(url + '#home')
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('button', name='重试读取配置', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='+ 创建我的知识库 →', exact=True)).to_have_count(0)
        page.screenshot(path=str(output / 'read-failed.png'), full_page=True)
        page.evaluate('fixture.failSetup = false')
        page.get_by_role('button', name='重试读取配置', exact=True).click()
        expect(page.get_by_role('heading', name='你好，开始探索你的知识', exact=True)).to_be_visible()
        assert page.evaluate('fixture.saves.length') == 0
        checks.append('老用户读取失败可重试，不新建或保存数据库')
        page.evaluate("location.hash = 'settings-system'")
        expect(page.locator('#network-mode-shared')).to_be_visible()
        page.locator('#network-mode-shared').check()
        page.locator('#shared-address').select_option('network-0')
        page.evaluate("location.hash = 'settings-general'; fixture.behaviorDelay = 300")
        expect(page.locator('#launch-at-login')).to_be_visible()
        page.locator('#launch-at-login').check()
        page.locator('#start-minimized').check()
        expect(page.locator('#desktop-behavior-note')).to_have_text('已保存')
        expect(page.locator('#launch-at-login')).to_be_checked()
        expect(page.locator('#start-minimized')).to_be_checked()
        assert page.evaluate('fixture.behaviorSaves.at(-1).startMinimized') is True
        page.evaluate("location.hash = 'settings-system'")
        expect(page.locator('#network-mode-shared')).to_be_checked()
        expect(page.locator('#shared-address')).to_have_value('network-0')
        checks.append('快速连改保存最后选择，系统事件保留未保存的网络草稿')
        page.evaluate("location.hash = 'settings-general'; fixture.behaviorFailure = true; fixture.behaviorDelay = 0")
        page.locator('#close-to-tray').uncheck()
        expect(page.locator('#desktop-behavior-retry')).to_be_visible()
        expect(page.locator('#close-to-tray')).not_to_be_checked()
        expect(page.get_by_role('button', name='重试读取配置', exact=True)).to_have_count(0)
        expect(page.locator('#launch-at-login')).to_be_enabled()
        page.evaluate('fixture.behaviorFailure = false')
        page.locator('#desktop-behavior-retry').click()
        expect(page.locator('#desktop-behavior-note')).to_have_text('已保存')
        expect(page.locator('#close-to-tray')).not_to_be_checked()
        checks.append('保存失败保留选择，手动重试成功')
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(page.locator('#close-to-tray')).not_to_be_checked()
        expect(page.get_by_role('button', name='重试读取配置', exact=True)).to_have_count(0)
        expect(page.locator('#launch-at-login')).to_be_enabled()
        checks.append('刷新后从桥接层重新读取已保存的启动选项')
        page.screenshot(path=str(output / 'settings.png'), full_page=True)
        page.close()

        page = page_for({'needsSetup': True})
        page.goto(url + '#create')
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='创建并继续', exact=True).click()
        expect(page.get_by_role('heading', name='基础配置', exact=True)).to_be_visible()
        assert page.evaluate('fixture.saves.length') == 1
        page.get_by_role('button', name='稍后配置', exact=True).click()
        page.get_by_label('选择文件', exact=True).set_input_files([{'name': 'first.md', 'mimeType': 'text/markdown', 'buffer': b'first'}, {'name': 'scan.md', 'mimeType': 'text/markdown', 'buffer': b'second'}])
        page.get_by_role('button', name='开始导入', exact=True).click()
        expect(page.get_by_role('button', name='继续未完成项', exact=True)).to_be_visible()
        assert page.evaluate('fixture.uploads.length') == 2
        page.get_by_role('button', name='继续未完成项', exact=True).click()
        expect(page.get_by_role('heading', name='知识库已经可以使用', exact=True)).to_be_visible()
        assert page.evaluate('fixture.uploads.length') == 2
        assert page.evaluate('fixture.retries') == ['task-2']
        checks.append('首次使用从创建到导入；第二份失败仅重试原任务，不重传已完成资料')
        page.screenshot(path=str(output / 'created.png'), full_page=True)
        page.close()
        assert not errors, errors
        browser.close()
    (output / 'result.json').write_text(json.dumps({'checks': checks, 'pageErrors': errors, 'backend': 'isolated preload fixture; no formal database'}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'checks': checks, 'pageErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    parser.add_argument('--url', default='')
    args = parser.parse_args()
    output = Path(args.artifacts_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)
    server = None
    if not args.url:
        class Assets(SimpleHTTPRequestHandler):
            def __init__(self, *values, **kwargs):
                super().__init__(*values, directory=str(Path(__file__).resolve().parents[2] / 'admin/dist'), **kwargs)

            def translate_path(self, path):
                return super().translate_path(path.replace('/admin/', '/', 1))

            def log_message(self, *values):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Assets)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        args.url = f'http://127.0.0.1:{server.server_port}/admin/'
    try:
        run(args.url, output)
    finally:
        if server:
            server.shutdown()
            server.server_close()
