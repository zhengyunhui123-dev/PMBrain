import copy
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

from playwright.sync_api import expect, sync_playwright


url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5298/admin/'
target = urlparse(url)
assert target.hostname == '127.0.0.1' and target.port == 5298, '仅允许隔离预览端口 5298'
url = url.split('#')[0].rstrip('/') + '/'
output = Path('.codex/design-refresh')
output.mkdir(parents=True, exist_ok=True)
checks = []
errors = []
requests = []
actual_runs = []
prompts = []


def sample(identifier, name, kind, status, percent, stage, metrics=None):
    return {
        'id': identifier, 'kind': kind, 'trigger': 'manual', 'status': status,
        'command': [], 'stdout': '', 'stderr': '', 'exitCode': 0 if status == 'completed' else None,
        'error': '隔离样例中的失败原因' if status == 'failed' else None,
        'startedAt': '2026-10-29T03:00:00.000Z',
        'completedAt': None if status in ['running', 'queued'] else '2026-10-29T03:01:00.000Z',
        'durationMs': None if status in ['running', 'queued'] else 60000,
        'result': {},
        'product': {
            'name': name, 'stage': stage, 'percent': percent, 'phasePercent': percent,
            'completedSteps': 1, 'steps': [
                {'id': 'sync', 'label': '同步资料', 'status': 'completed', 'phases': []},
                {'id': 'link', 'label': '建立关联', 'status': 'completed' if status == 'completed' else 'running' if status == 'running' else 'pending', 'phases': []},
            ],
            'processed': 4, 'total': 10, 'file': None, 'metrics': metrics or [],
            'errorReason': '隔离样例中的失败原因' if status == 'failed' else None,
        },
    }


fixture_rows = [
    sample('task-fixture-running', '快速维护·处理中', 'dream_quick', 'running', 40, '正在建立知识关联'),
    sample('task-fixture-completed', 'AI深度整理·已完成', 'dream_full', 'completed', 100, '本轮整理完成', [{'label': '新增知识', 'value': 3}]),
    sample('task-fixture-stopped', '快速维护·未完成', 'dream_quick', 'cancelled', 35, '已停止，已完成成果保留'),
    sample('task-fixture-failed', 'AI深度整理·失败', 'dream_full', 'failed', 20, '整理失败'),
]


def route_tasks(route):
    request = route.request
    path = unquote(urlparse(request.url).path)
    method = request.method
    if path == '/admin/api/dream-runs' and method == 'POST':
        body = request.post_data_json
        requests.append({'source': 'browser fixture', 'method': method, 'path': path, 'body': body})
        preset = body['preset']
        run = sample('task-fixture-created-' + preset, '新建' + ('快速维护' if preset == 'quick' else 'AI深度整理'), 'dream_' + preset, 'running', 10, '准备处理资料')
        fixture_rows.insert(0, run)
        route.fulfill(json={'runId': run['id'], 'status': 'running'})
        return
    if path == '/admin/api/runs' and method == 'GET':
        route.fulfill(json={'rows': fixture_rows})
        return
    prefix = '/admin/api/runs/'
    if path.startswith(prefix):
        parts = path[len(prefix):].split('/')
        run = next((item for item in fixture_rows if item['id'] == parts[0]), None)
        if run is None:
            route.fulfill(status=404, json={'error': 'Fixture task not found'})
            return
        if method == 'GET' and len(parts) == 1:
            route.fulfill(json=run)
            return
        if method == 'POST' and len(parts) == 2:
            requests.append({'source': 'browser fixture', 'method': method, 'path': path})
            if parts[1] == 'cancel':
                run['status'] = 'cancelled'
                run['product']['stage'] = '已停止，已完成成果保留'
                run['completedAt'] = datetime.now(timezone.utc).isoformat()
                route.fulfill(json={'ok': True})
                return
            if parts[1] == 'retry':
                resumed = copy.deepcopy(run)
                resumed['id'] = run['id'] + '-resumed'
                resumed['status'] = 'running'
                resumed['completedAt'] = None
                resumed['product']['stage'] = '继续未完成部分'
                fixture_rows.insert(0, resumed)
                route.fulfill(json={'runId': resumed['id'], 'status': 'running'})
                return
    route.continue_()


def row(page, name):
    return page.get_by_role('row', name='查看' + name + '任务', exact=True)


