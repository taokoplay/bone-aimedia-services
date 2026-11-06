# Bone AI 媒体服务

独立的 PI-Desktop 媒体服务插件，以 Agent 对话驱动已配置模型生图和 MiniMax 语音合成；页面用于配置、统一记录与可选手动生成。

- 插件 ID：`bone.aimedia.services`
- 当前版本：`0.5.1`
- 源码目录：`bone-aimedia-services`
- 许可证：[AGPL-3.0-only](LICENSE)

**在对话中说明服务、模型和画面，或明确朗读文本与音色，Agent 可生成一张 PNG 或一段 MP3，并写入统一生成记录。**
环境音效（如脚步声）、音乐、图生图、视频和 ComfyUI 执行尚未接入；不会把音效请求改成朗读或本地合成。

## 界面与功能

界面分为四个一级页面，配置继续使用 DutyDeck 风格的“列表 → 独立编辑页”：

| 一级页面 | 内容 |
|---|---|
| 配置 | 模型服务、即梦、LibTV、ComfyUI、本地工作流 |
| 生图 | 选择 GPT 服务与模型，准备请求、确认生成一张、预览和下载 PNG |
| 声音 | MiniMax 语音合成：选择服务、模型、音色，输入朗读文本与语速，确认生成 MP3 |
| 生成记录 | 统一查看本插件任务，按生成中／已完成／已失败筛选；点击详情打开弹窗 |

配置中的 **模型服务** 合并 OpenAI 图片兼容、小米 MiMo、MiniMax 等供应商，
支持全部／图片／视频／声音筛选；同一服务的全部模型保留，不因筛选而丢失。
**即梦** 独立为单配置入口，本机 CLI 登录态不是多个账号配置。
**LibTV** 也独立为单入口，通过宿主 HTTP MCP + OAuth 接入；这不是“平台只允许一个账号”的声明。
已有重复配置仍完整显示，可逐项整理，升级不会自动删除或覆盖它们。

列表支持查找和进入编辑。编辑页按基本信息、已启用模型、可用目录分组，底部集中
取消／保存。模型逐项管理，不要求手写整份模型配置文本。工作流 JSON 只出现在工作流
编辑页。返回、切换与并发冲突保留未保存修改保护。

同一供应商配置可包含多种媒体类型。筛选仅改变显示，不自动修改默认模型或清除隐藏
模型。全局图片、视频和声音默认服务由用户明确选择，不自动采用列表第一项。

生成记录列表将渠道与模型合并为一列，上方显示渠道，下方以灰色小字显示模型；旁列显示状态和时间，任务编号与完整参数放入详情弹窗。
弹窗支持图片预览或音频试听、下载和本地状态更新；图片分别显示请求／实际尺寸，音频显示时长、采样率和声道。
结果未知／图片待读取的任务标记“待核对”，不会被当作失败；未提交的请求显示“待确认”。
状态筛选和刷新只读本地记录，不向供应商提交或重试任务。

## 服务接入范围

| 服务 | 本版支持 | 明确未实现 |
|---|---|---|
| OpenAI 图片生成 | HTTP/HTTPS 地址、加密密钥、`GET /models`；已配置 GPT 模型文生图、PNG 预览与下载 | 图片编辑、批量生成、URL 结果下载 |
| 小米 MiMo | 配音模型、音色、格式；`GET /models` | 实际语音合成、克隆或音色设计 |
| MiniMax | 模型／音色目录；已配置 speech 系列语音朗读、MP3 试听与下载 | 环境音效、音乐、图像与视频生成 |
| ComfyUI | 系统与节点发现、模型目录、远端工作流列表与详情；本地 API 工作流校验 | 上传输入、提交任务、取消远端任务和下载生成结果 |
| 即梦 Dreamina | 一个 CLI 路径与模型配置入口 | 插件内启动 CLI、登录、额度查询和生成 |
| LibTV | 一个官方 MCP 服务入口与接入说明 | 插件内 OAuth 登录和代理调用远程 MCP 工具 |

