import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


root = Path(__file__).resolve().parents[2]
output = root / '.codex' / 'maintenance-progress-demo'
output.mkdir(parents=True, exist_ok=True)
checks = []
errors = []
external = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.on('pageerror', lambda error: errors.append(str(error)))

    def guard(route):
        if route.request.url.startswith(('http:', 'https:')):
            external.append(route.request.url)
            route.abort()
        else:
            route.continue_()

    page.route('**/*', guard)
    page.goto((root / '项目管理' / 'demo.html').as_uri() + '#dream')
    page.wait_for_load_state('networkidle')
    page.locator('[data-action="open-task"][data-id="3"]').click()
    dialog = page.get_by_role('dialog', name='快速维护', exact=True)
    expect(dialog.locator('.mp-summary')).to_be_visible()
    state = dialog.get_by_label('预览状态', exact=True)

    state.select_option('scanning')
    expect(dialog.locator('.mp-overall')).not_to_have_attribute('aria-valuenow', '0')
    expect(dialog.locator('.mp-summary')).to_contain_text('确定中')
    checks.append('扫描完成前不虚构总数和百分比')

    percentages = []
    for scenario in ['importing', 'relating', 'checking', 'vector', 'done']:
        dialog.get_by_label('预览状态', exact=True).select_option(scenario)
        expect(dialog.locator('[data-mp="scanned"]')).to_have_text('3,187')
        expect(dialog.locator('[data-mp="delta"]')).to_have_text('120')
        percentages.append(float(dialog.locator('.mp-overall').get_attribute('aria-valuenow')))
        if scenario != 'importing':
            expect(dialog.locator('.mp-results')).to_contain_text('新增 32')
            expect(dialog.locator('.mp-results')).to_contain_text('更新 88')
    assert percentages == sorted(percentages) and percentages[-1] == 100, percentages
    checks.append('扫描后本轮总数固定，整体进度跨阶段不重置，完成结果持续保留')

    dialog.get_by_label('预览状态', exact=True).select_option('waiting')
    expect(dialog.locator('.mp-current')).to_contain_text('项目沟通纪要.docx')
    expect(dialog.locator('.mp-database')).to_contain_text('5 个请求')
    expect(dialog.locator('.mp-database')).to_contain_text('累计等待')
    expect(dialog.locator('.mp-work-queue')).to_contain_text('47')
    expect(dialog.locator('.mp-summary')).not_to_contain_text('阶段耗时')
    checks.append('资料排队与数据库请求分开，展示总耗时、当前文档和累计等待')

    dialog.get_by_label('预览状态', exact=True).select_option('relating')
    expect(dialog.locator('.mp-current')).to_contain_text('只关联已有')
    expect(dialog.locator('.mp-entities')).to_contain_text('27')
    expect(dialog.locator('.mp-entities')).to_contain_text('人物 12')
    expect(dialog.locator('.mp-current')).to_contain_text('已写入 64 条关联')
    checks.append('实体关联区分已检查资料、去重实体和写入关联，不调用生成模型')

    dialog.get_by_label('预览状态', exact=True).select_option('checking')
    expect(dialog.locator('.mp-current')).to_contain_text('80 / 120')
    expect(dialog.locator('.mp-current')).to_contain_text('页面引用')
    expect(dialog.locator('.mp-results')).to_contain_text('45 个已有实体')
    checks.append('页面检查说明实际内容，前两阶段结果不丢失')

    dialog.get_by_label('预览状态', exact=True).select_option('vector-window')
    expect(dialog.locator('.mp-vector')).to_contain_text('30 分钟')
    expect(dialog.locator('.mp-vector')).to_contain_text('840 / 1,440')
    expect(dialog.locator('.mp-vector')).to_contain_text('600')
    expect(dialog.locator('.mp-overall')).to_have_attribute('aria-valuenow', '100')
    expect(dialog.locator('.mp-vector-progress')).to_have_attribute('aria-valuenow', '58.3')
    checks.append('向量化独立统计本轮全部分块，30分钟结束保留剩余数，不伪报全部完成')

    dialog.get_by_label('预览状态', exact=True).select_option('failed')
    expect(dialog.locator('.mp-current')).to_contain_text('2 份失败')
    assert float(dialog.locator('.mp-overall').get_attribute('aria-valuenow')) < 100
    expect(dialog.locator('.mp-current')).to_contain_text('示例原始错误')
    checks.append('导入失败保留原始原因与计数，不标为全部完成')

    dialog.get_by_label('预览状态', exact=True).select_option('stopped')
    expect(dialog.locator('.mp-summary')).to_contain_text('72 / 120')
    expect(dialog.locator('.mp-work-queue')).to_contain_text('48')
    expect(dialog.get_by_role('button', name='继续未完成任务', exact=True)).to_be_visible()
    checks.append('停止状态保留已导入数量、待处理数量和继续入口')

    dialog.get_by_label('预览状态', exact=True).select_option('unchanged')
    expect(dialog.locator('[data-mp="delta"]')).to_have_text('0')
    expect(dialog.locator('.mp-summary')).to_contain_text('0 / 0')
    expect(dialog.locator('.mp-results')).to_contain_text('没有变化')
    expect(dialog.locator('.mp-results')).to_contain_text('未变化 3,187')
    checks.append('无增量时明确零份导入和跳过阶段')

    for theme in ['light', 'dark']:
        page.evaluate("theme => { S.theme=theme; applyTheme(); }", theme)
        for width, height in [(1024, 768), (1440, 1000), (1920, 1080)]:
            page.set_viewport_size({'width': width, 'height': height})
            for scenario in ['importing', 'relating', 'vector-window', 'done']:
                dialog.get_by_label('预览状态', exact=True).select_option(scenario)
                assert dialog.evaluate('el => el.scrollWidth <= el.clientWidth'), (theme, width, scenario)
                expect(dialog.get_by_role('button', name='关闭', exact=True)).to_be_in_viewport()
            if width == 1440:
                for scenario in ['importing', 'relating', 'vector-window', 'done']:
                    dialog.get_by_label('预览状态', exact=True).select_option(scenario)
                    page.screenshot(path=str(output / f'{theme}-{scenario}.png'))
    checks.append('三种桌面宽度、深浅主题均可查看，底部操作可见，无弹窗横向溢出')

    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    page.get_by_role('button', name='快速维护', exact=True).click()
    expect(page.get_by_role('dialog', name='快速维护', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    page.goto((root / '项目管理' / 'demo.html').as_uri() + '#import')
    page.wait_for_load_state('networkidle')
    page.locator('[data-action="open-task"][data-id="4"]').click()
    imported = page.get_by_role('dialog', name='添加项目资料', exact=True)
    expect(imported.locator('.mp-summary')).to_contain_text('8 / 8')
    expect(imported.locator('.mp-steps')).to_have_count(0)
    expect(imported.locator('.mp-overall')).to_have_attribute('aria-valuenow', '100')
    page.goto((root / '项目管理' / 'demo.html').as_uri() + '?maintenance-demo=importing#dream')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('dialog', name='快速维护', exact=True).locator('.mp-summary')).to_contain_text('72 / 120')
    checks.append('快速维护入口与导入详情共用统计布局，普通导入没有额外整理阶段')
    assert not errors, errors
    assert not external, external
    checks.append('设计稿无脚本错误、无外部请求、不读写实际资料或数据库')
    browser.close()

receipt = {'checks': checks, 'errors': errors, 'externalRequests': external, 'percentages': percentages}
(output / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False, indent=2))
