"""Real entry + isolated settings-host, synthetic image providers only.
Run: python3 tests/generation.browser.py (existing Playwright and Chrome required).
"""
import hashlib
from pathlib import Path
import selectors
import shutil
import subprocess
import unittest
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PROMPT = 'A quiet mountain lake. <img src=x onerror="window.__injected=1">'


class GenerationBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        entry = (ROOT / "main.js").read_text()
        fixture = (ROOT / "tests/settings-host.cjs").read_text()
        if "aimedia.image.prepare" not in entry or any(mode not in fixture for mode in
                ["image-success", "image-timeout", "image-invalid", "image-url"]):
            raise unittest.SkipTest("Image backend channels and synthetic fixture modes are not ready")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node must be on PATH")
        cls.host = subprocess.Popen([node, str(ROOT / "tests/settings-host.cjs")], cwd=ROOT,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(cls.host.stdout, selectors.EVENT_READ)
                if not selector.select(20):
                    raise RuntimeError("Settings fixture did not announce its URL")
                cls.url = cls.host.stdout.readline().strip()
            if not cls.url.startswith("http://127.0.0.1:"):
                raise RuntimeError("Invalid fixture URL")
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch(channel="chrome", headless=True)
        except BaseException:
            cls.stop_host()
            if hasattr(cls, "pw"):
                cls.pw.stop()
            raise

    @classmethod
    def stop_host(cls):
        if cls.host.poll() is None:
            cls.host.terminate()
            try:
                cls.host.wait(timeout=3)
            except subprocess.TimeoutExpired:
                cls.host.kill()
                cls.host.wait(timeout=3)
        cls.host.stdout.close()
        cls.host.stderr.close()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
            cls.pw.stop()
        finally:
            cls.stop_host()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1100, "height": 900}, accept_downloads=True)
        self.page = self.context.new_page()
        self.errors, self.requests = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda request: self.requests.append(request.url))
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.goto(self.url)
        self.rpc("fixture.backend", {"mode": "normal"})
        self.rpc("fixture.network", {"mode": "image-success"})
        state = self.rpc("aimedia.get")
        self.rpc("aimedia.save", {"expectedRevision": state["revision"], "profiles": [],
                                  "defaults": {"image": None, "video": None, "audio": None}, "workflows": []})
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="ChatGPT / OpenAI 图片", exact=True).click()
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Browser GPT")
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        self.page.get_by_role("button", name="添加模型 GPT Image 2", exact=True).click()
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已保存")
        self.network = self.rpc("fixture.metrics")["network"]
        self.instrument()

    def tearDown(self):
        try:
            self.assertEqual(self.errors, [], "Unexpected browser errors")
            self.assertTrue(all(urlparse(url).hostname == "127.0.0.1" or url.startswith("blob:")
                                for url in self.requests), "Renderer requested an external URL")
        finally:
            self.context.close()

    def rpc(self, channel, payload=None):
        return self.page.evaluate("([channel,payload]) => window.pluginBridge.invoke(channel,payload)", [channel, payload])

    def instrument(self):
        self.page.evaluate("""() => {
          window.__imageCalls = []; window.__decoded = 0; window.__urls = []; window.__revoked = [];
          const invoke = window.pluginBridge.invoke;
          window.pluginBridge.invoke = (channel, payload) => {
            if (channel === 'aimedia.invoke' && payload.channel.startsWith('aimedia.image.'))
              window.__imageCalls.push(structuredClone(payload));
            return invoke(channel, payload);
          };
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = async function() { await decode.call(this); window.__decoded++; };
          const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
          URL.createObjectURL = blob => { const url = create(blob); window.__urls.push(url); return url; };
          URL.revokeObjectURL = url => { window.__revoked.push(url); revoke(url); };
        }""")

    def tab(self, name):
        self.page.get_by_role("tab", name=name, exact=True).click()
        expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")

    def pick(self, label, option):
        self.page.get_by_role("button", name=label, exact=True).click()
        self.page.get_by_role("option", name=option, exact=True).click()

    def fill_request(self, prompt=PROMPT):
        self.tab("生图")
        self.pick("OpenAI 服务", "Browser GPT")
        self.pick("图片模型", "GPT Image 2 · gpt-image-2")
        self.page.get_by_role("textbox", name="提示词", exact=True).fill(prompt)

    def prepare(self):
        self.page.get_by_role("button", name="准备生成", exact=True).click()
        expect(self.page.locator('[data-generation-state="prepared"]')).to_be_visible()
        return self.page.locator("[data-generation-job]").get_attribute("data-generation-job")

    def confirm(self):
        self.page.get_by_role("button", name="确认生成…", exact=True).evaluate("node => { node.click(); node.click(); }")
        dialog = self.page.get_by_role("dialog")
        expect(dialog).to_have_count(1)
        expect(dialog).to_contain_text("可能产生费用")
        expect(dialog).to_contain_text("预估费用未知")
        dialog.get_by_role("button", name="生成 1 张", exact=True).click()

    def calls(self, channel):
        return self.page.evaluate("channel => window.__imageCalls.filter(call => call.channel === channel)", channel)

    def test_local_refresh_keeps_generation_model_picker_open(self):
        self.page.evaluate("""() => {
          const invoke = window.pluginBridge.invoke;
          window.pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (payload?.channel === 'aimedia.image.list') await new Promise(resolve => window.__releasePickerList = resolve);
            return result;
          };
        }""")
        self.tab("生图")
        self.page.wait_for_function("typeof window.__releasePickerList === 'function'")
        self.pick("OpenAI 服务", "Browser GPT")
        self.page.get_by_role("button", name="图片模型", exact=True).click()
        self.page.evaluate("window.__releasePickerList()")
        expect(self.page.get_by_role("option", name="GPT Image 2 · gpt-image-2", exact=True)).to_be_visible()
        self.page.get_by_role("option", name="GPT Image 2 · gpt-image-2", exact=True).click()
        expect(self.page.get_by_role("button", name="图片模型", exact=True)).to_contain_text("gpt-image-2")

    def test_config_conflict_is_not_reported_as_billable_unknown(self):
        self.fill_request()
        job_id = self.prepare()
        state = self.rpc("aimedia.get")
        self.rpc("aimedia.save", {"expectedRevision": state["revision"], "profiles": state["profiles"],
                                  "defaults": state["defaults"], "workflows": state["workflows"]})
        self.confirm()
        expect(self.page.get_by_role("alert")).to_contain_text("尚未提交生成请求")
        expect(self.page.locator('[data-generation-state="prepared"]')).to_be_visible()
        expect(self.page.get_by_role("button", name="编辑请求", exact=True)).to_be_enabled()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        self.assertEqual(self.rpc("aimedia.image.get", {"jobId": job_id})["state"], "prepared")

    def test_success_prepare_confirm_decode_download_and_history(self):
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_have_attribute("aria-selected", "true")
        expect(self.page.get_by_role("tab")).to_have_count(3)
        self.fill_request()
        self.pick("图片尺寸", "1536x1024")
        self.pick("图片质量", "高")
        self.tab("生成记录")
        expect(self.page.get_by_role("heading", name="生成记录", exact=True)).to_be_visible()
        self.tab("生图")
        expect(self.page.get_by_role("textbox", name="提示词", exact=True)).to_have_value(PROMPT)
        job_id = self.prepare()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        self.assertEqual(len(self.calls("aimedia.image.submit")), 0)
        expect(self.page.get_by_role("textbox", name="提示词", exact=True)).to_be_disabled()
        expect(self.page.locator(".generation-prompt")).to_contain_text(PROMPT)
        self.assertIsNone(self.page.evaluate("window.__injected"))
        payload = self.calls("aimedia.image.prepare")[0]["payload"]
        self.assertEqual((payload["modelId"], payload["size"], payload["quality"]), ("gpt-image-2", "1536x1024", "high"))
        self.page.get_by_role("button", name="确认生成…", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        self.confirm()
        expect(self.page.locator('[data-generation-state="succeeded"]')).to_be_visible(timeout=10000)
        image = self.page.get_by_role("img", name="生成图片预览", exact=True)
        expect(image).to_be_visible(timeout=10000)
        self.assertTrue(image.evaluate("image => image.complete && image.naturalWidth > 0"))
        self.assertGreater(self.page.evaluate("window.__decoded"), 0)
        self.assertGreater(len(self.calls("aimedia.image.read")), 0)
        self.assertEqual(len(self.calls("aimedia.image.submit")), 1)
        with self.page.expect_download() as event:
            self.page.get_by_role("link", name="下载 PNG", exact=True).click()
        download = event.value
        self.assertEqual(download.suggested_filename, job_id + ".png")
        data = Path(download.path()).read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        details = self.rpc("aimedia.image.get", {"jobId": job_id})
        self.assertEqual(hashlib.sha256(data).hexdigest(), details["result"]["sha256"])
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        self.rpc("fixture.restart")
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.tab("生成记录")
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="生成详情", exact=True)
        expect(dialog).to_contain_text(PROMPT)
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.page.keyboard.press("Escape")
        self.page.get_by_role("button", name="生成中", exact=True).click()
        expect(self.page.locator(f'[data-image-job="{job_id}"]')).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)

    def test_unknown_never_resubmits_and_reload_is_local(self):
        self.rpc("fixture.network", {"mode": "image-timeout"})
        self.fill_request()
        job_id = self.prepare()
        self.confirm()
        expect(self.page.locator('[data-generation-state="unknown"]')).to_be_visible(timeout=10000)
        expect(self.page.locator('[data-generation-state="unknown"]')).to_contain_text("可能已收费")
        expect(self.page.get_by_role("button", name="确认生成…", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="重新读取本地任务", exact=True).click()
        self.tab("生成记录")
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        expect(self.page.locator('[data-generation-state="unknown"]')).to_be_visible()
        self.page.clock.install()
        self.page.clock.fast_forward(5000)
        self.assertEqual(len(self.calls("aimedia.image.submit")), 1)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.tab("生成记录")
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        expect(self.page.locator('[data-generation-state="unknown"]')).to_be_visible()
        expect(self.page.get_by_role("button", name="确认生成…", exact=True)).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)

    def test_invalid_and_url_outputs_never_preview_or_download(self):
        for mode in ["image-invalid", "image-url"]:
            with self.subTest(mode=mode):
                self.rpc("fixture.network", {"mode": mode})
                self.page.reload()
                expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
                self.fill_request(mode)
                self.prepare()
                self.confirm()
                expect(self.page.locator('[data-generation-state]:not([data-generation-state="prepared"]):not([data-generation-state="submitting"])')).to_be_visible(timeout=10000)
                state = self.page.locator("[data-generation-state]").get_attribute("data-generation-state")
                self.assertIn(state, ["unknown", "failed", "result-pending"])
                expect(self.page.get_by_role("img", name="生成图片预览", exact=True)).to_have_count(0)
                expect(self.page.get_by_role("link", name="下载 PNG", exact=True)).to_have_count(0)
                expect(self.page.get_by_role("button", name="确认生成…", exact=True)).to_have_count(0)
                self.assertNotIn("fixture-private-key", self.page.locator("body").inner_text())
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 2)

    def test_delayed_local_refresh_preserves_prompt_focus_and_disposal(self):
        self.page.evaluate("""() => {
          const invoke = window.pluginBridge.invoke; let held = false;
          window.pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (!held && payload?.channel === 'aimedia.image.list') {
              held = true; await new Promise(resolve => window.__releaseList = resolve);
              window.__listReleased = true;
            }
            return result;
          };
        }""")
        self.fill_request("Draft survives a delayed local read")
        self.page.wait_for_function("typeof window.__releaseList === 'function'")
        self.page.evaluate("window.__releaseList()")
        self.page.wait_for_function("window.__listReleased === true")
        prompt = self.page.get_by_role("textbox", name="提示词", exact=True)
        expect(prompt).to_have_value("Draft survives a delayed local read")
        expect(prompt).to_be_focused()
        self.tab("配置")
        self.tab("生图")
        expect(prompt).to_have_value("Draft survives a delayed local read")
        self.prepare()
        self.confirm()
        expect(self.page.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible(timeout=10000)
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        self.assertEqual(self.page.evaluate("window.__urls"), self.page.evaluate("window.__revoked"))

    def test_prepare_ack_failure_keeps_stable_request_id(self):
        self.fill_request()
        self.page.evaluate("""() => {
          const invoke = window.pluginBridge.invoke; let lost = false;
          window.pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (!lost && payload?.channel === 'aimedia.image.prepare') {
              lost = true; throw new Error('Synthetic lost acknowledgement');
            }
            return result;
          };
        }""")
        self.page.get_by_role("button", name="准备生成", exact=True).click()
        expect(self.page.locator("#generation-form-error")).to_be_visible()
        job_id = self.prepare()
        self.page.get_by_role("button", name="编辑请求", exact=True).click()
        self.assertEqual(self.prepare(), job_id)
        requests = self.calls("aimedia.image.prepare")
        self.assertEqual(len(requests), 3)
        self.assertEqual(len({call["payload"]["requestId"] for call in requests}), 1)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_submit_ack_failure_only_allows_local_recovery(self):
        self.fill_request()
        self.prepare()
        self.page.evaluate("""() => {
          const invoke = window.pluginBridge.invoke;
          window.pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (payload?.channel === 'aimedia.image.submit') throw new Error('Synthetic lost acknowledgement');
            return result;
          };
        }""")
        self.confirm()
        expect(self.page.locator('[data-generation-state="unknown"]')).to_be_visible()
        expect(self.page.get_by_role("button", name="确认生成…", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="重新读取本地任务", exact=True).click()
        expect(self.page.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible(timeout=10000)
        self.assertEqual(len(self.calls("aimedia.image.submit")), 1)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)

    def test_corrupt_local_chunk_blocks_preview_and_can_reread(self):
        self.fill_request()
        self.prepare()
        self.page.evaluate("""() => {
          const invoke = window.pluginBridge.invoke; let corrupted = false;
          window.pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (!corrupted && payload?.channel === 'aimedia.image.read' && result.ok) {
              corrupted = true; result.result.nextOffset++;
            }
            return result;
          };
        }""")
        self.confirm()
        expect(self.page.locator(".generation-detail [role=alert]")).to_contain_text("无法预览和下载", timeout=10000)
        expect(self.page.get_by_role("link", name="下载 PNG", exact=True)).to_have_count(0)
        self.assertEqual(self.page.evaluate("window.__urls.length"), 0)
        self.page.get_by_role("button", name="重新读取本地任务", exact=True).click()
        expect(self.page.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)

    def test_late_details_do_not_steal_focus_after_modal_closes(self):
        self.fill_request()
        job_id = self.prepare()
        self.page.evaluate("""() => {
          const invoke = window.pluginBridge.invoke;
          window.pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (payload?.channel === 'aimedia.image.get') {
              await new Promise(resolve => window.__releaseDetails = resolve);
              window.__detailsReleased = true;
            }
            return result;
          };
        }""")
        self.tab("生成记录")
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        self.page.wait_for_function("typeof window.__releaseDetails === 'function'")
        self.page.keyboard.press("Escape")
        self.tab("生图")
        self.page.evaluate("window.__releaseDetails()")
        self.page.wait_for_function("window.__detailsReleased === true")
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(self.page.get_by_role("tab", name="生图", exact=True)).to_be_focused()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_keyboard_responsive_validation_and_legacy_backend(self):
        self.page.get_by_role("tab", name="配置", exact=True).focus()
        self.page.keyboard.press("ArrowRight")
        expect(self.page.get_by_role("tab", name="生图", exact=True)).to_be_focused()
        self.page.get_by_role("textbox", name="提示词", exact=True).fill("Missing explicit profile")
        self.page.get_by_role("button", name="准备生成", exact=True).click()
        expect(self.page.locator("#generation-form-error")).to_contain_text("请选择")
        self.pick("OpenAI 服务", "Browser GPT")
        self.page.get_by_role("button", name="准备生成", exact=True).click()
        expect(self.page.locator("#generation-form-error")).to_contain_text("明确选择")
        model = self.page.get_by_role("button", name="图片模型", exact=True)
        model.focus()
        self.page.keyboard.press("ArrowDown")
        self.page.keyboard.press("End")
        self.page.keyboard.press("Enter")
        expect(model).to_contain_text("gpt-image-2")
        expect(self.page.get_by_role("button", name="图片质量", exact=True)).to_contain_text("中")
        expect(self.page.get_by_role("textbox", name="提示词", exact=True)).to_have_attribute("maxlength", "8000")
        for width in [390, 320]:
            self.page.set_viewport_size({"width": width, "height": 850})
            for base in ["dark", "light"]:
                self.page.evaluate("base => document.documentElement.dataset.base = base", base)
                self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.rpc("fixture.backend", {"mode": "legacy"})
        self.page.reload()
        expect(self.page.locator("[data-config-readonly]")).to_be_visible()
        self.tab("生图")
        expect(self.page.get_by_role("button", name="准备生成", exact=True)).to_be_disabled()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        self.rpc("fixture.backend", {"mode": "normal"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
