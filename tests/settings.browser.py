"""Isolated browser acceptance: real plugin storage, synthetic provider network only.
Run: python3 tests/settings.browser.py (Node and Playwright Chrome required).
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import unittest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir()))
FLOW = {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "Demo prompt"}}}


class SettingsBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node must be on PATH to start tests/settings-host.cjs")
        cls.host = subprocess.Popen([node, str(ROOT / "tests/settings-host.cjs")], stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, cwd=ROOT)
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
            cls.host.terminate()
            try: cls.host.wait(timeout=3)
            except subprocess.TimeoutExpired: cls.host.kill(); cls.host.wait(timeout=3)
            cls.host.stdout.close()
            cls.host.stderr.close()
            raise
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
            cls.pw.stop()
        finally:
            if cls.host.poll() is None:
                cls.host.terminate()
                try: cls.host.wait(timeout=3)
                except subprocess.TimeoutExpired: cls.host.kill(); cls.host.wait(timeout=3)
            cls.host.stdout.close()
            cls.host.stderr.close()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1100, "height": 900})
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.goto(self.url)
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        state = self.rpc("aimedia.get")
        self.rpc("aimedia.save", {"expectedRevision": state["revision"], "profiles": [],
                                  "defaults": {"image": None, "video": None, "audio": None}, "workflows": []})
        self.rpc("fixture.network", {"mode": "normal"})
        self.page.reload()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        self.network = self.rpc("fixture.metrics")["network"]

    def tearDown(self):
        try:
            self.assertEqual(self.errors, [], "Unexpected browser page errors")
        finally:
            self.context.close()

    def rpc(self, channel, payload=None):
        return self.page.evaluate("([channel,payload]) => window.pluginBridge.invoke(channel,payload)", [channel, payload])

    def tab(self, name):
        if name in ["配置", "生成记录"]:
            self.page.get_by_role("tab", name=name, exact=True).click()
            expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")
            return
        if name in ["模型服务", "即梦", "LibTV", "ComfyUI", "本地工作流"]:
            if self.page.get_by_role("tab", name="配置", exact=True).get_attribute("aria-selected") != "true":
                self.page.get_by_role("tab", name="配置", exact=True).click()
            return
        self.page.get_by_role("tab", name=name, exact=True).click()
        expect(self.page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")

    def pick(self, label, option):
        self.page.get_by_role("button", name=label, exact=True).click()
        self.page.get_by_role("option", name=option, exact=True).click()

    def confirm(self, name="放弃修改"):
        self.page.get_by_role("dialog").get_by_role("button", name=name, exact=True).click()

    def add_service(self, provider):
        labels = {"openai": "ChatGPT / OpenAI 图片", "minimax": "MiniMax", "xiaomi": "小米 MiMo",
                  "comfyui": "ComfyUI", "libtv": "LibTV", "workflow": "本地工作流"}
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name=labels[provider], exact=True).click()

    def create(self, provider="openai", name="Test service", secret=True):
        labels = {"openai": "OpenAI 图片生成", "dreamina": "即梦 Dreamina", "minimax": "MiniMax", "xiaomi": "小米 MiMo",
                  "libtv": "LibTV", "comfyui": "ComfyUI"}
        if provider == "dreamina":
            self.page.locator('[data-service-name="即梦"]').click()
        else:
            self.add_service(provider)
        current = self.page.get_by_role("button", name="供应商类型", exact=True).inner_text()
        if current != labels[provider]:
            self.pick("供应商类型", labels[provider])
            self.confirm("更换并清除凭据")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill(name)
        if secret and provider == "comfyui":
            self.pick("认证方式", "Bearer Token")
            self.page.get_by_label("认证秘密", exact=True).fill("fixture-key-for-browser")
        elif secret and provider not in ["dreamina", "libtv"]:
            self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        self.save()
        return next(p for p in self.rpc("aimedia.get")["profiles"] if p["name"] == name)

    def save(self):
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已保存")

    def edit(self, name):
        self.page.locator('[data-service-row], [data-workflow-row]').filter(has_text=name).click()
        expect(self.page.get_by_role("button", name="返回列表")).to_be_visible()

    def add_workflow(self, connection="未绑定", name="Demo workflow"):
        self.add_service("workflow")
        self.page.get_by_role("textbox", name="工作流名称", exact=True).fill(name)
        self.pick("工作流服务链接", connection)
        self.page.get_by_role("textbox", name="API JSON", exact=True).fill(json.dumps(FLOW))
        self.page.get_by_role("button", name="添加绑定", exact=True).click()
        self.page.get_by_role("textbox", name="绑定 1 节点 ID", exact=True).fill("1")
        self.page.get_by_role("textbox", name="绑定 1 输入字段", exact=True).fill("text")
        self.save()
    def test_01_primary_navigation_and_add_service_dialog(self):
        expect(self.page.get_by_role("tablist", name="媒体服务主导航", exact=True)).to_have_count(1)
        expect(self.page.get_by_role("tablist")).to_have_count(1)
        expect(self.page.get_by_role("tab")).to_have_count(3)
        expect(self.page.get_by_role("tab", name="配置", exact=True)).to_have_attribute("aria-selected", "true")
        expect(self.page.locator(".subtabs")).to_have_count(0)
        expect(self.page.get_by_role("heading", name="配置", exact=True)).to_be_visible()
        expect(self.page.locator('[data-service-name="即梦"]')).to_be_visible()
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        for label in ["ChatGPT / OpenAI 图片", "MiniMax", "小米 MiMo", "ComfyUI", "LibTV", "本地工作流"]:
            expect(dialog.get_by_role("button", name=label, exact=True)).to_be_visible()
        self.page.keyboard.press("Tab")
        self.page.keyboard.press("Shift+Tab")
        self.page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_focused()
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        dialog.get_by_role("button", name="MiniMax", exact=True).click()
        expect(self.page.get_by_role("heading", name="添加生成模型配置", exact=True)).to_be_visible()
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Unsaved draft")
        self.page.get_by_role("button", name="返回列表").click()
        self.confirm()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_visible()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_02_openai_image2_available_model_can_be_enabled(self):
        self.add_service("openai")
        expect(self.page.get_by_role("heading", name="添加生成模型配置", exact=True)).to_be_visible()
        expect(self.page.get_by_role("button", name="添加模型 GPT Image 2", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="添加模型 GPT Image 2", exact=True).click()
        expect(self.page.get_by_role("textbox", name="模型 1 ID", exact=True)).to_have_value("gpt-image-2")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("GPT Image 2 service")
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        self.save()
        profile = next(p for p in self.rpc("aimedia.get")["profiles"] if p["name"] == "GPT Image 2 service")
        self.assertIn("gpt-image-2", [model["id"] for model in profile["models"]])
    def test_02_save_masked_credentials_without_network(self):
        profile = self.create()
        self.assertTrue(profile["credentialConfigured"])
        self.assertTrue(profile["id"].startswith("profile-"))
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        self.assertIsNone(self.rpc("aimedia.get")["defaults"]["image"])
        self.page.get_by_role("switch", name="停用 Test service", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已停用")
        self.assertFalse(next(p for p in self.rpc("aimedia.get")["profiles"] if p["name"] == "Test service")["enabled"])
        self.page.get_by_role("switch", name="启用 Test service", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("配置已启用")
        self.assertTrue(next(p for p in self.rpc("aimedia.get")["profiles"] if p["name"] == "Test service")["enabled"])
        self.edit("Test service")
        expect(self.page.get_by_label("API Key", exact=True)).to_have_attribute("type", "password")
        expect(self.page.get_by_label("API Key", exact=True)).to_have_value("")
        self.page.get_by_label("API Key", exact=True).fill("temporary-value")
        self.page.get_by_role("button", name="显示 API Key", exact=True).click()
        self.assertLess(self.page.get_by_role("button", name="隐藏 API Key", exact=True).bounding_box()["height"], 45)
        expect(self.page.get_by_label("API Key", exact=True)).to_have_attribute("type", "text")
        self.assertEqual(self.page.evaluate("localStorage.length"), 0)

    def test_03_openai_explicit_discovery_and_add_model(self):
        self.create()
        self.edit("Test service")
        self.page.get_by_role("button", name="从供应商获取").click()
        expect(self.page.get_by_text("目录可访问 · 尚未验证生成能力", exact=True)).to_be_visible()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        row = self.page.locator(".row").filter(has_text="fixture-model")
        row.get_by_role("button", name="添加模型", exact=True).click()
        self.save()
        state = self.rpc("aimedia.get")
        self.assertIn("fixture-model", [m["id"] for m in state["profiles"][0]["models"]])
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)

    def test_04_xiaomi_probe_and_safe_error(self):
        self.create("xiaomi", "MiMo")
        self.edit("MiMo")
        self.page.get_by_role("button", name="从供应商获取").click()
        expect(self.page.get_by_text("目录可访问 · 尚未验证生成能力", exact=True)).to_be_visible()
        self.rpc("fixture.network", {"mode": "denied"})
        self.page.get_by_role("button", name="从供应商获取").click()
        expect(self.page.get_by_text("暂时无法访问目录", exact=False)).to_be_visible()
        self.assertNotIn("fixture-private-key", self.page.locator("body").inner_text())
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Modified")
        expect(self.page.get_by_role("button", name="从供应商获取")).to_be_disabled()

    def test_05_minimax_voice_and_hidden_models_preserved(self):
        self.create("minimax", "MiniMax shared")
        self.edit("MiniMax shared")
        self.pick("默认模型", "speech-2.6-hd · 音频 (speech-2.6-hd)")
        self.save()
        self.tab("模型服务")
        self.edit("MiniMax shared")
        before = self.rpc("aimedia.get")["profiles"][0]
        self.page.get_by_role("button", name="图片", exact=True).click()
        expect(self.page.get_by_role("button", name="默认模型", exact=True)).to_contain_text("speech-2.6-hd")
        expect(self.page.get_by_role("textbox", name="模型 3 ID", exact=True)).to_have_count(0)
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        expect(self.page.get_by_role("textbox", name="音色 ID", exact=True)).to_have_count(0)
        expect(self.page.locator("[data-voice-directory]").get_by_role("button")).to_have_count(0)
        self.save()
        after = self.rpc("aimedia.get")["profiles"][0]
        self.assertEqual(before["models"], after["models"])
        self.assertEqual(after["voice"], before["voice"])
        self.assertEqual(after["modelId"], "speech-2.6-hd")

    def test_06_default_save_and_reference_protection(self):
        profile = self.create()
        self.pick("默认图片配置", "Test service")
        self.assertIsNone(self.rpc("aimedia.get")["defaults"]["image"])
        self.page.get_by_role("button", name="保存默认项", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("默认项已保存")
        self.assertEqual(self.rpc("aimedia.get")["defaults"]["image"], profile["id"])
        self.page.get_by_role("button", name="删除 Test service", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("仍是默认项")
        self.pick("默认图片配置", "未设置")
        self.page.get_by_role("button", name="保存默认项", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("默认项已保存")
        self.page.get_by_role("button", name="删除 Test service", exact=True).click()
        self.confirm("确认删除")
        expect(self.page.get_by_role("status")).to_contain_text("已删除")
        self.assertEqual(self.rpc("aimedia.get")["profiles"], [])

    def test_07_comfy_standalone_workflow_and_unbind(self):
        self.create("comfyui", "Local Comfy", secret=False)
        self.edit("Local Comfy")
        expect(self.page.get_by_role("textbox", name="API JSON", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="返回列表").click()
        self.add_workflow("Local Comfy")
        self.edit("Demo workflow")
        self.page.get_by_role("button", name="检查工作流节点", exact=True).click()
        expect(self.page.get_by_text("目录可访问 · 尚未验证生成能力", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="返回列表").click()
        self.page.get_by_role("button", name="服务链接", exact=True).click()
        self.page.get_by_role("button", name="删除 Local Comfy", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("仍被 1 个工作流引用")
        self.page.get_by_role("button", name="本地工作流", exact=True).click()
        self.edit("Demo workflow")
        self.pick("工作流服务链接", "未绑定")
        self.save()
        self.page.get_by_role("button", name="服务链接", exact=True).click()
        self.page.get_by_role("button", name="删除 Local Comfy", exact=True).click()
        self.confirm("确认删除")
        expect(self.page.get_by_role("status")).to_contain_text("已删除")
        self.assertEqual(len(self.rpc("aimedia.get")["workflows"]), 1)

    def test_08_workflow_validation_preserves_source(self):
        self.tab("本地工作流")
        self.add_service("workflow")
        self.page.get_by_role("textbox", name="工作流名称", exact=True).fill("Invalid draft")
        source = '{"1": invalid source'
        self.page.get_by_role("textbox", name="API JSON", exact=True).fill(source)
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("JSON 格式无效")
        expect(self.page.get_by_role("textbox", name="API JSON", exact=True)).to_have_value(source)
        self.page.get_by_role("textbox", name="API JSON", exact=True).fill(json.dumps(FLOW))
        self.page.get_by_role("button", name="添加绑定", exact=True).click()
        self.page.get_by_role("textbox", name="绑定 1 节点 ID", exact=True).fill("missing")
        self.page.get_by_role("textbox", name="绑定 1 输入字段", exact=True).fill("text")
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("绑定目标不存在")
        self.assertEqual(self.rpc("aimedia.get")["workflows"], [])

    def test_09_cas_conflict_preserves_draft_until_discard(self):
        self.create()
        self.edit("Test service")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Local draft")
        state = self.rpc("aimedia.get")
        self.rpc("aimedia.save", {"expectedRevision": state["revision"], "profiles": state["profiles"], "defaults": state["defaults"], "workflows": state["workflows"]})
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("其他页面更新")
        expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_value("Local draft")
        expect(self.page.get_by_role("button", name="保存", exact=True)).to_be_disabled()
        self.page.get_by_role("button", name="重新读取", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_value("Local draft")
        self.page.get_by_role("button", name="重新读取", exact=True).click()
        self.confirm()
        expect(self.page.locator('[data-service-row][data-service-name="Test service"]')).to_be_visible()

    def test_10_unknown_save_outcome_and_busy_navigation(self):
        self.create()
        self.edit("Test service")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Retained draft")
        self.page.evaluate("""() => { const original=pluginBridge.invoke; window.restoreBridge=()=>pluginBridge.invoke=original;
          pluginBridge.invoke=(channel,payload)=>channel==='aimedia.invoke'&&payload.channel==='aimedia.save'?new Promise((resolve,reject)=>window.rejectSave=()=>reject(new Error('transport lost'))):original(channel,payload); }""")
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("tablist", name="媒体服务主导航", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="返回列表")).to_be_disabled()
        self.page.evaluate("window.rejectSave()")
        expect(self.page.get_by_role("alert")).to_contain_text("保存结果尚不确定")
        expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_value("Retained draft")
        expect(self.page.get_by_role("button", name="保存", exact=True)).to_be_disabled()
        self.page.evaluate("() => { window.restoreBridge(); }")

    def test_11_restart_restores_encrypted_key(self):
        self.create()
        self.assertTrue(self.rpc("aimedia.get")["profiles"][0]["credentialConfigured"])
        self.rpc("fixture.restart")
        self.page.get_by_role("button", name="重新读取", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("已重新读取")
        self.assertTrue(self.rpc("aimedia.get")["profiles"][0]["credentialConfigured"])
        self.edit("Test service")
        expect(self.page.get_by_label("API Key", exact=True)).to_have_value("")
        expect(self.page.get_by_text("已加密保存；留空保留。", exact=True)).to_be_visible()
        self.rpc("fixture.network", {"mode": "require-bearer"})
        state = self.rpc("aimedia.get")
        result = self.rpc("aimedia.probe", {"profileId": state["profiles"][0]["id"], "expectedRevision": state["revision"]})
        self.assertEqual(result["status"], "connected")

    def test_12_endpoint_change_clears_key_and_backend_rejection_preserves(self):
        self.create()
        self.edit("Test service")
        self.page.get_by_role("textbox", name="服务地址", exact=True).fill("https://example.com/v1")
        expect(self.page.locator("#credential-hint")).to_contain_text("服务地址已修改")
        self.save()
        self.assertFalse(self.rpc("aimedia.get")["profiles"][0]["credentialConfigured"])
        self.edit("Test service")
        self.page.get_by_role("textbox", name="服务地址", exact=True).fill("http://example.com/v1")
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("未通过校验")
        expect(self.page.get_by_role("textbox", name="服务地址", exact=True)).to_have_value("http://example.com/v1")

    def test_13_file_import_edit_and_navigation_races(self):
        self.add_workflow()
        self.edit("Demo workflow")
        self.page.evaluate("""() => { window.originalFileText=File.prototype.text; File.prototype.text=function(){ return new Promise(resolve=>window.resolveFile=()=>resolve(JSON.stringify({'9':{class_type:'KSampler',inputs:{seed:1}}}))); }; }""")
        self.page.get_by_label("导入 API JSON 文件", exact=True).set_input_files({"name": "flow.json", "mimeType": "application/json", "buffer": b"{}"})
        expect(self.page.get_by_role("button", name="正在读取文件…", exact=True)).to_be_visible()
        self.page.get_by_role("textbox", name="API JSON", exact=True).fill(json.dumps(FLOW, indent=2) + " ")
        self.page.evaluate("window.resolveFile()")
        expect(self.page.get_by_role("alert")).to_contain_text("已忽略迟到")
        self.assertNotIn('"9"', self.page.get_by_role("textbox", name="API JSON", exact=True).input_value())
        self.page.get_by_label("导入 API JSON 文件", exact=True).set_input_files({"name": "flow2.json", "mimeType": "application/json", "buffer": b"{}"})
        self.page.get_by_role("button", name="返回列表").click()
        self.confirm()
        self.edit("Demo workflow")
        self.page.evaluate("() => { window.resolveFile(); File.prototype.text=window.originalFileText; }")
        expect(self.page.get_by_role("textbox", name="API JSON", exact=True)).to_have_value(json.dumps(FLOW, indent=2))
        self.page.get_by_label("导入 API JSON 文件", exact=True).set_input_files({"name": "valid.json", "mimeType": "application/json", "buffer": json.dumps(FLOW).encode()})
        expect(self.page.get_by_role("status")).to_contain_text("文件已导入")

    def test_14_keyboard_picker_escape_and_add_dialog(self):
        main = self.page.get_by_role("tab", name="配置", exact=True)
        main.focus()
        self.page.keyboard.press("ArrowRight")
        expect(self.page.get_by_role("tab", name="生图", exact=True)).to_be_focused()
        self.page.keyboard.press("Home")
        self.page.get_by_role("button", name="添加服务", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("button", name="MiniMax", exact=True).click()
        select = self.page.get_by_role("button", name="供应商类型", exact=True)
        select.focus()
        self.page.keyboard.press("ArrowDown")
        expect(self.page.get_by_role("option", name="MiniMax", exact=True)).to_be_visible()
        self.page.keyboard.press("Escape")
        expect(select).to_be_focused()
        self.assertTrue(self.page.evaluate("document.activeElement === document.querySelector('summary[aria-label=\\\"供应商类型\\\"]')"))
        expect(select).to_have_attribute("aria-expanded", "false")
        self.page.emulate_media(reduced_motion="reduce")
        self.assertEqual(self.page.locator(".view").evaluate("el=>getComputedStyle(el).animationName"), "none")

    def test_15_responsive_themes_and_screenshots(self):
        self.create("minimax", "Shared model configuration / " + "long-name-" * 8)
        name = self.rpc("aimedia.get")["profiles"][0]["name"]
        for theme in ["dark", "light"]:
            for width in [1440, 900, 600, 390]:
                self.page.set_viewport_size({"width": width, "height": 1000})
                self.page.evaluate("theme=>document.documentElement.dataset.base=theme", theme)
                self.assert_layout()
                self.page.screenshot(path=str(ARTIFACTS / f"aimedia-v02-list-{width}-{theme}.png"), full_page=True)
                self.edit(name)
                self.assert_layout(expect_nav=False)
                self.page.get_by_role("button", name="返回列表").click()
        self.add_workflow(name="Long workflow")
        self.edit("Long workflow")
        for theme in ["dark", "light"]:
            for width in [1440, 900, 600, 390]:
                self.page.set_viewport_size({"width": width, "height": 1000})
                self.page.evaluate("theme=>document.documentElement.dataset.base=theme", theme)
                self.assert_layout(expect_nav=False)

    def assert_layout(self, expect_nav=True):
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        outside = self.page.locator("input:not([hidden]),textarea,.row,.field,.footer").evaluate_all("nodes=>nodes.filter(n=>{const r=n.getBoundingClientRect();return r.width && (r.right>innerWidth+1 || r.left<0)}).map(n=>n.getAttribute('aria-label')||n.className)")
        self.assertEqual(outside, [])
        if expect_nav:
            expect(self.page.get_by_role("tablist", name="媒体服务主导航", exact=True)).to_be_visible()
        else:
            expect(self.page.get_by_role("tablist", name="媒体服务主导航", exact=True)).to_have_count(0)

    def test_16_honest_external_setup_and_unknown_execution(self):
        self.create("dreamina", "Web auth setup", secret=False)
        self.edit("Web auth setup")
        expect(self.page.get_by_role("button", name="从供应商获取")).to_have_count(0)
        expect(self.page.get_by_text("网页授权", exact=False)).to_be_visible()
        self.page.get_by_role("button", name="返回列表").click()
        self.create("libtv", "MCP setup", secret=False)
        self.edit("MCP setup")
        expect(self.page.get_by_text("请在宿主 MCP 设置", exact=False)).to_be_visible()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        result = self.page.evaluate("async()=>{try{await AIMedia.createPanelInvoke(()=>pluginBridge)('aimedia.generate',{});return 'unexpected'}catch(e){return e.code}}")
        self.assertEqual(result, "NOT_FOUND")
        self.assertTrue(self.rpc("aimedia.status")["generationImplemented"])
        self.assertTrue(self.rpc("fixture.metrics")["unchanged"])

    def test_17_absent_bridge_and_system_theme(self):
        page = self.context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.route("**/index.html", lambda route: route.fulfill(status=200, content_type="text/html", body=(ROOT / "renderer/index.html").read_text()))
        page.emulate_media(color_scheme="light")
        page.goto(self.url + "/index.html")
        expect(page.get_by_role("alert")).to_contain_text("当前没有连接到配置服务")
        expect(page.locator("html")).to_have_attribute("data-base", "light")
        page.emulate_media(color_scheme="dark")
        expect(page.locator("html")).to_have_attribute("data-base", "dark")
        page.close()


    def test_18_appearance_event_and_structured_model_edit(self):
        self.create("minimax", "Structured models")
        self.edit("Structured models")
        self.page.get_by_role("button", name="视频", exact=True).click()
        self.page.get_by_role("button", name="添加自定义模型", exact=True).click()
        self.page.get_by_role("textbox", name="模型 4 名称", exact=True).fill("Custom video")
        self.page.get_by_role("textbox", name="模型 4 ID", exact=True).fill("custom-video")
        self.pick("默认模型", "Custom video · 视频 (custom-video)")
        self.save()
        models = self.rpc("aimedia.get")["profiles"][0]["models"]
        self.assertEqual([m["kind"] for m in models], ["image", "video", "audio", "video"])
        page = self.context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        def instrument(route):
            response = route.fetch()
            source = response.text().replace("on:()=>()=>{}", "on:(name,callback)=>{window.appearanceListener=callback;return()=>{}}")
            route.fulfill(response=response, body=source)
        page.route("**/index.html", instrument)
        page.goto(self.url + "/index.html")
        expect(page.locator("html")).to_have_attribute("data-base", "dark")
        page.evaluate("window.appearanceListener({base:'light'})")
        expect(page.locator("html")).to_have_attribute("data-base", "light")
        page.emulate_media(color_scheme="dark")
        expect(page.locator("html")).to_have_attribute("data-base", "light")
        page.close()


    def test_19_singletons_and_legacy_conflicts(self):
        for provider, tab in [("dreamina", "即梦"), ("libtv", "LibTV")]:
            profile = self.create(provider, tab + " setup", secret=False)
            expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_have_count(1)
            expect(self.page.get_by_role("button", name="配置即梦", exact=True)).to_have_count(0)
            self.edit(tab + " setup")
            expect(self.page.get_by_role("button", name="供应商类型", exact=True)).to_have_attribute("aria-disabled", "true")
            self.page.get_by_role("textbox", name="配置名称", exact=True).fill(tab + " edited")
            self.save()
            profiles = [p for p in self.rpc("aimedia.get")["profiles"] if p["provider"] == provider]
            self.assertEqual(len(profiles), 1)
            self.assertEqual(profiles[0]["id"], profile["id"])
        self.page.evaluate("""() => { const invoke = pluginBridge.invoke;
          pluginBridge.invoke = async (channel, payload) => { const response = await invoke(channel,payload);
            if(channel === 'aimedia.invoke' && payload.channel === 'aimedia.get') { const result = response.result; const original = result.profiles.find(p=>p.provider==='dreamina');
              result.profiles.push({...original,id:'legacy-dreamina',name:'Legacy duplicate'});
              result.singletonConflicts=[{provider:'dreamina',profileIds:[original.id,'legacy-dreamina']}]; }
            return response; }; }""")
        self.page.get_by_role("button", name="重新读取", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("已重新读取")
        self.tab("即梦")
        expect(self.page.get_by_role("alert")).to_contain_text("所有条目均保留")
        expect(self.page.locator('[aria-label="服务配置列表"] [data-row-id]')).to_have_count(3)
        self.edit("Legacy duplicate")
        expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_value("Legacy duplicate")
        self.page.get_by_role("button", name="返回列表").click()
        self.page.get_by_role("button", name="删除 Legacy duplicate", exact=True).click()
        expect(self.page.get_by_role("dialog")).to_contain_text("Legacy duplicate")
        self.page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def browse_connection(self):
        profile = self.create("comfyui", "Browse Comfy", secret=False)
        self.page.get_by_role("button", name="浏览资源 Browse Comfy", exact=True).click()
        expect(self.page.get_by_role("heading", name="浏览资源", exact=True)).to_be_visible()
        expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_count(0)
        return profile

    def test_20_resources_and_explicit_workflow_import(self):
        profile = self.browse_connection()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        self.page.get_by_role("tab", name="模型", exact=True).focus()
        self.page.keyboard.press("ArrowRight")
        expect(self.page.get_by_role("tab", name="远端工作流", exact=True)).to_be_focused()
        self.page.keyboard.press("Home")
        expect(self.page.get_by_role("tab", name="模型", exact=True)).to_be_focused()
        self.page.get_by_role("button", name="读取文件夹", exact=True).click()
        expect(self.page.locator('[data-resource="model-folders"]')).to_contain_text("checkpoints")
        self.pick("模型文件夹", "checkpoints")
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        self.page.get_by_role("button", name="读取模型文件", exact=True).click()
        expect(self.page.locator('[data-resource="models"]')).to_contain_text("fixture-model.safetensors")
        self.tab("远端工作流")
        self.page.get_by_role("button", name="读取工作流", exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 3)
        canvas = self.page.get_by_role("button", name="查看详情 canvas.json", exact=True)
        expect(canvas).to_be_enabled()
        canvas.click()
        expect(self.page.get_by_text("仅供只读查看，不自动转换画布格式", exact=False)).to_be_visible()
        expect(self.page.get_by_role("button", name="导入本地工作流草稿", exact=True)).to_be_disabled()
        self.page.get_by_role("button", name="查看详情 demo.json", exact=True).click()
        expect(self.page.get_by_role("button", name="导入本地工作流草稿", exact=True)).to_be_enabled()
        self.assertFalse(self.page.locator("details.definition").evaluate("el=>el.open"))
        self.page.locator("details.definition summary").click()
        expect(self.page.locator("pre.code")).to_contain_text("CLIPTextEncode")
        self.page.get_by_role("button", name="导入本地工作流草稿", exact=True).click()
        expect(self.page.get_by_role("textbox", name="工作流名称", exact=True)).to_have_value("demo")
        self.assertEqual(self.rpc("aimedia.get")["workflows"], [])
        self.page.get_by_role("button", name="返回列表").click()
        self.page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        self.save()
        flow = self.rpc("aimedia.get")["workflows"][0]
        self.assertEqual(flow["definition"], FLOW)
        self.assertEqual(flow["bindings"], [])
        self.assertEqual(flow["connectionId"], profile["id"])
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 5)

    def test_21_records_are_local_and_remote_activity_is_not_mixed_in(self):
        self.create("comfyui", "Remote service", secret=False)
        before = self.rpc("fixture.metrics")["network"]
        self.tab("生成记录")
        expect(self.page.get_by_role("heading", name="生成记录", exact=True)).to_be_visible()
        expect(self.page.get_by_role("tab", name="任务队列", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="远端 ComfyUI 连接", exact=True)).to_have_count(0)
        expect(self.page.locator('[data-resource="history"], [data-resource="queue"]')).to_have_count(0)
        self.page.get_by_role("button", name="刷新记录", exact=True).click()
        for label in ["生成中", "已完成", "已失败", "全部"]:
            self.page.get_by_role("button", name=label, exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["network"], before)
        self.assertNotIn("fixture-private-key", self.page.locator("body").inner_text())

    def test_22_unsupported_and_late_response_navigation(self):
        profile = self.browse_connection()
        self.rpc("fixture.network", {"mode": "unsupported"})
        self.page.get_by_role("button", name="读取文件夹", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("不支持")
        self.page.evaluate("""() => { const original=pluginBridge.invoke; window.restoreBrowse=()=>pluginBridge.invoke=original;
          window.browseCalls=0;
          pluginBridge.invoke=(channel,payload)=>channel==='aimedia.invoke'&&payload.channel==='aimedia.browse'?(window.browseCalls++,new Promise(resolve=>window.resolveBrowse=()=>resolve({protocol:'aimedia.panel.v1',ok:true,result:{profileId:payload.payload.profileId,resource:payload.payload.resource,status:'ok',checkedAt:'fixture',items:[{name:'late-folder'}],total:1,offset:0,limit:50,truncated:false}}))):original(channel,payload); }""")
        self.page.get_by_role("button", name="读取文件夹", exact=True).click()
        expect(self.page.get_by_role("button", name="读取文件夹", exact=True)).to_be_disabled()
        self.tab("生成记录")
        expect(self.page.get_by_role("button", name="刷新记录", exact=True)).to_be_enabled()
        self.page.evaluate("window.resolveBrowse()")
        expect(self.page.get_by_role("button", name="刷新记录", exact=True)).to_be_enabled()
        expect(self.page.get_by_text("late-folder", exact=True)).to_have_count(0)
        self.assertEqual(self.page.evaluate("window.browseCalls"), 1)

    def test_23_default_navigation_guard_and_dirty_browse(self):
        self.create("openai", "Default model")
        self.pick("默认图片配置", "Default model")
        self.page.get_by_role("tab", name="生成记录", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        expect(self.page.get_by_role("button", name="默认图片配置", exact=True)).to_contain_text("Default model")
        self.page.get_by_role("tab", name="生成记录", exact=True).click()
        self.confirm()
        self.assertIsNone(self.rpc("aimedia.get")["defaults"]["image"])
        self.tab("配置")
        self.create("comfyui", "Draft guard", secret=False)
        self.edit("Draft guard")
        expect(self.page.get_by_role("button", name="浏览资源", exact=True)).to_be_enabled()
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Dirty connection")
        expect(self.page.get_by_role("button", name="浏览资源", exact=True)).to_be_disabled()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_24_remote_responsive_themes(self):
        self.browse_connection()
        self.page.get_by_role("button", name="读取文件夹", exact=True).click()
        expect(self.page.locator('[data-resource="model-folders"]')).to_contain_text("checkpoints")
        self.pick("模型文件夹", "checkpoints")
        self.page.get_by_role("button", name="读取模型文件", exact=True).click()
        expect(self.page.locator('[data-resource="models"]')).to_contain_text("fixture-model")
        for surface in ["connection", "records"]:
            if surface == "records":
                self.tab("生成记录")
                expect(self.page.locator('[data-generation-list]')).to_be_visible()
            for theme in ["dark", "light"]:
                for width in [1440, 900, 600, 390]:
                    self.page.set_viewport_size({"width": width, "height": 1000})
                    self.page.evaluate("theme=>document.documentElement.dataset.base=theme", theme)
                    self.assert_layout()
                    self.page.screenshot(path=str(ARTIFACTS / f"aimedia-v02-{surface}-{width}-{theme}.png"), full_page=True)

    def test_25_comfy_connection_test_is_lightweight_and_independent_of_catalog(self):
        self.create("comfyui", "Lightweight connection", secret=False)
        self.edit("Lightweight connection")
        self.rpc("fixture.network", {"mode": "large-nodes"})
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常 · 系统状态可访问")
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        self.assertNotIn("发现 0 个节点", self.page.locator("body").inner_text())
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        expect(self.page.get_by_role("button", name="checkpoints", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="checkpoints", exact=True).click()
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("fixture-model.safetensors")
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 5)
        self.page.get_by_role("textbox", name="服务地址", exact=True).fill("http://127.0.0.1:8190")
        expect(self.page.get_by_role("button", name="测试连接", exact=True)).to_be_disabled()
        expect(self.page.locator(".duty-probe-status")).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 5)

    def test_26_comfy_auth_modes_save_reopen_and_use_matching_headers(self):
        self.add_service("comfyui")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Auth connection")
        self.pick("认证方式", "自定义 Header")
        self.page.get_by_role("textbox", name="Header 名称", exact=True).fill("X-API-Key")
        self.page.get_by_label("认证秘密", exact=True).fill("fixture-key-for-browser")
        self.save()
        self.edit("Auth connection")
        expect(self.page.get_by_role("button", name="认证方式", exact=True)).to_contain_text("自定义 Header")
        expect(self.page.get_by_label("认证秘密", exact=True)).to_have_value("")
        self.rpc("fixture.network", {"mode": "require-header"})
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Renamed auth")
        self.save()
        self.edit("Renamed auth")
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常")
        self.pick("认证方式", "Bearer Token")
        expect(self.page.get_by_role("textbox", name="Header 名称", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="保存", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("请填写认证秘密")
        self.page.get_by_label("认证秘密", exact=True).fill("fixture-key-for-browser")
        self.save()
        self.edit("Renamed auth")
        self.rpc("fixture.network", {"mode": "require-bearer"})
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常")
        self.pick("认证方式", "无认证")
        self.save()
        self.edit("Renamed auth")
        expect(self.page.get_by_label("认证秘密", exact=True)).to_have_count(0)
        self.assertFalse(self.rpc("aimedia.get")["profiles"][0]["credentialConfigured"])
        self.rpc("fixture.network", {"mode": "normal"})
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常")

    def test_27_comfy_connection_errors_are_localized_and_recoverable(self):
        self.create("comfyui", "Error connection", secret=False)
        self.edit("Error connection")
        for mode, message in [("unauthorized", "HTTP 401"), ("invalid", "有效 JSON"), ("unsupported", "接口不存在"), ("timeout", "连接超时"), ("denied", "宿主未授权")]:
            self.rpc("fixture.network", {"mode": mode})
            self.page.get_by_role("button", name="测试连接", exact=True).click()
            expect(self.page.get_by_role("alert")).to_contain_text(message)
            self.assertNotIn("fixture-private-key", self.page.locator("body").inner_text())
            expect(self.page.locator(".duty-probe-status")).to_have_count(0)
        self.rpc("fixture.network", {"mode": "normal"})
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常")
        expect(self.page.get_by_role("alert")).to_have_count(0)

    def test_28_inline_folder_switch_preserves_page_and_sidebar(self):
        self.page.clock.install()
        self.page.set_viewport_size({"width": 1000, "height": 600})
        self.create("comfyui", "Stable folders", secret=False)
        self.edit("Stable folders")
        self.rpc("fixture.network", {"mode": "many-models"})
        self.page.get_by_role("button", name="测试连接", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("连接正常")
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        target = self.page.get_by_role("button", name="folder-20", exact=True)
        target.scroll_into_view_if_needed()
        target.focus()
        before = self.rpc("fixture.metrics")["network"]
        self.page.evaluate("""() => {
          window.stableForm = document.querySelector('form');
          window.stableName = document.querySelector('[aria-label="配置名称"]');
          window.stableSidebar = document.querySelector('.duty-snapshot-folders');
          window.stableY = scrollY; window.stableSidebarY = stableSidebar.scrollTop;
        }""")
        target.click()
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("folder-20-model-1.safetensors")
        expect(target).to_have_attribute("aria-current", "true")
        expect(target).to_be_focused()
        self.assertTrue(self.page.evaluate("stableForm.isConnected && stableName.isConnected && stableSidebar.isConnected"))
        self.assertGreater(self.page.evaluate("stableSidebar.scrollTop"), 0)
        self.assertEqual(self.page.evaluate("stableSidebar.scrollTop"), self.page.evaluate("stableSidebarY"))
        self.assertEqual(self.page.evaluate("scrollY"), self.page.evaluate("stableY"))
        self.page.locator(".duty-snapshot-files").evaluate("node => node.scrollTop = 160")
        self.page.clock.fast_forward(2100)
        self.assertTrue(self.page.evaluate("stableForm.isConnected && stableSidebar.isConnected"))
        self.assertGreater(self.page.locator(".duty-snapshot-files").evaluate("node => node.scrollTop"), 0)
        expect(self.page.get_by_role("status")).to_have_count(0)
        target.click()
        self.rpc("fixture.network", {"mode": "denied"})
        self.page.get_by_role("button", name="folder-21", exact=True).click()
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("folder-21-model-1.safetensors")
        self.assertTrue(self.page.evaluate("stableForm.isConnected && stableSidebar.isConnected"))
        self.assertEqual(self.rpc("fixture.metrics")["network"], before)
        for width in [1000, 600, 390]:
            self.page.set_viewport_size({"width": width, "height": 600})
            self.assert_layout(expect_nav=False)

    def test_29_inline_pending_sync_is_discarded_after_leaving(self):
        self.create("comfyui", "Leave folders", secret=False)
        self.edit("Leave folders")
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        expect(self.page.get_by_role("button", name="checkpoints", exact=True)).to_be_visible()
        self.page.evaluate("""() => {
          const original = pluginBridge.invoke; window.syncCalls = 0;
          pluginBridge.invoke = (channel, payload) => channel === 'aimedia.invoke' && payload.channel === 'aimedia.syncResources'
            ? (syncCalls++, new Promise(resolve => { window.releaseSync = () => resolve({ protocol: 'aimedia.panel.v1', ok: true, result: { profileId: payload.payload.profileId, revision: payload.payload.expectedRevision, models: {checkedAt: '2025-01-01T00:00:00.000Z', folders: [{name: 'late-folder', items: [{name: 'late-model'}]}]}, workflows: null } }); }))
            : original(channel, payload);
        }""")
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        self.page.get_by_role("button", name="同步模型", exact=True).dispatch_event("click")
        self.assertEqual(self.page.evaluate("syncCalls"), 1)
        self.page.get_by_role("button", name="返回列表", exact=True).click()
        self.edit("Leave folders")
        self.page.evaluate("releaseSync()")
        expect(self.page.get_by_role("button", name="checkpoints", exact=True)).to_be_visible()
        expect(self.page.get_by_text("late-model", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="同步模型", exact=True)).to_be_enabled()

    def test_30_inline_resource_tabs_and_workflow_import(self):
        self.create("comfyui", "Inline workflows", secret=False)
        self.edit("Inline workflows")
        self.page.evaluate("window.stableForm = document.querySelector('form')")
        self.page.get_by_role("button", name="工作流", exact=True).click()
        self.page.get_by_role("button", name="同步工作流", exact=True).click()
        canvas = self.page.locator(".duty-snapshot-file-row").filter(has_text="canvas.json")
        canvas.get_by_role("button", name="导入", exact=True).click()
        expect(self.page.get_by_role("button", name="同步工作流", exact=True)).to_be_enabled()
        self.assertTrue(self.page.evaluate("stableForm.isConnected"))
        expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_value("Inline workflows")
        demo = self.page.locator(".duty-snapshot-file-row").filter(has_text="demo.json")
        demo.get_by_role("button", name="导入", exact=True).click()
        expect(self.page.get_by_role("textbox", name="工作流名称", exact=True)).to_have_value("demo")
        self.assertEqual(self.rpc("aimedia.get")["workflows"], [])

    def test_31_resource_snapshots_survive_restart_offline_and_failed_sync(self):
        profile = self.create("comfyui", "Cached service", secret=False)
        self.edit("Cached service")
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("fixture-model.safetensors")
        self.page.get_by_role("button", name="工作流", exact=True).click()
        self.page.get_by_role("button", name="同步工作流", exact=True).click()
        demo = self.page.locator(".duty-snapshot-file-row").filter(has_text="demo.json")
        demo.get_by_role("button", name="导入", exact=True).click()
        expect(self.page.get_by_role("textbox", name="工作流名称", exact=True)).to_have_value("demo")
        self.page.get_by_role("button", name="返回列表", exact=True).click()
        self.confirm()
        state = self.rpc("aimedia.get")
        identity = {"profileId": profile["id"], "expectedRevision": state["revision"]}
        cached = self.rpc("aimedia.resourceSnapshot", identity)
        self.rpc("fixture.network", {"mode": "denied"})
        self.rpc("fixture.restart")
        before = self.rpc("fixture.metrics")["network"]
        self.page.reload()
        self.edit("Cached service")
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("fixture-model.safetensors")
        expect(self.page.locator("[data-local-snapshot]")).to_contain_text("本地快照 · 上次同步")
        self.page.get_by_role("button", name="loras", exact=True).click()
        self.assertEqual(self.rpc("fixture.metrics")["network"], before)
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("保留上次成功")
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("fixture-model.safetensors")
        self.assertEqual(self.rpc("aimedia.resourceSnapshot", identity), cached)
        self.page.get_by_role("button", name="工作流", exact=True).click()
        demo = self.page.locator(".duty-snapshot-file-row").filter(has_text="demo.json")
        demo.get_by_role("button", name="导入", exact=True).click()
        expect(self.page.get_by_role("textbox", name="工作流名称", exact=True)).to_have_value("demo")
        self.assertEqual(self.rpc("fixture.metrics")["network"], before + 1)
        self.assertEqual(self.rpc("aimedia.get")["workflows"], [])

    def test_32_snapshot_identity_change_does_not_reuse_old_resources(self):
        self.create("comfyui", "Cache identity", secret=False)
        self.edit("Cache identity")
        self.page.get_by_role("button", name="同步模型", exact=True).click()
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("fixture-model.safetensors")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Cache renamed")
        self.save()
        self.edit("Cache renamed")
        expect(self.page.locator(".duty-snapshot-files")).to_contain_text("fixture-model.safetensors")
        self.page.get_by_role("textbox", name="服务地址", exact=True).fill("http://127.0.0.1:8190")
        self.save()
        before = self.rpc("fixture.metrics")["network"]
        self.edit("Cache renamed")
        expect(self.page.locator("[data-local-snapshot]")).to_contain_text("暂无本地快照")
        expect(self.page.get_by_role("button", name="checkpoints", exact=True)).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], before)

    def test_33_minimax_cloud_models_without_enabled_models(self):
        self.add_service("minimax")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("MiniMax cloud")
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        for model in ["image-01", "MiniMax-Hailuo-2.3", "speech-2.6-hd"]:
            self.page.get_by_role("button", name="移除模型 " + model, exact=True).click()
        expect(self.page.get_by_text("暂无已启用模型", exact=True)).to_be_visible()
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.locator("[data-discovery]")).to_contain_text("已从云端获取 4 个媒体模型")
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        profile = self.rpc("aimedia.get")["profiles"][0]
        self.assertEqual(profile["models"], [])
        self.assertEqual(profile["modelId"], "")
        expect(self.page.locator("#credential-hint")).to_contain_text("已加密保存")
        expect(self.page.get_by_role("button", name="添加模型 image-01", exact=True)).to_have_count(1)
        cloud = self.page.locator(".available-model-row").filter(has_text="image-cloud-fixture")
        expect(cloud).to_contain_text("云端返回")
        expect(self.page.locator(".available-model-row").filter(has_text="image-01-live")).to_contain_text("内置目录")
        self.assertNotIn("MiniMax-M2.7", self.page.locator("body").inner_text())
        cloud.get_by_role("button", name="添加模型 云端图片", exact=True).click()
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        expect(self.page.locator("[data-voice-directory]").get_by_role("button")).to_have_count(0)
        self.save()
        profile = self.rpc("aimedia.get")["profiles"][0]
        self.assertEqual(profile["models"], [{"id": "image-cloud-fixture", "name": "云端图片", "kind": "image"}])
        self.assertEqual(profile["voice"], "")
        self.edit("MiniMax cloud")
        expect(self.page.get_by_role("textbox", name="音色 ID", exact=True)).to_have_count(0)

    def test_34_minimax_partial_results_and_chat_only_catalog(self):
        self.create("minimax", "MiniMax partial")
        self.edit("MiniMax partial")
        self.rpc("fixture.network", {"mode": "minimax-models-failed"})
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.locator("[data-discovery]")).to_contain_text("供应商未提供此目录接口")
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        expect(self.page.locator("[data-discovery]")).to_contain_text("供应商未提供此目录接口")
        expect(self.page.get_by_role("button", name="添加模型 image-01-live", exact=True)).to_be_enabled()
        self.rpc("fixture.network", {"mode": "minimax-voices-failed"})
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.get_by_role("button", name="添加模型 云端图片", exact=True)).to_be_enabled()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("音色查询未完成")
        expect(self.page.get_by_role("button", name="添加模型 云端图片", exact=True)).to_be_enabled()
        self.rpc("fixture.network", {"mode": "minimax-chat-only"})
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.locator("[data-discovery]")).to_contain_text("云端未返回媒体模型")
        expect(self.page.get_by_role("button", name="添加模型 云端图片", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="添加模型 image-01-live", exact=True)).to_be_enabled()
        self.assertNotIn("fixture-private-key", self.page.locator("body").inner_text())

    def test_35_minimax_missing_key_does_not_save_or_fetch(self):
        self.add_service("minimax")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Missing key")
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.get_by_role("alert")).to_contain_text("请先填写 API Key")
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.get_by_role("alert")).to_contain_text("请先填写 API Key")
        self.assertEqual(self.rpc("aimedia.get")["profiles"], [])
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)

    def test_36_minimax_read_only_voices_have_an_independent_header_button(self):
        self.create("minimax", "Independent catalogs")
        state = self.rpc("aimedia.get")
        state["profiles"][0]["voice"] = "legacy-voice"
        self.rpc("aimedia.save", {"expectedRevision": state["revision"], "profiles": state["profiles"], "defaults": state["defaults"]})
        self.page.reload()
        self.edit("Independent catalogs")
        expect(self.page.get_by_role("button", name="从供应商获取", exact=True)).to_have_count(2)
        heading = self.page.get_by_role("heading", name="云端音色", exact=True).bounding_box()
        control = self.page.locator("[data-voice-fetch]").bounding_box()
        self.assertGreater(control["x"], heading["x"] + heading["width"])
        self.assertLess(abs(control["y"] + control["height"] / 2 - heading["y"] - heading["height"] / 2), 4)
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        expect(self.page.locator("[data-voice-directory]").get_by_role("button")).to_have_count(0)
        expect(self.page.get_by_role("textbox", name="音色 ID", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="添加模型 云端图片", exact=True)).to_have_count(0)
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 1)
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.get_by_role("button", name="添加模型 云端图片", exact=True)).to_be_enabled()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 2)
        self.page.locator("[data-voice-fetch]").click()
        expect(self.page.locator("[data-voice-directory]")).to_contain_text("fixture-voice")
        expect(self.page.locator("[data-voice-fetch]")).to_be_enabled()
        expect(self.page.get_by_role("button", name="添加模型 云端图片", exact=True)).to_be_enabled()
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 3)
        self.page.get_by_label("API Key", exact=True).fill("replacement-fixture-key")
        self.page.locator("[data-model-fetch]").click()
        expect(self.page.locator("[data-discovery]")).to_contain_text("已从云端获取")
        expect(self.page.locator("[data-voice-directory]")).not_to_contain_text("fixture-voice")
        self.save()
        self.assertEqual(self.rpc("aimedia.get")["profiles"][0]["voice"], "legacy-voice")

    def test_38_crypto_failure_preserves_draft_and_allows_retry(self):
        before = self.rpc("aimedia.get")["revision"]
        self.add_service("openai")
        self.page.get_by_role("textbox", name="配置名称", exact=True).fill("Retained encrypted draft")
        self.page.get_by_label("API Key", exact=True).fill("fixture-key-for-browser")
        try:
            for mode, text in [("unavailable", "无法使用插件密钥存储"), ("failed", "密钥无法安全保存"), ("denied", "宿主未授权")]:
                self.rpc("fixture.secrets", {"mode": mode})
                self.page.get_by_role("button", name="保存", exact=True).click()
                expect(self.page.get_by_role("alert")).to_contain_text(text)
                expect(self.page.get_by_label("API Key", exact=True)).to_have_value("fixture-key-for-browser")
                expect(self.page.get_by_role("button", name="保存", exact=True)).to_be_enabled()
                self.assertEqual(self.rpc("aimedia.get")["revision"], before)
                self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        finally:
            self.rpc("fixture.secrets", {"mode": "normal"})
        self.save()
        self.assertTrue(self.rpc("aimedia.get")["profiles"][0]["credentialConfigured"])

    def test_39_legacy_backend_keeps_saved_configuration_readable(self):
        profile = self.create("openai", "Existing configuration")
        before = self.rpc("aimedia.get")
        self.rpc("fixture.backend", {"mode": "legacy"})
        try:
            self.page.reload()
            expect(self.page.locator('[data-service-row]').filter(has_text="Existing configuration")).to_be_visible()
            expect(self.page.locator('[data-config-readonly]')).to_contain_text("只读")
            expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_disabled()
            self.edit("Existing configuration")
            expect(self.page.get_by_role("textbox", name="配置名称", exact=True)).to_have_value("Existing configuration")
            expect(self.page.get_by_role("button", name="保存", exact=True)).to_be_disabled()
            self.page.get_by_role("button", name="返回列表", exact=True).click()
            self.tab("生成记录")
            self.tab("配置")
            expect(self.page.locator('[data-config-readonly]')).to_be_visible()
            self.assertEqual(self.rpc("aimedia.get"), before)
            self.assertEqual(self.rpc("fixture.metrics")["network"], self.network)
        finally:
            self.rpc("fixture.backend", {"mode": "normal"})
        self.page.get_by_role("button", name="重新检查", exact=True).click()
        expect(self.page.get_by_role("button", name="添加服务", exact=True)).to_be_enabled()
        expect(self.page.locator('[data-config-readonly]')).to_have_count(0)
        self.assertEqual(self.rpc("aimedia.get")["profiles"][0]["id"], profile["id"])

    def test_40_load_failure_survives_navigation_and_retry_recovers(self):
        self.create("openai", "Preserved configuration", secret=False)
        before = self.rpc("aimedia.get")
        self.rpc("fixture.backend", {"mode": "offline"})
        try:
            self.page.reload()
            expect(self.page.locator('[data-config-load-error]')).to_be_visible()
            expect(self.page.get_by_role("button", name="重新读取", exact=True)).to_be_enabled()
            self.tab("生成记录")
            self.tab("配置")
            expect(self.page.locator('[data-config-load-error]')).to_be_visible()
            expect(self.page.get_by_role("button", name="重新读取", exact=True)).to_be_enabled()
        finally:
            self.rpc("fixture.backend", {"mode": "normal"})
        self.page.get_by_role("button", name="重新读取", exact=True).click()
        expect(self.page.locator('[data-service-row]').filter(has_text="Preserved configuration")).to_be_visible()
        expect(self.page.locator('[data-config-load-error]')).to_have_count(0)
        self.assertEqual(self.rpc("aimedia.get"), before)

    def test_41_decryption_unavailable_has_persistent_reason_and_retry(self):
        self.create("openai", "Encrypted configuration")
        before = self.rpc("aimedia.get")
        self.rpc("fixture.secrets", {"mode": "unavailable"})
        self.rpc("fixture.restart")
        try:
            self.page.reload()
            expect(self.page.locator('[data-config-load-error]')).to_contain_text("无法使用插件密钥存储")
            self.tab("生成记录")
            self.tab("配置")
            expect(self.page.locator('[data-config-load-error]')).to_contain_text("无法使用插件密钥存储")
        finally:
            self.rpc("fixture.secrets", {"mode": "normal"})
        self.page.get_by_role("button", name="重新读取", exact=True).click()
        expect(self.page.locator('[data-service-row]').filter(has_text="Encrypted configuration")).to_be_visible()
        self.assertEqual(self.rpc("aimedia.get"), before)

    def test_42_canvas_notes_preview_and_detail_failure_recovery(self):
        self.browse_connection()
        before = self.rpc("aimedia.get")
        self.tab("远端工作流")
        self.page.get_by_role("button", name="读取工作流", exact=True).click()
        self.page.get_by_role("button", name="查看详情 canvas.json", exact=True).click()
        expect(self.page.get_by_role("button", name="导入本地工作流草稿", exact=True)).to_be_disabled()
        self.page.locator("details.definition summary").click()
        expect(self.page.locator("pre.code")).to_contain_text("使用说明 🎬")
        expect(self.page.locator("pre.code")).to_contain_text("https://docs.example.test/workflows")
        expect(self.page.locator("pre.code img")).to_have_count(0)
        self.assertIsNone(self.page.evaluate("window.__workflowExecuted"))
        self.assertEqual(self.rpc("fixture.metrics")["network"], self.network + 2)
        try:
            for mode, text in [("unsupported", "工作流已不存在"), ("invalid", "不是有效 JSON"), ("workflow-sensitive", "未通过校验"), ("workflow-large", "200 KiB")]:
                self.rpc("fixture.network", {"mode": mode})
                self.page.get_by_role("button", name="查看详情 canvas.json", exact=True).click()
                expect(self.page.get_by_role("alert")).to_contain_text(text)
                expect(self.page.locator('[data-resource="workflows"]')).to_contain_text("demo.json")
                expect(self.page.get_by_role("button", name="查看详情 canvas.json", exact=True)).to_be_enabled()
                expect(self.page.locator("pre.code")).to_have_count(0)
                self.assertNotIn("fixture-private-key", self.page.locator("#app").inner_text())
        finally:
            self.rpc("fixture.network", {"mode": "normal"})
        self.page.get_by_role("button", name="查看详情 demo.json", exact=True).click()
        expect(self.page.get_by_role("button", name="导入本地工作流草稿", exact=True)).to_be_enabled()
        self.assertEqual(self.rpc("aimedia.get"), before)

    def test_43_inline_workflow_error_retains_directory_and_can_retry(self):
        self.create("comfyui", "Workflow errors", secret=False)
        self.edit("Workflow errors")
        self.page.get_by_role("button", name="工作流", exact=True).click()
        self.page.get_by_role("button", name="同步工作流", exact=True).click()
        demo = self.page.locator(".duty-snapshot-file-row").filter(has_text="demo.json")
        try:
            self.rpc("fixture.network", {"mode": "workflow-sensitive"})
            demo.get_by_role("button", name="导入", exact=True).click()
            expect(self.page.get_by_role("alert")).to_contain_text("未通过校验")
            expect(demo).to_be_visible()
            self.assertEqual(self.rpc("aimedia.get")["workflows"], [])
        finally:
            self.rpc("fixture.network", {"mode": "normal"})
        demo.get_by_role("button", name="导入", exact=True).click()
        expect(self.page.get_by_role("textbox", name="工作流名称", exact=True)).to_have_value("demo")
        self.assertEqual(self.rpc("aimedia.get")["workflows"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