目录检查只在用户明确点击时执行。小米／OpenAI 模型列表和 MiniMax 音色列表不混用；
ComfyUI 节点存在也不代表工作流一定能执行。建议模型 ID 是配置默认值，实际服务支持
范围仍需核验。保存服务不提交任务，不产生生成费用。

MiniMax discovery works without a selected model. Model and voice sections have
separate fetch buttons and retain independent results. The UI merges 18 builtin
media candidates with returned model IDs and labels the source. Account voices
are read-only names and IDs; choose the voice when making a generation request.
This settings page does not set a default voice. Existing saved voice values are
preserved for compatibility. Chat-only model responses remain explicitly empty
for media discovery; model choices still require saving.

### ComfyUI 资源

在 ComfyUI 连接列表选择“浏览资源”，手动读取模型目录，再查看目录里的模型文件；
远端工作流可查看路径、大小、更新时间和 JSON 详情。只有通过校验的 API 格式才可
导入为本地工作流草稿，必须再次保存；画布格式仅预览，不自动转换或执行。

生成记录页仅展示本插件自己的任务，不再混入 ComfyUI 服务端历史和队列。
原有服务端只读查询接口保留兼容，返回数据可能包含其他客户端任务，不能据此认领成果。

查询全部通过用户点击触发，没有后台轮询。老版本服务器不支持某接口时明确显示
“不支持”，不能当作“没有模型／没有任务”。配置修改或重载后旧查询结果需重新读取。
LibTV 官方资料与协议来源见[接入调查](docs/provider-integration-research.md)。
## 凭据与数据

API Key／Bearer Token 使用插件内的 AES-256-GCM 加密，和配置一起原子写入私有文件。
随机主密钥保存在 macOS 默认钥匙串，按本插件和数据目录隔离，不写入配置或进程参数。
重新打开页面、重载插件或重启后自动恢复；页面与 Agent 只收到“已配置”标志，
不会回填密钥或暴露密文。此方案兼容现有 PI-Desktop 0.21.0，无需更新客户端。

本版凭据持久化支持 macOS；其他系统可保存普通配置，含密钥的保存会明确失败。
钥匙串锁定、拒绝访问、密钥丢失、数据损坏时保留原配置，不生成替代密钥或降级为明文。
旧版仅在内存中的 Key 若已丢失，需重新填写一次；旧宿主加密格式保留原文件，需要
原加密环境才能恢复。本机钥匙串和原数据目录是恢复条件，仅复制配置不能迁移密钥。

- 密钥输入默认遮挡；留空保留已加密保存的密钥，显式清除后保存才生效。
- 切换供应商或服务地址时不自动沿用原凭据。
- 不自动读取 DutyDeck、影视工厂或其他插件的私有配置与登录状态。
- 非敏感配置与加密凭据一起保存在本插件私有目录的 `aimedia-settings.json`。
- 保存使用版本检查与原子替换；并发修改时需重新读取核对，不盲目覆盖。
- 数据损坏时报告错误，不静默重置或删除旧配置。

