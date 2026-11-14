(() => {
  'use strict';
  const A = window.AIMedia;
  const t = A.i18n.scope('profile');
  const { h, button, field, input, picker, section, note } = A;
  const iconAssets = {
    dreamina: 'assets/models/jimeng.png',
    openai: 'assets/models/openai.png',
    minimax: 'assets/models/minimax.png',
    xiaomi: 'assets/models/xiaomi.png',
    comfyui: 'assets/models/comfyui.png',
    libtv: 'assets/models/default.png',
  };
  const iconText = { dreamina: t('dreaminaIcon'), openai: 'AI', minimax: 'M', xiaomi: t('xiaomiIcon'), comfyui: 'C', libtv: 'L' };
  const providerIcon = provider => h('span', { class: `service-icon provider-${provider}`, 'aria-hidden': 'true' }, iconAssets[provider] ? h('img', { src: iconAssets[provider], alt: '' }) : iconText[provider] || '?');
  A.newProfile = provider => ({ id: A.id('profile'), name: '', provider: provider.id, enabled: true, baseUrl: provider.defaultBaseUrl,
    models: ['openai', 'dreamina'].includes(provider.id) ? [] : A.clone(provider.defaultModels), modelId: '', voice: provider.id === 'xiaomi' ? 'mimo_default' : '', format: '', cliPath: '', comfyUser: '', ...(provider.id === 'comfyui' ? { authKind: 'none', headerName: '' } : {}), workflow: null, bindings: [] });
  A.profileError = (draft, credential = { action: 'preserve' }) => {
    if (!draft.name.trim()) return t('nameRequired');
    if (draft.models.some(model => !model.id.trim() || !model.name.trim())) return t('modelFieldsRequired');
    if (new Set(draft.models.map(model => model.id)).size !== draft.models.length) return t('modelIdUnique');
    if (draft.modelId && !draft.models.some(model => model.id === draft.modelId)) return t('defaultModelMissing');
    if (draft.provider !== 'dreamina') {
      try { const url = new URL(draft.baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return t('urlCredentials'); }
      catch { return t('urlRequired'); }
    }
    if (draft.provider === 'comfyui') {
      if (draft.authKind === 'header' && (!(draft.headerName || '').match(/^(?:x-[a-z0-9-]+|authorization)$/i) || draft.headerName.length > 80)) return t('headerInvalid');
      if (['bearer', 'header'].includes(draft.authKind) && !(credential.action === 'replace' && credential.value) && !(credential.action === 'preserve' && draft.credentialConfigured)) return t('secretRequired');
    }
    return null;
  };
  function providerPicker(C, providers, draft, disabled) {
    const s = C.state;
    const details = h('details', { class: 'provider-picker' });
    const current = providers.find(item => item.id === draft.provider) || s.data.catalog.find(item => item.id === draft.provider);
    const summary = h('summary', { role: 'button', 'aria-label': t('providerType'), 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-disabled': String(disabled), tabindex: disabled ? -1 : 0 }, providerIcon(draft.provider), h('span', {}, A.providerName(current) || draft.provider));
    const list = h('ul', { class: 'provider-menu', role: 'listbox', 'aria-label': t('providerOptions') });
    const optionButtons = [];
    for (const provider of providers) {
      const option = button('', async () => {
        details.open = false;
        if (provider.id === draft.provider || disabled || !providers.some(item => item.id === provider.id)) return;
        const token = s.epoch;
        if (!await A.confirm(t('changeProvider'), t('changeProviderDescription'), t('changeAndClear')) || token !== s.epoch) return;
        Object.assign(draft, A.newProfile(provider), { id: draft.id, name: draft.name, enabled: draft.enabled });
        s.credential = { action: 'clear' }; s.credentialCaution = true; s.probe = null; C.touch(); C.render();
      }, { role: 'option', 'aria-selected': String(provider.id === draft.provider), class: 'provider-option-row', 'aria-label': A.providerName(provider), disabled });
      option.append(providerIcon(provider.id), h('span', {}, A.providerName(provider)), provider.id === draft.provider && h('strong', {}, '✓'));
      optionButtons.push(option);
      list.append(h('li', { role: 'presentation' }, option));
    }
    details.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(details.open)));
    details.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); details.open = false; summary.focus(); return; }
      if (disabled || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); details.open = true;
      const index = optionButtons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? optionButtons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + optionButtons.length) % optionButtons.length;
      optionButtons[next]?.focus();
    });
    details.append(summary, list);
    return details;
  }
  let dreaminaStatusCache = null;
  let dreaminaLoginSession = null;
  let dreaminaPollTimer = null;
  async function refreshDreamina(C, cliPath, force = false) {
    const s = C.state;
    if (s.dreaminaBusy && !force) return;
    s.dreaminaBusy = true;
    try {
      const res = await window.pluginBridge?.invoke?.('aimedia.dreamina.status', { cliPath });
      if (res) dreaminaStatusCache = res;
    } catch (err) {
      dreaminaStatusCache = { state: 'error', message: err.message };
    } finally {
      s.dreaminaBusy = false;
      C.render();
    }
  }
  function dreaminaLoginBlock(C, d) {
    const s = C.state;
    if (!dreaminaStatusCache && !s.dreaminaBusy) {
      void refreshDreamina(C, d.cliPath);
    }
    const container = h('div', { class: 'dreamina-panel' });
    const st = dreaminaStatusCache;
    const isLogged = st?.state === 'loggedIn';
    const statusText = s.dreaminaBusy
      ? t('loginChecking')
      : isLogged
        ? t('loggedIn', { p1: st.credit })
        : (A.dreaminaStatusText(st) || t('notLoggedIn'));
    const statusTone = isLogged ? 'status-logged' : 'status-unlogged';
    const header = h('div', { class: 'dreamina-panel-header' },
      h('div', { class: 'dreamina-panel-info' },
        h('div', { class: 'row-title' }, t('dreaminaLogin')),
        h('div', { class: `dreamina-status-badge ${statusTone}` }, statusText),
        h('p', { class: 'dreamina-desc' }, t('loginDescription'))),
      h('div', { class: 'dreamina-actions' },
        button(t('refreshStatus'), () => refreshDreamina(C, d.cliPath, true), { class: 'quiet', disabled: s.dreaminaBusy || s.busy }),
        isLogged
          ? button(t('logout'), async () => {
              if (!await A.confirm(t('logoutTitle'), t('logoutDescription'), t('confirmLogout'))) return;
              s.dreaminaBusy = true; C.render();
              try { await window.pluginBridge?.invoke?.('aimedia.dreamina.logout', { cliPath: d.cliPath }); } catch {}
              await refreshDreamina(C, d.cliPath, true);
            }, { class: 'quiet danger', disabled: s.dreaminaBusy || s.busy })
          : null,
        button(isLogged ? t('loginAgain') : t('login'), async () => {
          s.dreaminaBusy = true; C.render();
          try {
            const start = await window.pluginBridge?.invoke?.('aimedia.dreamina.loginStart', { cliPath: d.cliPath });
            if (start?.verificationUri) {
              dreaminaLoginSession = start;
              if (dreaminaPollTimer) clearInterval(dreaminaPollTimer);
              dreaminaPollTimer = setInterval(async () => {
                if (!dreaminaLoginSession?.deviceCode) { clearInterval(dreaminaPollTimer); return; }
                const poll = await window.pluginBridge?.invoke?.('aimedia.dreamina.loginPoll', { cliPath: d.cliPath, deviceCode: dreaminaLoginSession.deviceCode });
                if (poll?.success) {
                  clearInterval(dreaminaPollTimer);
                  dreaminaLoginSession = null;
                  C.message(t('loginSuccess'), 'success');
                  await refreshDreamina(C, d.cliPath, true);
                }
              }, 4000);
            } else {
              C.message(start?.raw || t('loginFailed'), 'error');
            }
          } catch (e) {
            C.message(e.message, 'error');
          } finally {
            s.dreaminaBusy = false; C.render();
          }
        }, { class: isLogged ? 'quiet' : 'primary', disabled: s.dreaminaBusy || s.busy })
      )
    );
    container.append(header);
    if (dreaminaLoginSession?.verificationUri) {
      const codeBox = h('div', { class: 'dreamina-auth-box' },
        h('p', { class: 'auth-tip' }, t('authorizationHelp')),
        h('div', { class: 'auth-code-row' },
          h('span', { class: 'user-code' }, dreaminaLoginSession.userCode || t('codeGenerated')),
          button(t('copyDeviceCode'), () => {
            navigator.clipboard.writeText(dreaminaLoginSession.userCode || '');
            C.message(t('codeCopied'), 'success');
          }, { class: 'quiet' }),
          h('a', { href: dreaminaLoginSession.verificationUri, target: '_blank', class: 'auth-link' }, t('openAuthorization'))
        ),
        button(t('cancelLogin'), () => {
          if (dreaminaPollTimer) clearInterval(dreaminaPollTimer);
          dreaminaLoginSession = null;
          C.render();
        }, { class: 'quiet' })
      );
      container.append(codeBox);
    }
    return container;
  }
  A.profileView = C => {
    const s = C.state, d = s.draft, provider = s.data.catalog.find(p => p.id === d.provider);
    const changed = (key, value, rerender = false) => { d[key] = value; C.touch(); if (rerender) C.render(); };
    const control = (label, key, attrs = {}) => input(label, d[key], value => changed(key, value), { disabled: s.busy, ...attrs });
    const providers = s.data.catalog.filter(p => C.tab.providers.includes(p.id));
    const providerDesc = d.provider === 'openai' ? t('openaiDescription') : A.providerDescription(provider);
    const isComfy = d.provider === 'comfyui';
    const basic = h('div', { class: 'duty-card' });
    const providerPickField = field(t('providerType'), providerPicker(C, providers, d, s.busy || C.tab.singleton), providerDesc);
    if (isComfy) {
      providerPickField.classList.add('visually-hidden');
    }
    basic.append(providerPickField);
    if (!isComfy) basic.append(field(t('providerName'), control(t('configurationName'), 'name', { maxlength: 128, placeholder: t('nameExample') })));
    if (isComfy) {
      const clearCredential = () => {
        s.credential = { action: 'clear' }; s.credentialCaution = true; d.credentialConfigured = false;
        const secret = document.querySelector('[data-auth-secret]');
        if (secret) { secret.value = ''; secret.placeholder = t('secretPlaceholder'); }
      };
      const authKinds = [
        { value: 'none', label: t('noAuthentication') },
        { value: 'bearer', label: 'Bearer Token' },
        { value: 'header', label: t('customHeader') },
      ];
      const currentAuthKind = d.authKind || (d.credentialConfigured || s.credential?.value ? 'bearer' : 'none');
      const grid = h('div', { class: 'duty-conn-grid' },
        field(t('name'), control(t('configurationName'), 'name', { maxlength: 128, placeholder: t('comfyExample') })),
        field(t('serviceUrl'), input(t('serviceUrl'), d.baseUrl, value => {
          d.baseUrl = value; clearCredential(); C.touch();
        }, { disabled: s.busy, spellcheck: 'false', maxlength: 2048, placeholder: 'http://127.0.0.1:8188' })),
        field(t('comfyUsernameOptional'), input(t('comfyUser'), d.comfyUser, value => { d.comfyUser = value; clearCredential(); C.touch(); }, { disabled: s.busy, placeholder: t('defaultUser') })),
        field(t('authentication'), picker(t('authentication'), currentAuthKind, authKinds, value => {
          if (value === currentAuthKind) return;
          d.authKind = value; d.headerName = ''; clearCredential();
          C.touch();
          C.render();
        }, s.busy))
      );
      if (currentAuthKind === 'header') {
        grid.append(field(t('headerName'), input(t('headerName'), d.headerName || '', value => {
          d.headerName = value; clearCredential(); C.touch();
        }, { placeholder: 'X-API-Key', disabled: s.busy })));
      }
      if (currentAuthKind !== 'none') {
        const secret = input(t('secret'), s.credential?.value || '', value => {
          s.credential = value ? { action: 'replace', value } : { action: s.credentialCaution ? 'clear' : 'preserve' };
          C.touch();
        }, { type: 'password', 'data-auth-secret': '', autocomplete: 'new-password', placeholder: d.credentialConfigured ? t('keepSecret') : t('secretPlaceholder'), disabled: s.busy });
        grid.append(field(t('secret'), secret));
      }
      basic.append(grid);
    } else if (d.provider === 'dreamina') {
      basic.append(dreaminaLoginBlock(C, d));
      basic.append(field(t('cliPathOptional'), control(t('cliPath'), 'cliPath', { placeholder: t('cliExample') }), t('cliHelp')));
    } else {
      const isHttp = /^http:\/\//i.test((d.baseUrl || '').trim());
      const urlNote = isHttp ? t('httpWarning') : '';
      const urlInput = input(t('serviceUrl'), d.baseUrl, value => {
        d.baseUrl = value; s.credential = { action: 'clear' }; s.credentialCaution = true; s.probe = null; C.touch();
        document.querySelector('[data-discovery]')?.replaceChildren(note(t('urlUpdated')));
        const secret = document.querySelector('[aria-label="API Key"]'); if (secret) secret.value = '';
        const hint = document.getElementById('credential-hint'); if (hint) hint.textContent = t('urlCredentialWarning');
      }, { disabled: s.busy, spellcheck: 'false', maxlength: 2048 });
      const urlField = field(t('serviceUrl'), urlInput, t('urlHelp'));
      if (urlNote) urlField.append(h('p', { class: 'field-caution' }, urlNote));
      basic.append(urlField);
    }
    if (d.provider === 'libtv') basic.append(note(t('libtvHelp')));
    if (!['dreamina', 'libtv', 'comfyui'].includes(d.provider)) {
      let isShowing = false;
      const savedCredentialHint = s.legacyBackend ? t('credentialReadOnly') : t('credentialSaved');
      const secret = input('API Key', s.credential.value || '', value => { s.credential = value ? { action: 'replace', value } : { action: s.credentialCaution ? 'clear' : 'preserve' }; if (d.provider === 'minimax') s.probe = null; C.touch(); const hint = document.getElementById('credential-hint'); if (hint) hint.textContent = value ? t('credentialEntered') : d.credentialConfigured && !s.credentialCaution ? savedCredentialHint : t('credentialMissing'); }, { type: 'password', autocomplete: 'new-password', spellcheck: 'false', disabled: s.busy });
      const eyeIconSpan = h('span', { class: 'eye-icon-slot' }, A.svgIcon('eye', 16));
      const reveal = button(t('show'), () => {
        isShowing = !isShowing;
        secret.type = isShowing ? 'text' : 'password';
        reveal.textContent = isShowing ? t('hide') : t('show');
        reveal.setAttribute('aria-label', isShowing ? t('hideKey') : t('showKey'));
        reveal.title = isShowing ? t('hideKey') : t('showKey');
        eyeIconSpan.replaceChildren(A.svgIcon(isShowing ? 'eyeOff' : 'eye', 16));
        reveal.prepend(eyeIconSpan);
      }, { class: 'key-eye-btn', 'aria-label': t('showKey'), title: t('showKey'), disabled: s.busy });
      reveal.prepend(eyeIconSpan);
      const secretWrapper = h('div', { class: 'key-input-wrapper inline' }, secret, reveal);
      basic.append(field('API Key', h('div', {}, secretWrapper, h('p', { class: 'muted', id: 'credential-hint' }, s.credentialCaution ? t('credentialChanged') : d.credentialConfigured ? savedCredentialHint : t('credentialMissing')), button(t('clearCredentials'), () => { s.credential = { action: 'clear' }; if (d.provider === 'minimax') s.probe = null; C.touch(); C.render(); }, { class: 'quiet', disabled: s.busy })), ''));
    }
    const toggleLabel = d.provider === 'comfyui' ? t('enableConnection') : t('enableConfiguration');
    const toggleDesc = d.provider === 'comfyui' ? t('connectionToggleHelp') : t('configurationToggleHelp');
    const toggleField = field(toggleLabel, A.toggle('', d.enabled, value => changed('enabled', value, true), s.busy), toggleDesc);
    toggleField.classList.add('field-toggle');
    basic.append(toggleField);
    const view = h('div', { class: 'duty-editor' }, section(d.provider === 'comfyui' ? t('editConnection') : t('basics'), basic));
    if (d.provider === 'comfyui' && A.resourceBrowserView) {
      view.append(A.resourceBrowserView(C));
    }
    if (!['comfyui', 'libtv'].includes(d.provider)) {
      const filter = s.modelFilter || 'all';
      const imgCount = d.models.filter(m => m.kind === 'image').length;
      const vidCount = d.models.filter(m => m.kind === 'video').length;
      const audCount = d.models.filter(m => m.kind === 'audio').length;
      const filterOptions = [{ id: 'all', name: t('all'), count: d.models.length }];
      if (provider.kinds.includes('image')) filterOptions.push({ id: 'image', name: t('image'), count: imgCount });
      if (provider.kinds.includes('video')) filterOptions.push({ id: 'video', name: t('video'), count: vidCount });
      if (provider.kinds.includes('audio')) filterOptions.push({ id: 'audio', name: t('audio'), count: audCount });
      const chips = h('div', { class: 'chips filter-capsules', 'aria-label': t('modelFilter') }, filterOptions.map(opt => {
        const b = button('', () => { s.modelFilter = opt.id; C.render(); }, { 'aria-label': opt.name, 'aria-pressed': String(filter === opt.id), disabled: s.busy });
        b.append(h('span', {}, opt.name), h('span', { class: 'capsule-count' }, ` ${opt.count}`));
        return b;
      }));
      const models = h('div', { class: 'duty-model-list' });
      const choice = h('div', { id: 'model-choice' });
      choice.append(field(t('defaultModel'), picker(t('defaultModel'), d.modelId, [{ value: '', label: t('unselected') }, ...d.models.map(m => ({ value: m.id, label: `${m.name || m.id} · ${A.kinds[m.kind]} (${m.id})` }))], value => changed('modelId', value, true), s.busy), t('defaultModelHelp')));
      models.append(choice);
      let count = 0;
      d.models.forEach((model, index) => {
        if (filter !== 'all' && filter !== model.kind) return;
        count++;
        const set = (key, value) => { model[key] = value; C.touch(); C.render(); };
        const row = h('div', { class: 'model-row duty-model-row' },
          h('span', { class: 'model-row-check' }, A.svgIcon('checkCircle', 16)),
          h('span', { class: 'model-kind-badge' }, A.kinds[model.kind] || model.kind),
          h('div', { class: 'model-row-info' },
            h('span', { class: 'model-row-name' }, model.name || model.id || t('modelNumber', { p1: index + 1 })),
            (model.name && model.name !== model.id) ? h('span', { class: 'model-row-id' }, `(${model.id})`) : null,
            h('span', { class: 'model-row-capability' }, A.capabilityText(model))),
          h('div', { class: 'model-row-hidden-inputs' },
            input(t('modelName', { p1: index + 1 }), model.name, value => set('name', value), { disabled: s.busy, maxlength: 256 }),
            input(t('modelId', { p1: index + 1 }), model.id, value => set('id', value), { disabled: s.busy, maxlength: 128, spellcheck: 'false' }),
            picker(t('modelType', { p1: index + 1 }), model.kind, provider.kinds.map(k => ({ value: k, label: A.kinds[k] })), value => set('kind', value), s.busy)),
          button('', e => {
            if (e) { e.stopPropagation(); e.preventDefault(); }
            if (d.modelId && model.id && d.modelId === model.id) {
              C.message(t('changeDefaultFirst'), 'error');
              return;
            }
            const idx = d.models.indexOf(model);
            if (idx >= 0) d.models.splice(idx, 1);
            if (d.modelId && !d.models.some(m => m.id === d.modelId)) {
              d.modelId = '';
            }
            C.touch();
            C.render();
          }, { class: 'model-remove-btn', 'aria-label': t('removeModel', { p1: model.id || index + 1 }), title: t('removeModel', { p1: model.id || index + 1 }), disabled: s.busy }));
        row.querySelector('.model-remove-btn')?.append(A.svgIcon('x', 14));
        models.append(row);
      });
      if (!count) models.append(A.empty(t('noEnabledModels'), t('addModelHelp')));
      models.append(h('div', { class: 'custom-model-bar' }, button(t('addCustomModel'), () => { d.models.push({ id: '', name: '', kind: filter === 'all' ? provider.kinds[0] : filter }); C.touch(); C.render(); }, { disabled: s.busy || d.models.length >= 100 })));
      const summaryText = t('modelCounts', { p1: imgCount, p2: vidCount, p3: audCount ? t('audioCountSuffix', { p1: audCount }) : '' });
      view.append(section(t('enabledModels'), models, h('div', { class: 'section-heading-cluster' }, h('p', { class: 'section-summary' }, summaryText), chips)));
      const available = h('div', { class: 'card available-models' });
      const enabled = new Set(d.models.map(m => m.id));
      const isDreamina = d.provider === 'dreamina', isMiniMax = d.provider === 'minimax';
      const remoteModels = isMiniMax ? s.probe?.models || [] : [];
      const remoteIds = new Set(remoteModels.map(model => model.id));
      const candidates = isDreamina ? (s.dreaminaCloudModels || provider.defaultModels) : isMiniMax ? [...(provider.builtinModels || provider.defaultModels), ...remoteModels] : provider.defaultModels;
      const candidateModels = candidates.filter((model, index) => candidates.findIndex(item => item.id === model.id) === index);
      const availableModels = candidateModels.filter(m => !enabled.has(m.id));
      const addAvailableModel = model => {
        if (d.models.some(item => item.id === model.id) || s.busy) return;
        if (d.models.length >= 100) { C.message(t('modelLimit'), 'error'); return; }
        d.models.push({ id: model.id, name: model.name || model.id, kind: model.kind }); C.touch(); C.render();
      };
      if (!availableModels.length) available.append(note(isDreamina ? t('dreaminaModelsLoaded') : t('localModelsLoaded')));
      for (const model of availableModels) {
        const addBtn = button('', () => addAvailableModel(model), { class: 'model-add-icon-btn', 'aria-label': t('addNamedModel', { p1: model.name || model.id }), title: t('addNamedModel', { p1: model.name || model.id }), disabled: s.busy || d.models.length >= 100 });
        addBtn.append(A.svgIcon('plus', 14));
        available.append(h('div', { class: 'available-model-row duty-available-row', onclick: e => { if (!e.target.closest('button')) addAvailableModel(model); } },
          addBtn,
          h('span', { class: 'model-kind-badge' }, A.kinds[model.kind] || model.kind),
          h('div', { class: 'available-row-content' }, h('span', { class: 'available-model-title' }, model.name || model.id), (model.name && model.name !== model.id) ? h('span', { class: 'available-model-id' }, ` (${model.id})`) : null),
          h('span', { class: 'available-model-cap' }, isMiniMax ? remoteIds.has(model.id) ? t('cloudSource') : t('builtinSource') : A.capabilityText(model))));
      }
      const discovery = h('div', { class: 'available-directory', 'data-discovery': '' });
      discovery.append(note(isMiniMax ? A.minimaxCatalogText(s.probe) : s.probe ? A.probeText(s.probe) : t('queryOnly')));
      if (s.probe && !isMiniMax) (s.probe.models || []).forEach(model => {
        const known = d.models.some(item => item.id === model.id);
        const resultAction = button(known ? t('added') : t('addModel'), () => addAvailableModel({ ...model, kind: provider.kinds.includes(model.kind) ? model.kind : provider.kinds[0] }), { disabled: s.busy || known || d.models.length >= 100 });
        discovery.append(h('div', { class: 'row' }, h('div', { class: 'row-copy' }, h('div', { class: 'row-title' }, model.name || model.id), h('p', {}, model.id)), resultAction));
      });
      available.append(discovery);
      const fetchBtn = isDreamina
        ? button('', async () => {
            s.dreaminaFetching = true; C.render();
            try {
              const cloudModels = await window.pluginBridge?.invoke?.('aimedia.dreamina.models');
              if (Array.isArray(cloudModels) && cloudModels.length) {
                s.dreaminaCloudModels = cloudModels;
                C.message(t('dreaminaModelsFetched', { p1: cloudModels.length }), 'success');
              } else {
                C.message(t('dreaminaModelsFailed'), 'error');
              }
            } catch (e) {
              C.message(e.message, 'error');
            } finally {
              s.dreaminaFetching = false; C.render();
            }
          }, { class: 'fetch-supplier-btn', 'aria-label': t('fetchCloud'), title: t('fetchDreaminaModels'), disabled: s.busy || s.dreaminaFetching })
        : button('', () => C.probe(isMiniMax ? 'models' : undefined), { 'data-probe': '', 'data-model-fetch': '', class: 'fetch-supplier-btn', disabled: !C.canProbe() });
      fetchBtn.append(A.svgIcon('download', 14), h('span', {}, isDreamina ? t('fetchCloud') : t('fetchProvider')));
      view.append(section(t('availableModels'), available, h('div', { class: 'section-actions' }, fetchBtn)));
      if (isMiniMax) {
        const voices = h('div', { class: 'card', 'data-voice-directory': '' }, note(A.minimaxCatalogText(s.probe, 'voices')), note(t('voiceHelp')));
        for (const voice of s.probe?.voices || []) voices.append(h('div', { class: 'row' },
          h('div', { class: 'row-copy' }, h('div', { class: 'row-title' }, voice.name || voice.id), h('p', {}, voice.id))));
        const fetchVoices = button('', () => C.probe('voices'), { 'data-voice-fetch': '', class: 'fetch-supplier-btn', disabled: !C.canProbe() });
        fetchVoices.append(A.svgIcon('download', 14), h('span', {}, t('fetchProvider')));
        view.append(section(t('cloudVoices'), voices, h('div', { class: 'section-actions' }, fetchVoices)));
      }
    }
    if (provider.kinds.includes('audio') && d.provider !== 'comfyui') {
      const audioCard = h('div', { class: 'duty-card' },
        d.provider !== 'minimax' && field(t('voiceId'), control(t('voiceId'), 'voice', { maxlength: 128 }), t('voiceIdHelp')),
        field(t('formatOptional'), control(t('format'), 'format', { maxlength: 64, placeholder: t('formatExample') })));
      view.append(section(t('audioOptions'), audioCard));
    }
    if (d.provider === 'comfyui') {
      const hiddenBrowseBtn = button(t('browse'), () => C.openResources(d), { 'data-browse': '', class: 'visually-hidden', disabled: !C.canProbe() });
      view.append(hiddenBrowseBtn);
    }
    return view;
  };
})();
