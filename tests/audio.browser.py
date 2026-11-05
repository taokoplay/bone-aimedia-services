"""Real plugin entry + isolated synthetic MiniMax speech. No real credentials or provider calls."""
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
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="MiniMax", exact=True).click()
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Synthetic MiniMax")
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        self.page.get_by_role("button", name="添加模型 speech-2.8-hd", exact=True).click()
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已保存")
        self.profile = self.rpc("aimedia.get")["profiles"][0]["id"]
        self.instrument()

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
          OfflineAudioContext.prototype.decodeAudioData = async function(bytes) { const result = await decode.call(this, bytes); __decodes++; return result; };
        }""")

    def calls(self, channel):
        return self.page.evaluate("channel => __calls.filter(call => call.channel === channel)", channel)

    def tab(self, name):
        self.page.get_by_role("tab", name=name, exact=True).click()
        expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")

    def pick(self, label, option):
        self.page.get_by_role("button", name=label, exact=True).click()
        self.page.get_by_role("option", name=option, exact=True).click()

    def fill(self, text=TEXT, fetch=True):
        self.tab("声音")
        self.pick("MiniMax 服务", "Synthetic MiniMax")
        self.pick("语音模型", "speech-2.8-hd · speech-2.8-hd")
        if fetch:
            self.page.get_by_role("button", name="获取音色", exact=True).click()
            expect(self.page.get_by_role("button", name="账号音色", exact=True)).to_be_visible()
            expect(self.page.get_by_role("textbox", name="音色 ID", exact=True)).to_have_value("")
            self.pick("账号音色", "测试音色 · fixture-voice")
        self.page.get_by_role("textbox", name="朗读文本", exact=True).fill(text)

    def prepare(self):
        self.page.get_by_role("button", name="准备语音", exact=True).click()
        expect(self.page.locator('[data-generation-state="prepared"]')).to_be_visible()
        return self.page.locator("[data-generation-job]").get_attribute("data-generation-job")

    def confirm(self):
        self.page.get_by_role("button", name="确认合成…", exact=True).evaluate("node => { node.click(); node.click(); }")
        dialog = self.page.get_by_role("dialog")
        expect(dialog).to_have_count(1)
        expect(dialog).to_contain_text("可能产生费用")
        expect(dialog).to_contain_text("预估费用未知")
        dialog.get_by_role("button", name="合成 1 段语音", exact=True).click()

    def create_job(self, kind="audio", mode=None):
        state = self.rpc("aimedia.get")
        if kind == "image" and not any(p["provider"] == "openai" for p in state["profiles"]):
            profiles = state["profiles"] + [{"id": "image-fixture", "provider": "openai", "name": "Synthetic GPT",
                "models": [{"id": "gpt-image-2", "name": "GPT Image 2", "kind": "image"}],
                "credentialUpdate": {"action": "replace", "value": "fixture-image-key"}}]
            state = self.rpc("aimedia.save", {"expectedRevision": state["revision"], "profiles": profiles,
                "defaults": state["defaults"], "workflows": state["workflows"]})
        request = {"requestId": str(uuid.uuid4()), "profileId": self.profile if kind == "audio" else "image-fixture", "expectedRevision": state["revision"]}
        request.update({"modelId": "speech-2.8-hd", "operation": "speech", "voiceId": "fixture-voice", "text": TEXT, "speed": 1}
                       if kind == "audio" else {"modelId": "gpt-image-2", "prompt": "Synthetic image", "size": "1024x1024", "quality": "low"})
        job = self.rpc(f"aimedia.{kind}.prepare", request)
        if mode:
            self.rpc("fixture.network", {"mode": mode})
            job = self.rpc(f"aimedia.{kind}.submit", {"jobId": job["id"], "requestHash": job["requestHash"], "confirm": True})
            if not mode.endswith("held"):
                self.page.wait_for_function("""async ({kind,id}) => (await pluginBridge.invoke(`aimedia.${kind}.get`, {jobId:id})).state !== 'submitting'""", arg={"kind": kind, "id": job["id"]})
                job = self.rpc(f"aimedia.{kind}.get", {"jobId": job["id"]})
        return job

    def details(self, job_id):
        self.page.get_by_role("button", name=f"查看任务 {job_id}", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="生成详情", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def test_configure_voice_prepare_confirm_mixed_records_play_download_and_restart(self):
        expect(self.page.get_by_role("tab")).to_have_count(4)
        self.fill()
        expect(self.page.locator(".audio-view")).to_contain_text("不支持脚步声、环境音")
        expect(self.page.get_by_role("spinbutton", name="语速", exact=True)).to_have_value("1")
        self.page.get_by_role("spinbutton", name="语速", exact=True).fill("1.2")
        self.page.screenshot(path=str(SCRATCH / "audio-form-1160-dark.png"), full_page=True)
        job_id = self.prepare()
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 0)
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["voices"], 1)
        self.assertEqual(self.calls("aimedia.audio.prepare")[0]["payload"]["speed"], 1.2)
        self.assertIsNone(self.page.evaluate("window.__injected"))
        self.page.get_by_role("button", name="确认合成…", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 0)
        self.rpc("fixture.network", {"mode": "audio-held"})
        self.confirm()
        expect(self.page.locator('[data-generation-state="submitting"]')).to_be_visible()
        self.tab("生成记录")
        dialog = self.details(job_id)
        expect(dialog.locator('[data-generation-state="submitting"]')).to_be_visible()
        self.rpc("fixture.audioRelease", {"outcome": "success"})
        expect(dialog.locator('[data-generation-state="succeeded"]')).to_be_visible(timeout=15000)
        audio = dialog.locator("audio")
        expect(audio).to_be_visible(timeout=10000)
        self.assertGreater(self.page.evaluate("__decodes"), 0)
        for value in ["MP3", "时长", "采样率", "声道", "fixture-voice"]:
            expect(dialog).to_contain_text(value)
        audio.evaluate("async audio => { window.__playing = audio; audio.loop = true; await audio.play(); }")
        self.page.wait_for_function("!__playing.paused && __playing.currentTime > 0")
        count = len(self.calls("aimedia.records.list"))
        self.page.wait_for_function("n => __calls.filter(c => c.channel === 'aimedia.records.list').length > n", arg=count)
        self.assertTrue(audio.evaluate("audio => audio === __playing && !audio.paused"))
        with self.page.expect_download() as event:
            dialog.get_by_role("link", name="下载 MP3", exact=True).click()
        data = Path(event.value.path()).read_bytes()
        job = self.rpc("aimedia.audio.get", {"jobId": job_id})
        self.assertEqual(hashlib.sha256(data).hexdigest(), job["result"]["sha256"])
        self.assertEqual(event.value.suggested_filename, job_id + ".mp3")
        self.assertEqual(len(self.calls("aimedia.audio.submit")), 1)
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 1)
        for key in ["Tab", "Shift+Tab"]:
            for _ in range(12):
                self.page.keyboard.press(key)
                self.assertTrue(dialog.evaluate("dialog => dialog.contains(document.activeElement)"))
        dialog.locator("summary").filter(has_text="朗读文本").click()
        expect(dialog.locator(".record-prompt-text")).to_have_text(TEXT)
        self.page.screenshot(path=str(SCRATCH / "audio-detail-1160-dark.png"))
        self.page.keyboard.press("Escape")
        self.assertTrue(self.page.evaluate("__playing.paused && !__playing.hasAttribute('src') && __urls.every(u => __revoked.includes(u))"))
        image = self.create_job("image", "image-success")
        expect(self.page.locator("[data-record-job]")).to_have_count(2, timeout=10000)
        expect(self.page.locator("[data-record-kind=audio]")).to_contain_text("语音合成")
        expect(self.page.locator("[data-record-kind=image]")).to_contain_text("图片生成")
        self.rpc("fixture.restart")
        self.page.reload()
        self.tab("生成记录")
        expect(self.page.locator("[data-record-job]")).to_have_count(2)
        dialog = self.details(image["id"])
        expect(dialog.get_by_role("img", name="生成图片预览", exact=True)).to_be_visible()
        self.page.keyboard.press("Escape")
        for width, theme in [(1160, "dark"), (390, "dark"), (320, "light")]:
            self.page.set_viewport_size({"width": width, "height": 880})
            self.page.evaluate("theme => document.documentElement.dataset.base = theme", theme)
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            self.page.screenshot(path=str(SCRATCH / f"mixed-records-{width}-{theme}.png"), full_page=True)
            dialog = self.details(job_id)
            expect(dialog.locator("audio")).to_be_visible()
            self.assertTrue(dialog.evaluate("d => d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().width <= innerWidth"))
            self.page.screenshot(path=str(SCRATCH / f"audio-detail-{width}-{theme}.png"))
            self.page.emulate_media(reduced_motion="reduce")
            self.assertEqual(dialog.evaluate("d => getComputedStyle(d).animationName"), "none")
            self.page.keyboard.press("Escape")

    def test_explicit_voice_validation_and_catalog_failure_recovery(self):
        self.fill(fetch=False)
        self.page.get_by_role("button", name="准备语音", exact=True).click()
        expect(self.page.locator("#audio-form-error")).to_contain_text("音色 ID")
        self.assertEqual(len(self.calls("aimedia.audio.prepare")), 0)
        self.rpc("fixture.network", {"mode": "minimax-voices-failed"})
        self.page.get_by_role("button", name="获取音色", exact=True).click()
        expect(self.page.locator(".audio-voice-status")).to_contain_text("查询未完成")
        self.rpc("fixture.network", {"mode": "normal"})
        self.page.get_by_role("button", name="获取音色", exact=True).click()
        self.pick("账号音色", "测试音色 · fixture-voice")
        expect(self.page.get_by_role("textbox", name="朗读文本", exact=True)).to_have_attribute("maxlength", "1000")
        self.page.get_by_role("spinbutton", name="语速", exact=True).fill("2.1")
        self.page.get_by_role("button", name="准备语音", exact=True).click()
        expect(self.page.locator("#audio-form-error")).to_contain_text("0.5 到 2")
        self.assertEqual(len(self.calls("aimedia.audio.prepare")), 0)
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 0)
        for width in [390, 320]:
            self.page.set_viewport_size({"width": width, "height": 880})
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            self.page.screenshot(path=str(SCRATCH / f"audio-form-{width}-dark.png"), full_page=True)

    def test_failed_unknown_and_invalid_never_resubmit(self):
        for mode, state in [("audio-failed", "failed"), ("audio-rate", "failed"), ("audio-timeout", "unknown"), ("audio-unknown", "unknown"), ("audio-invalid", "result-pending")]:
            with self.subTest(mode=mode):
                self.page.reload()
                expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
                self.fill(fetch=False)
                self.page.get_by_role("textbox", name="音色 ID", exact=True).fill("fixture-voice")
                self.rpc("fixture.network", {"mode": mode})
                before = self.rpc("fixture.metrics")["perKind"]["audio"]
                job_id = self.prepare()
                self.confirm()
                expect(self.page.locator(f'[data-generation-state="{state}"]')).to_be_visible(timeout=15000)
                expect(self.page.get_by_role("button", name="确认合成…", exact=True)).to_have_count(0)
                expect(self.page.locator("audio")).to_have_count(0)
                expect(self.page.get_by_role("link", name="下载 MP3", exact=True)).to_have_count(0)
                self.page.get_by_role("button", name="重新读取本地任务", exact=True).click()
                self.tab("生成记录")
                dialog = self.details(job_id)
                if state == "unknown":
                    expect(dialog).to_contain_text("可能已收费")
                    expect(dialog).to_contain_text("待核对")
                expect(dialog.get_by_role("button", name="确认合成…", exact=True)).to_have_count(0)
                self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], before + 1)
                self.assertNotIn("fixture-key-for-browser", self.page.locator("body").inner_text())

    def test_local_list_discovers_new_jobs_preserves_focus_and_does_not_overlap_or_poll_hidden(self):
        first = self.create_job()
        self.tab("生成记录")
        action = self.page.get_by_role("button", name=f'查看任务 {first["id"]}', exact=True)
        action.focus()
        action.evaluate("node => window.__originalAction = node")
        self.rpc("fixture.network", {"mode": "audio-success"})
        generated = self.rpc("fixture.tool", {"name": "generate_audio", "args": {"requestKey": str(uuid.uuid4()), "modelRef": f"media:{self.profile}:speech-2.8-hd", "operation": "speech", "voiceId": "fixture-voice", "text": TEXT}})["structuredContent"]
        self.assertTrue(generated["ok"], generated)
        self.assertEqual(generated["job"]["state"], "succeeded")
        expect(self.page.locator("[data-record-job]")).to_have_count(2, timeout=10000)
        expect(action).to_be_focused()
        self.assertTrue(action.evaluate("node => node === __originalAction"))
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke; let held = false;
          pluginBridge.invoke = async (channel,payload) => {
            const result = await invoke(channel,payload);
            if (!held && payload?.channel === 'aimedia.records.list') { held = true; await new Promise(resolve => window.__releaseList = resolve); }
            return result;
          };
        }""")
        self.page.wait_for_function("typeof __releaseList === 'function'")
        count = len(self.calls("aimedia.records.list"))
        self.page.clock.install()
        self.page.clock.fast_forward(6000)
        self.assertEqual(len(self.calls("aimedia.records.list")), count)
        self.page.evaluate("""() => { Object.defineProperty(document, 'hidden', {configurable:true, value:true}); document.dispatchEvent(new Event('visibilitychange')); __releaseList(); }""")
        self.page.clock.fast_forward(6000)
        self.assertEqual(len(self.calls("aimedia.records.list")), count)
        self.page.evaluate("""() => { Object.defineProperty(document, 'hidden', {configurable:true, value:false}); document.dispatchEvent(new Event('visibilitychange')); }""")
        self.page.wait_for_function("n => __calls.filter(c => c.channel === 'aimedia.records.list').length > n", arg=count)
        self.tab("配置")
        count = len(self.calls("aimedia.records.list"))
        self.page.clock.fast_forward(6000)
        self.assertEqual(len(self.calls("aimedia.records.list")), count)
        self.assertEqual(self.rpc("fixture.metrics")["network"], 1)
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 1)

    def test_corrupt_hash_duration_decode_failure_retry_and_late_result_cleanup(self):
        job = self.create_job(mode="audio-success")
        for corruption in ["hash", "duration", "decode"]:
            self.page.reload()
            self.instrument()
            self.page.evaluate("""kind => {
              const invoke = pluginBridge.invoke; let once = true;
              pluginBridge.invoke = async (channel,payload) => {
                const result = await invoke(channel,payload);
                if (once && result.ok && payload?.channel === (kind === 'duration' ? 'aimedia.records.get' : 'aimedia.records.read')) {
                  once = false;
                  if (kind === 'hash') result.result.base64 = result.result.base64.replace(/./, c => c === 'A' ? 'B' : 'A');
                  if (kind === 'duration') result.result.result.durationMs += 10000;
                }
                return result;
              };
              if (kind === 'decode') {
                const decode = OfflineAudioContext.prototype.decodeAudioData; let first = true;
                OfflineAudioContext.prototype.decodeAudioData = function(bytes) { if(first) { first = false; return Promise.reject(Error('Synthetic decoder failure')); } return decode.call(this,bytes); };
              }
            }""", corruption)
            self.tab("生成记录")
            dialog = self.details(job["id"])
            expect(dialog.get_by_role("alert").filter(has_text="无法预览和下载")).to_be_visible(timeout=10000)
            expect(dialog.locator("audio")).to_have_count(0)
            expect(dialog.get_by_role("link", name="下载 MP3", exact=True)).to_have_count(0)
            if corruption == "duration":
                self.page.keyboard.press("Escape")
                dialog = self.details(job["id"])
            else:
                dialog.get_by_role("button", name="重试读取音频", exact=True).click()
            expect(dialog.locator("audio")).to_be_visible(timeout=10000)
            self.page.keyboard.press("Escape")
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel,payload) => { const result = await invoke(channel,payload); if(payload?.channel === 'aimedia.records.read') await new Promise(resolve => window.__releaseRead = resolve); return result; };
        }""")
        dialog = self.details(job["id"])
        self.page.wait_for_function("typeof __releaseRead === 'function'")
        expect(dialog.locator("audio")).to_have_count(0)
        self.page.keyboard.press("Escape")
        self.tab("声音")
        self.page.evaluate("__releaseRead()")
        expect(self.page.locator("audio")).to_have_count(0)
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertTrue(self.page.evaluate("__urls.every(url => __revoked.includes(url))"))
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 1)

    def test_audio_page_navigation_and_disposal_stop_media(self):
        self.fill()
        self.rpc("fixture.network", {"mode": "audio-success"})
        self.prepare()
        self.confirm()
        audio = self.page.locator("audio")
        expect(audio).to_be_visible(timeout=15000)
        audio.evaluate("async audio => { window.__playing = audio; audio.loop = true; await audio.play(); }")
        self.tab("配置")
        self.assertTrue(self.page.evaluate("__playing.paused && !__playing.hasAttribute('src') && __urls.every(u => __revoked.includes(u))"))
        self.tab("声音")
        expect(audio).to_be_visible()
        audio.evaluate("async audio => { window.__playing = audio; audio.loop = true; await audio.play(); }")
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        self.assertTrue(self.page.evaluate("__playing.paused && !__playing.hasAttribute('src') && __urls.every(u => __revoked.includes(u))"))
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 1)

    def test_lost_acknowledgements_keep_request_identity_and_never_retry_submission(self):
        self.fill()
        self.rpc("fixture.network", {"mode": "audio-success"})
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke; let lost = false;
          pluginBridge.invoke = async (channel,payload) => {
            const result = await invoke(channel,payload);
            if (!lost && payload?.channel === 'aimedia.audio.prepare') { lost = true; throw Error('Synthetic lost preparation acknowledgement'); }
            if (payload?.channel === 'aimedia.audio.submit') throw Error('Synthetic lost submission acknowledgement');
            return result;
          };
        }""")
        self.page.get_by_role("button", name="准备语音", exact=True).click()
        expect(self.page.locator("#audio-form-error")).to_be_visible()
        first = self.prepare()
        self.page.get_by_role("button", name="编辑请求", exact=True).click()
        self.assertEqual(self.prepare(), first)
        self.assertEqual(len({call["payload"]["requestId"] for call in self.calls("aimedia.audio.prepare")}), 1)
        self.confirm()
        expect(self.page.locator('[data-generation-state="unknown"]')).to_be_visible()
        expect(self.page.get_by_role("button", name="确认合成…", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="重新读取本地任务", exact=True).click()
        expect(self.page.locator("audio")).to_be_visible(timeout=10000)
        self.assertEqual(len(self.calls("aimedia.audio.submit")), 1)
        self.page.get_by_role("button", name="新建请求", exact=True).click()
        expect(self.page.get_by_role("textbox", name="朗读文本", exact=True)).to_have_value("")
        expect(self.page.get_by_role("textbox", name="音色 ID", exact=True)).to_have_value("fixture-voice")
        self.assertTrue(self.page.evaluate("__urls.every(u => __revoked.includes(u))"))
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 1)

    def test_voice_read_retains_text_selection_and_discards_late_navigation_result(self):
        self.fill(fetch=False)
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel,payload) => { const result = await invoke(channel,payload); if(payload?.channel === 'aimedia.probe') await new Promise(resolve => window.__releaseVoice = resolve); return result; };
        }""")
        self.page.get_by_role("button", name="获取音色", exact=True).click()
        self.page.wait_for_function("typeof __releaseVoice === 'function'")
        text = self.page.get_by_role("textbox", name="朗读文本", exact=True)
        text.focus()
        text.evaluate("node => node.setSelectionRange(2,5)")
        self.page.evaluate("__releaseVoice()")
        expect(self.page.get_by_role("button", name="账号音色", exact=True)).to_be_visible()
        expect(text).to_be_focused()
        self.assertEqual(text.evaluate("node => [node.selectionStart,node.selectionEnd]"), [2, 5])
        self.page.evaluate("delete window.__releaseVoice")
        self.page.get_by_role("button", name="获取音色", exact=True).click()
        self.page.wait_for_function("typeof __releaseVoice === 'function'")
        self.tab("配置")
        self.page.evaluate("__releaseVoice()")
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_be_focused()
        expect(self.page.locator("[data-audio-generation]")).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 0)

    def test_late_submit_acknowledgement_does_not_replace_next_request(self):
        self.fill()
        self.rpc("fixture.network", {"mode": "audio-success"})
        self.prepare()
        self.page.evaluate("""() => {
          const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel,payload) => {
            const result = await invoke(channel,payload);
            if (payload?.channel === 'aimedia.audio.submit') { await new Promise(resolve => window.__releaseSubmit = resolve); window.__releasedSubmit = true; }
            return result;
          };
        }""")
        self.confirm()
        self.page.wait_for_function("typeof __releaseSubmit === 'function'")
        expect(self.page.locator("audio")).to_be_visible(timeout=15000)
        self.page.get_by_role("button", name="新建请求", exact=True).click()
        self.page.get_by_role("textbox", name="朗读文本", exact=True).fill("A new explicit request")
        next_id = self.prepare()
        self.page.evaluate("__releaseSubmit()")
        self.page.wait_for_function("window.__releasedSubmit === true")
        expect(self.page.locator("[data-generation-job]")).to_have_attribute("data-generation-job", next_id)
        expect(self.page.locator('[data-generation-state="prepared"]')).to_be_visible()
        self.assertEqual(self.rpc("fixture.metrics")["perKind"]["audio"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
