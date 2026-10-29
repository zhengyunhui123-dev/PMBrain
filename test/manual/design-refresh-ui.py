import json
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5298/admin/'
target = urlparse(url)
assert target.hostname == '127.0.0.1' and target.port in [5298, 5398], '仅允许隔离预览端口 5298/5398'
output = Path('.codex/design-refresh')
output.mkdir(parents=True, exist_ok=True)
errors = []
checks = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'])
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url + '#home')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('button', name='展开菜单', exact=True)).to_be_visible()
    expect(page.locator('.home-actions .home-card')).to_have_count(6)
    page.get_by_role('button', name='展开菜单', exact=True).click()
    expect(page.get_by_role('button', name='收起菜单', exact=True)).to_be_visible()
    page.reload()
    expect(page.get_by_role('button', name='收起菜单', exact=True)).to_be_visible()
    page.get_by_role('button', name='收起菜单', exact=True).click()
    checks.append('主导航默认折叠，手动切换与重载保留')
    page.get_by_role('button', name='切换主题', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.reload()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.get_by_role('button', name='切换主题', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    checks.append('主题按钮切换与重载保留')
    expect(page.get_by_role('textbox', name='消息', exact=True)).to_be_visible()
    page.get_by_role('checkbox', name='知识库', exact=True).uncheck()
    expect(page.locator('.wb-compose-note')).to_contain_text('普通对话')
    page.get_by_role('textbox', name='消息', exact=True).fill('验证首页提问能进入知识助手')
    page.get_by_role('button', name='发送消息', exact=True).click()
    expect(page.get_by_label('助手回答').last).to_contain_text('隔离测试回复', timeout=30000)
    checks.append('首页真实发送并进入知识助手')
    for theme in ['light', 'dark']:
        for width, height in [(1034, 612), (1440, 900), (1920, 1080)]:
            page.set_viewport_size({'width': width, 'height': height})
            for route in ['home', 'assistant', 'data', 'dream']:
                page.goto(url + '#' + route)
                page.wait_for_load_state('networkidle')
                page.wait_for_selector({'home': '.home-actions', 'assistant': '.wb-chat', 'data': '.library-redesign tbody tr', 'dream': '.maintenance-run-list'}[route])
                page.evaluate("theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }", theme)
                expect(page.locator('.design-refresh')).to_be_visible()
                overflow = page.evaluate('document.documentElement.scrollWidth > innerWidth')
                assert not overflow, f'{route}/{theme}/{width}: 页面横向溢出'
                page.screenshot(path=str(output / f'{route}-{theme}-{width}.png'))
                checks.append(f'{route}/{theme}/{width}x{height}')
                if route == 'assistant':
                    page.get_by_role('button', name='助手配置', exact=True).click()
                    config = page.get_by_role('dialog', name='助手配置', exact=True)
                    box = config.bounding_box()
                    assert box and box['height'] <= height - 48 and box['width'] == 820, box
                    expect(config.get_by_role('button', name='保存', exact=True)).to_be_in_viewport()
                    page.keyboard.press('Shift+Tab')
                    expect(config.get_by_role('button', name='保存', exact=True)).to_be_focused()
                    page.screenshot(path=str(output / f'config-{theme}-{width}.png'))
                    page.keyboard.press('Escape')
                    expect(config).not_to_be_visible()
                    expect(page.get_by_role('button', name='助手配置', exact=True)).to_be_focused()
                    checks.append(f'助手弹窗、焦点和关闭/{theme}/{width}x{height}')
    assert not errors, errors
    (output / 'receipt.json').write_text(json.dumps({'checks': checks, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
print(json.dumps({'checks': len(checks), 'pageErrors': errors, 'output': str(output)}, ensure_ascii=False))