ComfyUI 工作流采用 API 格式 JSON，记录名称、输出媒体类型、启用状态、连接引用和
输入绑定。工作流最多64项，每份定义最多200KiB／300节点。支持的绑定用途为
`prompt`、`negativePrompt`、`seed`、`width`、`height`、`steps`，必须指向真实节点输入。
被工作流引用的连接不能直接删除；先明确解除引用或删除对应工作流。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `media_catalog` | 首选入口：查看已配置模型、modelRef、参数约束、默认项和不可用原因 |
| `generate_image` | 自动准备与单次提交，保持调用直到请求结束并保存结果（网络上限 90 秒）；完成返回图片块 |
| `image_job` | 查询、最多等待 15 秒、会话任务列表或读取图片，不重新生成 |
| `export_image_result` | 交接原图到授权工作区，由 Agent 的执行工具解码为 PNG，无需模型转写 Base64 |
| `generate_audio` | 将明确的文本和音色提交为一次 MiniMax 语音任务，等待网络与保存结束；成功后导出 MP3 |
| `audio_job` | 查询／等待／列出当前会话音频任务，或核对结果；不重新提交 |
| `audio_voices` | 按 MiniMax 语音 modelRef 显式查询音色 ID，不生成或更改默认音色 |
| `export_audio_result` | 交接原始 MP3 到授权工作区，由 Agent 固定解码命令生成文件 |
| `get_capabilities` | 返回图片／语音实际能力与约束；ready 取决于已启用模型和凭据，不代表供应商实测通过 |
| `list_profiles` | 列出服务、模型、默认项和凭据是否已设置；可按媒体类型筛选，不返回密钥 |
| `list_workflows` | 列出工作流名称、类型、连接引用与节点数量，不返回工作流正文或执行工作流 |
| `prepare_image` | 本地固化请求，返回任务 ID、哈希和参数，不收费 |
| `submit_image` | 确认后单次提交并等待本次请求结束，可能收费；同任务不会重复提交 |
| `get_image_job` / `list_image_jobs` | 本地查询任务状态与记录，不提交远端请求 |
| `read_image_result` | 分块读取已验证的 PNG，每次最多 64 KiB；不返回私有路径 |

原有 12 个工具保留，新增 4 个音频工具。模型目录与任务查询不联网；`audio_voices` 显式查询供应商音色。生成入口
在用户明确授权的范围内提交，宿主权限检查继续生效。可直接请求：

> 用媒体服务中的传贝GPT、GPT Image 2，低质量 1024×1024，生成一张白底蓝色陶瓷杯；只提交一次。

语音流程：查询音频模型 → `audio_voices` 选择明确音色 → `generate_audio(operation="speech")` → `audio_job` → `export_audio_result`。
朗读文本最多 1000 字符，语速 0.5–2，输出 MP3；不设置新的默认音色。音频和图片共用最多两个活动生成名额。
每类记录最多 200 项，合并列表最多 400 项。记录页可见时自动同步本地任务；关闭音频弹窗会停止播放并释放临时地址。

工具可调用只证明本插件对当前会话可达，不代表某个供应商能生成。未发现工具也不能
直接推断插件未安装，需要区分未启用、未授权与未暴露。

Agent 使用流程：发现工具 → 查询模型 → 按用户指定／会话选择／默认／唯一候选选择 →
生成一张 → 等待原任务 → 返回图片。多候选确有歧义时只询问必要的模型选择，不跳转页面。
费用由供应商结算，插件不提供价格保证。unknown 可能已计费，绝不自动新建任务重试。
0.4.1 修复了新提交在 10 秒后提前结束工具调用、导致宿主丢弃慢响应的问题。
`waitMs` 只用于已有任务的本地等待；新提交的网络等待上限为 90 秒，给宿主 110 秒
工具时限预留校验保存时间。超时仍是未知结果，不能自动重试。页面提交后仍可查看进度。

图片块直接传给 Agent；用户侧是否展示取决于客户端。需要原图或客户端不展示插件图片块时，
Agent 调用导出工具，并在授权工作区运行其固定解码命令，完成后返回 PNG 文件链接。
交接成功不代表 PNG 已生成，必须核对解码退出码、文件大小和 SHA-256。
无工作区／缺少权限时单独报告导出限制，原有生成结果仍保留。

手动生图页继续保留。影视工厂可使用导出文件执行 `register_media → adopt_media`；
本插件不自动采用素材或判定画面质量。详见[Agent 使用与接口契约](docs/agent-image-contract.md)。

## 安装与权限

