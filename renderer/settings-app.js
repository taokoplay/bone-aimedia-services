(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, input, field, picker, section } = A;
  const tabs = [
    { id: 'models', name: '模型服务', providers: ['openai', 'minimax', 'xiaomi'], kinds: ['image', 'video', 'audio'], description: '管理图片、视频和音频模型服务。' },
    { id: 'dreamina', name: '即梦', providers: ['dreamina'], kinds: ['image', 'video'], singleton: true, description: '共享本机 CLI 登录身份，仅维护一个入口。' },
    { id: 'libtv', name: 'LibTV', providers: ['libtv'], kinds: [], singleton: true, description: '通过宿主 MCP + OAuth 维护一个官方服务入口。' },
    { id: 'connections', name: 'ComfyUI', providers: ['comfyui'], kinds: [], description: '管理 ComfyUI 服务连接和远端资源。' },
    { id: 'workflows', name: '本地工作流', providers: [], kinds: [], description: '导入和管理 ComfyUI API 工作流。' }
  ];
  const screens = [{ id: 'config', name: '配置' }, { id: 'image', name: '生图' }, { id: 'audio', name: '声音' }, { id: 'records', name: '生成记录' }];
  const providerDisplay = { openai: 'ChatGPT / OpenAI 图片', minimax: 'MiniMax', xiaomi: '小米 MiMo', comfyui: 'ComfyUI', dreamina: '即梦 Dreamina', libtv: 'LibTV', workflow: '本地工作流' };
  const categoryForProvider = provider => provider === 'dreamina' ? 'dreamina' : provider === 'libtv' ? 'libtv' : provider === 'comfyui' ? 'connections' : 'models';
  const s = { data: null, screen: 'config', tab: 'models', addDialog: false, dialogReturnFocus: null, resourceProfile: null, draft: null, defaults: null, defaultsDirty: false, dirty: false, busy: false, notice: null, locked: false,
    epoch: 0, editVersion: 0, importTicket: 0, importing: false, alive: true, loadError: null, legacyBackend: false, query: '', modelFilter: 'all', listFilter: 'all', credential: { action: 'preserve' }, probe: null };
  const root = document.getElementById('app');
  const invoke = A.createPanelInvoke(() => window.pluginBridge);
  const C = { state: s, get tab() { return tabs.find(tab => tab.id === s.tab); }, render, touch, message, probe, canProbe, openResources, importRemote };
  const remote = A.remoteController({ state: s, invoke, render, importRemote });
  const generation = A.generationController({ state: s, invoke, render, message });
  const audio = A.audioController({ state: s, invoke, render });
  const records = A.recordsPageController({ state: s, invoke });
  const generationPages = { image: generation, audio, records };
  function touch() {
    s.dirty = true; s.editVersion++;
    document.querySelectorAll('[data-browse]').forEach(node => { node.disabled = true; });
    if (s.draft?.provider === 'comfyui') {
      s.probe = null; remote.reset();
      document.querySelector('.duty-resource-snapshot-section')?.replaceWith(remote.inlineBrowserView(C));
    }
    if (s.draft?.provider === 'xiaomi') {
      document.querySelectorAll('[data-probe]').forEach(node => { node.disabled = true; });
    }
  }
  let noticeTimer = null;
  function setNotice(text, type = 'success', autoDismissMs = 2000) {
    if (noticeTimer) clearTimeout(noticeTimer);
    s.notice = text ? { text, type } : null;
    render();
    if (text && type === 'success' && autoDismissMs > 0) {
      noticeTimer = setTimeout(() => {
        if (s.notice?.text === text) {
          s.notice = null;
          document.querySelector('[data-app-notice]')?.remove();
        }
      }, autoDismissMs);
    }
  }
  function message(text, type = 'success') { setNotice(text, type); }
  function resetDraft() {
    s.epoch++; s.editVersion++; s.importTicket++; s.importing = false; s.resourceProfile = null; remote.reset();
    s.draft = null; s.isNew = false; s.dirty = false; s.credential = { action: 'preserve' }; s.credentialCaution = false; s.probe = null; s.jsonText = '';
  }
  async function canLeave() {
    if (s.busy) return false;
    if (!s.dirty && !s.defaultsDirty) return true;
    return A.confirm('放弃未保存的修改？', '当前输入尚未保存。返回或切换页面将丢弃这些修改。');
  }
  async function navigate(tab = s.tab, screen = s.screen, focusId = screen === 'config' ? 'config-list' : `main-${screen}`) {
    if (!await canLeave()) return;
    resetDraft(); s.tab = tab; s.screen = screen; s.notice = null; s.query = ''; s.listFilter = 'all'; s.defaultsDirty = false;
    for (const controller of Object.values(generationPages)) controller.screenChanged();
    if (s.data) s.defaults = A.clone(s.data.defaults);
    render(); document.getElementById(focusId)?.focus();
    void generationPages[screen]?.refresh();
  }
  async function load(explicit = false) {
    if (s.busy) return;
    if (explicit && !await canLeave()) return;
    const ticket = ++s.epoch;
    s.busy = true; s.notice = null; render();
    invoke.reset();
    try {
      const data = await invoke('aimedia.get');
      if (!s.alive || ticket !== s.epoch) return;
      resetDraft(); s.data = data; s.defaults = A.clone(data.defaults); s.defaultsDirty = false;
      s.legacyBackend = invoke.isReadOnly(); s.locked = s.legacyBackend; s.loadError = null;
      if (explicit) setNotice('已重新读取配置。', 'success');
    } catch (error) {
      if (!s.alive || ticket !== s.epoch) return;
      s.loadError = error.code === 'NO_BRIDGE' ? '请在 PI-Desktop 插件面板中打开此页面。当前没有连接到配置服务。' : A.errorText(error);
      if (s.data) s.notice = { text: s.loadError, type: 'error' };
    } finally { if (s.alive) { s.busy = false; render(); void generationPages[s.screen]?.refresh(); } }
  }
  async function open(item, providerId = null) {
    if (s.busy || !s.data) return;
    if (s.defaultsDirty && !await canLeave()) return;
    if (item) s.tab = item.definition ? 'workflows' : categoryForProvider(item.provider);
    else if (providerId === 'workflow') s.tab = 'workflows';
    else if (providerId) s.tab = categoryForProvider(providerId);
    resetDraft(); s.defaultsDirty = false; s.defaults = A.clone(s.data.defaults); s.notice = null;
    const provider = providerId ? s.data.catalog.find(p => p.id === providerId) : null;
    s.draft = item ? A.clone(item) : s.tab === 'workflows' ? A.newWorkflow() : A.newProfile(provider || s.data.catalog.find(p => p.id === C.tab.providers[0]));
    s.isNew = !item; s.modelFilter = 'all'; s.jsonText = s.tab === 'workflows' ? JSON.stringify(s.draft.definition, null, 2) : '';
    render(); document.querySelector('#editor-heading')?.focus();
    if (s.draft?.provider === 'comfyui' && s.draft.enabled && s.data.profiles.some(profile => profile.id === s.draft.id)) void remote.loadSnapshot();
  }
  async function openAddDialog() {
    if (s.busy || s.locked || !s.data || !(await canLeave())) return;
    s.dialogReturnFocus = document.activeElement;
    s.addDialog = true; render(); document.querySelector('.aimedia-add-dialog')?.focus();
  }
  function closeAddDialog() {
    s.addDialog = false; const returnFocus = s.dialogReturnFocus; s.dialogReturnFocus = null; render();
    if (returnFocus?.isConnected) returnFocus.focus(); else document.querySelector('[data-add-service]')?.focus();
  }
  async function openResources(item) {
    if (s.busy || s.locked || !item.enabled || s.dirty || s.isNew && s.draft) return;
    if (!await canLeave()) return;
    resetDraft(); s.tab = 'connections'; s.defaultsDirty = false; s.defaults = A.clone(s.data.defaults); s.notice = null;
    s.resourceProfile = item.id; remote.select(item.id); render(); document.getElementById('resource-heading')?.focus();
  }
  function importRemote(definition, path, profileId) {
    resetDraft(); s.tab = 'workflows'; s.screen = 'config'; s.isNew = true;
    s.draft = { ...A.newWorkflow(), name: path.split('/').pop().replace(/\.json$/i, '').slice(0, 128), definition: A.clone(definition), connectionId: profileId };
    s.jsonText = JSON.stringify(definition, null, 2); s.dirty = true;
    s.notice = { text: '已导入本地工作流草稿。请核对并明确保存；不会修改远端工作流。', type: 'success' }; render(); document.getElementById('editor-heading')?.focus();
  }
  function payload() { return { expectedRevision: s.data.revision, profiles: s.data.profiles.map(A.cleanProfile), defaults: A.clone(s.data.defaults), workflows: A.clone(s.data.workflows) }; }
  async function save(candidate, success) {
    if (s.busy || s.locked) return;
    s.busy = true; s.notice = null; const epoch = s.epoch; render();
    try {
      const data = await invoke('aimedia.save', candidate);
      if (!s.alive || epoch !== s.epoch) return;
      s.data = data; s.defaults = A.clone(data.defaults); s.defaultsDirty = false; resetDraft();
      setNotice(success, 'success');
    } catch (error) {
      if (!s.alive || epoch !== s.epoch) return;
      const knownRejection = ['INVALID_ARGUMENT', 'CONFLICT', 'NOT_FOUND', 'DISABLED', 'PERMISSION_DENIED', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_ERROR', 'CREDENTIAL_LEGACY', 'PLUGIN_RELOAD_REQUIRED'].includes(error.code);
      s.locked = error.code === 'CONFLICT' || !knownRejection;
      s.notice = { text: knownRejection ? A.errorText(error) : '保存结果尚不确定，输入已保留。请重新读取并核对已保存配置，不要直接重试。', type: 'error' };
    } finally { if (s.alive && epoch <= s.epoch) { s.busy = false; render(); } }
  }
  function saveDraft() {
    if (!s.draft || s.busy || s.locked) return;
    const candidate = payload();
    if (s.tab === 'workflows') {
      s.listCategory = 'workflows';
      let record;
      try { record = A.parseWorkflow(s.draft, s.jsonText); } catch (error) { message(error.message, 'error'); return; }
      const index = candidate.workflows.findIndex(item => item.id === record.id);
      if (index < 0) candidate.workflows.push(record); else candidate.workflows[index] = record;
    } else {
      s.listCategory = 'models';
      const error = A.profileError(s.draft, s.credential); if (error) { message(error, 'error'); return; }
      const record = { ...A.cleanProfile(s.draft), credentialUpdate: A.clone(s.credential) };
      const index = candidate.profiles.findIndex(item => item.id === record.id);
      if (index < 0) candidate.profiles.push(record); else candidate.profiles[index] = record;
    }
    void save(candidate, '配置已保存。未发起目录查询。');
  }
  async function toggleProfile(item, enabled) {
    if (s.busy || s.locked || item.enabled === enabled) return;
    const candidate = payload();
    const index = candidate.profiles.findIndex(profile => profile.id === item.id);
    if (index < 0) return;
    candidate.profiles[index] = { ...candidate.profiles[index], enabled };
    await save(candidate, enabled ? '配置已启用。' : '配置已停用。');
  }
  async function remove(item, kind = null) {
    if (s.busy || s.locked) return;
    const workflow = kind === 'workflow' || Boolean(item.definition);
    if (s.defaultsDirty) { message('请先保存默认项，或重新读取以放弃默认项修改。', 'error'); return; }
    if (!workflow) {
      const references = s.data.workflows.filter(flow => flow.connectionId === item.id);
      if (references.length) { message(`此连接仍被 ${references.length} 个工作流引用。请在「本地工作流」中明确解除绑定或删除工作流后再删除。`, 'error'); return; }
      if (Object.values(s.data.defaults).includes(item.id)) { message('此配置仍是默认项。请先明确更改并保存对应默认项，再删除配置。', 'error'); return; }
    }
    const epoch = s.epoch;
    if (!await A.confirm('删除配置？', `将删除「${item.name}」。此操作不会删除其他配置。`, '确认删除') || epoch !== s.epoch) return;
    const candidate = payload(); const key = workflow ? 'workflows' : 'profiles'; candidate[key] = candidate[key].filter(row => row.id !== item.id);
    await save(candidate, '配置已删除。');
  }
  function canProbe() {
    if (s.busy || s.locked || !s.draft || s.importing) return false;
    if (s.draft.provider === 'xiaomi' && (s.dirty || s.isNew)) return false;
    if (s.draft.provider === 'comfyui') return !s.dirty && !s.isNew && s.draft.enabled;
    if (s.tab === 'workflows') return Boolean(s.data.profiles.find(p => p.id === s.draft.connectionId && p.enabled));
    return true;
  }
  async function probe(catalogTarget) {
    if (!canProbe()) return;
    const operationEpoch = s.epoch;
    if (s.draft.provider === 'minimax' && !(s.credential.action === 'replace' && s.credential.value?.trim()) && !(s.credential.action === 'preserve' && s.draft.credentialConfigured)) { message('请先填写 API Key。', 'error'); return; }
    if (s.dirty || s.isNew) {
      const error = A.profileError(s.draft, s.credential);
      if (error) { message(error, 'error'); return; }
      const candidate = payload();
      const record = { ...A.cleanProfile(s.draft), credentialUpdate: A.clone(s.credential) };
      const index = candidate.profiles.findIndex(item => item.id === record.id);
      if (index < 0) candidate.profiles.push(record); else candidate.profiles[index] = record;
      s.busy = true; render();
      try {
        const data = await invoke('aimedia.save', candidate);
        if (!s.alive || operationEpoch !== s.epoch) return;
        const saved = data.profiles.find(profile => profile.id === record.id);
        if (!saved) throw new Error('Missing saved profile');
        s.data = data; s.defaults = A.clone(data.defaults);
        s.draft = A.clone(saved); s.credential = { action: 'preserve' };
        s.dirty = false; s.isNew = false; s.credentialCaution = false;
      } catch (e) {
        if (!s.alive || operationEpoch !== s.epoch) return;
        if (e.code === 'CONFLICT') s.locked = true;
        s.busy = false;
        message(A.errorText(e), 'error');
        return;
      }
    }
    const epoch = s.epoch, version = s.editVersion;
    const data = { profileId: s.tab === 'workflows' ? s.draft.connectionId : s.draft.id, expectedRevision: s.data.revision };
    if (s.tab === 'workflows') data.workflowId = s.draft.id;
    const isComfyProbe = s.data.profiles.find(p => p.id === data.profileId)?.provider === 'comfyui';
    const isMiniMaxProbe = s.draft.provider === 'minimax';
    const catalog = isMiniMaxProbe ? catalogTarget || 'models' : undefined;
    if (catalog) data.catalog = catalog;
    const previous = s.probe;
    s.busy = true; if (!isMiniMaxProbe) s.probe = null; s.notice = null; render();
    try {
      const result = await invoke('aimedia.probe', data);
      if (s.alive && epoch === s.epoch && version === s.editVersion) {
        s.probe = isMiniMaxProbe ? { ...result,
          models: catalog === 'models' ? result.models : previous?.models || [],
          voices: catalog === 'voices' ? result.voices : previous?.voices || [],
          catalogs: { ...previous?.catalogs, ...result.catalogs } } : result;
        if (isComfyProbe) setNotice(A.connectionProbeText(result), result.status === 'connected' ? 'success' : 'error');
        else if (isMiniMaxProbe) {
          const complete = result.catalogs?.[catalog]?.status === 'connected';
          setNotice(A.minimaxCatalogText(result, catalog), complete ? 'success' : 'error');
        }
        else if (result.status === 'connected') setNotice('成功从供应商获取模型目录！', 'success');
      }
    } catch (error) {
      if (s.alive && epoch === s.epoch) {
        if (error.code === 'CONFLICT') s.locked = true;
        message(A.errorText(error), 'error');
      }
    } finally {
      if (s.alive && epoch === s.epoch) { s.busy = false; render(); }
    }
  }
  function allDefaultsView() {
    const card = h('div', { class: 'card' }, ['image', 'video', 'audio'].map(kind => {
      const matchingProfiles = s.data.profiles.filter(profile => profile.enabled && s.data.catalog.find(p => p.id === profile.provider)?.kinds.includes(kind));
      const options = [{ value: null, label: '未设置' }];
      for (const p of matchingProfiles) {
        const kindModels = (p.models || []).filter(m => m.kind === kind);
        if (kindModels.length) {
          for (const m of kindModels) {
            options.push({
              value: p.id,
              modelId: m.id,
              label: `${m.name || m.id} · ${p.name}`
            });
          }
        } else {
          options.push({
            value: p.id,
            modelId: null,
            label: p.name
          });
        }
      }
      const curId = s.defaults[kind];
      const curProf = s.data.profiles.find(p => p.id === curId);
      const curOpt = options.find(opt => opt.value === curId && (!opt.modelId || opt.modelId === curProf?.modelId)) || options.find(opt => opt.value === curId);
      const customPicker = picker(`默认${A.kinds[kind]}配置`, curId, options, (value, opt) => {
        s.defaults[kind] = value;
        if (value && opt?.modelId && curProf) {
          curProf.modelId = opt.modelId;
        }
        s.defaultsDirty = JSON.stringify(s.defaults) !== JSON.stringify(s.data.defaults);
        s.editVersion++;
        render();
      }, s.busy || s.locked);
      if (curOpt && customPicker.querySelector('summary')) {
        customPicker.querySelector('summary').textContent = curOpt.label;
      }
      return field(`默认${A.kinds[kind]}配置`, customPicker);
    }), A.note('默认项单独保存；新增服务不会自动成为默认。'));
    return section('默认配置', card, button(s.busy ? '处理中…' : '保存默认项', () => { if (!s.defaultsDirty || s.draft) return; const candidate = payload(); candidate.defaults = A.clone(s.defaults); void save(candidate, '默认项已保存。'); }, { disabled: s.busy || s.locked || !s.defaultsDirty }));
  }
  const providerIcon = {
    dreamina: { text: '梦', src: 'assets/models/jimeng.png' }, openai: { text: 'AI', src: 'assets/models/openai.png' },
    minimax: { text: 'M', src: 'assets/models/minimax.png' }, xiaomi: { text: '米', src: 'assets/models/xiaomi.png' },
    comfyui: { text: 'C', src: 'assets/models/comfyui.png' }, libtv: { text: 'L', src: 'assets/models/default.png' },
  };
  const providerIconView = provider => { const icon = providerIcon[provider] || { text: '?' }; return h('span', { class: `service-icon provider-${provider}`, 'aria-hidden': 'true' }, icon.src ? h('img', { src: icon.src, alt: '' }) : icon.text); };
  function providerLabel(p) {
    const map = { openai: 'OpenAI 图片兼容', minimax: 'MiniMax 图像', dreamina: '即梦', xiaomi: '小米语音', comfyui: 'ComfyUI', libtv: 'LibTV' };
    return map[p] || providerDisplay[p] || p;
  }
  function modelCountSummary(item) {
    const models = item.models || [];
    if (!models.length) return '尚未配置模型';
    const first = models[0].name || models[0].id;
    const imgs = models.filter(m => m.kind === 'image').length;
    const vids = models.filter(m => m.kind === 'video').length;
    const auds = models.filter(m => m.kind === 'audio').length;
    let typeDesc = '';
    if (imgs && vids) typeDesc = `${imgs} 图片 + ${vids} 视频`;
    else if (imgs && !vids) typeDesc = '图片模型';
    else if (vids && !imgs) typeDesc = '视频模型';
    else if (auds) typeDesc = '音频模型';
    else typeDesc = `${models.length} 个模型`;
    return `${providerLabel(item.provider)} · ${first} 等 ${models.length} 个模型 · ${typeDesc}`;
  }
  function endpointSummary(item) {
    if (item.provider === 'dreamina') return 'CLI 登录态 · CLI 登录态';
    if (item.provider === 'libtv') return '宿主 MCP / OAuth · 固定单实例';
    const url = item.baseUrl || '';
    const cred = item.credentialConfigured ? '凭据已配置' : '缺少凭据';
    return `${url ? url + ' · ' : ''}${cred}`;
  }
  function serviceToggle(item) {
    return h('label', { class: 'service-switch', title: item.enabled ? '停用配置' : '启用配置' },
      h('input', { type: 'checkbox', role: 'switch', 'aria-label': `${item.enabled ? '停用' : '启用'} ${item.name}`, checked: item.enabled, disabled: s.busy || s.locked || item.id === 'dreamina-unconfigured', onchange: e => { e.stopPropagation(); void toggleProfile(item, e.target.checked); } }),
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }));
  }
  function copyProfile(item) {
    const clone = A.clone(item);
    clone.id = A.id('profile');
    clone.name = `${item.name} 副本`;
    void open(clone);
    s.isNew = true;
    s.dirty = true;
  }
  function openServiceRow(item, event) {
    if (event.target.closest('button, input, label')) return;
    if (item.id === 'dreamina-unconfigured') void open(null, 'dreamina'); else void open(item);
  }
  function profileRow(item) {
    const isDefault = Object.entries(s.data.defaults).filter(([, id]) => id === item.id).map(([kind]) => A.kinds[kind]).join('、');
    const summaryLine1 = modelCountSummary(item);
    const summaryLine2 = `${endpointSummary(item)}${isDefault ? ` · 默认${isDefault}` : ''}`;
    const copyBtn = button('', e => { e.stopPropagation(); copyProfile(item); }, { class: 'icon-action-btn', 'aria-label': `复制 ${item.name}`, title: '复制', disabled: s.busy || s.locked });
    copyBtn.append(A.svgIcon('copy', 16));
    const editBtn = button('', e => { e.stopPropagation(); void open(item); }, { class: 'icon-action-btn', 'aria-label': `编辑 ${item.name}`, title: '编辑', disabled: s.busy || s.locked });
    editBtn.append(A.svgIcon('pencil', 16));
    const delBtn = button('', e => { e.stopPropagation(); void remove(item); }, { class: 'icon-action-btn action-delete', 'aria-label': `删除 ${item.name}`, title: '删除', disabled: s.busy || s.locked });
    delBtn.append(A.svgIcon('trash', 16));
    const browseBtn = item.provider === 'comfyui' && button('浏览资源', e => { e.stopPropagation(); void openResources(item); }, { class: 'quiet service-action', 'aria-label': `浏览资源 ${item.name}`, title: '浏览资源', disabled: s.busy || s.locked || !item.enabled });
    const actions = h('div', { class: 'service-actions visible-actions' },
      browseBtn,
      serviceToggle(item),
      copyBtn,
      editBtn,
      delBtn);
    return h('div', { class: 'service-row duty-service-row', 'data-service-row': '', 'data-service-name': item.name, 'data-row-id': item.id, role: 'group', tabindex: '0', 'aria-label': `${item.name}，${summaryLine1}`, onclick: e => openServiceRow(item, e), onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, label')) { e.preventDefault(); void open(item); } } },
      providerIconView(item.provider),
      h('div', { class: 'service-copy' },
        h('div', { class: 'service-title' }, item.name),
        h('p', { class: 'service-desc-line1' }, summaryLine1),
        h('p', { class: 'service-desc-line2' }, summaryLine2)),
      actions);
  }
  function dreaminaRow() {
    const items = s.data.profiles.filter(item => item.provider === 'dreamina');
    if (items.length) return items.map(profileRow);
    const item = { id: 'dreamina-unconfigured', name: '即梦', provider: 'dreamina', enabled: false, models: [] };
    const summaryLine1 = '即梦 · 网页授权 · 尚未配置';
    const summaryLine2 = 'CLI 登录态 · CLI 登录态';
    const editBtn = button('', e => { e.stopPropagation(); void open(null, 'dreamina'); }, { class: 'icon-action-btn', 'aria-label': '编辑 即梦', title: '编辑', disabled: s.busy || s.locked });
    editBtn.append(A.svgIcon('pencil', 16));
    const actions = h('div', { class: 'service-actions visible-actions' },
      serviceToggle(item),
      editBtn);
    return h('div', { class: 'service-row duty-service-row', 'data-service-row': '', 'data-service-name': item.name, 'data-row-id': item.id, role: 'group', tabindex: '0', 'aria-label': '即梦，网页授权，固定单实例，尚未配置', onclick: e => openServiceRow(item, e), onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, label')) { e.preventDefault(); void open(null, 'dreamina'); } } },
      providerIconView(item.provider),
      h('div', { class: 'service-copy' },
        h('div', { class: 'service-title' }, '即梦'),
        h('p', { class: 'service-desc-line1' }, summaryLine1),
        h('p', { class: 'service-desc-line2' }, summaryLine2)),
      actions);
  }
  function copyWorkflow(item) {
    const clone = A.clone(item);
    clone.id = A.id('workflow');
    clone.name = `${item.name} 副本`;
    void open(clone);
    s.isNew = true;
    s.dirty = true;
  }
  function workflowRow(item) {
    const connection = s.data.profiles.find(profile => profile.id === item.connectionId);
    const nodeCount = Object.keys(item.definition || {}).length;
    const desc = `${A.kinds[item.kind] || item.kind} · ${nodeCount} 个节点 · ${connection?.name || '未绑定连接'}`;
    const copyBtn = button('', e => { e.stopPropagation(); copyWorkflow(item); }, { class: 'icon-action-btn', 'aria-label': `复制 ${item.name}`, title: '复制', disabled: s.busy || s.locked });
    copyBtn.append(A.svgIcon('copy', 16));
    const editBtn = button('', e => { e.stopPropagation(); void open(item); }, { class: 'icon-action-btn', 'aria-label': `编辑 ${item.name}`, title: '编辑', disabled: s.busy || s.locked });
    editBtn.append(A.svgIcon('pencil', 16));
    const delBtn = button('', e => { e.stopPropagation(); void remove(item, 'workflow'); }, { class: 'icon-action-btn action-delete', 'aria-label': `删除 ${item.name}`, title: '删除', disabled: s.busy || s.locked });
    delBtn.append(A.svgIcon('trash', 16));
    const iconSlot = h('span', { class: 'service-icon workflow-icon-badge', 'aria-hidden': 'true' }, A.svgIcon('workflow', 20));
    return h('div', { class: 'service-row duty-service-row workflow-row', 'data-workflow-row': '', 'data-row-id': item.id, role: 'group', tabindex: '0', 'aria-label': `${item.name}，${desc}`, onclick: e => { if (!e.target.closest('button, input, label')) void open(item); }, onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, label')) { e.preventDefault(); void open(item); } } },
      iconSlot,
      h('div', { class: 'service-copy' },
        h('div', { class: 'service-title' }, item.name),
        h('p', { class: 'service-desc-line1' }, desc),
        h('p', { class: 'service-desc-line2' }, item.enabled ? '已启用 · 本地 API 格式' : '已停用 · 本地 API 格式')),
      h('div', { class: 'service-actions visible-actions' }, copyBtn, editBtn, delBtn));
  }
  function addServiceDialog() {
    if (!s.addDialog) return null;
    const providers = ['openai', 'minimax', 'xiaomi', 'comfyui', 'libtv', 'workflow'];
    const modal = h('div', { class: 'aimedia-modal-backdrop', role: 'presentation', onclick: e => { if (e.target === modal) closeAddDialog(); } });
    const box = h('div', { class: 'aimedia-add-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'add-service-title', tabindex: '-1' });
    box.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); closeAddDialog(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...box.querySelectorAll('button:not(:disabled)')];
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement);
      const next = e.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
      if (index < 0 || e.shiftKey && index === 0 || !e.shiftKey && index === focusable.length - 1) { e.preventDefault(); focusable[next].focus(); }
    };
    box.append(h('div', { class: 'dialog-heading' }, h('div', {}, h('h2', { id: 'add-service-title' }, '添加服务'), h('p', { class: 'description' }, '选择类型后进入独立编辑页。')), button('×', closeAddDialog, { class: 'quiet', 'aria-label': '关闭添加服务' })));
    const list = h('div', { class: 'add-service-grid' });
    for (const id of providers) {
      const singleton = id === 'libtv';
      const exists = id === 'workflow' ? false : s.data.profiles.some(profile => profile.provider === id);
      const disabled = singleton && exists;
      const description = id === 'workflow' ? '保存 ComfyUI API 工作流并配置输入绑定。' : s.data.catalog.find(provider => provider.id === id)?.description || '';
      list.append(h('button', { type: 'button', class: 'add-service-option', 'aria-label': providerDisplay[id], disabled, onclick: () => { closeAddDialog(); void open(null, id); } }, h('strong', {}, providerDisplay[id]), h('span', {}, disabled ? '已配置，可从服务列表编辑；不会自动创建重复入口。' : description)));
    }
    box.append(list); modal.append(box); setTimeout(() => box.focus(), 0); return modal;
  }
  function unifiedListView() {
    const query = s.query.trim().toLowerCase();
    const categoryTabs = [
      { id: 'models', label: '生成模型' },
      { id: 'audio', label: '音频生成' },
      { id: 'connections', label: '服务链接' },
      { id: 'workflows', label: '本地工作流' }
    ];
    const activeCategory = s.listCategory || 'models';
    const navCapsules = h('div', { class: 'duty-nav-capsules', role: 'group', 'aria-label': '配置类别切换' },
      categoryTabs.map(cat => button(cat.label, () => { s.listCategory = cat.id; render(); }, {
        class: `duty-capsule ${activeCategory === cat.id ? 'active' : ''}`,
        'aria-pressed': String(activeCategory === cat.id)
      }))
    );
    const isWfTab = activeCategory === 'workflows';
    const searchIcon = h('span', { class: 'search-icon-slot' }, A.svgIcon('search', 15));
    const searchPlaceholder = isWfTab ? '搜索名称、输入或输出类型' : '搜索名称、供应商或模型';
    const searchInput = input('搜索名称、供应商或模型', s.query, value => { s.query = value; render(); document.querySelector('[aria-label="搜索名称、供应商或模型"]')?.focus(); }, { class: 'search-duty-input', type: 'search', placeholder: searchPlaceholder, disabled: s.busy });
    const searchBox = h('div', { class: 'search-duty-box' }, searchIcon, searchInput);
    const addBtn = button(isWfTab ? '添加工作流' : '添加服务', isWfTab ? () => open(null, 'workflow') : openAddDialog, { class: 'primary duty-add-btn', 'data-add-service': '', disabled: s.busy || s.locked });
    const headerBar = h('div', { class: 'duty-list-header-bar' },
      navCapsules,
      h('div', { class: 'duty-list-header-right' }, searchBox, addBtn)
    );
    const matches = item => [item.name, providerDisplay[item.provider], item.provider, ...(item.models || []).map(model => `${model.name} ${model.id}`)].join(' ').toLowerCase().includes(query);
    const profiles = s.data.profiles.filter(item => matches(item));
    const workflows = s.data.workflows.filter(item => `${item.name} ${item.kind} ${item.connectionId || ''}`.toLowerCase().includes(query));
    const dreaminaMatches = matches({ name: '即梦', provider: 'dreamina', models: [] });
    let visibleProfiles = profiles.filter(item => item.provider !== 'dreamina');
    if (activeCategory === 'audio') {
      visibleProfiles = visibleProfiles.filter(p => p.provider === 'xiaomi' || p.models?.some(m => m.kind === 'audio'));
    } else if (activeCategory === 'connections') {
      visibleProfiles = visibleProfiles.filter(p => p.provider === 'comfyui');
    }
    const showDreamina = (activeCategory === 'models' || activeCategory === 'all') && dreaminaMatches;
    const profileChildren = [showDreamina && dreaminaRow(), ...visibleProfiles.map(profileRow)].filter(Boolean);
    const profileRows = h('div', { class: 'service-list duty-card-list', 'aria-label': '服务配置列表' }, profileChildren);
    if (!profileChildren.length) profileRows.append(A.empty('没有匹配的服务', s.data.profiles.length ? '试试其他名称、供应商或模型 ID。' : '点击右上角“添加服务”选择服务类型。'));
    const workflowRows = h('div', { class: 'card workflow-list', 'aria-label': '本地工作流列表' }, workflows.map(workflowRow));
    if (!workflows.length && activeCategory === 'workflows') workflowRows.append(A.empty('尚未保存本地工作流', '从 ComfyUI 远端资源导入后，检查并明确保存。'));
    const conflict = s.data.singletonConflicts?.length;
    const hasWorkflows = workflows.length > 0;
    return h('div', { class: 'duty-list-container' },
      h('div', { class: 'heading visually-hidden' }, h('h2', {}, '配置')),
      headerBar,
      Boolean(conflict) ? h('div', { class: 'notice error', role: 'alert' }, '检测到历史重复配置，所有条目均保留。请核对并编辑需要保留的一份，再明确删除其余条目；不会自动合并。') : null,
      activeCategory === 'workflows' ? null : h('div', { class: 'duty-service-section' }, profileRows),
      (hasWorkflows || activeCategory === 'workflows' || activeCategory === 'all') ? section('本地工作流', workflowRows) : null,
      (activeCategory === 'models' || activeCategory === 'all') ? h('div', { class: 'duty-defaults-section' }, allDefaultsView()) : null,
      addServiceDialog()
    );
  }
  function navView(entries, selected, prefix, label, panel, change) {
    return h('nav', { class: 'tabs', role: 'tablist', 'aria-label': label }, entries.map((tab, index) => {
      const b = button(tab.name, () => change(tab.id), { id: `${prefix}-${tab.id}`, role: 'tab', 'aria-label': tab.name, 'aria-selected': String(tab.id === selected), 'aria-controls': panel, tabindex: tab.id === selected ? 0 : -1, disabled: s.busy });
      b.addEventListener('keydown', e => {
        const next = e.key === 'ArrowRight' ? (index + 1) % entries.length : e.key === 'ArrowLeft' ? (index + entries.length - 1) % entries.length : e.key === 'Home' ? 0 : e.key === 'End' ? entries.length - 1 : -1;
        if (next >= 0 && !s.busy) { e.preventDefault(); void change(entries[next].id); }
      }); return b;
    }));
  }
  function render() {
    if (!s.alive) return;
    const header = h('header', {}, h('div', { class: 'brand' }, h('h1', {}, 'AI 媒体服务', h('span', { class: 'title-version' }, '0.5.0'))),
      h('p', { class: 'capability' }, 'GPT 文生图 · MiniMax 语音合成'));
    const nav = navView(screens, s.screen, 'main', '媒体服务主导航', 'main-panel', id => navigate(s.tab, id, `main-${id}`));
    const main = h('div', { id: 'main-panel', role: 'tabpanel', 'aria-labelledby': `main-${s.screen}` });
    const panel = h('div', { id: 'settings-panel', ...(s.screen === 'config' ? { role: 'region', 'aria-labelledby': 'main-config' } : {}), 'aria-busy': String(s.busy), class: 'view' });
    if (s.notice) panel.append(h('div', { class: `notice ${s.notice.type}`, 'data-app-notice': '', role: s.notice.type === 'error' ? 'alert' : 'status' }, h('p', {}, s.notice.text), (s.locked || !s.data) && button('重新读取', () => load(true), { disabled: s.busy })));
    if (s.data && s.legacyBackend) panel.append(h('div', { class: 'note', 'data-config-readonly': '', role: 'status' }, h('p', {}, '已读取原有配置，当前为只读模式。插件后台尚未更新；重载插件后点击「重新检查」恢复编辑。'), button('重新检查', () => load(true), { class: 'quiet', disabled: s.busy })));
    if (!s.data) {
      const empty = A.empty(s.busy ? '正在读取配置…' : '无法读取配置', s.busy ? '正在读取本地配置，不会自动连接供应商。' : s.loadError || '配置服务尚未响应，请重新读取。');
      if (s.loadError && !s.busy) { empty.setAttribute('data-config-load-error', ''); empty.setAttribute('role', 'alert'); }
      empty.append(button('重新读取', () => load(true), { disabled: s.busy }));
      panel.append(h('div', { class: 'card' }, empty));
    }
    else if (s.screen === 'image') panel.append(generation.view());
    else if (s.screen === 'audio') panel.append(audio.view());
    else if (s.screen === 'records') panel.append(records.view());
    else if (s.resourceProfile) panel.append(h('div', { class: 'heading' }, h('div', { class: 'inline' }, button('←', () => navigate(), { 'aria-label': '返回连接列表', class: 'quiet' }), h('h2', { id: 'resource-heading', tabindex: -1 }, '浏览资源'))), remote.resourceView());
    else if (s.draft) {
      const isComfy = s.draft.provider === 'comfyui';
      const isWf = s.tab === 'workflows';
      const editTitle = isComfy ? `${s.isNew ? '添加' : '编辑'}服务连接` : isWf ? `${s.isNew ? '添加' : '编辑'}本地工作流` : `${s.isNew ? '添加' : '编辑'}生成模型配置`;
      panel.append(h('div', { class: 'heading' }, h('div', { class: 'inline' }, button('←', () => navigate(), { 'aria-label': '返回列表', class: 'quiet', disabled: s.busy }), h('h2', { id: 'editor-heading', tabindex: -1 }, editTitle))));
      const form = h('form', { onsubmit: e => { e.preventDefault(); saveDraft(); } }, h('fieldset', { disabled: s.busy || s.legacyBackend }, s.tab === 'workflows' ? A.workflowView(C) : A.profileView(C)), h('div', { class: 'footer' }, button('取消', () => navigate(), { disabled: s.busy }), button(s.busy ? '处理中…' : '保存', null, { type: 'submit', class: 'primary', disabled: s.busy || s.locked || s.importing })));
      panel.append(form);
    } else panel.append(unifiedListView());
    if (s.data && !s.draft && s.screen !== 'records') panel.append(h('div', { class: 'footer' }, button('重新读取', () => load(true), { class: 'quiet', disabled: s.busy })));
    main.append(panel); root.replaceChildren(...(s.draft ? [main] : [header, nav, main]));
  }
  const media = matchMedia('(prefers-color-scheme: light)');
  let hostBase = null, appearanceVersion = 0;
  const applyAppearance = appearance => { hostBase = ['dark', 'light'].includes(appearance?.base) ? appearance.base : null; document.documentElement.dataset.base = hostBase || (media.matches ? 'light' : 'dark'); };
  const systemAppearance = () => { if (!hostBase) applyAppearance(null); };
  applyAppearance(null); media.addEventListener('change', systemAppearance);
  const unsubscribe = window.pluginBridge?.on?.('appearance:changed', appearance => { appearanceVersion++; applyAppearance(appearance); });
  const appearanceTicket = appearanceVersion;
  invoke('app.getAppearance').then(appearance => { if (s.alive && appearanceVersion === appearanceTicket) applyAppearance(appearance); }).catch(() => {});
  window.addEventListener('beforeunload', e => { if (s.dirty || s.defaultsDirty || s.busy) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', () => { s.alive = false; for (const controller of Object.values(generationPages)) controller.dispose(); resetDraft(); media.removeEventListener('change', systemAppearance); if (typeof unsubscribe === 'function') unsubscribe(); });
  void load();
})();
