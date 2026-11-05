/* Resource views. Navigation reads local snapshots; only explicit sync performs network I/O. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, picker, field, section, note } = A;
  function resourceErrorText(error, fallback) {
    const permissions = ['PERMISSION_DENIED', 'HOST_PERMISSION_DENIED', 'NETWORK_PERMISSION_DENIED', 'NET_PERMISSION_DENIED', 'CAPABILITY_DENIED', 'FORBIDDEN', 'APPROVAL_REQUIRED'];
    const messages = {
      WORKFLOW_NOT_FOUND: '该工作流已不存在，请刷新工作流列表后重试。',
      WORKFLOW_TOO_LARGE: '工作流超过 200 KiB 预览上限，未读取详情。',
      WORKFLOW_INVALID: '工作流内容未通过校验，可能包含敏感字段或无效结构。',
      RESOURCE_LIST_STALE: '目录记录已失效，请重新读取目录后再选择文件。',
      RESOURCE_UNSUPPORTED: '此服务不支持该资源接口；未获得新的结果。',
      AUTHENTICATION_REQUIRED: '服务拒绝认证，请检查该连接的认证设置。',
      CREDENTIAL_REQUIRED: '请先为该连接填写认证凭据并保存。',
      ENDPOINT_NOT_FOUND: '资源接口不存在，请检查服务地址和接口支持情况。',
      TIMEOUT: '资源读取超时，请稍后重试。',
      NETWORK_ERROR: '无法连接资源服务，请检查网络和服务状态。',
      REDIRECT_DISALLOWED: '资源请求被重定向，请检查服务地址。',
      INVALID_JSON: '服务返回的内容不是有效 JSON，无法读取详情。',
      INVALID_RESPONSE: '服务返回的数据未通过校验，未更新当前结果。',
      RESPONSE_TOO_LARGE: '资源响应超过 2 MiB 上限，未读取详情。',
      HTTP_ERROR: '服务返回错误，请稍后重试。',
    };
    const text = permissions.includes(error?.code) ? '未获网络访问权限，请在宿主检查授权后重试。' : messages[error?.code];
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
        r.error = error.code === 'CONFLICT' ? '配置已变化，请重新打开连接。' : local ? '本地快照读取失败，请检查存储后重试。' : channel === 'aimedia.readResourceWorkflow' ? resourceErrorText(error, '工作流读取或本地保存失败，请检查服务与存储后重试。') : '同步失败，已保留上次成功的本地快照。';
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
          r.error = resourceErrorText(result, result.status === 'unsupported' ? '此服务不支持该资源接口；未获得新的结果。' : '暂时无法读取远端资源，请检查权限、地址及服务状态后重试。');
        } else {
          r.results[resource] = { ...result, fresh: true, params };
          if (resource === 'model-folders') { r.folder = ''; delete r.results.models; }
          if (resource === 'workflows') { r.path = ''; delete r.results.workflow; }
        }
      } catch (error) {
        if (s.alive && epoch === s.epoch && request === ticket) {
          if (error.code === 'CONFLICT') { s.locked = true; Object.values(r.results).forEach(result => { result.fresh = false; }); C.render(); }
          r.error = error.code === 'CONFLICT' ? '配置版本已变化，请重新读取配置后再浏览。' : resourceErrorText(error, '读取未完成，请检查权限及服务状态后重试。');
        }
      } finally {
        if (request === ticket) { pending = false; if (s.alive) refresh(); }
      }
    }
    function feedback() {
      return h('div', {}, pending && h('p', { class: 'note', role: 'status' }, '正在读取…切换页面会忽略此次响应，读取结束前不可重复请求。'),
        r.error && h('div', { class: 'notice error', role: 'alert' }, r.error));
    }
    function results(resource, row, emptyText) {
      const result = r.results[resource];
      if (!result) return h('div', { class: 'card' }, A.empty('尚未读取', emptyText));
      const card = h('div', { class: 'card', 'data-resource': resource },
        note(`${result.fresh ? '手动读取快照' : '旧结果 · 非最新，请重新读取'} · ${result.checkedAt || '时间未知'} · 共 ${result.total} 项 · 当前 ${result.items.length} 项${result.truncated ? ' · 结果已截断' : ''}`));
      result.items.forEach(item => card.append(row(item, result.fresh)));
      if (!result.items.length) card.append(A.empty('没有返回条目', '此结果仅代表所选服务本次返回的数据。'));
      if (resource !== 'workflow') card.append(h('div', { class: 'pagination' },
        button('上一页', () => read(resource, { ...result.params, offset: Math.max(0, result.offset - result.limit) }), { disabled: blocked() || result.offset <= 0 }),
        h('span', { class: 'muted' }, result.total ? `${result.offset + 1}–${result.offset + result.items.length} / ${result.total}` : '0 / 0'),
        button('下一页', () => read(resource, { ...result.params, offset: result.offset + result.limit }), { disabled: blocked() || result.offset + result.limit >= result.total || resource === 'history' && result.offset + result.limit >= 100 })));
      return card;
    }
    const row = (title, text, action) => h('div', { class: 'row' }, h('div', { class: 'row-copy' }, h('div', { class: 'row-title' }, title), text && h('p', {}, text)), action);
    const loadButton = (resource, label, params = {}, disabled = false) => button(r.results[resource] ? `刷新${label}` : `读取${label}`, () => read(resource, params), { disabled: blocked() || disabled });
    function resourceTabs() {
      const entries = [{ id: 'models', name: '模型' }, { id: 'workflows', name: '远端工作流' }];
      const change = id => { const profile = r.profileId; select(profile); r.tab = id; C.render(); document.getElementById(`resource-${id}`)?.focus(); };
      return h('nav', { class: 'tabs subtabs', role: 'tablist', 'aria-label': '远端资源分类' }, entries.map((entry, index) => {
        const control = button(entry.name, () => change(entry.id), { id: `resource-${entry.id}`, role: 'tab', 'aria-selected': String(r.tab === entry.id), 'aria-controls': 'resource-panel', tabindex: r.tab === entry.id ? 0 : -1 });
        control.addEventListener('keydown', event => {
          const next = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 1 - index : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : -1;
          if (next >= 0) { event.preventDefault(); change(entries[next].id); }
        }); return control;
      }));
    }
    function resourceView() {
      const view = h('div', {}, h('p', { class: 'description' }, `${enabled()?.name || '连接不可用'} · 只读浏览，进入页面不会访问网络。`), resourceTabs());
      const panel = h('div', { id: 'resource-panel', role: 'tabpanel', 'aria-labelledby': `resource-${r.tab}`, 'aria-busy': String(pending) }, feedback());
      if (r.tab === 'models') {
        panel.append(section('模型文件夹', results('model-folders', item => row(item.name), '先手动读取文件夹，再选择并读取模型文件。'), loadButton('model-folders', '文件夹')));
        const folders = r.results['model-folders'];
        if (folders) panel.append(section('模型文件', h('div', {}, h('div', { class: 'card' }, field('文件夹', picker('模型文件夹', r.folder,
          [{ value: '', label: '请选择文件夹' }, ...folders.items.map(item => ({ value: item.name, label: item.name }))], value => { r.folder = value; delete r.results.models; r.error = null; C.render(); }, blocked() || !folders.fresh))),
          results('models', item => row(item.name), '选择文件夹后点击读取模型文件。')),
          loadButton('models', '模型文件', { folder: r.folder }, !r.folder || !folders.fresh)));
      } else {
        panel.append(section('远端工作流', results('workflows', (item, current) => row(item.path,
          `${item.size ?? '未知'} 字节 · 修改 ${item.modified ?? '未知'} · 创建 ${item.created ?? '未知'}`,
          button('查看详情', () => { r.path = item.path; delete r.results.workflow; void read('workflow', { path: item.path }); }, { 'aria-label': `查看详情 ${item.path}`, disabled: blocked() || !current })),
          '手动读取远端工作流列表，再按路径查看详情。'), loadButton('workflows', '工作流')));
        const detail = r.results.workflow;
        if (detail) panel.append(section('工作流详情', h('div', { class: 'card' }, note(`${r.path} · ${detail.format === 'api' ? 'API 格式' : detail.format === 'canvas' ? '画布格式' : '未知格式'}${detail.fresh ? '' : ' · 旧结果，非最新'}`),
          detail.format !== 'api' && note('仅供只读查看，不自动转换画布格式；请从 ComfyUI 导出 API 格式后导入。'),
          h('details', { class: 'definition' }, h('summary', {}, '查看定义（只读）'), h('pre', { class: 'code' }, JSON.stringify(detail.definition, null, 2))),
          h('div', { class: 'block' }, button('导入本地工作流草稿', () => C.importRemote(detail.definition, r.path, r.profileId), { disabled: blocked() || !detail.fresh || detail.format !== 'api' || !detail.importable || s.data.workflows.length >= 64 }),
            note('仅创建本地草稿，需明确保存；不会修改远端。')))));
      }
      view.append(panel); return view;
    }
    function activityView(screen) {
      const history = screen === 'records', resource = history ? 'history' : 'queue';
      const connections = s.data.profiles.filter(p => p.provider === 'comfyui' && p.enabled);
      const title = history ? '本插件生成记录' : '本插件任务队列';
      return h('div', {}, h('div', { class: 'heading' }, h('h2', {}, title)), h('div', { class: 'card' }, A.empty('尚未接入生成执行器', history ? '当前没有本插件生成记录。' : '当前没有本插件提交的任务；不提供取消或重试操作。')),
        section(history ? '远端历史记录' : '远端队列', h('div', {}, h('p', { class: 'description' }, history ? '所选 ComfyUI 服务的历史记录（可能含其他客户端任务，不代表本插件生成）' : '所选 ComfyUI 服务的队列（可能含其他客户端任务，不代表本插件任务），仅供只读查看。'),
          h('div', { class: 'card' }, field('ComfyUI 连接', picker('远端 ComfyUI 连接', r.profileId, [{ value: null, label: '请选择已保存且启用的连接' }, ...connections.map(p => ({ value: p.id, label: p.name }))], id => { select(id); C.render(); }, s.busy), connections.length ? '切换连接会清除结果；不会自动读取。' : '请先在配置 → ComfyUI 中保存并启用一个连接。')),
          feedback(), results(resource, item => row(item.promptId, history ? `状态：${({ success: '成功', error: '错误', unknown: '未知' })[item.status] || '未知'} · 完成：${item.completed === true ? '是' : item.completed === false ? '否' : '未知'} · 输出 ${item.outputCount} 项` : `${item.state === 'running' ? '运行中' : '等待中'} · 序号 ${item.number}`), '选择连接后手动读取。只显示任务元数据，不显示提示词或输出内容。')),
          loadButton(resource, history ? '远端记录' : '远端队列')));
    }
    function inlineBrowserView(C) {
      const d = s.draft;
      if (!d || d.provider !== 'comfyui') return null;
      if (r.profileId !== d.id) select(d.id);
      const viewState = r;
      const isSaved = s.data.profiles.some(p => p.id === d.id);
      const isLocked = !isSaved || s.dirty || s.isNew || !d.enabled;
      const container = h('div', { class: 'duty-resource-snapshot-section' }, h('h3', { class: 'duty-snapshot-title' }, '资源快照'));
      const card = h('div', { class: 'duty-card duty-snapshot-card' });
      const testButton = button('', () => C.probe(), { class: 'duty-test-btn', disabled: isLocked || blocked() || !C.canProbe(), 'aria-label': '测试连接', title: '测试连通性' });
      testButton.append(A.svgIcon('testTube', 14), h('span', {}, s.busy ? '正在测试…' : '测试连接'));
      card.append(h('div', { class: 'duty-snapshot-top' },
        h('div', { class: 'duty-snapshot-header-left' }, h('span', { class: 'duty-snapshot-conn-name' }, d.name || '服务连接'),
          s.probe?.connectionStatus === 'connected' ? h('span', { class: 'duty-probe-status' }, '连接正常 · 系统状态可访问') : null), testButton));
      container.append(card);
      updateInline = null;
      if (isLocked) {
        card.append(h('div', { class: 'duty-snapshot-locked-notice' }, note(!isSaved ? '连接尚未保存。保存后才能读取该连接的资源。' : s.dirty ? '连接设置已修改。保存后才能读取该连接的资源。' : '请先启用此服务连接以查看资源快照。')));
        return container;
      }

      // Keep the mounted editor, controls and directory navigation in place.
      // Request transitions only paint this view's content and control state.
      const tabs = [{ id: 'models', label: '模型' }, { id: 'workflows', label: '工作流' }].map(entry =>
        button(entry.label, () => { if (r.tab !== entry.id) { r.tab = entry.id; refresh(); } }, { class: 'duty-capsule', 'data-resource-tab': entry.id }));
      const syncButton = button('', () => snapshotRequest('aimedia.syncResources', { resource: r.tab }), { class: 'duty-sync-btn' });
      card.append(h('div', { class: 'duty-snapshot-filter-row' }, h('div', { class: 'duty-nav-capsules' }, tabs), h('div', { class: 'duty-snapshot-refresh-group' }, syncButton)));
      const snapshotMeta = h('p', { class: 'note', 'data-local-snapshot': '' });
      const feedbackSlot = h('div');
      const content = h('div');
      card.append(snapshotMeta, feedbackSlot, content);
      const folderList = h('nav', { class: 'duty-snapshot-folders', 'aria-label': '模型目录' });
      const fileList = h('div', { class: 'duty-snapshot-files' });
      const modelLayout = h('div', { class: 'duty-snapshot-body duty-model-snapshot-layout' }, folderList, fileList);
      const workflowList = h('div', { class: 'duty-snapshot-files full-width' });
      let renderedFolders;
      function paint() {
        testButton.disabled = blocked() || !C.canProbe();
        syncButton.disabled = blocked();
        syncButton.replaceChildren(A.svgIcon('search', 13), h('span', {}, r.tab === 'models' ? '同步模型' : '同步工作流'));
        const catalog = r.catalog?.[r.tab];
        snapshotMeta.textContent = r.localLoading ? '正在读取本地快照…' : catalog ? `本地快照 · 上次同步：${new Date(catalog.checkedAt).toLocaleString()}${pending ? ' · 正在更新…' : ''}` : pending ? '正在同步资源并保存到本地…' : '暂无本地快照，点击同步获取。';
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
            }, { class: 'duty-folder-btn', 'data-folder': folder.name })) : [h('p', { class: 'empty-text' }, pending ? '正在读取目录…' : folders ? '暂无模型目录' : '点击「同步模型」获取')]));
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
            h('span', { class: 'file-name' }, file.name), h('span', { class: 'file-badge' }, '已发现')))
            : [h('div', { class: 'empty-text' }, models ? '该目录下无模型文件' : pending && r.folder ? '正在读取模型文件…' : r.error ? '读取失败，请重试。' : '选择左侧目录查看模型')]));
        } else {
          if (content.firstChild !== workflowList) content.replaceChildren(workflowList);
          const workflows = r.results.workflows;
          workflowList.replaceChildren(...(workflows?.items.length ? workflows.items.map(item => h('div', { class: 'duty-snapshot-file-row' },
            h('div', { class: 'file-info' }, h('span', { class: 'file-name' }, item.path), h('span', { class: 'file-sub' }, `${item.size ?? 0} 字节 · 修改 ${item.modified || ''}`)),
            button('导入', async () => {
              if (blocked() || !fresh('workflows')) return;
              r.path = item.path; delete r.results.workflow;
              await snapshotRequest('aimedia.readResourceWorkflow', { path: item.path });
              const detail = r.results.workflow;
              if (s.draft === d && r === viewState && r.tab === 'workflows' && detail?.fresh && detail.params.path === item.path && detail.importable && detail.format === 'api') C.importRemote(detail.definition, item.path, d.id);
            }, { class: 'quiet', disabled: blocked() || !fresh('workflows') })))
            : [h('div', { class: 'empty-text' }, pending ? '正在读取工作流…' : workflows ? '暂无远端工作流' : '点击「同步工作流」获取')]));
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
