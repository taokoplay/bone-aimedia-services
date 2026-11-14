"""Agent speech -> unified records with real tools and synthetic MiniMax HTTP only.
Run: python3 tests/audio.browser.py (existing Playwright and Chrome required).
"""
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
TEXT = '这是一段合成测试文本。<img src=x onerror="window.__injected=1">'


class AudioBrowser(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={"width": 1160, "height": 900}, accept_downloads=True)
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors, self.requests = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda request: self.requests.append(request.url))
        self.page.goto(self.url)
        self.profile = self.configure("MiniMax", "Synthetic MiniMax", "speech-2.8-hd")
        self.assertEqual(self.rpc("fixture.metrics")["network"], 0)
        self.instrument()

    def configure(self, provider, name, model):
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name=provider, exact=True).click()
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill(name)
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        self.page.get_by_role("button", name=f"添加模型 {model}", exact=True).click()
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已保存")
        return next(profile["id"] for profile in self.rpc("aimedia.get")["profiles"] if profile["name"] == name)

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

    def tool(self, name, args):
        reply = self.rpc("fixture.tool", {"name": name, "args": args})["structuredContent"]
        self.assertTrue(reply["ok"], reply)
        return reply

    def request(self, text=TEXT):
        return {"requestKey": str(uuid.uuid4()), "modelRef": f"media:{self.profile}:speech-2.8-hd",
                "operation": "speech", "voiceId": "fixture-voice", "text": text, "speed": 1.2}

    def generate(self, args=None, mode="audio-success"):
        self.rpc("fixture.network", {"mode": mode})
        return self.tool("generate_audio", args if args is not None else self.request())["job"]

    def instrument(self):
        self.page.evaluate("""() => {
          window.__calls = []; window.__urls = []; window.__revoked = []; window.__decodes = 0;
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = (channel, payload) => {
            if (channel === 'aimedia.invoke') __calls.push(structuredClone(payload));
            return invoke(channel, payload);
          };
          const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
          URL.createObjectURL = blob => { const url = create(blob); __urls.push(url); return url; };
          URL.revokeObjectURL = url => { __revoked.push(url); revoke(url); };
          const decode = OfflineAudioContext.prototype.decodeAudioData;
          OfflineAudioContext.prototype.decodeAudioData = async function(bytes) {
            const result = await decode.call(this, bytes); __decodes++; return result;
          };
        }""")

    def reload(self):
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_have_attribute("aria-selected", "true")
        self.instrument()

    def calls(self, channel):
        return self.page.evaluate("channel => __calls.filter(call => call.channel === channel)", channel)

    def tab(self, name):
        self.page.get_by_role("tab", name=name, exact=True).click()
        expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")

    def details(self, job_id):
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="生成详情", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def play(self, audio):
        expect(audio).to_be_visible(timeout=10000)
        audio.evaluate("async audio => { window.__playing = audio; audio.loop = true; await audio.play(); }")
        self.page.wait_for_function("!__playing.paused && __playing.currentTime > 0")

    def assert_media_released(self):
        self.assertTrue(self.page.evaluate("""__playing.paused && !__playing.hasAttribute('src') &&
          __urls.length > 0 && __urls.every(url => __revoked.includes(url))"""))

    def test_agent_held_speech_mixed_records_play_original_download_and_restart(self):
        expect(self.page.get_by_role("tab")).to_have_text(["配置", "生成记录"])
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_have_attribute("aria-selected", "true")
        args = self.request()
        voices = self.tool("audio_voices", {"modelRef": args["modelRef"]})
        self.assertIn("fixture-voice", [voice["id"] for voice in voices["voices"]])
        self.tab("生成记录")
        expect(self.page.locator("[data-record-job]")).to_have_count(0)
        self.rpc("fixture.network", {"mode": "audio-held"})
        self.page.evaluate("""args => {
          window.__agentReply = null; window.__agentError = null;
          void pluginBridge.invoke('fixture.tool', {name:'generate_audio', args})
            .then(reply => window.__agentReply = reply, error => window.__agentError = String(error));
        }""", args)
        row = self.page.locator('[data-record-kind="audio"]')
        expect(row).to_have_count(1, timeout=10000)
        expect(row.locator('[data-generation-state="submitting"]')).to_be_visible()
        self.assertIsNone(self.page.evaluate("__agentReply"))
        job_id = row.get_attribute("data-record-job")
        dialog = self.details(job_id)
        expect(dialog.locator('[data-generation-state="submitting"]')).to_be_visible()
        self.rpc("fixture.audioRelease", {"outcome": "success"})
        self.page.wait_for_function("__agentReply !== null || __agentError !== null")
        self.assertIsNone(self.page.evaluate("__agentError"))
        job = self.page.evaluate("__agentReply.structuredContent.job")
        self.assertEqual((job["id"], job["state"], job["request"]["speed"]), (job_id, "succeeded", 1.2))
        expect(dialog.locator('[data-generation-state="succeeded"]')).to_be_visible(timeout=10000)
        audio = dialog.locator("audio")
        self.play(audio)
        self.assertGreater(self.page.evaluate("__decodes"), 0)
        for value in ["MP3", "时长", "采样率", "声道", "fixture-voice", "1.2 ×"]:
            expect(dialog).to_contain_text(value)
        count = len(self.calls("aimedia.records.list"))
        self.page.wait_for_function("n => __calls.filter(c => c.channel === 'aimedia.records.list').length > n", arg=count)
        expect(self.page.get_by_role("button", name="刷新记录", exact=True, include_hidden=True)).to_be_enabled()
        self.assertTrue(audio.evaluate("audio => audio === __playing && !audio.paused"))
        with self.page.expect_download() as event:
            dialog.get_by_role("link", name="下载 MP3", exact=True).click()
        data = Path(event.value.path()).read_bytes()
        self.assertEqual(len(data), job["result"]["byteLength"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), job["result"]["sha256"])
        self.assertEqual(event.value.suggested_filename, job_id + ".mp3")
        for key in ["Tab", "Shift+Tab"]:
            for _ in range(12):
                self.page.keyboard.press(key)
                self.assertTrue(dialog.evaluate("dialog => dialog.contains(document.activeElement)"))
        dialog.locator("summary").filter(has_text="朗读文本").click()
        expect(dialog.locator(".record-prompt-text")).to_have_text(TEXT)
        self.assertIsNone(self.page.evaluate("window.__injected"))
        self.page.screenshot(path=str(SCRATCH / "agent-only-audio-detail-1160-dark.png"))
        self.page.keyboard.press("Escape")
        self.assert_media_released()
        expect(self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True)).to_be_focused()
        self.assertEqual(self.tool("generate_audio", args)["job"]["id"], job_id)
        self.tab("配置")
        image_profile = self.configure("ChatGPT / OpenAI 图片", "Synthetic GPT", "GPT Image 2")
        self.tab("生成记录")
        self.rpc("fixture.network", {"mode": "image-success"})
        image = self.tool("generate_image", {"requestKey": str(uuid.uuid4()),
            "modelRef": f"media:{image_profile}:gpt-image-2", "prompt": "Synthetic image"})["job"]
        expect(self.page.locator("[data-record-job]")).to_have_count(2, timeout=10000)
        expect(self.page.locator("[data-record-kind=audio]")).to_contain_text("语音合成")
        expect(self.page.locator("[data-record-kind=image]")).to_contain_text("图片生成")
        self.rpc("fixture.restart")
        self.reload()
        self.tab("生成记录")
        expect(self.page.locator("[data-record-job]")).to_have_count(2)
        self.assertEqual(self.tool("generate_audio", args)["job"]["id"], job_id)
        dialog = self.details(image["id"])
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.page.keyboard.press("Escape")
        for width, theme in [(1160, "dark"), (390, "dark"), (320, "light")]:
            self.page.set_viewport_size({"width": width, "height": 880})
            self.page.evaluate("theme => document.documentElement.dataset.base = theme", theme)
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            self.page.screenshot(path=str(SCRATCH / f"agent-only-mixed-records-{width}-{theme}.png"), full_page=True)
            dialog = self.details(job_id)
            expect(dialog.locator("audio")).to_be_visible()
            self.assertTrue(dialog.evaluate("d => d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().width <= innerWidth"))
            self.page.screenshot(path=str(SCRATCH / f"agent-only-audio-detail-{width}-{theme}.png"))
            self.page.emulate_media(reduced_motion="reduce")
            self.assertEqual(dialog.evaluate("d => getComputedStyle(d).animationName"), "none")
            self.page.keyboard.press("Escape")
        self.assertEqual(self.rpc("fixture.metrics")["perKind"], {"audio": 1, "image": 1, "voices": 1, "other": 0})

    def test_failed_unknown_and_pending_list_refresh_reload_and_same_key_never_resubmit(self):
        for mode, state in [("audio-failed", "failed"), ("audio-rate", "failed"),
                            ("audio-timeout", "unknown"), ("audio-unknown", "unknown"), ("audio-invalid", "result-pending")]:
            with self.subTest(mode=mode):
                args = self.request(mode)
                before = self.rpc("fixture.metrics")["perKind"]["audio"]
                job = self.generate(args, mode)
                self.assertEqual(job["state"], state)
                self.tab("生成记录")
                action = self.page.get_by_role("button", name=f'查看任务 {job["id"]}', exact=True)
                expect(action).to_be_visible(timeout=10000)
                dialog = self.details(job["id"])
                expect(dialog.locator(f'[data-generation-state="{state}"]')).to_be_visible()
                if state == "unknown":
                    expect(dialog).to_contain_text("可能已收费")
                expect(dialog.locator("audio")).to_have_count(0)
                expect(dialog.get_by_role("link", name="下载 MP3", exact=True)).to_have_count(0)
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
                repeat = self.tool("generate_audio", args)["job"]
                self.assertEqual((repeat["id"], repeat["state"]), (job["id"], state))
                self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], before + 1)
                self.assertNotIn("fixture-key-for-browser", self.page.locator("body").inner_text())
                self.page.keyboard.press("Escape")

    def test_visible_poll_discovers_agent_jobs_preserves_focus_and_stops_when_hidden_or_config(self):
        self.tab("生成记录")
        first = self.generate()
        action = self.page.get_by_role("button", name=f'查看任务 {first["id"]}', exact=True)
        expect(action).to_be_visible(timeout=10000)
        action.focus()
        action.evaluate("node => window.__originalAction = node")
        second = self.generate()
        expect(self.page.get_by_role("button", name=f'查看任务 {second["id"]}', exact=True)).to_be_visible(timeout=10000)
        expect(self.page.locator("[data-record-job]")).to_have_count(2)
        expect(action).to_be_focused()
        self.assertTrue(action.evaluate("node => node === __originalAction"))
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke; let held = false;
          pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (!held && payload?.channel === 'aimedia.records.list') {
              held = true; await new Promise(resolve => window.__releaseList = resolve);
              window.__listReleased = true;
            }
            return result;
          };
        }""")
        self.page.wait_for_function("typeof window.__releaseList === 'function'")
        count = len(self.calls("aimedia.records.list"))
        self.page.clock.install()
        self.page.clock.fast_forward(6000)
        self.assertEqual(len(self.calls("aimedia.records.list")), count, "Local list reads overlapped")
        self.page.evaluate("""() => {
          Object.defineProperty(document, 'hidden', {configurable:true, value:true});
          document.dispatchEvent(new Event('visibilitychange')); __releaseList();
        }""")
        self.page.wait_for_function("window.__listReleased === true")
        self.page.clock.fast_forward(6000)
        self.assertEqual(len(self.calls("aimedia.records.list")), count, "Hidden records kept polling")
        self.page.evaluate("""() => {
          Object.defineProperty(document, 'hidden', {configurable:true, value:false});
          document.dispatchEvent(new Event('visibilitychange'));
        }""")
        self.page.wait_for_function("n => __calls.filter(c => c.channel === 'aimedia.records.list').length > n", arg=count)
        expect(self.page.get_by_role("button", name="刷新记录", exact=True)).to_be_enabled()
        self.tab("配置")
        count = len(self.calls("aimedia.records.list"))
        self.page.clock.fast_forward(6000)
        self.assertEqual(len(self.calls("aimedia.records.list")), count, "Configuration kept records polling")
        self.assertEqual(self.rpc("fixture.metrics")["network"], 2)

    def test_corrupt_chunks_hash_duration_and_decode_allow_only_local_retry(self):
        job = self.generate()
        for corruption in ["chunk", "hash", "duration", "decode"]:
            with self.subTest(corruption=corruption):
                self.reload()
                self.page.evaluate("""kind => {
                  const invoke = pluginBridge.invoke; let once = true;
                  pluginBridge.invoke = async (channel, payload) => {
                    const result = await invoke(channel, payload);
                    if (once && result.ok && payload?.channel === (kind === 'duration' ? 'aimedia.records.get' : 'aimedia.records.read')) {
                      once = false;
                      if (kind === 'chunk') result.result.nextOffset++;
                      if (kind === 'hash') result.result.base64 = result.result.base64.replace(/./, c => c === 'A' ? 'B' : 'A');
                      if (kind === 'duration') result.result.result.durationMs += 10000;
                    }
                    return result;
                  };
                  if (kind === 'decode') {
                    const decode = OfflineAudioContext.prototype.decodeAudioData; let first = true;
                    OfflineAudioContext.prototype.decodeAudioData = function(bytes) {
                      if (first) { first = false; return Promise.reject(Error('Synthetic decoder failure')); }
                      return decode.call(this, bytes);
                    };
                  }
                }""", corruption)
                self.tab("生成记录")
                dialog = self.details(job["id"])
                expect(dialog.get_by_role("alert").filter(has_text="无法预览和下载")).to_be_visible(timeout=10000)
                expect(dialog.locator("audio")).to_have_count(0)
                expect(dialog.get_by_role("link", name="下载 MP3", exact=True)).to_have_count(0)
                self.assertTrue(self.page.evaluate("__urls.every(url => __revoked.includes(url))"))
                if corruption == "duration":
                    self.page.keyboard.press("Escape")
                    dialog = self.details(job["id"])
                else:
                    dialog.get_by_role("button", name="重试读取音频", exact=True).click()
                self.play(dialog.locator("audio"))
                self.page.keyboard.press("Escape")
                self.assert_media_released()
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_late_read_and_decode_do_not_reopen_or_restore_audio_and_focus(self):
        job = self.generate()
        for stage in ["read", "decode"]:
            with self.subTest(stage=stage):
                self.reload()
                self.page.evaluate("""stage => {
                  let once = true;
                  const hold = async () => {
                    await new Promise(resolve => window.__releaseResult = resolve);
                    window.__resultReleased = true;
                  };
                  if (stage === 'read') {
                    const invoke = pluginBridge.invoke;
                    pluginBridge.invoke = async (channel, payload) => {
                      const result = await invoke(channel, payload);
                      if (once && payload?.channel === 'aimedia.records.read') { once = false; await hold(); }
                      return result;
                    };
                  } else {
                    const decode = OfflineAudioContext.prototype.decodeAudioData;
                    OfflineAudioContext.prototype.decodeAudioData = async function(bytes) {
                      const result = await decode.call(this, bytes);
                      if (once) { once = false; await hold(); }
                      return result;
                    };
                  }
                }""", stage)
                self.tab("生成记录")
                dialog = self.details(job["id"])
                self.page.wait_for_function("typeof window.__releaseResult === 'function'")
                expect(dialog.locator("audio")).to_have_count(0)
                self.page.keyboard.press("Escape")
                self.tab("配置")
                self.page.evaluate("__releaseResult()")
                self.page.wait_for_function("window.__resultReleased === true")
                expect(self.page.locator("audio")).to_have_count(0)
                expect(self.page.get_by_role("dialog")).to_have_count(0)
                expect(self.page.get_by_role("tab", name="配置", exact=True)).to_be_focused()
                self.assertEqual(self.page.evaluate("__urls"), [])
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_audio_close_configuration_navigation_and_pagehide_stop_playback(self):
        job = self.generate()
        self.tab("生成记录")
        dialog = self.details(job["id"])
        self.play(dialog.locator("audio"))
        dialog.get_by_role("button", name="关闭详情", exact=True).click()
        self.tab("配置")
        self.assert_media_released()
        self.tab("生成记录")
        dialog = self.details(job["id"])
        self.play(dialog.locator("audio"))
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        self.assert_media_released()
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)

    def test_lost_agent_acknowledgement_recovers_original_record_with_same_request_key(self):
        args = self.request()
        self.rpc("fixture.network", {"mode": "audio-success"})
        self.tab("生成记录")
        self.page.evaluate("""args => {
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel, payload) => {
            const result = await invoke(channel, payload);
            if (channel === 'fixture.tool' && payload.name === 'generate_audio')
              throw Error('Synthetic lost tool acknowledgement');
            return result;
          };
          window.__lostAck = null;
          void pluginBridge.invoke('fixture.tool', {name:'generate_audio', args})
            .catch(error => window.__lostAck = error.message);
        }""", args)
        self.page.wait_for_function("window.__lostAck !== null")
        self.assertEqual(self.page.evaluate("__lostAck"), "Synthetic lost tool acknowledgement")
        row = self.page.locator('[data-record-kind="audio"]')
        expect(row).to_have_count(1, timeout=10000)
        job_id = row.get_attribute("data-record-job")
        dialog = self.details(job_id)
        expect(dialog.locator("audio")).to_be_visible()
        recovered = self.tool("generate_audio", args)["job"]
        self.assertEqual((recovered["id"], recovered["state"]), (job_id, "succeeded"))
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
