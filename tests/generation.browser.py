"""Agent image generation -> local records, using the real plugin and synthetic HTTP.
Run: python3 tests/generation.browser.py (existing Playwright and Chrome required).
"""
import base64
import hashlib
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import unittest
from urllib.parse import urlparse
import uuid

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ["PI_SCRATCH_DIR"])
PROMPT = 'A quiet mountain lake. <img src=x onerror="window.__injected=1">'


class GenerationBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chrome", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node must be on PATH")
        self.host = subprocess.Popen([node, str(ROOT / "tests/settings-host.cjs")], cwd=ROOT,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop_host)
        with selectors.DefaultSelector() as selector:
            selector.register(self.host.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(20), "Fixture URL was not announced")
            self.url = self.host.stdout.readline().strip()
        self.assertTrue(self.url.startswith("http://127.0.0.1:"))
        self.context = self.browser.new_context(viewport={"width": 1100, "height": 900}, accept_downloads=True)
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors, self.requests = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda request: self.requests.append(request.url))
        self.page.goto(self.url)
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="ChatGPT / OpenAI 图片", exact=True).click()
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Browser GPT")
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        self.page.get_by_role("button", name="添加模型 GPT Image 2", exact=True).click()
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已保存")
        self.profile = self.rpc("aimedia.get")["profiles"][0]["id"]
        self.assertEqual(self.rpc("fixture.metrics")["network"], 0)
        self.instrument()

    def stop_host(self):
        if self.host.poll() is None:
            self.host.terminate()
            try:
                self.host.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.host.kill()
                self.host.wait(timeout=4)
        self.host.stdout.close()
        self.host.stderr.close()

    def tearDown(self):
        self.assertEqual(self.errors, [], "Unexpected browser errors")
        self.assertTrue(all(urlparse(url).hostname == "127.0.0.1" or url.startswith("blob:")
                            for url in self.requests), "Renderer requested an external URL")
        calls = self.rpc("fixture.metrics")["calls"]
        for kind in ["image", "audio"]:
            for operation in ["prepare", "submit"]:
                self.assertEqual(calls.get(f"aimedia.{kind}.{operation}", 0), 0,
                                 "The records UI must not prepare or submit generation")

    def rpc(self, channel, payload=None):
        response = self.context.request.post(self.url + "/bridge", data={"channel": channel, "payload": payload})
        data = response.json()
        self.assertNotIn("error", data, str(data))
        return data["result"]

    def instrument(self):
        self.page.evaluate("""() => {
          window.__calls = []; window.__decoded = 0; window.__urls = []; window.__revoked = [];
          const invoke = window.pluginBridge.invoke;
          window.pluginBridge.invoke = (channel, payload) => {
            if (channel === 'aimedia.invoke') __calls.push(structuredClone(payload));
            return invoke(channel, payload);
          };
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = async function() { await decode.call(this); __decoded++; };
          const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
          URL.createObjectURL = blob => { const url = create(blob); __urls.push(url); return url; };
          URL.revokeObjectURL = url => { __revoked.push(url); revoke(url); };
        }""")

    def reload(self):
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_have_attribute("aria-selected", "true")
        self.instrument()

    def tab(self, name):
        self.page.get_by_role("tab", name=name, exact=True).click()
        expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")

    def request(self, prompt=PROMPT):
        return {"requestKey": str(uuid.uuid4()), "modelRef": f"media:{self.profile}:gpt-image-2",
                "prompt": prompt, "size": "1536x1024", "quality": "high"}

    def generate(self, args, mode=None):
        if mode:
            self.rpc("fixture.network", {"mode": mode})
        reply = self.rpc("fixture.tool", {"name": "generate_image", "args": args})
        self.assertTrue(reply["structuredContent"]["ok"], reply)
        return reply

    def details(self, job_id):
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="生成详情", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def test_agent_held_image_poll_decode_original_download_and_restart(self):
        expect(self.page.get_by_role("tab")).to_have_count(2)
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_have_attribute("aria-selected", "true")
        self.tab("生成记录")
        expect(self.page.locator("[data-record-job]")).to_have_count(0)
        args = self.request()
        self.rpc("fixture.network", {"mode": "image-held"})
        # The registered tool stays pending while the visible records page discovers it.
        self.page.evaluate("""args => {
          window.__agentReply = null; window.__agentError = null;
          void pluginBridge.invoke('fixture.tool', {name:'generate_image', args})
            .then(reply => window.__agentReply = reply, error => window.__agentError = String(error));
        }""", args)
        row = self.page.locator('[data-record-kind="image"]')
        expect(row).to_have_count(1, timeout=10000)
        expect(row.locator('[data-generation-state="submitting"]')).to_be_visible()
        self.assertIsNone(self.page.evaluate("__agentReply"))
        job_id = row.get_attribute("data-record-job")
        dialog = self.details(job_id)
        expect(dialog.locator('[data-generation-state="submitting"]')).to_be_visible()
        dialog.evaluate("node => window.__originalDialog = node")
        self.rpc("fixture.imageRelease", {"outcome": "success"})
        self.page.wait_for_function("__agentReply !== null || __agentError !== null")
        self.assertIsNone(self.page.evaluate("__agentError"))
        reply = self.page.evaluate("__agentReply")
        job = reply["structuredContent"]["job"]
        self.assertEqual((job["id"], job["state"]), (job_id, "succeeded"))
        self.assertEqual((job["request"]["size"], job["request"]["quality"]), ("1536x1024", "high"))
        expect(dialog.locator('[data-generation-state="succeeded"]')).to_be_visible(timeout=10000)
        self.assertTrue(dialog.evaluate("node => node === __originalDialog"))
        image = dialog.get_by_role("img", name="生成图片预览", exact=True)
        expect(image).to_be_visible(timeout=10000)
        self.assertEqual(image.evaluate("image => [image.complete, image.naturalWidth, image.naturalHeight]"), [True, 32, 32])
        self.assertGreater(self.page.evaluate("__decoded"), 0)
        expect(dialog).to_contain_text("1536 × 1024")
        expect(dialog).to_contain_text("32 × 32")
        dialog.locator("summary").filter(has_text="提示词").click()
        expect(dialog.locator(".record-prompt-text")).to_have_text(PROMPT)
        self.assertIsNone(self.page.evaluate("window.__injected"))
        with self.page.expect_download() as event:
            dialog.get_by_role("link", name="下载 PNG", exact=True).click()
        download = event.value
        data = Path(download.path()).read_bytes()
        self.assertEqual(download.suggested_filename, job_id + ".png")
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(hashlib.sha256(data).hexdigest(), job["result"]["sha256"])
        original = next(item["data"] for item in reply["content"] if item["type"] == "image")
        self.assertEqual(data, base64.b64decode(original))
        self.page.screenshot(path=str(SCRATCH / "agent-only-image-detail-1100-dark.png"))
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True)).to_be_focused()
        self.assertTrue(self.page.evaluate("__urls.length > 0 && __urls.every(url => __revoked.includes(url))"))
        self.assertEqual(self.generate(args)["structuredContent"]["job"]["id"], job_id)
        self.rpc("fixture.restart")
        self.reload()
        self.tab("生成记录")
        expect(self.page.locator("[data-record-job]")).to_have_count(1)
        dialog = self.details(job_id)
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        dialog.locator("summary").filter(has_text="提示词").click()
        expect(dialog.locator(".record-prompt-text")).to_have_text(PROMPT)
        self.assertEqual(self.generate(args)["structuredContent"]["job"]["id"], job_id)
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_unknown_failed_and_pending_refresh_reload_and_same_key_never_resubmit(self):
        for mode, state in [("image-timeout", "unknown"), ("unauthorized", "failed"),
                            ("image-invalid", "result-pending"), ("image-url", "result-pending")]:
            with self.subTest(mode=mode):
                args = self.request(mode)
                before = self.rpc("fixture.metrics")["network"]
                job = self.generate(args, mode)["structuredContent"]["job"]
                self.assertEqual(job["state"], state)
                self.tab("生成记录")
                action = self.page.get_by_role("button", name=f'查看任务 {job["id"]}', exact=True)
                expect(action).to_be_visible(timeout=10000)
                dialog = self.details(job["id"])
                expect(dialog.locator(f'[data-generation-state="{state}"]')).to_be_visible()
                if state == "unknown":
                    expect(dialog).to_contain_text("可能已收费")
                expect(dialog.get_by_role("img")).to_have_count(0)
                expect(dialog.get_by_role("link", name="下载 PNG", exact=True)).to_have_count(0)
                self.page.keyboard.press("Escape")
                self.page.get_by_role("button", name="已失败", exact=True).click()
                expect(action).to_have_count(1 if state == "failed" else 0)
                self.page.get_by_role("button", name="全部", exact=True).click()
                self.page.get_by_role("button", name="刷新记录", exact=True).click()
                expect(self.page.get_by_role("button", name="刷新记录", exact=True)).to_be_enabled()
                self.reload()
                self.tab("生成记录")
                dialog = self.details(job["id"])
                expect(dialog.locator(f'[data-generation-state="{state}"]')).to_be_visible()
                repeat = self.generate(args)["structuredContent"]["job"]
                self.assertEqual((repeat["id"], repeat["state"]), (job["id"], state))
                self.assertEqual(self.rpc("fixture.metrics")["network"], before + 1)
                self.assertNotIn("fixture-private-key", self.page.locator("body").inner_text())
                self.assertNotIn("fixture-key-for-browser", self.page.locator("body").inner_text())
                self.page.keyboard.press("Escape")

    def test_corrupt_chunks_hash_and_browser_decode_block_download_and_allow_local_retry(self):
        job = self.generate(self.request(), "image-success")["structuredContent"]["job"]
        for corruption in ["chunk", "hash", "decode"]:
            with self.subTest(corruption=corruption):
                self.reload()
                self.page.evaluate("""kind => {
                  const invoke = pluginBridge.invoke; let once = true;
                  pluginBridge.invoke = async (channel, payload) => {
                    const result = await invoke(channel, payload);
                    if (once && result.ok && payload?.channel === 'aimedia.records.read') {
                      once = false;
                      if (kind === 'chunk') result.result.nextOffset++;
                      if (kind === 'hash') result.result.base64 = result.result.base64.replace(/./, c => c === 'A' ? 'B' : 'A');
                    }
                    return result;
                  };
                  if (kind === 'decode') {
                    const decode = HTMLImageElement.prototype.decode; let first = true;
                    HTMLImageElement.prototype.decode = function() {
                      if (first) { first = false; return Promise.reject(Error('Synthetic decoder failure')); }
                      return decode.call(this);
                    };
                  }
                }""", corruption)
                self.tab("生成记录")
                dialog = self.details(job["id"])
                expect(dialog.get_by_role("alert").filter(has_text="无法预览和下载")).to_be_visible(timeout=10000)
                expect(dialog.get_by_role("img")).to_have_count(0)
                expect(dialog.get_by_role("link", name="下载 PNG", exact=True)).to_have_count(0)
                self.assertTrue(self.page.evaluate("__urls.every(url => __revoked.includes(url))"))
                dialog.get_by_role("button", name="重试读取图片", exact=True).click()
                expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
                self.page.keyboard.press("Escape")
                self.assertTrue(self.page.evaluate("__urls.every(url => __revoked.includes(url))"))
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_late_details_do_not_reopen_or_steal_configuration_focus(self):
        job = self.generate(self.request(), "image-success")["structuredContent"]["job"]
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (payload?.channel === 'aimedia.records.get') {
              await new Promise(resolve => window.__releaseDetails = resolve);
              window.__detailsReleased = true;
            }
            return result;
          };
        }""")
        self.tab("生成记录")
        self.details(job["id"])
        self.page.wait_for_function("typeof window.__releaseDetails === 'function'")
        self.page.keyboard.press("Escape")
        self.tab("配置")
        self.page.evaluate("__releaseDetails()")
        self.page.wait_for_function("window.__detailsReleased === true")
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_be_focused()
        self.assertEqual(self.page.evaluate("__urls"), [])
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_late_preview_read_and_pagehide_release_image_resources(self):
        job = self.generate(self.request(), "image-success")["structuredContent"]["job"]
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke; let once = true;
          pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (once && payload?.channel === 'aimedia.records.read') {
              once = false; await new Promise(resolve => window.__releaseRead = resolve);
              window.__readReleased = true;
            }
            return result;
          };
        }""")
        self.tab("生成记录")
        self.details(job["id"])
        self.page.wait_for_function("typeof window.__releaseRead === 'function'")
        self.page.keyboard.press("Escape")
        self.tab("配置")
        self.page.evaluate("__releaseRead()")
        self.page.wait_for_function("window.__readReleased === true")
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_be_focused()
        self.assertEqual(self.page.evaluate("__urls"), [])
        self.tab("生成记录")
        dialog = self.details(job["id"])
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        self.assertTrue(self.page.evaluate("__urls.length > 0 && __urls.every(url => __revoked.includes(url))"))
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_two_tab_keyboard_responsive_themes_and_legacy_read_only(self):
        expect(self.page.get_by_role("tab")).to_have_text(["配置", "生成记录"])
        self.page.get_by_role("tab", name="配置", exact=True).focus()
        for key, name in [("ArrowRight", "生成记录"), ("ArrowRight", "配置"),
                          ("ArrowLeft", "生成记录"), ("Home", "配置"), ("End", "生成记录")]:
            self.page.keyboard.press(key)
            expect(self.page.get_by_role("tab", name=name, exact=True)).to_be_focused()
            expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")
        expect(self.page.get_by_role("heading", name="生成记录", exact=True)).to_be_visible()
        expect(self.page.locator(".records-empty")).to_contain_text("Agent")
        for width, theme in [(1100, "dark"), (390, "dark"), (320, "light")]:
            self.page.set_viewport_size({"width": width, "height": 850})
            self.page.evaluate("theme => document.documentElement.dataset.base = theme", theme)
            for name, artifact in [("配置", "config"), ("生成记录", "empty-records")]:
                with self.subTest(width=width, theme=theme, screen=name):
                    self.tab(name)
                    self.page.screenshot(path=str(SCRATCH / f"agent-only-{artifact}-{width}-{theme}.png"), full_page=True)
                    dimensions = self.page.evaluate("({content: document.documentElement.scrollWidth, viewport: innerWidth})")
                    self.assertLessEqual(dimensions["content"], dimensions["viewport"],
                                         f"{name} overflows at {width}px ({theme}): {dimensions}")
        self.rpc("fixture.backend", {"mode": "legacy"})
        self.page.reload()
        expect(self.page.locator("[data-config-readonly]")).to_be_visible()
        expect(self.page.get_by_role("tab")).to_have_text(["配置", "生成记录"])
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_disabled()
        self.tab("生成记录")
        expect(self.page.get_by_role("alert")).to_contain_text("当前后台不支持读取生成记录")
        expect(self.page.get_by_role("button", name="刷新记录", exact=True)).to_be_disabled()
        self.assertEqual(self.rpc("fixture.metrics")["network"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
