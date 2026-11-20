/* Resource views. Navigation reads local snapshots; only explicit sync performs network I/O. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const t = A.i18n.scope('remote');
  const { h, button, picker, field, section, note } = A;
  function resourceErrorText(error, fallback) {
    const permissions = ['PERMISSION_DENIED', 'HOST_PERMISSION_DENIED', 'NETWORK_PERMISSION_DENIED', 'NET_PERMISSION_DENIED', 'CAPABILITY_DENIED', 'FORBIDDEN', 'APPROVAL_REQUIRED'];
    const messages = {
      WORKFLOW_NOT_FOUND: t('workflowMissing'),
      WORKFLOW_TOO_LARGE: t('workflowTooLarge'),
      WORKFLOW_INVALID: t('workflowInvalid'),
      RESOURCE_LIST_STALE: t('staleCatalog'),
      RESOURCE_UNSUPPORTED: t('unsupported'),
      AUTHENTICATION_REQUIRED: t('authentication'),
      CREDENTIAL_REQUIRED: t('credentialRequired'),
      ENDPOINT_NOT_FOUND: t('endpointMissing'),
      TIMEOUT: t('timeout'),
      NETWORK_ERROR: t('network'),
      REDIRECT_DISALLOWED: t('redirect'),
      INVALID_JSON: t('invalidJson'),
      INVALID_RESPONSE: t('invalidResponse'),
      RESPONSE_TOO_LARGE: t('responseTooLarge'),
      HTTP_ERROR: t('httpError'),
    };
    const text = permissions.includes(error?.code) ? t('permission') : messages[error?.code];
    const status = Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? `（HTTP ${error.httpStatus}）` : '';
    return text ? text + status : fallback;
  }
  A.remoteController = C => {
    const s = C.state;
    let ticket = 0, pending = false, updateInline = null;
    let r;
    const reset = () => { ticket++; pending = false; updateInline = null; r = { profileId: null, tab: 'models', folder: '', path: '', results: {}, catalog: null, localLoading: false, error: null }; };
    reset();
    const select = id => { reset(); r.profileId = id; };
    const enabled = () => s.data.profiles.find(p => p.id === r.profileId && p.provider === 'comfyui' && p.enabled);
    const blocked = () => pending || s.busy || s.locked || !enabled() || s.draft?.provider === 'comfyui' && (s.dirty || s.isNew);
    const fresh = resource => r.results[resource]?.fresh === true;
    function refresh() {
      if (!updateInline?.()) C.render();
    }
    function localResult(items, checkedAt, params = {}) {
      return { items, checkedAt, total: items.length, offset: 0, limit: items.length, truncated: false, fresh: true, source: 'local', params };
    }
    function selectLocalFolder(name) {
      const folder = r.catalog?.models?.folders.find(item => item.name === name);
      if (!folder) return;
      r.folder = name; r.error = null;
      r.results.models = localResult(folder.items, r.catalog.models.checkedAt, { folder: name });
    }
    function applySnapshot(snapshot) {
      r.catalog = snapshot;
      if (snapshot.models) {
        r.results['model-folders'] = localResult(snapshot.models.folders.map(item => ({ name: item.name })), snapshot.models.checkedAt);
        const folder = snapshot.models.folders.find(item => item.name === r.folder)?.name || snapshot.models.folders[0]?.name;
        delete r.results.models; r.folder = '';
        if (folder) selectLocalFolder(folder);
      } else { delete r.results['model-folders']; delete r.results.models; r.folder = ''; }
      if (snapshot.workflows) r.results.workflows = localResult(snapshot.workflows.items, snapshot.workflows.checkedAt);
      else delete r.results.workflows;
      delete r.results.workflow;
    }
    async function snapshotRequest(channel, extra = {}) {
      if (blocked()) return;
      const epoch = s.epoch, revision = s.data.revision, id = r.profileId, request = ++ticket;
      const current = () => s.alive && epoch === s.epoch && request === ticket && revision === s.data.revision && id === r.profileId;
      const local = channel === 'aimedia.resourceSnapshot';
      pending = true; r.localLoading = local; r.error = null; refresh();
      try {
        const result = await C.invoke(channel, { profileId: id, expectedRevision: revision, ...extra });
        if (!current()) return;
        if (result.profileId !== id || result.revision !== revision) throw new Error('Mismatched snapshot');
        if (channel === 'aimedia.readResourceWorkflow') r.results.workflow = { ...result, fresh: true, params: { path: extra.path } };
        else applySnapshot(result);
      } catch (error) {
        if (!current()) return;
        if (error.code === 'CONFLICT') { s.locked = true; C.render(); }
        r.error = error.code === 'CONFLICT' ? t('configurationChanged') : local ? t('snapshotFailed') : channel === 'aimedia.readResourceWorkflow' ? resourceErrorText(error, t('workflowReadFailed')) : t('syncFailed');
      } finally {
        if (request === ticket) { pending = false; r.localLoading = false; if (s.alive) refresh(); }
      }
    }
    const loadSnapshot = () => snapshotRequest('aimedia.resourceSnapshot');
    async function read(resource, params = {}) {
      if (blocked()) return;
      if (resource === 'models' && (!fresh('model-folders') || !r.folder)) return;
      if (resource === 'workflow' && (!fresh('workflows') || !r.path)) return;
      const epoch = s.epoch, revision = s.data.revision, id = r.profileId, request = ++ticket;
      const previous = r.results[resource];
      if (previous) previous.fresh = false;
      if (resource === 'model-folders' && r.results.models) r.results.models.fresh = false;
      if (resource === 'workflows' && r.results.workflow) r.results.workflow.fresh = false;
      pending = true; r.error = null; refresh();
      try {
        const result = await C.invoke('aimedia.browse', { profileId: id, expectedRevision: revision, resource, offset: 0, limit: 50, ...params });
        if (!s.alive || epoch !== s.epoch || request !== ticket || revision !== s.data.revision || id !== r.profileId) return;
        if (result.profileId !== id || result.resource !== resource) throw new Error('Mismatched response');
        if (result.status !== 'ok') {
          r.error = resourceErrorText(result, result.status === 'unsupported' ? t('unsupported') : t('readUnavailable'));
        } else {
          r.results[resource] = { ...result, fresh: true, params };
          if (resource === 'model-folders') { r.folder = ''; delete r.results.models; }
          if (resource === 'workflows') { r.path = ''; delete r.results.workflow; }
        }
      } catch (error) {
        if (s.alive && epoch === s.epoch && request === ticket) {
          if (error.code === 'CONFLICT') { s.locked = true; Object.values(r.results).forEach(result => { result.fresh = false; }); C.render(); }
          r.error = error.code === 'CONFLICT' ? t('revisionChanged') : resourceErrorText(error, t('readFailed'));
        }
      } finally {
        if (request === ticket) { pending = false; if (s.alive) refresh(); }
      }
    }
    function feedback() {
      return h('div', {}, pending && h('p', { class: 'note', role: 'status' }, t('reading')),
        r.error && h('div', { class: 'notice error', role: 'alert' }, r.error));
    }
    function results(resource, row, emptyText) {
      const result = r.results[resource];
      if (!result) return h('div', { class: 'card' }, A.empty(t('notRead'), emptyText));
      const card = h('div', { class: 'card', 'data-resource': resource },
        note(t('resultSummary', { p1: result.fresh ? t('manualSnapshot') : t('staleResult'), p2: result.checkedAt || t('unknownTime'), p3: result.total, p4: result.items.length, p5: result.truncated ? t('truncatedSuffix') : '' })));
      result.items.forEach(item => card.append(row(item, result.fresh)));
      if (!result.items.length) card.append(A.empty(t('noEntries'), t('resultHelp')));
      if (resource !== 'workflow') card.append(h('div', { class: 'pagination' },
        button(t('previous'), () => read(resource, { ...result.params, offset: Math.max(0, result.offset - result.limit) }), { disabled: blocked() || result.offset <= 0 }),
        h('span', { class: 'muted' }, result.total ? `${result.offset + 1}–${result.offset + result.items.length} / ${result.total}` : '0 / 0'),
        button(t('next'), () => read(resource, { ...result.params, offset: result.offset + result.limit }), { disabled: blocked() || result.offset + result.limit >= result.total || resource === 'history' && result.offset + result.limit >= 100 })));
      return card;
    }
    const row = (title, text, action) => h('div', { class: 'row' }, h('div', { class: 'row-copy' }, h('div', { class: 'row-title' }, title), text && h('p', {}, text)), action);
    const loadButton = (resource, label, params = {}, disabled = false) => button(r.results[resource] ? t('refreshResource', { p1: label }) : t('readResource', { p1: label }), () => read(resource, params), { disabled: blocked() || disabled });
    function resourceTabs() {
      const entries = [{ id: 'models', name: t('models') }, { id: 'workflows', name: t('remoteWorkflows') }];
      const change = id => { const profile = r.profileId; select(profile); r.tab = id; C.render(); document.getElementById(`resource-${id}`)?.focus(); };
      return h('nav', { class: 'tabs subtabs', role: 'tablist', 'aria-label': t('categories') }, entries.map((entry, index) => {
        const control = button(entry.name, () => change(entry.id), { id: `resource-${entry.id}`, role: 'tab', 'aria-selected': String(r.tab === entry.id), 'aria-controls': 'resource-panel', tabindex: r.tab === entry.id ? 0 : -1 });
        control.addEventListener('keydown', event => {
          const next = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 1 - index : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : -1;
          if (next >= 0) { event.preventDefault(); change(entries[next].id); }
        }); return control;
      }));
    }
    function resourceView() {
      const view = h('div', {}, h('p', { class: 'description' }, t('browseDescription', { p1: enabled()?.name || t('connectionUnavailable') })), resourceTabs());
      const panel = h('div', { id: 'resource-panel', role: 'tabpanel', 'aria-labelledby': `resource-${r.tab}`, 'aria-busy': String(pending) }, feedback());
      if (r.tab === 'models') {
        panel.append(section(t('modelFolders'), results('model-folders', item => row(item.name), t('folderHelp')), loadButton('model-folders', t('folder'))));
        const folders = r.results['model-folders'];
        if (folders) panel.append(section(t('modelFiles'), h('div', {}, h('div', { class: 'card' }, field(t('folder'), picker(t('modelFolders'), r.folder,
          [{ value: '', label: t('selectFolder') }, ...folders.items.map(item => ({ value: item.name, label: item.name }))], value => { r.folder = value; delete r.results.models; r.error = null; C.render(); }, blocked() || !folders.fresh))),
          results('models', item => row(item.name), t('modelFilesHelp'))),
          loadButton('models', t('modelFiles'), { folder: r.folder }, !r.folder || !folders.fresh)));
      } else {
        panel.append(section(t('remoteWorkflows'), results('workflows', (item, current) => row(item.path,
          t('fileMetadata', { p1: item.size ?? t('unknown'), p2: item.modified ?? t('unknown'), p3: item.created ?? t('unknown') }),
          button(t('details'), () => { r.path = item.path; delete r.results.workflow; void read('workflow', { path: item.path }); }, { 'aria-label': t('fileDetails', { p1: item.path }), disabled: blocked() || !current })),
          t('remoteWorkflowHelp')), loadButton('workflows', t('workflows'))));
        const detail = r.results.workflow;
        if (detail) panel.append(section(t('workflowDetails'), h('div', { class: 'card' }, note(`${r.path} · ${detail.format === 'api' ? t('apiFormat') : detail.format === 'canvas' ? t('canvasFormat') : t('unknownFormat')}${detail.fresh ? '' : t('staleSuffix')}`),
          detail.format !== 'api' && note(t('canvasHelp')),
          h('details', { class: 'definition' }, h('summary', {}, t('viewDefinition')), h('pre', { class: 'code' }, JSON.stringify(detail.definition, null, 2))),
          h('div', { class: 'block' }, button(t('importDraft'), () => C.importRemote(detail.definition, r.path, r.profileId, detail.contentSha256), { disabled: blocked() || !detail.fresh || detail.format !== 'api' || !detail.importable || s.data.workflows.length >= 64 }),
            note(t('draftHelp'))))));
      }
      view.append(panel); return view;
    }
    function activityView(screen) {
      const history = screen === 'records', resource = history ? 'history' : 'queue';
      const connections = s.data.profiles.filter(p => p.provider === 'comfyui' && p.enabled);
      const title = history ? t('pluginRecords') : t('pluginQueue');
      return h('div', {}, h('div', { class: 'heading' }, h('h2', {}, title)), h('div', { class: 'card' }, A.empty(t('executorUnavailable'), history ? t('noPluginRecords') : t('noPluginTasks'))),
        section(history ? t('remoteHistory') : t('remoteQueue'), h('div', {}, h('p', { class: 'description' }, history ? t('historyHelp') : t('queueHelp')),
          h('div', { class: 'card' }, field(t('comfyConnection'), picker(t('remoteConnection'), r.profileId, [{ value: null, label: t('selectConnection') }, ...connections.map(p => ({ value: p.id, label: p.name }))], id => { select(id); C.render(); }, s.busy), connections.length ? t('switchConnectionHelp') : t('connectionRequired'))),
          feedback(), results(resource, item => row(item.promptId, history ? t('historySummary', { p1: ({ success: t('success'), error: t('error'), unknown: t('unknown') })[item.status] || t('unknown'), p2: item.completed === true ? t('yes') : item.completed === false ? t('no') : t('unknown'), p3: item.outputCount }) : t('queueSummary', { p1: item.state === 'running' ? t('running') : t('waiting'), p2: item.number })), t('activityHelp'))),
          loadButton(resource, history ? t('remoteRecords') : t('remoteQueue'))));
    }
    function inlineBrowserView(C) {
      const d = s.draft;
      if (!d || d.provider !== 'comfyui') return null;
      if (r.profileId !== d.id) select(d.id);
      const viewState = r;
      const isSaved = s.data.profiles.some(p => p.id === d.id);
      const isLocked = !isSaved || s.dirty || s.isNew || !d.enabled;
      const container = h('div', { class: 'duty-resource-snapshot-section' }, h('h3', { class: 'duty-snapshot-title' }, t('snapshot')));
      const card = h('div', { class: 'duty-card duty-snapshot-card' });
      const testButton = button('', () => C.probe(), { class: 'duty-test-btn', disabled: isLocked || blocked() || !C.canProbe(), 'aria-label': t('testConnection'), title: t('testConnectivity') });
      testButton.append(A.svgIcon('testTube', 14), h('span', {}, s.busy ? t('testing') : t('testConnection')));
      card.append(h('div', { class: 'duty-snapshot-top' },
        h('div', { class: 'duty-snapshot-header-left' }, h('span', { class: 'duty-snapshot-conn-name' }, d.name || t('serviceConnection')),
          s.probe?.connectionStatus === 'connected' ? h('span', { class: 'duty-probe-status' }, t('connected')) : null), testButton));
      container.append(card);
      updateInline = null;
      if (isLocked) {
        card.append(h('div', { class: 'duty-snapshot-locked-notice' }, note(!isSaved ? t('saveConnectionFirst') : s.dirty ? t('saveChangesFirst') : t('enableConnectionFirst'))));
        return container;
      }

      // Keep the mounted editor, controls and directory navigation in place.
      // Request transitions only paint this view's content and control state.
      const tabs = [{ id: 'models', label: t('models') }, { id: 'workflows', label: t('workflows') }].map(entry =>
        button(entry.label, () => { if (r.tab !== entry.id) { r.tab = entry.id; refresh(); } }, { class: 'duty-capsule', 'data-resource-tab': entry.id }));
      const syncButton = button('', () => snapshotRequest('aimedia.syncResources', { resource: r.tab }), { class: 'duty-sync-btn' });
      card.append(h('div', { class: 'duty-snapshot-filter-row' }, h('div', { class: 'duty-nav-capsules' }, tabs), h('div', { class: 'duty-snapshot-refresh-group' }, syncButton)));
      const snapshotMeta = h('p', { class: 'note', 'data-local-snapshot': '' });
      const feedbackSlot = h('div');
      const content = h('div');
      card.append(snapshotMeta, feedbackSlot, content);
      const folderList = h('nav', { class: 'duty-snapshot-folders', 'aria-label': t('modelCatalog') });
      const fileList = h('div', { class: 'duty-snapshot-files' });
      const modelLayout = h('div', { class: 'duty-snapshot-body duty-model-snapshot-layout' }, folderList, fileList);
      const workflowList = h('div', { class: 'duty-snapshot-files full-width' });
      let renderedFolders;
      function paint() {
        testButton.disabled = blocked() || !C.canProbe();
        syncButton.disabled = blocked();
        syncButton.replaceChildren(A.svgIcon('search', 13), h('span', {}, r.tab === 'models' ? t('syncModels') : t('syncWorkflows')));
        const catalog = r.catalog?.[r.tab];
        snapshotMeta.textContent = r.localLoading ? t('readingSnapshot') : catalog ? t('lastSynced', { p1: new Date(catalog.checkedAt).toLocaleString(A.i18n.locale), p2: pending ? t('updatingSuffix') : '' }) : pending ? t('syncing') : t('noSnapshot');
        for (const tab of tabs) {
          const active = tab.dataset.resourceTab === r.tab;
          tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
        }
        feedbackSlot.replaceChildren(...(r.error ? [feedback()] : []));
        content.setAttribute('aria-busy', String(pending));
        if (r.tab === 'models') {
          if (content.firstChild !== modelLayout) content.replaceChildren(modelLayout);
          const folders = r.results['model-folders'];
          if (folders !== renderedFolders || !folders) {
            renderedFolders = folders;
            folderList.replaceChildren(...(folders?.items.length ? folders.items.map(folder => button(folder.name, () => {
              if (blocked() || !fresh('model-folders') || r.folder === folder.name && fresh('models')) return;
              selectLocalFolder(folder.name); fileList.scrollTop = 0; refresh();
            }, { class: 'duty-folder-btn', 'data-folder': folder.name })) : [h('p', { class: 'empty-text' }, pending ? t('readingCatalog') : folders ? t('noCatalog') : t('syncModelsHelp'))]));
          }
          for (const control of folderList.querySelectorAll('[data-folder]')) {
            const active = control.dataset.folder === r.folder;
            control.classList.toggle('active', active);
            control.setAttribute('aria-current', String(active));
            // aria-disabled keeps the clicked directory focused while loading.
            control.setAttribute('aria-disabled', String(blocked() || !fresh('model-folders')));
          }
          const models = r.results.models;
          fileList.replaceChildren(...(models?.items.length ? models.items.map(file => h('div', { class: 'duty-snapshot-file-row' },
            h('span', { class: 'file-name' }, file.name), h('span', { class: 'file-badge' }, t('found'))))
            : [h('div', { class: 'empty-text' }, models ? t('noModelFiles') : pending && r.folder ? t('readingModels') : r.error ? t('readRetry') : t('selectFolderHelp'))]));
        } else {
          if (content.firstChild !== workflowList) content.replaceChildren(workflowList);
          const workflows = r.results.workflows;
          workflowList.replaceChildren(...(workflows?.items.length ? workflows.items.map(item => h('div', { class: 'duty-snapshot-file-row' },
            h('div', { class: 'file-info' }, h('span', { class: 'file-name' }, item.path), h('span', { class: 'file-sub' }, t('workflowMetadata', { p1: item.size ?? 0, p2: item.modified || '' }))),
            button(t('import'), async () => {
              if (blocked() || !fresh('workflows')) return;
              r.path = item.path; delete r.results.workflow;
              await snapshotRequest('aimedia.readResourceWorkflow', { path: item.path });
              const detail = r.results.workflow;
              if (s.draft === d && r === viewState && r.tab === 'workflows' && detail?.fresh && detail.params.path === item.path && detail.importable && detail.format === 'api') C.importRemote(detail.definition, item.path, d.id, detail.contentSha256);
            }, { class: 'quiet', disabled: blocked() || !fresh('workflows') })))
            : [h('div', { class: 'empty-text' }, pending ? t('readingWorkflows') : workflows ? t('noWorkflows') : t('syncWorkflowsHelp'))]));
        }
      }
      paint();
      updateInline = () => {
        if (!container.isConnected || s.draft !== d || r !== viewState) return false;
        paint(); return true;
      };
      return container;
    }
    A.resourceBrowserView = inlineBrowserView;
    return { reset, select, resourceView, activityView, inlineBrowserView, loadSnapshot };
  };
})();
