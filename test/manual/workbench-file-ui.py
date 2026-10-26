import json
import pathlib
import time
from playwright.sync_api import sync_playwright, expect

out = pathlib.Path('.codex/file-capability')
meta = json.loads((out / 'preview.json').read_text(encoding='utf-8'))
records = []
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    context = browser.new_context(viewport={'width': 1500, 'height': 1000}, timezone_id='Asia/Shanghai')
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    test_agent = None

    def api(path):
        response = context.request.get(meta['frontend'] + '/admin/api/workbench' + path)
        assert response.ok, response.text()
        return response.json()

    def current():
        rows = [row for row in api('/conversations')['conversations'] if row.get('assistantId') == test_agent]
        return api('/conversations/' + rows[0]['id']) if rows else None

    def send(text):
        previous = current()
        count = len(previous['messages']) if previous else 0
        page.get_by_role('textbox', name='消息', exact=True).fill(text)
        page.get_by_role('button', name='发送消息', exact=True).click()
        deadline = time.monotonic() + 210
        while time.monotonic() < deadline:
            row = current()
            if row and len(row['messages']) >= count + 2 and row['messages'][-1]['status'] != 'running':
                records.append(row)
                (out / 'live-dialogues.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
                reply = row['messages'][-1]
                print(json.dumps({'request': text, 'status': reply['status'], 'text': reply['text'], 'error': reply.get('error'), 'tools': [(call['name'], call['status']) for call in reply.get('toolCalls', [])]}, ensure_ascii=False), flush=True)
                assert reply['status'] == 'complete', reply.get('error')
                expect(page.get_by_role('button', name='发送消息', exact=True)).to_be_disabled()
                return row
            time.sleep(.4)
        raise AssertionError('对话超时')

    try:
        response = context.request.post(meta['frontend'] + '/admin/api/workbench/agents', data={'name': '文件验收助手' + str(int(time.time())), 'description': '按用户指令处理授权工作目录中的文件', 'systemPrompt': '你负责执行本地文件操作，必须使用真实工具，按实际结果回答。', 'workspaceDirectory': meta['work'], 'knowledge': False, 'model': 'mimo:mimo-v2.6-flash', 'deliveryFormat': 'markdown'})
        assert response.ok, response.text()
        test_agent = response.json()['id']
        page.goto(meta['frontend'] + '/admin/#assistant', wait_until='networkidle')
        page.locator('.wb-agent-list button').filter(has_text=response.json()['name']).click()
        expect(page.locator('.wb-workspace-choice')).to_be_visible()
        page.locator('.wb-workspace-choice').click()
        page.get_by_label('这个助手的工作目录').fill(meta['work'])
        page.get_by_role('button', name='使用此目录', exact=True).click()
        page.get_by_label('工作目录文件权限', exact=True).select_option('new-files')
        expect(page.get_by_label('工作目录文件权限', exact=True)).to_be_enabled()
        page.get_by_label('工作目录文件权限', exact=True).select_option('read-write')
        expect(page.get_by_label('工作目录文件权限', exact=True)).to_be_enabled()
        page.reload(wait_until='networkidle')
        expect(page.get_by_label('工作目录文件权限', exact=True)).to_have_value('read-write')
        page.get_by_role('checkbox', name='知识库', exact=True).uncheck()
        work = pathlib.Path(meta['work'])
        path = work / 'PMBrain写的内容.md'
        original = path.read_bytes()
        first = send('把下面这段内容实际追加到当前工作目录里的 PMBrain写的内容.md 文件末尾，原有内容保留，不要另外保存成果文件：\n新增内容：今天核对了文件操作能力。')
        assert path.read_bytes().startswith(original)
        assert '今天核对了文件操作能力' in path.read_text(encoding='utf-8')
        assert any(call['name'] == 'local_write' and call['status'] == 'complete' for call in first['messages'][-1].get('toolCalls', []))
        send('把刚才文件里的「今天核对了文件操作能力」改成「今天完成了文件操作验收」，其他原文不要动。')
        assert '今天完成了文件操作验收' in path.read_text(encoding='utf-8')
        page.reload(wait_until='networkidle')
        expect(page.get_by_label('工作目录文件权限', exact=True)).to_have_value('read-write')
        deleted = send('把当前工作目录里的旧稿.md 删除。')
        assert not (work / '旧稿.md').exists()
        assert any(call['name'] == 'local_delete' and call['status'] == 'complete' for call in deleted['messages'][-1].get('toolCalls', []))
        page.reload(wait_until='networkidle')
        send('恢复刚才删除的旧稿.md。')
        assert (work / '旧稿.md').read_text(encoding='utf-8') == '这是测试用的错误旧稿。'
        send('在当前工作目录新建一份 验收笔记.md，正文只写：文件操作已核验。请直接写到这个文件名。')
        assert '文件操作已核验' in (work / '验收笔记.md').read_text(encoding='utf-8')
        send('请新建一个叫归档的文件夹，然后把验收笔记.md复制进去，并把复制后的文件重命名为归档稿.md。保留外面的验收笔记.md。')
        assert (work / '验收笔记.md').is_file()
        assert (work / '归档' / '归档稿.md').is_file()
        assert pathlib.Path(meta['library'], '原始资料.md').read_text(encoding='utf-8') == '受保护知识原文'
        assert not errors, errors
        page.screenshot(path=str((out / 'live-final.png').resolve()), full_page=True)
        (out / 'receipt.json').write_text(json.dumps({'checks': ['目录与读写权限保存后重载', '真实MiMo追加保留原文', '局部编辑', '删除与刷新后恢复', '按指定文件名创建', '建目录复制并重命名', '知识原文保留'], 'errors': errors, 'root': meta['root']}, ensure_ascii=False, indent=2), encoding='utf-8')
    finally:
        page.screenshot(path=str((out / 'last.png').resolve()), full_page=True)
        (out / 'last.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
        browser.close()
