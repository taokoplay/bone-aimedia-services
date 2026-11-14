"""Locale acceptance against the real plugin and synthetic settings host.
Run: python3 tests/i18n.browser.py (existing Playwright Chrome environment).
"""
import json
import re
import selectors
import shutil
import subprocess
import unittest
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HOSTILE = '中文 <img src=x onerror=window.__injected=1> {p1} $&'
COPY = {
    'en': {
        'add': 'Add service', 'openai': 'ChatGPT / OpenAI Images', 'name': 'Configuration name',
        'save': 'Save', 'saved': 'Configuration saved. No catalog query was made.',
        'nameRequired': 'Enter a configuration name.', 'fetch': 'Fetch from provider',
        'addModel': 'Add model GPT Image 2', 'edit': 'Edit ', 'delete': 'Delete ',
        'cancel': 'Cancel', 'search': 'Search name, provider, or model',
        'records': 'Generation records', 'config': 'Configuration', 'details': 'View details',
        'close': 'Close details', 'completed': 'Completed', 'preview': 'Generated image preview',
        'download': 'Download PNG', 'prompt': 'Prompt', 'project': 'Project: ',
        'service': 'Service', 'requestedSize': 'Requested size', 'actualSize': 'Actual size',
        'workflow': 'Local workflows', 'workflowName': 'Workflow name', 'parse': 'Parse JSON',
        'invalidJson': 'Invalid JSON. Check brackets, quotes, and commas. The original text is retained.',
        'sync': 'Sync models', 'found': 'Discovered', 'back': 'Back to list',
        'speechText': 'Text to read', 'audioPreview': 'Generated speech preview', 'downloadAudio': 'Download MP3',
    },
    'zh-CN': {
        'add': '添加服务', 'openai': 'ChatGPT / OpenAI 图片', 'name': '配置名称',
        'save': '保存', 'saved': '配置已保存。未发起目录查询。',
        'nameRequired': '请填写配置名称。', 'fetch': '从供应商获取', 'addModel': '添加模型 GPT Image 2',
        'edit': '编辑 ', 'delete': '删除 ', 'cancel': '取消', 'search': '搜索名称、供应商或模型',
        'records': '生成记录', 'config': '配置', 'details': '查看详情', 'close': '关闭详情',
        'completed': '已完成', 'preview': '生成图片预览', 'download': '下载 PNG', 'prompt': '提示词',
        'project': '所属项目：', 'service': '渠道', 'requestedSize': '请求尺寸', 'actualSize': '实际尺寸',
        'workflow': '本地工作流', 'workflowName': '工作流名称', 'parse': '解析 JSON',
        'invalidJson': 'JSON 格式无效，请检查括号、引号和逗号。原文已保留。',
        'sync': '同步模型', 'found': '已发现', 'back': '返回列表',
        'speechText': '朗读文本', 'audioPreview': '生成语音预览', 'downloadAudio': '下载 MP3',
    }
}


class LocaleBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.host = subprocess.Popen([shutil.which('node'), str(ROOT / 'tests/settings-host.cjs')],
                                     cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop_host)
        with selectors.DefaultSelector() as selector:
            selector.register(self.host.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(20), 'Settings host did not start')
            self.url = self.host.stdout.readline().strip()
        self.assertTrue(self.url.startswith('http://127.0.0.1:'))
        self.context = self.browser.new_context(viewport={'width': 1200, 'height': 1000})
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: dialog.accept())
        self.locale_calls = 0

    def stop_host(self):
        if self.host.poll() is None:
            self.host.terminate()
            try:
                self.host.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.host.kill()
                self.host.wait(timeout=3)
        self.host.stdout.close()
        self.host.stderr.close()

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def inject_locale(self, locale):
        def bridge(route):
            if route.request.post_data_json.get('channel') == 'app.getLocale':
                self.locale_calls += 1
                route.fulfill(json={'result': locale})
            else:
                route.continue_()
        self.page.route('**/bridge', bridge)

    def rpc(self, channel, payload=None):
        response = self.context.request.post(self.url + '/bridge', data={'channel': channel, 'payload': payload}).json()
        self.assertNotIn('error', response, response)
        return response['result']

    def button(self, name):
        return self.page.get_by_role('button', name=name, exact=True)

    def add(self, provider, copy):
        self.button(copy['add']).click()
        self.page.get_by_role('dialog').get_by_role('button', name=provider, exact=True).click()

    def save(self, copy):
        self.button(copy['save']).click()
        expect(self.page.get_by_role('status')).to_have_text(copy['saved'])

    def flow(self, locale):
        c = COPY[locale]
        self.inject_locale(locale)
        self.page.goto(self.url)
        expect(self.button(c['add'])).to_be_enabled()
        expect(self.page.locator('html')).to_have_attribute('lang', locale)
        self.assertEqual(self.locale_calls, 1)
        self.assertEqual(self.page.evaluate('AIMedia.kinds.image'), 'Image' if locale == 'en' else '图片')
        self.button(c['add']).click()
        dialog = self.page.get_by_role('dialog')
        if locale == 'en':
            self.assertNotRegex(dialog.inner_text(), r'[\u3400-\u9fff]')
        dialog.get_by_role('button', name=c['openai'], exact=True).click()
        self.button(c['save']).click()
        expect(self.page.get_by_role('alert')).to_have_text(c['nameRequired'])
        self.page.get_by_role('textbox', name=c['name'], exact=True).fill(HOSTILE)
        self.page.get_by_label('API Key', exact=True).fill('fixture-key-for-browser')
        self.button(c['addModel']).click()
        self.save(c)
        self.button(c['edit'] + HOSTILE).click()
        self.button(c['fetch']).click()
        expect(self.page.locator('[data-discovery]')).to_contain_text('fixture-model')
        self.save(c)
        search = self.page.get_by_role('searchbox', name=c['search'], exact=True)
        search.fill('中文')
        expect(search).to_be_focused()
        expect(self.page.locator('[data-service-row]')).to_contain_text(HOSTILE)
        search.fill('')
        self.button(c['delete'] + HOSTILE).click()
        expect(self.page.get_by_role('dialog')).to_contain_text(HOSTILE)
        self.assertEqual(self.page.get_by_role('dialog').locator('img').count(), 0)
        self.page.get_by_role('dialog').get_by_role('button', name=c['cancel'], exact=True).click()
        self.assertIsNone(self.page.evaluate('window.__injected'))

        self.add('ComfyUI', c)
        self.page.get_by_role('textbox', name=c['name'], exact=True).fill('Local connection')
        self.save(c)
        self.button(c['edit'] + 'Local connection').click()
        self.button(c['sync']).click()
        expect(self.page.locator('.file-badge').first).to_have_text(c['found'])
        expect(self.page.locator('.duty-snapshot-files')).to_contain_text('nested/模型.safetensors')
        self.button(c['back']).click()

        self.add(c['workflow'], c)
        self.page.get_by_role('textbox', name=c['workflowName'], exact=True).fill('用户工作流')
        self.page.get_by_role('textbox', name='API JSON', exact=True).fill('{')
        self.button(c['parse']).click()
        expect(self.page.get_by_role('alert')).to_have_text(c['invalidJson'])
        definition = {'1': {'class_type': 'CLIPTextEncode', 'inputs': {'text': HOSTILE}}}
        self.page.get_by_role('textbox', name='API JSON', exact=True).fill(json.dumps(definition))
        self.button(c['parse']).click()
        self.save(c)

        self.button('Generation models' if locale == 'en' else '生成模型').click()
        self.add('MiniMax', c)
        self.page.get_by_role('textbox', name=c['name'], exact=True).fill('Voice service')
        self.page.get_by_label('API Key', exact=True).fill('fixture-key-for-browser')
        self.save(c)
        state = self.rpc('aimedia.get')
        image_profile = next(p for p in state['profiles'] if p['name'] == HOSTILE)
        audio_profile = next(p for p in state['profiles'] if p['name'] == 'Voice service')
        self.assertEqual(state['workflows'][0]['definition'], definition)
        self.assertEqual(image_profile['models'][0]['name'], 'GPT Image 2')
        self.rpc('fixture.project', {'status': 'project', 'name': HOSTILE})
        self.rpc('fixture.network', {'mode': 'image-success'})
        image = self.rpc('fixture.tool', {'name': 'generate_image', 'args': {
            'requestKey': str(uuid.uuid4()), 'modelRef': f"media:{image_profile['id']}:gpt-image-2",
            'prompt': HOSTILE, 'size': '1024x1024', 'quality': 'low'
        }})['structuredContent']
        self.assertTrue(image['ok'], image)
        image = image['job']
        self.rpc('fixture.network', {'mode': 'audio-success'})
        audio = self.rpc('fixture.tool', {'name': 'generate_audio', 'args': {
            'requestKey': str(uuid.uuid4()), 'modelRef': f"media:{audio_profile['id']}:speech-2.6-hd",
            'operation': 'speech', 'voiceId': 'fixture-voice', 'text': HOSTILE, 'speed': 1.2
        }})['structuredContent']
        self.assertTrue(audio['ok'], audio)
        audio = audio['job']
        network = self.rpc('fixture.metrics')['network']
        self.page.get_by_role('tab', name=c['records'], exact=True).click()
        for job, is_audio in [(image, False), (audio, True)]:
            row = self.page.locator(f'[data-record-job="{job["id"]}"]')
            expect(row).to_contain_text(c['completed'])
            expect(row.locator('.record-project-tag')).to_have_text(HOSTILE)
            expect(row.locator('.record-project-tag')).to_have_attribute('aria-label', c['project'] + HOSTILE)
            row.get_by_role('button', name=re.compile('^View task ' if locale == 'en' else '^查看任务 ')).click()
            dialog = self.page.get_by_role('dialog')
            if is_audio:
                expect(dialog.get_by_label(c['audioPreview'], exact=True)).to_be_visible()
                expect(dialog.get_by_role('link', name=c['downloadAudio'])).to_be_visible()
                dialog.get_by_text(c['speechText'], exact=True).click()
            else:
                expect(dialog.get_by_role('img', name=c['preview'], exact=True)).to_be_visible()
                expect(dialog.get_by_role('link', name=c['download'])).to_be_visible()
                expect(dialog.locator('dt').filter(has_text=c['requestedSize'])).to_be_visible()
                expect(dialog.locator('dt').filter(has_text=c['actualSize'])).to_be_visible()
                dialog.get_by_text(c['prompt'], exact=True).click()
            expect(dialog.locator('.record-prompt-text')).to_have_text(HOSTILE)
            dialog.get_by_role('button', name=c['close'], exact=True).click()
        self.assertEqual(self.rpc('fixture.metrics')['network'], network, 'Viewing records must not generate again')
        self.assertIsNone(self.page.evaluate('window.__injected'))
        self.assertEqual(self.locale_calls, 1)

    def test_english_user_flow(self):
        self.flow('en')

    def test_chinese_user_flow(self):
        self.flow('zh-CN')

    def test_unsupported_known_locale_uses_english(self):
        self.inject_locale('fr-FR')
        self.page.goto(self.url)
        expect(self.button('Add service')).to_be_enabled()
        expect(self.page.locator('html')).to_have_attribute('lang', 'en')
        expect(self.page).to_have_title('Bone AI Media Services 0.5.4')

    def test_old_host_unknown_channel_retains_chinese(self):
        self.page.goto(self.url)
        expect(self.button('添加服务')).to_be_enabled()
        expect(self.page.locator('html')).to_have_attribute('lang', 'zh-CN')
        self.assertEqual(self.page.evaluate('AIMedia.kinds.audio'), '音频')

    def test_modules_wait_for_locale_before_initializing(self):
        self.page.add_init_script("""const nativeTimeout = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 1000 ? 10000 : delay, ...args);""")
        held = []
        def bridge(route):
            if route.request.post_data_json.get('channel') == 'app.getLocale':
                held.append(route)
            else:
                route.continue_()
        self.page.route('**/bridge', bridge)
        self.page.goto(self.url, wait_until='domcontentloaded')
        self.page.wait_for_function('window.AIMedia !== undefined')
        expect(self.page.locator('#app')).to_be_hidden()
        self.assertIsNone(self.page.evaluate('AIMedia.kinds'))
        self.assertEqual(len(held), 1)
        held[0].fulfill(json={'result': 'en'})
        expect(self.button('Add service')).to_be_enabled()
        self.assertEqual(self.page.evaluate('AIMedia.kinds.image'), 'Image')

    def test_script_load_failure_is_localized(self):
        self.inject_locale('en')
        self.page.route('**/settings-profile.js', lambda route: route.abort())
        self.page.goto(self.url)
        expect(self.page.get_by_role('alert')).to_have_text('The settings page could not load. Reload the plugin panel to try again.')


if __name__ == '__main__':
    unittest.main(verbosity=2)
