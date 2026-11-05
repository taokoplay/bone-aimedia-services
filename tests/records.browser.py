"""Unified local generation records, real plugin entry, synthetic suppliers only."""
import hashlib
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import unittest
import uuid
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ["PI_SCRATCH_DIR"])


class RecordsBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chrome", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.host = subprocess.Popen([shutil.which("node"), str(ROOT / "tests/settings-host.cjs")], cwd=ROOT,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop_host)
        with selectors.DefaultSelector() as selector:
            selector.register(self.host.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(20), "Fixture URL was not announced")
            self.url = self.host.stdout.readline().strip()
        self.assertTrue(self.url.startswith("http://127.0.0.1:"))
        self.context = self.browser.new_context(viewport={"width": 1160, "height": 900}, accept_downloads=True)
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.url)
        self.page.wait_for_load_state("networkidle")
        profiles = [{"id": key, "provider": "openai", "name": label,
                     "models": [{"id": model, "name": model, "kind": "image"}],
                     "credentialUpdate": {"action": "replace", "value": "fixture-records-key"}}
                    for key, label, model in [("first", "传贝GPT", "gpt-image-2"),
                                              ("second", "团队渠道", "gpt-image-2.5-flare")]]
        self.rpc("aimedia.save", {"expectedRevision": 0, "profiles": profiles,
                                  "defaults": {"image": None, "video": None, "audio": None}})
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.jobs = {}
        self.network = 0

    def stop_host(self):
        if self.host.poll() is None:
            self.host.terminate()
            try:
                self.host.wait(4)
            except subprocess.TimeoutExpired:
                self.host.kill()
                self.host.wait(4)
        self.host.stdout.close()
        self.host.stderr.close()

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def rpc(self, channel, payload=None):
        response = self.context.request.post(self.url + "/bridge", data={"channel": channel, "payload": payload})
        data = response.json()
        self.assertNotIn("error", data, str(data))
        return data["result"]

    def create_job(self, label, mode=None, profile="first", prompt=None):
        request = {"requestId": str(uuid.uuid4()), "profileId": profile, "expectedRevision": 1,
                   "modelId": "gpt-image-2" if profile == "first" else "gpt-image-2.5-flare",
                   "prompt": prompt or f"Fixture image {label}", "size": "1024x1024", "quality": "low"}
        job = self.rpc("aimedia.image.prepare", request)
        if mode:
            self.rpc("fixture.network", {"mode": mode})
            job = self.rpc("aimedia.image.submit", {"jobId": job["id"], "requestHash": job["requestHash"], "confirm": True})
            if mode != "image-held":
                self.page.wait_for_function("""async id => (await pluginBridge.invoke('aimedia.image.get', {jobId:id})).state !== 'submitting'""", arg=job["id"], polling=100)
                job = self.rpc("aimedia.image.get", {"jobId": job["id"]})
        self.jobs[label] = job
        return job

    def seed(self):
        self.create_job("completed", "image-success")
        self.create_job("completed2", "image-success", "second")
        self.create_job("failed", "unauthorized")
        self.create_job("unknown", "image-timeout")
        self.create_job("pending", "image-invalid")
        self.create_job("prepared")
        self.create_job("generating", "image-held", "second")
        self.network = self.rpc("fixture.metrics")["network"]

    def records(self):
        self.page.get_by_role("tab", name="生成记录", exact=True).click()
        expect(self.page.locator("[data-generation-list]")).to_be_visible()

    def row(self, label):
        return self.page.locator(f'[data-image-job="{self.jobs[label]["id"]}"]')

    def details(self, label):
        self.row(label).get_by_role("button", name=f'查看任务 {self.jobs[label]["id"]}', exact=True).click()
        dialog = self.page.get_by_role("dialog", name="生成详情", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def test_unified_filters_metadata_and_no_remote_requests(self):
        self.seed()
        self.records()
        expect(self.page.get_by_role("tab")).to_have_count(3)
        expect(self.page.get_by_role("tab", name="任务队列", exact=True)).to_have_count(0)
        expect(self.page.locator("[data-image-job]")).to_have_count(7)
        expect(self.row("completed")).to_contain_text("传贝GPT")
        expect(self.row("completed2")).to_contain_text("团队渠道")
        expect(self.row("completed2")).to_contain_text("gpt-image-2.5-flare")
        expect(self.row("completed2").get_by_role("cell").filter(has_text="团队渠道").filter(has_text="gpt-image-2.5-flare")).to_have_count(1)
        expect(self.page.get_by_role("columnheader")).to_have_text(["任务", "渠道 / 模型", "状态", "创建时间", "操作"])
        expect(self.row("unknown")).to_contain_text("待核对")
        expect(self.row("pending")).to_contain_text("待核对")
        expect(self.row("prepared")).to_contain_text("待确认")
        for label, count in [("生成中", 1), ("已完成", 2), ("已失败", 1), ("全部", 7)]:
            control = self.page.get_by_role("button", name=label, exact=True)
            control.click()
            expect(control).to_have_attribute("aria-pressed", "true")
            expect(self.page.locator("[data-image-job]")).to_have_count(count)
        expect(self.page.get_by_role("button", name="刷新记录", exact=True)).to_have_count(1)
        expect(self.page.get_by_role("button", name="重新读取", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="远端 ComfyUI 连接", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("heading", name="任务详情", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="刷新记录", exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_completed_modal_preview_actual_dimensions_download_and_focus(self):
        self.seed()
        self.records()
        dialog = self.details("completed")
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible(timeout=10000)
        text = dialog.inner_text()
        self.assertIn("1024", text)
        self.assertIn("实际尺寸", text)
        self.assertIn("32", text)
        expect(dialog.get_by_role("button", name="确认生成…", exact=True)).to_have_count(0)
        with self.page.expect_download() as event:
            dialog.get_by_role("link", name="下载 PNG", exact=True).click()
        data = Path(event.value.path()).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), self.jobs["completed"]["result"]["sha256"])
        for key in ["Tab", "Shift+Tab"]:
            for _ in range(12):
                self.page.keyboard.press(key)
                self.assertTrue(dialog.evaluate("dialog => dialog.contains(document.activeElement)"))
        dialog.locator("summary").filter(has_text="提示词").click()
        expect(dialog.locator(".record-prompt-text")).to_have_text(self.jobs["completed"]["request"]["prompt"])
        dialog.get_by_role("button", name="关闭详情", exact=True).focus()
        self.page.keyboard.press("Shift+Tab")
        expect(dialog.locator("summary").filter(has_text="技术详情")).to_be_focused()
        self.page.keyboard.press("Tab")
        expect(dialog.get_by_role("button", name="关闭详情", exact=True)).to_be_focused()
        self.page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(self.row("completed").get_by_role("button", name=f'查看任务 {self.jobs["completed"]["id"]}')).to_be_focused()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_generating_transitions_to_completed_with_modal_retained(self):
        self.seed()
        self.records()
        self.page.get_by_role("button", name="生成中", exact=True).click()
        dialog = self.details("generating")
        expect(dialog.locator('[data-generation-state="submitting"]')).to_be_visible()
        dialog.evaluate("dialog => window.__originalRecordDialog = dialog")
        close = dialog.get_by_role("button", name="关闭详情", exact=True)
        close.focus()
        self.rpc("fixture.imageRelease", {"outcome": "success"})
        expect(dialog.locator('[data-generation-state="succeeded"]')).to_be_visible(timeout=10000)
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.assertTrue(dialog.evaluate("dialog => dialog === window.__originalRecordDialog"))
        expect(close).to_be_focused()
        close.click()
        expect(self.page.locator("[data-image-job]")).to_have_count(0)
        self.page.get_by_role("button", name="已完成", exact=True).click()
        expect(self.page.locator("[data-image-job]")).to_have_count(3)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_late_details_do_not_reopen_closed_modal(self):
        self.seed()
        self.records()
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel,payload) => {
            const result = await invoke(channel,payload);
            if(payload?.channel === 'aimedia.image.get') await new Promise(resolve => window.__releaseDetail = resolve);
            return result;
          };
        }""")
        dialog = self.details("completed")
        self.page.wait_for_function("typeof __releaseDetail === 'function'")
        self.page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        self.page.get_by_role("tab", name="配置", exact=True).click()
        self.page.evaluate("window.__releaseDetail()")
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_be_focused()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_unknown_is_not_failure_and_detail_failure_can_recover(self):
        self.seed()
        self.records()
        dialog = self.details("unknown")
        expect(dialog).to_contain_text("可能已收费")
        expect(dialog.get_by_role("link", name="下载 PNG", exact=True)).to_have_count(0)
        dialog.get_by_role("button", name="关闭详情", exact=True).click()
        self.page.get_by_role("button", name="已失败", exact=True).click()
        expect(self.row("unknown")).to_have_count(0)
        expect(self.row("failed")).to_have_count(1)
        self.page.get_by_role("button", name="全部", exact=True).click()
        self.page.evaluate("""id => {
          const invoke = pluginBridge.invoke; let once = true;
          pluginBridge.invoke = async (channel,payload) => {
            if(once && payload?.channel === 'aimedia.image.get' && payload.payload?.jobId === id) { once = false; throw Error('Synthetic detail read failure'); }
            return invoke(channel,payload);
          };
        }""", self.jobs["completed"]["id"])
        dialog = self.details("completed")
        expect(dialog.locator('[role="alert"]:visible')).to_be_visible()
        dialog.get_by_role("button", name="重试读取", exact=True).click()
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_responsive_theme_visuals_and_scroll_restoration(self):
        self.seed()
        for n in range(12):
            self.create_job(f"extra-{n}")
        self.records()
        expect(self.page.locator("[data-image-job]")).to_have_count(19)
        target = self.row("completed").get_by_role("button", name=f'查看任务 {self.jobs["completed"]["id"]}')
        target.scroll_into_view_if_needed()
        before = self.page.evaluate("window.scrollY")
        target.click()
        dialog = self.page.get_by_role("dialog", name="生成详情", exact=True)
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.page.keyboard.press("Escape")
        self.assertAlmostEqual(before, self.page.evaluate("window.scrollY"), delta=3)
        for width, theme in [(1160, "dark"), (390, "dark"), (320, "light")]:
            self.page.set_viewport_size({"width": width, "height": 880})
            self.page.evaluate("theme => document.documentElement.dataset.base = theme", theme)
            self.page.evaluate("window.scrollTo(0,0)")
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            channel = self.row("completed2").get_by_text("团队渠道", exact=True).bounding_box()
            model = self.row("completed2").get_by_text("gpt-image-2.5-flare", exact=True).bounding_box()
            self.assertAlmostEqual(channel["x"], model["x"], delta=1)
            self.assertGreaterEqual(model["y"], channel["y"] + channel["height"])
            self.page.screenshot(path=str(SCRATCH / f"records-{width}-{theme}.png"))
            dialog = self.details("completed")
            expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
            self.assertTrue(dialog.evaluate("dialog => dialog.getBoundingClientRect().width <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1"))
            self.page.screenshot(path=str(SCRATCH / f"record-dialog-{width}-{theme}.png"))
            dialog.get_by_role("button", name="关闭详情", exact=True).click()

    def test_empty_records_and_keyboard_navigation(self):
        self.records()
        expect(self.page.locator("[data-image-job]")).to_have_count(0)
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.page.get_by_role("button", name="已失败", exact=True).click()
        self.page.get_by_role("tab", name="配置", exact=True).focus()
        self.page.keyboard.press("End")
        expect(self.page.get_by_role("tab", name="生成记录", exact=True)).to_be_focused()
        self.assertEqual(self.rpc("fixture.metrics")["network"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
