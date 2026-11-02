import json
import re
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

base = 'http://127.0.0.1:5398'
output = Path('.codex/maintenance-round-ui')
output.mkdir(parents=True, exist_ok=True)
checks = []
errors = []
snapshots = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script("localStorage.setItem('pmbrain.admin.theme-mode','light')")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/admin/#dream')
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='快速维护', exact=True).click()
    row = page.locator('.maintenance-run-row').filter(has_text='快速维护').first
    expect(row).to_be_visible()
    row.get_by_role('button', name='查看快速维护详情', exact=True).click()
    dialog = page.get_by_role('dialog', name='快速维护详情', exact=True)
    expect(dialog.locator('.mpr-summary')).to_be_visible()
    run_id = None
    late_added = False
    deadline = time.monotonic() + 120
    last_percent = None
    while time.monotonic() < deadline:
        rows = page.request.get(base + '/admin/api/task-center').json()['rows']
        runs = [run for run in rows if run['kind'] == 'dream_quick']
        if not runs:
            time.sleep(.2)
            continue
        current = runs[0]
        run_id = current['id']
        round_state = current.get('product', {}).get('maintenance')
        if round_state and round_state['scan']['complete']:
            assert round_state['scan']['incremental'] == 12, round_state
            assert round_state['scan']['total'] == 12, round_state
            if not late_added:
                assert current['status'] == 'running', current['status']
                page.request.post(base + '/fixture/add-late')
                late_added = True
            snapshots.append({'stage': round_state['stage'], 'imported': current['product'].get('syncFiles', {}).get('completed', 0)})
            bar = dialog.get_by_role('progressbar', name='快速维护整体进度', exact=True)
            percent = bar.get_attribute('aria-valuenow')
            if percent is not None:
                percent = float(percent)
                if last_percent is not None:
                    assert percent >= last_percent, (last_percent, percent)
                last_percent = percent
            if current['status'] == 'running' and round_state['stage'] == 'sync':
                visible = dialog.locator('.maintenance-round-progress').evaluate("el=>({stage:el.querySelector('.mpr-current h4')?.textContent||'',totals:[...el.querySelectorAll('.mpr-totals dd')].at(-1)?.textContent||'',queue:el.querySelector('.mpr-current .mpr-work-queue')?.textContent||''})")
                if '扫描与导入' in visible['stage']:
                    totals = re.findall(r'\d+', visible['totals'])
                    queue = re.findall(r'\d+', visible['queue'])
                    if len(totals) == 2 and len(queue) == 3:
                        assert int(totals[0]) + sum(map(int, queue)) == int(totals[1]), (totals, queue)
                page.screenshot(path=str(output / 'light-importing.png'))
        if current['status'] not in ['running', 'queued']:
            assert current['status'] == 'completed', current
            break
        time.sleep(.25)
    else:
        raise AssertionError('真实快速维护超时')
    assert late_added and run_id
    expect(dialog.locator('.mpr-results .mpr-result-row')).to_have_count(3)
    expect(dialog.locator('.mpr-results')).to_contain_text('2 个已有实体')
    expect(dialog.locator('.mpr-overall').first).to_have_attribute('aria-valuenow', '100')
    assert len(current['product']['maintenance']['stages']) == 3
    assert current['product']['database']['writes'] > 0, current['product']['database']
    assert not any(item['slug'] == 'arrived-later' for item in page.request.get(base + '/fixture/pages').json())
    checks.append('真实API：12份固定增量、整体进度递增、途中新增资料留待下一轮')
    checks.append('真实数据库：关联2个已有实体，导入/关联/页面检查结果及数据库请求统计保存')

    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        rows = page.request.get(base + '/admin/api/task-center').json()['rows']
        vectors = [run for run in rows if run['kind'] == 'embed_stale']
        if vectors and all(run['status'] == 'completed' for run in vectors):
            assert all(run['product']['vectorTotals']['completed'] == run['product']['vectorTotals']['total'] for run in vectors)
            assert all(run['product']['vectorTotals']['windowMs'] <= 1800000 for run in vectors)
            break
        assert not any(run['status'] == 'failed' for run in vectors), vectors
        time.sleep(.3)
    else:
        raise AssertionError('真实后台向量任务超时')
    expect(dialog.locator('.mpr-vector')).to_contain_text('已完成')
    fixture = page.request.get(base + '/fixture').json()
    assert fixture['modelCalls'] == 0 and fixture['vectorCalls'] > 0, fixture
    checks.append('真实后台向量：本轮分块统计完整、窗口不超过30分钟、没有生成模型调用')

    for theme in ['light', 'dark']:
        page.evaluate("theme=>{localStorage.setItem('pmbrain.admin.theme-mode',theme)}", theme)
        page.reload()
        page.wait_for_load_state('networkidle')
        dialog = page.get_by_role('dialog', name='快速维护详情', exact=True)
        expect(dialog.locator('.mpr-summary')).to_contain_text('12')
        for width, height in [(1024, 768), (1440, 1000), (1920, 1080)]:
            page.set_viewport_size({'width': width, 'height': height})
            assert dialog.evaluate('el=>el.scrollWidth<=el.clientWidth'), (theme, width)
            expect(dialog.get_by_role('button', name='关闭', exact=True)).to_be_in_viewport()
            page.screenshot(path=str(output / f'{theme}-{width}-completed.png'))
    checks.append('正式源码页面：三种桌面尺寸、深浅主题、刷新重载后统计和结果保留')
    page.goto(base + '/admin/#tasks')
    page.wait_for_load_state('networkidle')
    completed_row = page.locator('.task-table tbody tr').filter(has_text='快速维护').first
    expect(completed_row).not_to_contain_text('待统计')
    folder = page.request.post(base + '/fixture/ordinary').json()['path']
    accepted = page.request.post(base + '/admin/api/import-runs', data={'path': folder, 'sourceId': 'default', 'autoEmbed': False, 'documentOcr': False})
    assert accepted.ok, accepted.text()
    ordinary_id = accepted.json()['runId']
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        ordinary = page.request.get(base + '/admin/api/runs/' + ordinary_id).json()
        if ordinary['status'] not in ['running', 'queued']:
            break
        time.sleep(.2)
    counts = ordinary['product']['importCounts']
    assert counts['imported'] == 1 and counts['failed'] == 1 and counts['processed'] == 2, ordinary
    page.goto(base + '/admin/#tasks?run=' + ordinary_id)
    page.wait_for_load_state('networkidle')
    drawer = page.locator('.task-detail-drawer')
    expect(drawer.locator('.mpr-totals')).to_contain_text('1 / 2')
    expect(drawer.locator('.mpr-summary')).to_contain_text('失败 1 份')
    expect(drawer.locator('.mpr-overall')).to_have_attribute('aria-valuenow', '50')
    page.screenshot(path=str(output / 'ordinary-partial.png'))
    checks.append('普通导入真实失败样例：总数2、已导入1、失败1，失败文件不计为成功，保留原始错误')
    assert not errors, errors
    browser.close()

receipt = {'checks': checks, 'errors': errors, 'snapshots': snapshots, 'runId': run_id, 'fixture': fixture}
(output / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'checks': checks, 'errors': errors, 'runId': run_id}, ensure_ascii=False, indent=2))
