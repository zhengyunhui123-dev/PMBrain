import json
import sys
from base64 import b64decode
from pathlib import Path
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

url = sys.argv[1]
output = Path('.codex')
output.mkdir(exist_ok=True)
short_text = '你好，这是一条测试消息。'
long_text = ('这是一段用于检查换行和左右布局的长消息。' * 24 + '\n\n' + 'https://example.test/' + 'longpath' * 35
             + '\n\n```\n' + 'long_unbroken_code_' * 25 + '\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 布局 | 已检查 |')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'])
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url)
    page.wait_for_load_state('networkidle')
    name = '写作验收助手' + uuid4().hex[:6]
    created = page.request.post(url.rstrip('/') + '/api/workbench/agents', data={
        'name': name, 'description': '验证写作助手的对话布局', 'systemPrompt': '请直接回答。',
        'knowledge': False, 'model': 'service-preview:chat', 'deliveryFormat': 'markdown',
    })
    assert created.ok, created.text()
    page.reload()
    page.wait_for_load_state('networkidle')
    page.get_by_role('navigation', name='PMBrain 主导航').get_by_role('button', name='知识助手', exact=True).click()
    page.locator('.wb-agent-list button').filter(has_text=name).click()
    expect(page.get_by_label('当前正在使用专用助手 ' + name)).to_be_visible()
    textbox = page.get_by_role('textbox', name='消息')
    expect(textbox).to_be_visible()
    expect(page.get_by_label('对话模型')).to_have_value('service-preview:chat', timeout=30000)
    expect(page.get_by_role('checkbox', name='知识库')).not_to_be_checked()
    expect(page.get_by_role('button', name='发送消息')).to_be_disabled()
    page.locator('input.wb-file-input').set_input_files([
        {'name': 'layout-example.txt', 'mimeType': 'text/plain', 'buffer': b'synthetic test attachment'},
        {'name': 'layout-example.png', 'mimeType': 'image/png', 'buffer': b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1eoAAAAASUVORK5CYII=')},
    ])
    textbox.fill(short_text)
    page.get_by_role('button', name='发送消息').click()
    user = page.get_by_label('你的消息').last
    expect(user).to_contain_text(short_text, timeout=30000)
    expect(user).to_contain_text('layout-example.txt')
    expect(user.get_by_role('img', name='layout-example.png')).to_be_visible()
    assistant = page.get_by_label('助手回答').last
    expect(assistant).to_be_visible(timeout=60000)
    expect(assistant).to_contain_text('用于验证对话布局', timeout=90000)
    expect(page.get_by_role('button', name='停止生成')).to_have_count(0, timeout=90000)
    expect(user.get_by_role('button', name='修改问题')).to_be_visible()
    page.screenshot(path=str(output / 'chat-layout-check.png'))

    def check_layout(expected_text):
        message = page.get_by_label('你的消息').last
        bubble = message.locator('.docs-markdown')
        expect(bubble).to_contain_text(expected_text)
        geometry = page.evaluate('''() => {
          const column = document.querySelector('.wb-message-column');
          const user = [...document.querySelectorAll('.wb-user .docs-markdown')].at(-1);
          const assistant = document.querySelector('.wb-message.wb-assistant .wb-message-body');
          const c = column.getBoundingClientRect(), u = user.getBoundingClientRect(), a = assistant.getBoundingClientRect();
          const style = getComputedStyle(column), bubble = getComputedStyle(user);
          return {left:c.left+parseFloat(style.paddingLeft),right:c.right-parseFloat(style.paddingRight),
            userLeft:u.left,userRight:u.right,userWidth:u.width,assistantLeft:a.left,
            background:bubble.backgroundColor,scrollWidth:user.scrollWidth,clientWidth:user.clientWidth};
        }''')
        assert abs(geometry['userRight'] - geometry['right']) < 3, geometry
        assert geometry['userLeft'] > geometry['assistantLeft'] + 20, geometry
        assert geometry['background'] not in ('rgba(0, 0, 0, 0)', 'transparent'), geometry
        assert geometry['scrollWidth'] <= geometry['clientWidth'] + 1, geometry
        return geometry

    initial = check_layout(short_text)
    assert initial['userWidth'] < (initial['right'] - initial['left']) * 0.8, initial
    user.get_by_role('button', name='复制', exact=True).click()
    expect(user.get_by_role('button', name='已复制', exact=True)).to_be_visible()
    assert page.evaluate('navigator.clipboard.readText()') == short_text
    user.get_by_role('button', name='修改问题', exact=True).click()
    expect(textbox).to_have_value(short_text)
    expect(page.locator('.wb-composer')).to_contain_text('layout-example.txt')
    expect(page.locator('.wb-composer').get_by_role('img', name='layout-example.png')).to_be_visible()
    page.get_by_role('button', name='取消修改', exact=True).click()
    textbox.fill(long_text)
    page.get_by_role('button', name='发送消息').click()
    expect(page.get_by_label('你的消息').last).to_contain_text('这是一段用于检查换行', timeout=30000)
    expect(page.get_by_label('助手回答').last).to_contain_text('用于验证对话布局', timeout=90000)
    expect(page.get_by_role('button', name='停止生成')).to_have_count(0, timeout=90000)
    for width in (1024, 1440, 1920):
        page.set_viewport_size({'width': width, 'height': 900})
        for theme in ('light', 'dark'):
            page.evaluate('(theme) => document.documentElement.setAttribute("data-theme", theme)', theme)
            check_layout('这是一段用于检查换行')
            assert page.locator('.wb-messages').evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
            if width == 1440:
                page.screenshot(path=str(output / f'chat-layout-{theme}.png'))
    page.reload()
    page.wait_for_load_state('networkidle')
    expect(page.get_by_label('你的消息').last).to_contain_text('这是一段用于检查换行', timeout=30000)
    check_layout('这是一段用于检查换行')
    expect(page.get_by_label('当前正在使用专用助手 ' + name)).to_be_visible()
    expect(page.get_by_label('对话模型')).to_have_value('service-preview:chat', timeout=30000)
    textbox.fill('你好，请帮我看看这段话。')
    page.get_by_role('button', name='发送消息').click()
    expect(page.get_by_label('你的消息').last).to_contain_text('你好，请帮我看看这段话。', timeout=30000)
    expect(page.get_by_label('助手回答').last).to_contain_text('用于验证对话布局', timeout=90000)
    expect(page.get_by_role('button', name='停止生成')).to_have_count(0, timeout=90000)
    page.set_viewport_size({'width': 1440, 'height': 900})
    page.evaluate('document.documentElement.setAttribute("data-theme", "dark")')
    check_layout('你好，请帮我看看这段话。')
    page.screenshot(path=str(output / 'chat-layout-specialist.png'))
    assert not errors, errors
    browser.close()

print(json.dumps({'passed': True, 'sizes': [1024, 1440, 1920], 'themes': ['light', 'dark'],
                  'attachments': True, 'copy': True, 'edit': True, 'reload': True,
                  'specialist': True, 'pageErrors': errors}, ensure_ascii=False))