def action_count(action):
    return sum(item['path'].endswith('/' + action) for item in requests)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    real_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = real_context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(url + '#dream')
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading', name='知识整理', exact=True)).to_be_visible()
        expect(page.locator('.maintenance-automation')).not_to_contain_text('正在读取')
        checks.append('真实隔离 API：页面与自动整理设置读取成功')
        for preset, label in [('quick', '快速维护'), ('full', 'AI 深度整理')]:
            with page.expect_response(lambda response: '/admin/api/dream-runs' in response.url and response.request.method == 'POST') as accepted_response:
                page.get_by_role('button', name=label, exact=True).click()
            accepted = accepted_response.value.json()
            assert accepted_response.value.ok, accepted
            run_id = accepted['runId']
            deadline = time.monotonic() + 50
            run = None
            while time.monotonic() < deadline:
                response = real_context.request.get(url + 'api/runs/' + run_id)
                assert response.ok, response.text()
                run = response.json()
                if run['status'] not in ['queued', 'running']:
                    break
                page.wait_for_timeout(250)
            assert run and run['status'] not in ['queued', 'running'], run
            name = run.get('product', {}).get('name', label)
            state = 'AI 提炼未执行' if 'AI 提炼未执行' in run.get('product', {}).get('stage', '') else {'completed': '本轮已完成', 'failed': '失败', 'cancelled': '已停止'}[run['status']]
            actual_runs.append({
                'source': 'real isolated API', 'preset': preset, 'runId': run_id,
                'status': run['status'], 'stage': run.get('product', {}).get('stage'),
                'error': run.get('error'), 'body': accepted_response.value.request.post_data_json,
                'skippedPhases': [
                    {'phase': phase['phase'], 'reason': phase.get('details', {}).get('reason')}
                    for phase in (run.get('result') or {}).get('phases', []) if phase['status'] == 'skipped'
                ],
                'modelCalls': (run.get('result') or {}).get('budget', {}).get('calls'),
            })
            expect(row(page, name).locator('.maintenance-run-state').first).to_have_text(state, timeout=8000)
            checks.append('真实隔离 API：' + label + '发起后轮询与页面终态一致')
        page.screenshot(path=str(output / 'maintenance-real-api.png'), full_page=True)
        real_context.close()

        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        context.route('**/admin/api/runs**', route_tasks)
        context.route('**/admin/api/dream-runs', route_tasks)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url + '#dream')
        page.wait_for_load_state('networkidle')
        rows = page.locator('.maintenance-run-row')
        expect(rows).to_have_count(4)
        expect(page.locator('.maintenance-run-list th')).to_have_text(['任务', '状态', '处理进度', '时间', '操作'])
        expect(row(page, '快速维护·处理中').get_by_role('progressbar')).to_have_attribute('aria-valuenow', '40')
        expect(row(page, 'AI深度整理·已完成').get_by_role('progressbar')).to_have_count(0)
        expect(row(page, 'AI深度整理·已完成')).to_contain_text('新增知识 3')
        expect(row(page, 'AI深度整理·失败')).to_contain_text('隔离样例中的失败原因')
        for value, count in [('active', 1), ('completed', 1), ('unfinished', 2), ('all', 4)]:
            page.get_by_label('整理任务状态', exact=True).select_option(value)
            expect(rows).to_have_count(count)
        checks.append('浏览器样例：四类状态、进度、完成成果、失败原因及四项筛选')
        page.screenshot(path=str(output / 'maintenance-fixture-list.png'), full_page=True)

        active = row(page, '快速维护·处理中')
        stop = page.locator('.maintenance-stop-dialog')
        detail = page.locator('.maintenance-task-dialog:not(.maintenance-stop-dialog)')
        active.get_by_role('button', name='停止', exact=True).click()
        expect(stop).to_contain_text('停止任务不会删除已经完成的成果')
        expect(stop).to_contain_text('40%')
        stop_box = stop.bounding_box()
        assert stop_box and stop_box['height'] < 500, stop_box
        page.screenshot(path=str(output / 'maintenance-stop-confirm.png'))
        stop.get_by_role('button', name='继续运行', exact=True).click()
        expect(stop).not_to_be_visible()
        assert action_count('cancel') == 0
        active.get_by_role('button', name='停止', exact=True).click()
        page.keyboard.press('Escape')
        expect(stop).not_to_be_visible()
        assert action_count('cancel') == 0
        active.get_by_role('button', name='停止', exact=True).click()
        stop.get_by_role('button', name='确认停止', exact=True).click()
        expect(stop).not_to_be_visible()
        expect(active.locator('.maintenance-run-state')).to_have_text('已停止')
        expect(active.get_by_role('progressbar')).to_have_attribute('aria-valuenow', '40')
        assert action_count('cancel') == 1
        checks.append('浏览器样例：停止弹窗保留进度，取消和 Escape 不提交，确认仅提交一次')

        active.get_by_role('button', name='查看快速维护·处理中详情', exact=True).click()
        expect(detail).to_be_visible()
        def dismiss(prompt):
            prompts.append(prompt.message)
            prompt.dismiss()
        page.once('dialog', dismiss)
        detail.get_by_role('button', name='继续未完成任务', exact=True).click()
        assert action_count('retry') == 0
        assert '费用' in prompts[-1] and '已完成资料' in prompts[-1]
        def accept(prompt):
            prompts.append(prompt.message)
            prompt.accept()
        page.once('dialog', accept)
        detail.get_by_role('button', name='继续未完成任务', exact=True).click()
        expect(page).to_have_url(url + '#dream?run=task-fixture-running-resumed')
        expect(detail).to_contain_text('继续未完成部分')
        assert action_count('retry') == 1
        detail.get_by_role('button', name='停止任务', exact=True).click()
        expect(stop).to_be_visible()
        stop.get_by_role('button', name='继续运行', exact=True).click()
        expect(detail).to_be_visible()
        page.screenshot(path=str(output / 'maintenance-detail-dialog.png'))
        page.keyboard.press('Escape')
        expect(detail).not_to_be_visible()
        expect(page).to_have_url(url + '#dream')
        checks.append('浏览器样例：详情继续费用确认、取消/提交、新任务定位、详情停止取消和 Escape')

        for preset, label in [('quick', '快速维护'), ('full', 'AI 深度整理')]:
            page.get_by_role('button', name=label, exact=True).click()
            expect(row(page, '新建' + ('快速维护' if preset == 'quick' else 'AI深度整理'))).to_be_visible()
            body = next(item['body'] for item in requests if item['path'] == '/admin/api/dream-runs' and item['body']['preset'] == preset)
            assert body['dryRun'] is False and body['allSources'] is (preset == 'quick'), body
            if preset == 'quick':
                assert 'sourceId' not in body, body
            else:
                overview = context.request.get(url + 'api/brain/overview').json()
                assert body['sourceId'] == overview['main_source_id'], body
        checks.append('浏览器样例：快速维护全 Source、深度整理主 Source，均提交 dryRun=false')

        page.reload()
        page.wait_for_load_state('networkidle')
        expect(row(page, '快速维护·处理中').filter(has=page.locator('.maintenance-state-cancelled'))).to_have_count(1)
        page.get_by_role('button', name='整理设置', exact=True).click()
        expect(page).to_have_url(url + '#settings-dream')
        expect(page.locator('.product-app')).to_have_attribute('data-page', 'settings-dream')
        page.locator('.settings-topbar').get_by_role('button', name='返回', exact=True).click()
        expect(page.locator('.product-app')).to_have_attribute('data-page', 'dream')
        page.get_by_role('button', name='全部后台任务', exact=True).click()
        expect(page).to_have_url(url + '#tasks')
        expect(page.locator('.product-app')).to_have_attribute('data-page', 'tasks')
        page.goto(url + '#dream?run=task-fixture-failed')
        page.wait_for_load_state('networkidle')
        expect(page.locator('.product-app')).to_have_attribute('data-page', 'dream')
        expect(detail).to_contain_text('隔离样例中的失败原因')
        detail.get_by_role('button', name='查看任务', exact=True).click()
        expect(page).to_have_url(url + '#tasks?run=task-fixture-failed')
        checks.append('浏览器样例：重载保留结果、设置/后台任务跳转和详情深链接')
        page.goto(url + '#dream')
        page.wait_for_load_state('networkidle')
        page.set_viewport_size({'width': 1034, 'height': 612})
        expect(page.get_by_role('button', name='快速维护', exact=True)).to_be_visible()
        expect(page.get_by_label('整理任务状态', exact=True)).to_be_visible()
        page.screenshot(path=str(output / 'maintenance-fixture-1034.png'), full_page=True)
        row(page, '新建快速维护').get_by_role('button', name='停止', exact=True).click()
        expect(stop).to_be_visible()
        stop_box = stop.bounding_box()
        assert stop_box and 0 <= stop_box['y'] and stop_box['y'] + stop_box['height'] <= 612 and stop_box['height'] < 500, stop_box
        expect(stop.get_by_role('button', name='确认停止', exact=True)).to_be_in_viewport()
        expect(stop.get_by_role('button', name='继续运行', exact=True)).to_be_in_viewport()
        page.screenshot(path=str(output / 'maintenance-stop-1034.png'))
        stop.get_by_role('button', name='继续运行', exact=True).click()
        checks.append('浏览器样例：1034x612 桌面入口与筛选可用，停止确认内容高度及底部按钮完整可见')
        assert not errors, errors
        print(json.dumps({'passed': len(checks), 'checks': checks, 'actualRuns': actual_runs}, ensure_ascii=False, indent=2))
    except Exception:
        page.screenshot(path=str(output / 'maintenance-failure.png'), full_page=True)
        raise
    finally:
        (output / 'maintenance-receipt.json').write_text(json.dumps({
            'url': url, 'checks': checks, 'actualRuns': actual_runs,
            'fixtureRequests': requests, 'confirmPrompts': prompts, 'pageErrors': errors,
            'boundary': '真实 API 仅指隔离 Vite 5298 / API 3298；浏览器样例仅拦截任务列表、详情、停止、继续及发起请求，不证明后台执行。',
        }, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