在插件管理中安装 `dist/bone.aimedia.services-0.5.1.piplug` 或加载开发目录，并审核所需权限。
插件启动即注册工具与技能，不需要先打开页面。已有有效配置后即可在 Agent 模式调用。
不保证在已运行的同一轮即时增加工具；新会话和下一轮的发现以安装客户端验收为准。
当前安装的 PI-Desktop 0.21.0 已验证 Agent 模式下的新会话／下一轮工具发现。
该版本的规划模式不会暴露插件声明的只读动作；插件图片块也不自动生成图片卡片。
Agent 可通过原图导出与 Markdown 图片链接完成用户可见展示，无需进入生图页面。

| 权限 | 用途 |
|---|---|
| `ui.view` | 显示独立设置页面 |
| `agent.tool.register` | 注册发现、准备、提交和结果读取工具；提交为高风险操作 |
| `agent.prompt.inject` | 提供对应 Agent 技能 |
| `net.fetch` / `net.anyHost` | 显式目录查询及已授权的 GPT／MiniMax 生成请求，沿用已保存地址与来源限制 |
| `fs.read` / `fs.write` | 仅 `bone-media/exports/**` 内交接文件检查与写入，PNG／MP3 由 Agent 授权工具解码 |

网络通过宿主 API 执行，拒绝重定向。接口会校验 URL、拒绝 URL 内嵌凭据及云元数据
地址；云服务预设约束来源，自定义服务允许 HTTP/HTTPS。
不声明任意 shell 执行权限，不直接用插件 Node 文件系统写工作区，不手改宿主权限登记。

更新插件前保存当前编辑。重载会从加密文件恢复已保存密钥，无需再次填写。
不需要为了测试中断其他运行任务。
PI-Desktop 0.21.0 可能保留升级前的插件页面；若仍显示旧导航，先保存编辑并等任务结束，再禁用／启用本插件以重建页面，无需更新客户端。

## 开发与测试

使用现代 Node.js，当前验证环境为 Node.js 22；界面为原生 JavaScript/CSS，无需前端构建。

```bash
node scripts/sync-manifest.cjs --check
node --test tests/*.test.cjs
python3 tests/settings.browser.py
python3 tests/generation.browser.py
python3 tests/records.browser.py
python3 tests/audio.browser.py
```

浏览器检查要求 Python Playwright 与 Chrome。测试自动启动真实插件入口、临时存储和
合成供应商响应，不连接真实账号、不读取用户密钥、不生成或收费。修改工具定义后运行
`node scripts/sync-manifest.cjs --write` 同步 manifest。

在已配置工具链的 PI-Desktop 仓库根目录校验／打包：

```bash
pnpm pi-plugin check /path/to/PI-Plugins/bone-aimedia-services
```

发布打包使用白名单脚本（在插件根目录运行）：

```bash
node scripts/pack-clean.cjs /absolute/path/to/PI-Desktop
```

发布包仅包含运行模块、技能、许可证与文档，不含测试服务器、私有配置或素材。
安装包与开发源码分别管理，后续真实供应商验收需明确账号、数量与费用范围。

## 后续计划与来源

- [实施计划（含未实现阶段）](docs/implementation-plan.zh-CN.md)
- [未来生成接口草案](docs/api-contract-draft.md)
- [Agent 驱动生图验收与客户端限制](docs/acceptance-agent-images.md)
- [DutyDeck 界面基准](docs/ui-design.zh-CN.md)
- [运行配置契约](docs/configuration-contract.md)
- [Agent 优先接口与使用流程](docs/agent-image-contract.md)
- [来源与许可说明](NOTICE.md)

后续阶段：环境音效、音乐、参考图／图生图、远程结果下载和可恢复的视频任务。当前不会把
未接入的媒体或模型目录候选标记为已实现执行能力。

- [0.4.1 慢响应请求修复与验收](docs/acceptance-image-request-lifetime.md)
- [统一生成记录与详情弹窗](docs/generation-records-ui.md)
- [MiniMax 语音与统一记录契约](docs/audio-generation-contract.md)
