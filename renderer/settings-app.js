(() => {
  'use strict';
  const A = window.AIMedia;
  const t = A.i18n.scope('app');
  const { h, button, input, field, picker, section } = A;
  const tabs = [
    { id: 'models', name: t('models'), providers: ['openai', 'minimax', 'xiaomi'], kinds: ['image', 'video', 'audio'], description: t('modelsDescription') },
    { id: 'dreamina', name: t('dreamina'), providers: ['dreamina'], kinds: ['image', 'video'], singleton: true, description: t('dreaminaDescription') },
    { id: 'libtv', name: 'LibTV', providers: ['libtv'], kinds: [], singleton: true, description: t('libtvDescription') },
    { id: 'connections', name: 'ComfyUI', providers: ['comfyui'], kinds: [], description: t('connectionsDescription') },
    { id: 'workflows', name: t('workflows'), providers: [], kinds: [], description: t('workflowsDescription') }
  ];
  const screens = [{ id: 'config', name: t('configuration') }, { id: 'records', name: t('records') }];
  const providerDisplay = { openai: t('openai'), minimax: 'MiniMax', xiaomi: t('xiaomi'), comfyui: 'ComfyUI', dreamina: t('dreaminaDisplay'), libtv: 'LibTV', workflow: t('workflows') };
  const categoryForProvider = provider => provider === 'dreamina' ? 'dreamina' : provider === 'libtv' ? 'libtv' : provider === 'comfyui' ? 'connections' : 'models';
  const s = { data: null, screen: 'config', tab: 'models', addDialog: false, dialogReturnFocus: null, resourceProfile: null, draft: null, defaults: null, defaultsDirty: false, dirty: false, busy: false, notice: null, locked: false,
    epoch: 0, editVersion: 0, importTicket: 0, importing: false, alive: true, version: null, loadError: null, legacyBackend: false, query: '', modelFilter: 'all', listFilter: 'all', credential: { action: 'preserve' }, probe: null };
  const root = document.getElementById('app');
  const invoke = A.createPanelInvoke(() => window.pluginBridge, version => {
    if (!s.alive) return;
    s.version = version;
    const badge = root.querySelector('.title-version');
    if (badge) { badge.textContent = version || ''; badge.hidden = !version; }
    document.title = [A.i18n.scope('shell')('title'), version].filter(Boolean).join(' ');
  });
  const C = { state: s, get tab() { return tabs.find(tab => tab.id === s.tab); }, render, touch, message, probe, canProbe, openResources, importRemote };
  const remote = A.remoteController({ state: s, invoke, render, importRemote });
  const records = A.recordsPageController({ state: s, invoke });
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
    return A.confirm(t('discardTitle'), t('discardDescription'));
  }
  async function navigate(tab = s.tab, screen = s.screen, focusId = screen === 'config' ? 'config-list' : `main-${screen}`) {
    if (!await canLeave()) return;
    resetDraft(); s.tab = tab; s.screen = screen; s.notice = null; s.query = ''; s.listFilter = 'all'; s.defaultsDirty = false;
    records.screenChanged();
    if (s.data) s.defaults = A.clone(s.data.defaults);
    render(); document.getElementById(focusId)?.focus();
    if (screen === 'records') void records.refresh();
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
      if (explicit) setNotice(t('reloaded'), 'success');
    } catch (error) {
      if (!s.alive || ticket !== s.epoch) return;
      s.loadError = error.code === 'NO_BRIDGE' ? t('noBridge') : A.errorText(error);
      if (s.data) s.notice = { text: s.loadError, type: 'error' };
    } finally { if (s.alive) { s.busy = false; render(); if (s.screen === 'records') void records.refresh(); } }
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
  function importRemote(definition, path, profileId, contentSha256) {
    resetDraft(); s.tab = 'workflows'; s.screen = 'config'; s.isNew = true;
    s.draft = { ...A.newWorkflow(), name: path.split('/').pop().replace(/\.json$/i, '').slice(0, 128), definition: A.clone(definition), connectionId: profileId, origin: 'comfyui-remote', remote: { profileId, path, contentSha256: contentSha256 || '0'.repeat(64), syncedAt: new Date().toISOString() }, executable: false, outputs: [] };
    s.jsonText = JSON.stringify(definition, null, 2); s.dirty = true;
    s.notice = { text: t('workflowImported'), type: 'success' }; render(); document.getElementById('editor-heading')?.focus();
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
      s.notice = { text: knownRejection ? A.errorText(error) : t('saveUncertain'), type: 'error' };
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
    void save(candidate, t('saved'));
  }
  async function toggleProfile(item, enabled) {
    if (s.busy || s.locked || item.enabled === enabled) return;
    const candidate = payload();
    const index = candidate.profiles.findIndex(profile => profile.id === item.id);
    if (index < 0) return;
    candidate.profiles[index] = { ...candidate.profiles[index], enabled };
    await save(candidate, enabled ? t('enabled') : t('disabled'));
  }
  async function remove(item, kind = null) {
    if (s.busy || s.locked) return;
    const workflow = kind === 'workflow' || Boolean(item.definition);
    if (s.defaultsDirty) { message(t('saveDefaultsFirst'), 'error'); return; }
    if (!workflow) {
      const references = s.data.workflows.filter(flow => flow.connectionId === item.id);
      if (references.length) { message(t('connectionReferenced', { p1: references.length }), 'error'); return; }
      if (Object.values(s.data.defaults).includes(item.id)) { message(t('defaultReferenced'), 'error'); return; }
    }
    const epoch = s.epoch;
    if (!await A.confirm(t('deleteTitle'), t('deleteDescription', { p1: item.name }), t('confirmDelete')) || epoch !== s.epoch) return;
    const candidate = payload(); const key = workflow ? 'workflows' : 'profiles'; candidate[key] = candidate[key].filter(row => row.id !== item.id);
    await save(candidate, t('deleted'));
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
    if (s.draft.provider === 'minimax' && !(s.credential.action === 'replace' && s.credential.value?.trim()) && !(s.credential.action === 'preserve' && s.draft.credentialConfigured)) { message(t('enterKey'), 'error'); return; }
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
        else if (result.status === 'connected') setNotice(t('catalogLoaded'), 'success');
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
      const options = [{ value: null, label: t('unset') }];
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
      const customPicker = picker(t('defaultKind', { p1: A.kinds[kind] }), curId, options, (value, opt) => {
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
      return field(t('defaultKind', { p1: A.kinds[kind] }), customPicker);
    }), A.note(t('defaultHelp')));
    return section(t('defaults'), card, button(s.busy ? t('busy') : t('saveDefaults'), () => { if (!s.defaultsDirty || s.draft) return; const candidate = payload(); candidate.defaults = A.clone(s.defaults); void save(candidate, t('defaultsSaved')); }, { disabled: s.busy || s.locked || !s.defaultsDirty }));
  }
  const providerIcon = {
    dreamina: { text: t('dreaminaIcon'), src: 'assets/models/jimeng.png' }, openai: { text: 'AI', src: 'assets/models/openai.png' },
    minimax: { text: 'M', src: 'assets/models/minimax.png' }, xiaomi: { text: t('xiaomiIcon'), src: 'assets/models/xiaomi.png' },
    comfyui: { text: 'C', src: 'assets/models/comfyui.png' }, libtv: { text: 'L', src: 'assets/models/default.png' },
  };
  const providerIconView = provider => { const icon = providerIcon[provider] || { text: '?' }; return h('span', { class: `service-icon provider-${provider}`, 'aria-hidden': 'true' }, icon.src ? h('img', { src: icon.src, alt: '' }) : icon.text); };
  function providerLabel(p) {
    const map = { openai: t('openaiCompatible'), minimax: t('minimaxImages'), dreamina: t('dreamina'), xiaomi: t('xiaomiSpeech'), comfyui: 'ComfyUI', libtv: 'LibTV' };
    return map[p] || providerDisplay[p] || p;
  }
  function modelCountSummary(item) {
    const models = item.models || [];
    if (!models.length) return t('noModels');
    const first = models[0].name || models[0].id;
    const imgs = models.filter(m => m.kind === 'image').length;
    const vids = models.filter(m => m.kind === 'video').length;
    const auds = models.filter(m => m.kind === 'audio').length;
    let typeDesc = '';
    if (imgs && vids) typeDesc = t('imageVideoCount', { p1: imgs, p2: vids });
    else if (imgs && !vids) typeDesc = t('imageModels');
    else if (vids && !imgs) typeDesc = t('videoModels');
    else if (auds) typeDesc = t('audioModels');
    else typeDesc = t('modelCount', { p1: models.length });
    return t('modelSummary', { p1: providerLabel(item.provider), p2: first, p3: models.length, p4: typeDesc });
  }
  function endpointSummary(item) {
    if (item.provider === 'dreamina') return t('cliLogin');
    if (item.provider === 'libtv') return t('hostMcp');
    const url = item.baseUrl || '';
    const cred = item.credentialConfigured ? t('credentialsConfigured') : t('credentialsMissing');
    return `${url ? url + ' · ' : ''}${cred}`;
  }
  function serviceToggle(item) {
    return h('label', { class: 'service-switch', title: item.enabled ? t('disableConfiguration') : t('enableConfiguration') },
      h('input', { type: 'checkbox', role: 'switch', 'aria-label': `${item.enabled ? t('disable') : t('enable')} ${item.name}`, checked: item.enabled, disabled: s.busy || s.locked || item.id === 'dreamina-unconfigured', onchange: e => { e.stopPropagation(); void toggleProfile(item, e.target.checked); } }),
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
    const summaryLine2 = `${endpointSummary(item)}${isDefault ? t('defaultSuffix', { p1: isDefault }) : ''}`;
    const copyBtn = button('', e => { e.stopPropagation(); copyProfile(item); }, { class: 'icon-action-btn', 'aria-label': t('copyItem', { p1: item.name }), title: t('copy'), disabled: s.busy || s.locked });
    copyBtn.append(A.svgIcon('copy', 16));
    const editBtn = button('', e => { e.stopPropagation(); void open(item); }, { class: 'icon-action-btn', 'aria-label': t('editItem', { p1: item.name }), title: t('edit'), disabled: s.busy || s.locked });
    editBtn.append(A.svgIcon('pencil', 16));
    const delBtn = button('', e => { e.stopPropagation(); void remove(item); }, { class: 'icon-action-btn action-delete', 'aria-label': t('deleteItem', { p1: item.name }), title: t('delete'), disabled: s.busy || s.locked });
    delBtn.append(A.svgIcon('trash', 16));
    const browseBtn = item.provider === 'comfyui' && button(t('browse'), e => { e.stopPropagation(); void openResources(item); }, { class: 'quiet service-action', 'aria-label': t('browseItem', { p1: item.name }), title: t('browse'), disabled: s.busy || s.locked || !item.enabled });
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
    const item = { id: 'dreamina-unconfigured', name: t('dreamina'), provider: 'dreamina', enabled: false, models: [] };
    const summaryLine1 = t('dreaminaUnconfigured');
    const summaryLine2 = t('cliLogin');
    const editBtn = button('', e => { e.stopPropagation(); void open(null, 'dreamina'); }, { class: 'icon-action-btn', 'aria-label': t('editDreamina'), title: t('edit'), disabled: s.busy || s.locked });
    editBtn.append(A.svgIcon('pencil', 16));
    const actions = h('div', { class: 'service-actions visible-actions' },
      serviceToggle(item),
      editBtn);
    return h('div', { class: 'service-row duty-service-row', 'data-service-row': '', 'data-service-name': item.name, 'data-row-id': item.id, role: 'group', tabindex: '0', 'aria-label': t('dreaminaAccessible'), onclick: e => openServiceRow(item, e), onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, label')) { e.preventDefault(); void open(null, 'dreamina'); } } },
      providerIconView(item.provider),
      h('div', { class: 'service-copy' },
        h('div', { class: 'service-title' }, t('dreamina')),
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
    const desc = t('workflowSummary', { p1: A.kinds[item.kind] || item.kind, p2: nodeCount, p3: connection?.name || t('unboundConnection') });
    const copyBtn = button('', e => { e.stopPropagation(); copyWorkflow(item); }, { class: 'icon-action-btn', 'aria-label': t('copyItem', { p1: item.name }), title: t('copy'), disabled: s.busy || s.locked });
    copyBtn.append(A.svgIcon('copy', 16));
    const editBtn = button('', e => { e.stopPropagation(); void open(item); }, { class: 'icon-action-btn', 'aria-label': t('editItem', { p1: item.name }), title: t('edit'), disabled: s.busy || s.locked });
    editBtn.append(A.svgIcon('pencil', 16));
    const delBtn = button('', e => { e.stopPropagation(); void remove(item, 'workflow'); }, { class: 'icon-action-btn action-delete', 'aria-label': t('deleteItem', { p1: item.name }), title: t('delete'), disabled: s.busy || s.locked });
    delBtn.append(A.svgIcon('trash', 16));
    const iconSlot = h('span', { class: 'service-icon workflow-icon-badge', 'aria-hidden': 'true' }, A.svgIcon('workflow', 20));
    return h('div', { class: 'service-row duty-service-row workflow-row', 'data-workflow-row': '', 'data-row-id': item.id, role: 'group', tabindex: '0', 'aria-label': `${item.name}，${desc}`, onclick: e => { if (!e.target.closest('button, input, label')) void open(item); }, onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, label')) { e.preventDefault(); void open(item); } } },
      iconSlot,
      h('div', { class: 'service-copy' },
        h('div', { class: 'service-title' }, item.name),
        h('p', { class: 'service-desc-line1' }, desc),
        h('p', { class: 'service-desc-line2' }, item.enabled ? t('workflowEnabled') : t('workflowDisabled'))),
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
    box.append(h('div', { class: 'dialog-heading' }, h('div', {}, h('h2', { id: 'add-service-title' }, t('addService')), h('p', { class: 'description' }, t('selectService'))), button('×', closeAddDialog, { class: 'quiet', 'aria-label': t('closeAddService') })));
    const list = h('div', { class: 'add-service-grid' });
    for (const id of providers) {
      const singleton = id === 'libtv';
      const exists = id === 'workflow' ? false : s.data.profiles.some(profile => profile.provider === id);
      const disabled = singleton && exists;
      const description = id === 'workflow' ? t('workflowServiceDescription') : A.providerDescription(s.data.catalog.find(provider => provider.id === id));
      list.append(h('button', { type: 'button', class: 'add-service-option', 'aria-label': providerDisplay[id], disabled, onclick: () => { closeAddDialog(); void open(null, id); } }, h('strong', {}, providerDisplay[id]), h('span', {}, disabled ? t('singletonConfigured') : description)));
    }
    box.append(list); modal.append(box); setTimeout(() => box.focus(), 0); return modal;
  }
  function unifiedListView() {
    const query = s.query.trim().toLowerCase();
    const categoryTabs = [
      { id: 'models', label: t('generationModels') },
      { id: 'audio', label: t('audioGeneration') },
      { id: 'connections', label: t('serviceConnections') },
      { id: 'workflows', label: t('workflows') }
    ];
    const activeCategory = s.listCategory || 'models';
    const navCapsules = h('div', { class: 'duty-nav-capsules', role: 'group', 'aria-label': t('configurationCategories') },
      categoryTabs.map(cat => button(cat.label, () => { s.listCategory = cat.id; render(); }, {
        class: `duty-capsule ${activeCategory === cat.id ? 'active' : ''}`,
        'aria-pressed': String(activeCategory === cat.id)
      }))
    );
    const isWfTab = activeCategory === 'workflows';
    const searchIcon = h('span', { class: 'search-icon-slot' }, A.svgIcon('search', 15));
    const searchPlaceholder = isWfTab ? t('workflowSearch') : t('serviceSearch');
    const searchInput = input(t('serviceSearch'), s.query, value => { s.query = value; render(); document.querySelector('[data-service-search]')?.focus(); }, { class: 'search-duty-input', 'data-service-search': '', type: 'search', placeholder: searchPlaceholder, disabled: s.busy });
    const searchBox = h('div', { class: 'search-duty-box' }, searchIcon, searchInput);
    const addBtn = button(isWfTab ? t('addWorkflow') : t('addService'), isWfTab ? () => open(null, 'workflow') : openAddDialog, { class: 'primary duty-add-btn', 'data-add-service': '', disabled: s.busy || s.locked });
    const headerBar = h('div', { class: 'duty-list-header-bar' },
      navCapsules,
      h('div', { class: 'duty-list-header-right' }, searchBox, addBtn)
    );
    const matches = item => [item.name, providerDisplay[item.provider], item.provider, ...(item.models || []).map(model => `${model.name} ${model.id}`)].join(' ').toLowerCase().includes(query);
    const profiles = s.data.profiles.filter(item => matches(item));
    const workflows = s.data.workflows.filter(item => `${item.name} ${item.kind} ${item.connectionId || ''}`.toLowerCase().includes(query));
    const dreaminaMatches = matches({ name: t('dreamina'), provider: 'dreamina', models: [] });
    let visibleProfiles = profiles.filter(item => item.provider !== 'dreamina');
    if (activeCategory === 'audio') {
      visibleProfiles = visibleProfiles.filter(p => p.provider === 'xiaomi' || p.models?.some(m => m.kind === 'audio'));
    } else if (activeCategory === 'connections') {
      visibleProfiles = visibleProfiles.filter(p => p.provider === 'comfyui');
    }
    const showDreamina = (activeCategory === 'models' || activeCategory === 'all') && dreaminaMatches;
    const profileChildren = [showDreamina && dreaminaRow(), ...visibleProfiles.map(profileRow)].filter(Boolean);
    const profileRows = h('div', { class: 'service-list duty-card-list', 'aria-label': t('serviceList') }, profileChildren);
    if (!profileChildren.length) profileRows.append(A.empty(t('noMatchingService'), s.data.profiles.length ? t('searchHelp') : t('addServiceHelp')));
    const workflowRows = h('div', { class: 'card workflow-list', 'aria-label': t('workflowList') }, workflows.map(workflowRow));
    if (!workflows.length && activeCategory === 'workflows') workflowRows.append(A.empty(t('noWorkflows'), t('importWorkflowHelp')));
    const conflict = s.data.singletonConflicts?.length;
    const hasWorkflows = workflows.length > 0;
    return h('div', { class: 'duty-list-container' },
      h('div', { class: 'heading visually-hidden' }, h('h2', {}, t('configuration'))),
      headerBar,
      Boolean(conflict) ? h('div', { class: 'notice error', role: 'alert' }, t('singletonConflict')) : null,
      activeCategory === 'workflows' ? null : h('div', { class: 'duty-service-section' }, profileRows),
      (hasWorkflows || activeCategory === 'workflows' || activeCategory === 'all') ? section(t('workflows'), workflowRows) : null,
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
    const header = h('header', {}, h('div', { class: 'brand' }, h('h1', {}, t('title'), h('span', { class: 'title-version', hidden: !s.version }, s.version || ''))),
      h('p', { class: 'capability' }, t('subtitle')));
    const nav = navView(screens, s.screen, 'main', t('navigation'), 'main-panel', id => navigate(s.tab, id, `main-${id}`));
    const main = h('div', { id: 'main-panel', role: 'tabpanel', 'aria-labelledby': `main-${s.screen}` });
    const panel = h('div', { id: 'settings-panel', ...(s.screen === 'config' ? { role: 'region', 'aria-labelledby': 'main-config' } : {}), 'aria-busy': String(s.busy), class: 'view' });
    if (s.notice) panel.append(h('div', { class: `notice ${s.notice.type}`, 'data-app-notice': '', role: s.notice.type === 'error' ? 'alert' : 'status' }, h('p', {}, s.notice.text), (s.locked || !s.data) && button(t('reload'), () => load(true), { disabled: s.busy })));
    if (s.data && s.legacyBackend) panel.append(h('div', { class: 'note', 'data-config-readonly': '', role: 'status' }, h('p', {}, t('legacyBackend')), button(t('checkAgain'), () => load(true), { class: 'quiet', disabled: s.busy })));
    if (!s.data) {
      const empty = A.empty(s.busy ? t('loading') : t('loadFailed'), s.busy ? t('loadingHelp') : s.loadError || t('serviceNotResponding'));
      if (s.loadError && !s.busy) { empty.setAttribute('data-config-load-error', ''); empty.setAttribute('role', 'alert'); }
      empty.append(button(t('reload'), () => load(true), { disabled: s.busy }));
      panel.append(h('div', { class: 'card' }, empty));
    }
    else if (s.screen === 'records') panel.append(records.view());
    else if (s.resourceProfile) panel.append(h('div', { class: 'heading' }, h('div', { class: 'inline' }, button('←', () => navigate(), { 'aria-label': t('backConnections'), class: 'quiet' }), h('h2', { id: 'resource-heading', tabindex: -1 }, t('browse')))), remote.resourceView());
    else if (s.draft) {
      const isComfy = s.draft.provider === 'comfyui';
      const isWf = s.tab === 'workflows';
      const editTitle = isComfy ? t('connectionEditor', { p1: s.isNew ? t('add') : t('edit') }) : isWf ? t('workflowEditor', { p1: s.isNew ? t('add') : t('edit') }) : t('modelEditor', { p1: s.isNew ? t('add') : t('edit') });
      panel.append(h('div', { class: 'heading' }, h('div', { class: 'inline' }, button('←', () => navigate(), { 'aria-label': t('backList'), class: 'quiet', disabled: s.busy }), h('h2', { id: 'editor-heading', tabindex: -1 }, editTitle))));
      const form = h('form', { onsubmit: e => { e.preventDefault(); saveDraft(); } }, h('fieldset', { disabled: s.busy || s.legacyBackend }, s.tab === 'workflows' ? A.workflowView(C) : A.profileView(C)), h('div', { class: 'footer' }, button(t('cancel'), () => navigate(), { disabled: s.busy }), button(s.busy ? t('busy') : t('save'), null, { type: 'submit', class: 'primary', disabled: s.busy || s.locked || s.importing })));
      panel.append(form);
    } else panel.append(unifiedListView());
    if (s.data && !s.draft && s.screen !== 'records') panel.append(h('div', { class: 'footer' }, button(t('reload'), () => load(true), { class: 'quiet', disabled: s.busy })));
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
  window.addEventListener('pagehide', () => { s.alive = false; records.dispose(); resetDraft(); media.removeEventListener('change', systemAppearance); if (typeof unsubscribe === 'function') unsubscribe(); });
  void load();
})();
