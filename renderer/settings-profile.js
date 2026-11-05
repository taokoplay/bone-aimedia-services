(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, field, input, picker, section, note } = A;
  const iconAssets = {
    dreamina: 'assets/models/jimeng.png',
    openai: 'assets/models/openai.png',
    minimax: 'assets/models/minimax.png',
    xiaomi: 'assets/models/xiaomi.png',
    comfyui: 'assets/models/comfyui.png',
    libtv: 'assets/models/default.png',
  };
  const iconText = { dreamina: '梦', openai: 'AI', minimax: 'M', xiaomi: '米', comfyui: 'C', libtv: 'L' };
  const providerIcon = provider => h('span', { class: `service-icon provider-${provider}`, 'aria-hidden': 'true' }, iconAssets[provider] ? h('img', { src: iconAssets[provider], alt: '' }) : iconText[provider] || '?');
  A.newProfile = provider => ({ id: A.id('profile'), name: '', provider: provider.id, enabled: true, baseUrl: provider.defaultBaseUrl,
    models: ['openai', 'dreamina'].includes(provider.id) ? [] : A.clone(provider.defaultModels), modelId: '', voice: provider.id === 'xiaomi' ? 'mimo_default' : '', format: '', cliPath: '', comfyUser: '', ...(provider.id === 'comfyui' ? { authKind: 'none', headerName: '' } : {}), workflow: null, bindings: [] });
  A.profileError = (draft, credential = { action: 'preserve' }) => {
    if (!draft.name.trim()) return '请填写配置名称。';
    if (draft.models.some(model => !model.id.trim() || !model.name.trim())) return '请填写每个模型的名称和 ID。';
    if (new Set(draft.models.map(model => model.id)).size !== draft.models.length) return '模型 ID 不可重复。';
    if (draft.modelId && !draft.models.some(model => model.id === draft.modelId)) return '当前默认模型已不在模型列表中，请明确重新选择。';
    if (draft.provider !== 'dreamina') {
      try { const url = new URL(draft.baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '请填写不含账号、密码或查询参数的服务地址。'; }
      catch { return '请填写完整的服务地址。'; }
    }
    if (draft.provider === 'comfyui') {
      if (draft.authKind === 'header' && (!(draft.headerName || '').match(/^(?:x-[a-z0-9-]+|authorization)$/i) || draft.headerName.length > 80)) return '请填写有效的认证 Header 名称，例如 X-API-Key。';
      if (['bearer', 'header'].includes(draft.authKind) && !(credential.action === 'replace' && credential.value) && !(credential.action === 'preserve' && draft.credentialConfigured)) return '请填写认证秘密。';
    }
    return null;
  };
  function providerPicker(C, providers, draft, disabled) {
    const s = C.state;
    const details = h('details', { class: 'provider-picker' });
    const current = providers.find(item => item.id === draft.provider) || s.data.catalog.find(item => item.id === draft.provider);
    const summary = h('summary', { role: 'button', 'aria-label': '供应商类型', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-disabled': String(disabled), tabindex: disabled ? -1 : 0 }, providerIcon(draft.provider), h('span', {}, current?.name || draft.provider));
    const list = h('ul', { class: 'provider-menu', role: 'listbox', 'aria-label': '供应商类型选项' });
    const optionButtons = [];
    for (const provider of providers) {
      const option = button('', async () => {
        details.open = false;
        if (provider.id === draft.provider || disabled || !providers.some(item => item.id === provider.id)) return;
        const token = s.epoch;
        if (!await A.confirm('更换供应商？', '将使用新供应商的模型目录与服务地址，并清除当前凭据。其他配置与默认项保持原样。', '更换并清除凭据') || token !== s.epoch) return;
        Object.assign(draft, A.newProfile(provider), { id: draft.id, name: draft.name, enabled: draft.enabled });
        s.credential = { action: 'clear' }; s.credentialCaution = true; s.probe = null; C.touch(); C.render();
      }, { role: 'option', 'aria-selected': String(provider.id === draft.provider), class: 'provider-option-row', 'aria-label': provider.name, disabled });
      option.append(providerIcon(provider.id), h('span', {}, provider.name), provider.id === draft.provider && h('strong', {}, '✓'));
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
      ? '正在查询本机登录态…'
      : isLogged
        ? `本机已登录 · 剩余额度 ${st.credit}`
        : (st?.message || '尚未登录本机即梦 CLI');
    const statusTone = isLogged ? 'status-logged' : 'status-unlogged';
    const header = h('div', { class: 'dreamina-panel-header' },
      h('div', { class: 'dreamina-panel-info' },
        h('div', { class: 'row-title' }, '即梦登录'),
        h('div', { class: `dreamina-status-badge ${statusTone}` }, statusText),
        h('p', { class: 'dreamina-desc' }, '即梦使用网页授权登录，登录态由本地即梦 CLI 保存在系统凭据库，本机所有即梦配置共用同一个账号。')),
      h('div', { class: 'dreamina-actions' },
        button('刷新状态', () => refreshDreamina(C, d.cliPath, true), { class: 'quiet', disabled: s.dreaminaBusy || s.busy }),
        isLogged
          ? button('退出登录', async () => {
              if (!await A.confirm('退出即梦？', '将清除本机即梦 CLI 登录态。', '确认退出')) return;
              s.dreaminaBusy = true; C.render();
              try { await window.pluginBridge?.invoke?.('aimedia.dreamina.logout', { cliPath: d.cliPath }); } catch {}
              await refreshDreamina(C, d.cliPath, true);
            }, { class: 'quiet danger', disabled: s.dreaminaBusy || s.busy })
          : null,
        button(isLogged ? '重新登录' : '登录即梦', async () => {
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
                  C.message('即梦登录成功！', 'success');
                  await refreshDreamina(C, d.cliPath, true);
                }
              }, 4000);
            } else {
              C.message(start?.raw || '启动登录失败，请检查 CLI 路径', 'error');
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
        h('p', { class: 'auth-tip' }, '请在浏览器打开授权页面，并确认或输入设备代码：'),
        h('div', { class: 'auth-code-row' },
          h('span', { class: 'user-code' }, dreaminaLoginSession.userCode || '已生成代码'),
          button('复制设备码', () => {
            navigator.clipboard.writeText(dreaminaLoginSession.userCode || '');
            C.message('设备代码已复制到剪贴板', 'success');
          }, { class: 'quiet' }),
          h('a', { href: dreaminaLoginSession.verificationUri, target: '_blank', class: 'auth-link' }, '打开授权页面 ↗')
        ),
        button('取消登录', () => {
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
    const providerDesc = d.provider === 'openai' ? '支持官方与第三方 OpenAI Images 接口；仅兼容聊天接口的服务不能用于生图。' : provider.description;
    const isComfy = d.provider === 'comfyui';
    const basic = h('div', { class: 'duty-card' });
    const providerPickField = field('供应商类型', providerPicker(C, providers, d, s.busy || C.tab.singleton), providerDesc);
    if (isComfy) {
      providerPickField.classList.add('visually-hidden');
    }
    basic.append(providerPickField);
    if (!isComfy) basic.append(field('供应商名称', control('配置名称', 'name', { maxlength: 128, placeholder: '例如：日常创作账号' })));
    if (isComfy) {
      const clearCredential = () => {
        s.credential = { action: 'clear' }; s.credentialCaution = true; d.credentialConfigured = false;
        const secret = document.querySelector('[aria-label="认证秘密"]');
        if (secret) { secret.value = ''; secret.placeholder = '输入认证秘密'; }
      };
      const authKinds = [
        { value: 'none', label: '无认证' },
        { value: 'bearer', label: 'Bearer Token' },
        { value: 'header', label: '自定义 Header' },
      ];
      const currentAuthKind = d.authKind || (d.credentialConfigured || s.credential?.value ? 'bearer' : 'none');
      const grid = h('div', { class: 'duty-conn-grid' },
        field('名称', control('配置名称', 'name', { maxlength: 128, placeholder: '我的 ComfyUI' })),
        field('服务地址', input('服务地址', d.baseUrl, value => {
          d.baseUrl = value; clearCredential(); C.touch();
        }, { disabled: s.busy, spellcheck: 'false', maxlength: 2048, placeholder: 'http://127.0.0.1:8188' })),
        field('ComfyUI 用户名（可选）', input('Comfy 用户', d.comfyUser, value => { d.comfyUser = value; clearCredential(); C.touch(); }, { disabled: s.busy, placeholder: '留空表示默认用户' })),
        field('认证方式', picker('认证方式', currentAuthKind, authKinds, value => {
          if (value === currentAuthKind) return;
          d.authKind = value; d.headerName = ''; clearCredential();
          C.touch();
          C.render();
        }, s.busy))
      );
      if (currentAuthKind === 'header') {
        grid.append(field('Header 名称', input('Header 名称', d.headerName || '', value => {
          d.headerName = value; clearCredential(); C.touch();
        }, { placeholder: 'X-API-Key', disabled: s.busy })));
      }
      if (currentAuthKind !== 'none') {
        const secret = input('认证秘密', s.credential?.value || '', value => {
          s.credential = value ? { action: 'replace', value } : { action: s.credentialCaution ? 'clear' : 'preserve' };
          C.touch();
        }, { type: 'password', autocomplete: 'new-password', placeholder: d.credentialConfigured ? '留空保留现有秘密' : '输入认证秘密', disabled: s.busy });
        grid.append(field('认证秘密', secret));
      }
      basic.append(grid);
    } else if (d.provider === 'dreamina') {
      basic.append(dreaminaLoginBlock(C, d));
      basic.append(field('CLI 路径（可选）', control('CLI 路径', 'cliPath', { placeholder: '例如：/Users/xutaoyu/.local/bin/dreamina' }), '留空则按 PATH 查找 dreamina；换路径不会切换账号，登录态属于本机 CLI。'));
    } else {
      const isHttp = /^http:\/\//i.test((d.baseUrl || '').trim());
      const urlNote = isHttp ? 'HTTP 会明文传输 API Key、提示词和参考图，请仅用于你信任的服务；优先使用 HTTPS。' : '';
      const urlInput = input('服务地址', d.baseUrl, value => {
        d.baseUrl = value; s.credential = { action: 'clear' }; s.credentialCaution = true; s.probe = null; C.touch();
        document.querySelector('[data-discovery]')?.replaceChildren(note('服务地址已更新，点击「从供应商获取」即可直接同步最新模型。'));
        const secret = document.querySelector('[aria-label="API Key"]'); if (secret) secret.value = '';
        const hint = document.getElementById('credential-hint'); if (hint) hint.textContent = '服务地址已修改，保存时将清除旧凭据。需要认证时请填写新密钥。';
      }, { disabled: s.busy, spellcheck: 'false', maxlength: 2048 });
      const urlField = field('服务地址', urlInput, '填写供应商提供的 API 地址，通常以 /v1 结尾；自定义路径按原样使用。');
      if (urlNote) urlField.append(h('p', { class: 'field-caution' }, urlNote));
      basic.append(urlField);
    }
    if (d.provider === 'libtv') basic.append(note('请在宿主 MCP 设置中添加 https://mcp.liblib.tv/mcp 并完成 OAuth 授权。本页仅维护一个入口。'));
    if (!['dreamina', 'libtv', 'comfyui'].includes(d.provider)) {
      let isShowing = false;
      const savedCredentialHint = s.legacyBackend ? '已配置；当前仅可查看。' : '已加密保存；留空保留。';
      const secret = input('API Key', s.credential.value || '', value => { s.credential = value ? { action: 'replace', value } : { action: s.credentialCaution ? 'clear' : 'preserve' }; if (d.provider === 'minimax') s.probe = null; C.touch(); const hint = document.getElementById('credential-hint'); if (hint) hint.textContent = value ? '凭据已填写，保存或查询时生效。' : d.credentialConfigured && !s.credentialCaution ? savedCredentialHint : '尚未配置凭据。'; }, { type: 'password', autocomplete: 'new-password', spellcheck: 'false', disabled: s.busy });
      const eyeIconSpan = h('span', { class: 'eye-icon-slot' }, A.svgIcon('eye', 16));
      const reveal = button('显示', () => {
        isShowing = !isShowing;
        secret.type = isShowing ? 'text' : 'password';
        reveal.textContent = isShowing ? '隐藏' : '显示';
        reveal.setAttribute('aria-label', isShowing ? '隐藏 API Key' : '显示 API Key');
        reveal.title = isShowing ? '隐藏 API Key' : '显示 API Key';
        eyeIconSpan.replaceChildren(A.svgIcon(isShowing ? 'eyeOff' : 'eye', 16));
        reveal.prepend(eyeIconSpan);
      }, { class: 'key-eye-btn', 'aria-label': '显示 API Key', title: '显示 API Key', disabled: s.busy });
      reveal.prepend(eyeIconSpan);
      const secretWrapper = h('div', { class: 'key-input-wrapper inline' }, secret, reveal);
      basic.append(field('API Key', h('div', {}, secretWrapper, h('p', { class: 'muted', id: 'credential-hint' }, s.credentialCaution ? '服务或地址已修改，旧凭据将清除；请按需填写新密钥。' : d.credentialConfigured ? savedCredentialHint : '尚未配置凭据。'), button('清除凭据', () => { s.credential = { action: 'clear' }; if (d.provider === 'minimax') s.probe = null; C.touch(); C.render(); }, { class: 'quiet', disabled: s.busy })), ''));
    }
    const toggleLabel = d.provider === 'comfyui' ? '启用连接' : '启用此配置';
    const toggleDesc = d.provider === 'comfyui' ? '关闭后该服务连接不可用于任务执行与资源同步' : '关闭后该配置的图片与视频模型都不会出现在画布与 agent 的可选列表中';
    const toggleField = field(toggleLabel, A.toggle('', d.enabled, value => changed('enabled', value, true), s.busy), toggleDesc);
    toggleField.classList.add('field-toggle');
    basic.append(toggleField);
    const view = h('div', { class: 'duty-editor' }, section(d.provider === 'comfyui' ? '编辑服务连接' : '基本信息', basic));
    if (d.provider === 'comfyui' && A.resourceBrowserView) {
      view.append(A.resourceBrowserView(C));
    }
    if (!['comfyui', 'libtv'].includes(d.provider)) {
      const filter = s.modelFilter || 'all';
      const imgCount = d.models.filter(m => m.kind === 'image').length;
      const vidCount = d.models.filter(m => m.kind === 'video').length;
      const audCount = d.models.filter(m => m.kind === 'audio').length;
      const filterOptions = [{ id: 'all', name: '全部', count: d.models.length }];
      if (provider.kinds.includes('image')) filterOptions.push({ id: 'image', name: '图片', count: imgCount });
      if (provider.kinds.includes('video')) filterOptions.push({ id: 'video', name: '视频', count: vidCount });
      if (provider.kinds.includes('audio')) filterOptions.push({ id: 'audio', name: '音频', count: audCount });
      const chips = h('div', { class: 'chips filter-capsules', 'aria-label': '模型类型筛选' }, filterOptions.map(opt => {
        const b = button('', () => { s.modelFilter = opt.id; C.render(); }, { 'aria-label': opt.name, 'aria-pressed': String(filter === opt.id), disabled: s.busy });
        b.append(h('span', {}, opt.name), h('span', { class: 'capsule-count' }, ` ${opt.count}`));
        return b;
      }));
      const models = h('div', { class: 'duty-model-list' });
      const choice = h('div', { id: 'model-choice' });
      choice.append(field('默认模型', picker('默认模型', d.modelId, [{ value: '', label: '未选择' }, ...d.models.map(m => ({ value: m.id, label: `${m.name || m.id} · ${A.kinds[m.kind]} (${m.id})` }))], value => changed('modelId', value, true), s.busy), '显示并保留全部类型的实际选择。'));
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
            h('span', { class: 'model-row-name' }, model.name || model.id || `模型 ${index + 1}`),
            (model.name && model.name !== model.id) ? h('span', { class: 'model-row-id' }, `(${model.id})`) : null,
            h('span', { class: 'model-row-capability' }, A.capabilityText(model))),
          h('div', { class: 'model-row-hidden-inputs' },
            input(`模型 ${index + 1} 名称`, model.name, value => set('name', value), { disabled: s.busy, maxlength: 256 }),
            input(`模型 ${index + 1} ID`, model.id, value => set('id', value), { disabled: s.busy, maxlength: 128, spellcheck: 'false' }),
            picker(`模型 ${index + 1} 类型`, model.kind, provider.kinds.map(k => ({ value: k, label: A.kinds[k] })), value => set('kind', value), s.busy)),
          button('', e => {
            if (e) { e.stopPropagation(); e.preventDefault(); }
            if (d.modelId && model.id && d.modelId === model.id) {
              C.message('请先更改默认模型，再移除此模型。', 'error');
              return;
            }
            const idx = d.models.indexOf(model);
            if (idx >= 0) d.models.splice(idx, 1);
            if (d.modelId && !d.models.some(m => m.id === d.modelId)) {
              d.modelId = '';
            }
            C.touch();
            C.render();
          }, { class: 'model-remove-btn', 'aria-label': `移除模型 ${model.id || index + 1}`, title: `移除模型 ${model.id || index + 1}`, disabled: s.busy }));
        row.querySelector('.model-remove-btn')?.append(A.svgIcon('x', 14));
        models.append(row);
      });
      if (!count) models.append(A.empty('暂无已启用模型', '从下方可用模型列表点击“＋”加入。'));
      models.append(h('div', { class: 'custom-model-bar' }, button('添加自定义模型', () => { d.models.push({ id: '', name: '', kind: filter === 'all' ? provider.kinds[0] : filter }); C.touch(); C.render(); }, { disabled: s.busy || d.models.length >= 100 })));
      const summaryText = `${imgCount} 个图片模型 · ${vidCount} 个视频模型${audCount ? ` · ${audCount} 个音频模型` : ''}`;
      view.append(section('已启用模型', models, h('div', { class: 'section-heading-cluster' }, h('p', { class: 'section-summary' }, summaryText), chips)));
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
        if (d.models.length >= 100) { C.message('最多启用 100 个模型。', 'error'); return; }
        d.models.push({ id: model.id, name: model.name || model.id, kind: model.kind }); C.touch(); C.render();
      };
      if (!availableModels.length) available.append(note(isDreamina ? '已加载全部即梦模型；可点击上方“从云端获取”刷新最新支持列表。' : '已加载全部本地模型；如供应商返回新模型，可通过“从供应商获取”加入。'));
      for (const model of availableModels) {
        const addBtn = button('', () => addAvailableModel(model), { class: 'model-add-icon-btn', 'aria-label': `添加模型 ${model.name || model.id}`, title: `添加模型 ${model.name || model.id}`, disabled: s.busy || d.models.length >= 100 });
        addBtn.append(A.svgIcon('plus', 14));
        available.append(h('div', { class: 'available-model-row duty-available-row', onclick: e => { if (!e.target.closest('button')) addAvailableModel(model); } },
          addBtn,
          h('span', { class: 'model-kind-badge' }, A.kinds[model.kind] || model.kind),
          h('div', { class: 'available-row-content' }, h('span', { class: 'available-model-title' }, model.name || model.id), (model.name && model.name !== model.id) ? h('span', { class: 'available-model-id' }, ` (${model.id})`) : null),
          h('span', { class: 'available-model-cap' }, isMiniMax ? remoteIds.has(model.id) ? '云端返回' : '内置目录' : A.capabilityText(model))));
      }
      const discovery = h('div', { class: 'available-directory', 'data-discovery': '' });
      discovery.append(note(isMiniMax ? A.minimaxCatalogText(s.probe) : s.probe ? A.probeText(s.probe) : '仅查询目录，不创建任务或生成媒体。'));
      if (s.probe && !isMiniMax) (s.probe.models || []).forEach(model => {
        const known = d.models.some(item => item.id === model.id);
        const resultAction = button(known ? '已添加' : '添加模型', () => addAvailableModel({ ...model, kind: provider.kinds.includes(model.kind) ? model.kind : provider.kinds[0] }), { disabled: s.busy || known || d.models.length >= 100 });
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
                C.message(`成功从即梦云端获取 ${cloudModels.length} 个最新模型！`, 'success');
              } else {
                C.message('未能获取到即梦模型列表', 'error');
              }
            } catch (e) {
              C.message(e.message, 'error');
            } finally {
              s.dreaminaFetching = false; C.render();
            }
          }, { class: 'fetch-supplier-btn', 'aria-label': '从云端获取', title: '从即梦云端获取支持模型', disabled: s.busy || s.dreaminaFetching })
        : button('', () => C.probe(isMiniMax ? 'models' : undefined), { 'data-probe': '', 'data-model-fetch': '', class: 'fetch-supplier-btn', disabled: !C.canProbe() });
      fetchBtn.append(A.svgIcon('download', 14), h('span', {}, isDreamina ? '从云端获取' : '从供应商获取'));
      view.append(section('可用模型', available, h('div', { class: 'section-actions' }, fetchBtn)));
      if (isMiniMax) {
        const voices = h('div', { class: 'card', 'data-voice-directory': '' }, note(A.minimaxCatalogText(s.probe, 'voices')), note('音色在生成时由用户或 Agent 指定。'));
        for (const voice of s.probe?.voices || []) voices.append(h('div', { class: 'row' },
          h('div', { class: 'row-copy' }, h('div', { class: 'row-title' }, voice.name || voice.id), h('p', {}, voice.id))));
        const fetchVoices = button('', () => C.probe('voices'), { 'data-voice-fetch': '', class: 'fetch-supplier-btn', disabled: !C.canProbe() });
        fetchVoices.append(A.svgIcon('download', 14), h('span', {}, '从供应商获取'));
        view.append(section('云端音色', voices, h('div', { class: 'section-actions' }, fetchVoices)));
      }
    }
    if (provider.kinds.includes('audio') && d.provider !== 'comfyui') {
      const audioCard = h('div', { class: 'duty-card' },
        d.provider !== 'minimax' && field('音色 ID', control('音色 ID', 'voice', { maxlength: 128 }), '音色 ID 用于语音合成。'),
        field('输出格式（可选）', control('输出格式', 'format', { maxlength: 64, placeholder: '例如：mp3' })));
      view.append(section('音频选项', audioCard));
    }
    if (d.provider === 'comfyui') {
      const hiddenBrowseBtn = button('浏览资源', () => C.openResources(d), { 'data-browse': '', class: 'visually-hidden', disabled: !C.canProbe() });
      view.append(hiddenBrowseBtn);
    }
    return view;
  };
})();
