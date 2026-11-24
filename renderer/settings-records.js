/* Read-only local records. Stable rows and a native dialog preserve focus during polling. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const t = A.i18n.scope('records');
  const { h, button } = A;
  const states = {
    prepared: [t('prepared'), 'neutral'], submitting: [t('submitting'), 'progress'], succeeded: [t('succeeded'), 'success'],
    failed: [t('failed'), 'danger'], unknown: [t('unknown'), 'warning'], 'result-pending': [t('unknown'), 'warning']
  };
  const filters = [['all', t('all')], ['submitting', t('submitting')], ['succeeded', t('succeeded')], ['failed', t('failed')]];
  const qualities = { low: t('low'), medium: t('medium'), high: t('high') };
  const text = (node, value) => { const next = String(value ?? '—'); if (node.textContent !== next) node.textContent = next; };
  const stateInfo = state => states[state] || [t('unknown'), 'warning'];
  const canDelete = job => job.kind === 'workflow' ? ['succeeded', 'failed'].includes(job.state) : ['prepared', 'succeeded', 'failed'].includes(job.state);
  function badge(node, job) {
    const [label, tone] = stateInfo(job.state);
    text(node, label); node.className = `record-status record-status-${tone}`;
    node.setAttribute('data-generation-state', job.state);
  }
  function timestamp(node, value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) { text(node, t('timeUnknown')); node.removeAttribute('datetime'); return; }
    node.dateTime = date.toISOString();
    text(node, date.toLocaleString(A.i18n.locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }));
  }
  function mediaIcon(kind = 'image') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    svg.innerHTML = kind === 'audio' ? '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>' : kind === 'video' ? '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 9 4-2v10l-4-2"/>' : '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    return svg;
  }
  A.recordsController = ({ state: s, disabled, allJobs, getJob, regenerateRecord, refresh, deleteRecords, listState, clearPreview, loadResult, previewView, previewKey }) => {
    let alive = true, root = null, filter = 'all', selectedId = null, ticket = 0;
    const selectedIds = new Set(), rows = new Map(), filterButtons = new Map(), meta = new Map();
    let dialog = null, parts = null, detailLoading = false, detailError = '', regenerating = false, returnFocus = null, lastPreview = '';
    let count, unresolved, list, empty, error, refreshButton, selectAll, selectedCount, deleteSelectedButton;
    const live = () => alive && s.alive;
    const showing = id => live() && s.screen === 'records' && selectedId === id && Boolean(dialog?.open);
    const selected = () => allJobs().find(job => job.id === selectedId);
    function createRow(job) {
      const mediaKind = job.kind === 'workflow' ? job.request.kind : job.kind;
      const select = h('input', { type: 'checkbox', 'aria-label': t('selectRecord', { p1: job.id }), onchange: event => { event.stopPropagation(); if (event.target.checked) selectedIds.add(job.id); else selectedIds.delete(job.id); update(); } });
      const channel = h('span', { class: 'record-value record-channel-value' });
      const model = h('span', { class: 'record-value record-model-value' });
      const status = h('span');
      const time = h('time');
      const project = h('span', { class: 'record-project-tag' });
      const action = button(t('details'), event => { void open(job.id, event.currentTarget); }, { class: 'record-detail-button', 'aria-label': t('viewTask', { p1: job.id }) });
      const cell = (label, content, className) => h('div', { class: `record-cell ${className}`, role: 'cell' }, h('span', { class: 'record-mobile-label', 'aria-hidden': 'true' }, label), content);
      const node = h('div', { class: 'record-row', role: 'row', 'data-record-job': job.id, 'data-record-kind': mediaKind, [mediaKind === 'audio' ? 'data-audio-job' : mediaKind === 'video' ? 'data-video-job' : 'data-image-job']: job.id },
        h('div', { class: 'record-task', role: 'cell' }, select, h('span', { class: 'record-image-icon', 'aria-hidden': 'true' }, mediaIcon(mediaKind)),
          h('div', { class: 'record-task-copy' }, h('strong', {}, mediaKind === 'audio' ? t('speech') : mediaKind === 'video' ? t('video') : t('imageGeneration')), project)),
        h('div', { class: 'record-cell record-source', role: 'cell' }, channel, model),
        cell(t('status'), status, 'record-state'), cell(t('createdAt'), time, 'record-time'),
        h('div', { class: 'record-action', role: 'cell' }, action));
      return { node, select, channel, model, status, time, action, project };
    }
    async function deleteSelected() {
      const selectedJobs = allJobs().filter(job => selectedIds.has(job.id) && canDelete(job));
      if (!selectedJobs.length) return;
      if (!await A.confirm(t('deleteSelectedTitle'), t('deleteSelectedDescription', { p1: selectedJobs.length }), t('confirmDeleteSelected'))) return;
      if (await deleteRecords(selectedJobs)) { selectedIds.clear(); update(); }
    }
    async function regenerate() {
      const job = selected();
      if (!job || job.state !== 'failed' || typeof regenerateRecord !== 'function' || regenerating) return;
      if (!await A.confirm(t('regenerateTitle'), t('regenerateDescription'), t('confirmRegenerate'))) return;
      regenerating = true; updateDetails();
      try {
        if (await regenerateRecord(job)) { closeDetails(); await refresh(); }
      } finally { regenerating = false; updateDetails(); }
    }
    function view() {
      if (!root) {
        count = h('span', { class: 'records-total', 'aria-label': t('recordCount') });
        refreshButton = button(t('refresh'), () => { void refresh(); }, { id: 'records-refresh', class: 'records-refresh' });
        const controls = filters.map(([value, label]) => {
          const total = h('span', { class: 'record-filter-count', 'aria-hidden': 'true' }, '0');
          const control = button('', () => { filter = value; update(); }, { 'data-record-filter': value, 'aria-label': label, 'aria-pressed': 'false' });
          control.append(h('span', {}, label), total); filterButtons.set(value, { control, total }); return control;
        });
        unresolved = h('p', { class: 'records-unresolved' });
        error = h('p', { class: 'generation-error', role: 'alert', hidden: true });
        list = h('div', { class: 'records-body', role: 'rowgroup' });
        empty = h('div', { class: 'records-empty', role: 'status' });
        root = h('div', { class: 'generation-view generation-records', 'data-generation': '' },
          h('div', { class: 'records-heading' }, h('div', { class: 'records-title' }, h('h2', {}, t('records')), count), refreshButton),
          h('div', { class: 'records-toolbar' },
            h('div', { class: 'record-filters', role: 'group', 'aria-label': t('statusFilter') }, controls),
            h('div', { class: 'records-bulk-actions' },
              h('label', { class: 'records-select-all' }, selectAll = h('input', { type: 'checkbox', 'aria-label': t('selectAll'), onchange: event => { const chosen = allJobs().filter(job => (filter === 'all' || job.state === filter) && canDelete(job)); for (const job of chosen) { if (event.target.checked) selectedIds.add(job.id); else selectedIds.delete(job.id); } update(); } }), h('span', {}, t('selectAll'))),
              selectedCount = h('span', { class: 'records-selected-count' }),
              deleteSelectedButton = button(t('deleteSelected'), () => { void deleteSelected(); }, { class: 'records-delete-selected' })),
            unresolved),
          error,
          h('div', { class: 'records-table', role: 'table', 'aria-label': t('records'), 'data-generation-list': '' },
            h('div', { class: 'records-columns', role: 'row' }, [t('task'), t('source'), t('status'), t('createdAt'), t('actions')].map(label => h('div', { role: 'columnheader' }, label))), list),
          empty, h('p', { class: 'records-caption' }, t('caption')));
      }
      update(); return root;
    }
    function update() {
      if (!live()) return;
      if (root) {
        const jobs = allJobs(), { loading, error: listError } = listState();
        for (const id of selectedIds) if (!jobs.some(job => job.id === id)) selectedIds.delete(id);
        text(count, jobs.length); refreshButton.disabled = disabled() || loading;
        refreshButton.setAttribute('aria-busy', String(loading));
        root.querySelector('[data-generation-list]').setAttribute('aria-busy', String(loading));
        for (const [value, { control, total }] of filterButtons) {
          text(total, value === 'all' ? jobs.length : jobs.filter(job => job.state === value).length);
          control.setAttribute('aria-pressed', String(filter === value));
        }
        const pending = jobs.filter(job => !['submitting', 'succeeded', 'failed'].includes(job.state)).length;
        text(unresolved, pending ? t('unresolved', { p1: pending }) : '');
        unresolved.hidden = !pending;
        const issue = s.legacyBackend ? t('legacyBackend') : listError;
        text(error, issue); error.hidden = !issue;
        const visible = jobs.filter(job => filter === 'all' || job.state === filter);
        const selectable = visible.filter(canDelete), selectedVisible = selectable.filter(job => selectedIds.has(job.id));
        text(selectedCount, t('selectedCount', { p1: selectedIds.size }));
        deleteSelectedButton.disabled = disabled() || selectedIds.size === 0;
        selectAll.disabled = disabled() || selectable.length === 0;
        selectAll.checked = selectable.length > 0 && selectedVisible.length === selectable.length;
        selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < selectable.length;
        const ids = new Set(visible.map(job => job.id));
        for (const [id, row] of rows) {
          if (!ids.has(id)) {
            const focused = row.node.contains(document.activeElement);
            row.node.remove(); rows.delete(id);
            if (focused && !dialog?.open) filterButtons.get(filter).control.focus({ preventScroll: true });
          }
        }
        visible.forEach((job, index) => {
          let row = rows.get(job.id);
          if (!row) { row = createRow(job); rows.set(job.id, row); }
          text(row.channel, job.kind === 'workflow' ? job.request.workflowName : job.profileName); row.channel.title = row.channel.textContent;
          text(row.model, job.kind === 'workflow' ? `ComfyUI · ${job.request.kind}` : job.request.modelId); row.model.title = row.model.textContent;
          const projectName = job.project?.status === 'project' && typeof job.project.name === 'string' ? job.project.name : job.project?.status === 'none' ? t('noProject') : t('projectUnknown');
          text(row.project, projectName);
          row.project.title = projectName;
          row.project.setAttribute('aria-label', t('project', { p1: projectName }));
          badge(row.status, job); timestamp(row.time, job.createdAt); row.select.checked = selectedIds.has(job.id); row.select.disabled = disabled() || !canDelete(job); row.action.disabled = disabled();
          if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] || null);
        });
        empty.hidden = Boolean(visible.length);
        text(empty, loading && !jobs.length ? t('loading') : issue && !jobs.length ? t('unavailable') : !jobs.length ? t('empty') : t('emptyFilter'));
      }
      updateDetails();
    }
    function ensureDialog() {
      if (dialog) return;
      const close = button('', () => closeDetails(), { class: 'record-dialog-close', 'aria-label': t('closeDetails'), autofocus: true });
      close.append(A.svgIcon('x', 20));
      const regenerateButton = button(t('regenerate'), () => { void regenerate(); }, { class: 'record-regenerate-button primary', 'data-record-regenerate': '', hidden: true });
      const loading = h('p', { class: 'record-dialog-loading', role: 'status' }, t('loadingDetails'));
      const errorText = h('p', { class: 'generation-error', role: 'alert' });
      const retry = button(t('retry'), () => { close.focus({ preventScroll: true }); void readDetails(); }, { 'data-record-retry': '' });
      const failure = h('div', { class: 'record-dialog-failure', hidden: true }, errorText, retry);
      const status = h('span');
      const warning = h('p', { class: 'record-warning', role: 'status', hidden: true });
      const jobError = h('p', { class: 'generation-error', role: 'alert', hidden: true });
      const info = h('dl', { class: 'record-metadata' });
      for (const label of [t('service'), t('model'), t('createdAt'), t('requestedSize'), t('actualSize'), t('quality'), t('count'), t('format'), t('duration'), t('sampleRate'), t('channels'), t('voiceId'), t('speed')]) {
        const value = label === t('createdAt') ? h('time') : h('span');
        const dd = h('dd', {}, value), dt = h('dt', {}, label);
        meta.set(label, { value, dt, dd }); info.append(dt, dd);
      }
      const finance = h('p', { class: 'record-finance', hidden: true }, t('chargesUnknown'));
      const preview = h('div', { class: 'record-preview', 'aria-label': t('result') });
      const prompt = h('p', { class: 'record-prompt-text' }), promptLabel = h('summary', {}, t('prompt'));
      const id = h('dd'), hash = h('dd');
      const content = h('div', { class: 'record-dialog-content', hidden: true },
        h('div', { class: 'record-detail-grid' }, preview, h('div', { class: 'record-detail-meta' },
          h('div', { class: 'record-detail-state' }, status), warning, jobError, info, finance)),
        h('details', { class: 'record-disclosure' }, promptLabel, prompt),
        h('details', { class: 'record-disclosure' }, h('summary', {}, t('technical')),
          h('dl', { class: 'record-metadata record-technical' }, h('dt', {}, t('taskId')), id, h('dt', {}, t('requestHash')), hash)));
      const body = h('div', { class: 'record-dialog-body' }, loading, failure, content);
      dialog = h('dialog', { class: 'record-dialog', 'aria-label': t('generationDetails') },
        h('header', { class: 'record-dialog-heading' }, h('h2', {}, t('generationDetails')), h('div', { class: 'record-dialog-heading-actions' }, regenerateButton, close)), body);
      parts = { close, regenerateButton, loading, failure, errorText, retry, status, warning, jobError, finance, preview, prompt, promptLabel, id, hash, body, content };
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeDetails(); });
      dialog.addEventListener('close', () => { if (!dialog.open && selectedId) closeDetails(); });
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
          .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.checkVisibility({ visibilityProperty: true }));
        const first = controls[0] || parts.close, last = controls.at(-1) || parts.close;
        const active = document.activeElement;
        if (!controls.includes(active) || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      });
      const outside = event => {
        const bounds = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
      };
      let backdropPressed = false;
      dialog.addEventListener('pointerdown', event => { backdropPressed = outside(event); });
      dialog.addEventListener('click', event => { if (backdropPressed && outside(event)) closeDetails(); backdropPressed = false; });
    }
    async function open(id, trigger) {
      if (!live() || disabled() || s.screen !== 'records') return;
      ensureDialog();
      dialog.setAttribute('data-generation-job', id);
      selectedId = id; returnFocus = trigger; clearPreview(); lastPreview = '';
      parts.body.scrollTop = 0;
      for (const disclosure of dialog.querySelectorAll('details')) disclosure.open = false;
      document.body.append(dialog);
      document.documentElement.classList.add('generation-dialog-open');
      detailLoading = true; detailError = ''; updateDetails();
      if (!dialog.open) dialog.showModal();
      parts.close.focus({ preventScroll: true });
      await readDetails();
    }
    async function readDetails() {
      const id = selectedId, currentTicket = ++ticket, epoch = s.epoch;
      if (!id || !showing(id)) return;
      detailLoading = true; detailError = ''; updateDetails();
      try {
        await getJob(id);
        if (!showing(id) || currentTicket !== ticket || epoch !== s.epoch) return;
      } catch (error) {
        if (!showing(id) || currentTicket !== ticket || epoch !== s.epoch) return;
        detailError = A.errorText(error);
      } finally {
        if (showing(id) && currentTicket === ticket && epoch === s.epoch) { detailLoading = false; update(); }
      }
    }
    function updateDetails() {
      if (!selectedId || !parts) return;
      parts.loading.hidden = !detailLoading;
      parts.failure.hidden = !detailError;
      parts.content.hidden = detailLoading || Boolean(detailError);
      parts.retry.disabled = disabled() || detailLoading;
      parts.regenerateButton.hidden = true;
      parts.regenerateButton.disabled = disabled() || detailLoading || regenerating;
      text(parts.errorText, detailError);
      if (detailLoading || detailError) return;
      const job = selected();
      if (!job) return;
      dialog.setAttribute('data-generation-job', job.id);
      parts.regenerateButton.hidden = job.state !== 'failed';
      parts.regenerateButton.disabled = disabled() || regenerating;
      badge(parts.status, job);
      const request = job.request, audio = job.kind === 'audio';
      const values = { [t('service')]: job.profileName, [t('model')]: request.modelId, [t('createdAt')]: job.createdAt,
        ...(audio ? { [t('format')]: 'MP3', [t('duration')]: job.result && A.audioDuration(job.result.durationMs), [t('sampleRate')]: job.result && `${job.result.sampleRate} Hz`, [t('channels')]: job.result?.channels, [t('voiceId')]: request.voiceId, [t('speed')]: `${request.speed} ×` }
          : { [t('requestedSize')]: request.size?.replace('x', ' × '), [t('actualSize')]: job.result ? `${job.result.width} × ${job.result.height}` : null, [t('quality')]: qualities[request.quality] || request.quality, [t('count')]: t('imageCount', { p1: request.n || 1 }) }) };
      for (const [label, item] of meta) {
        const value = values[label];
        item.dt.hidden = item.dd.hidden = value === null || value === undefined;
        if (label === t('createdAt')) timestamp(item.value, value); else text(item.value, value);
      }
      const warning = job.state === 'unknown' ? t('submissionUnknown') : job.state === 'result-pending' ? t('localUnavailable', { p1: audio ? t('audio') : t('image') }) : !states[job.state] ? t('stateUnknown') : '';
      text(parts.warning, warning); parts.warning.hidden = !warning;
      const jobError = job.error ? A.errorText(job.error) : job.state === 'failed' ? t('generationFailed') : '';
      text(parts.jobError, jobError); parts.jobError.hidden = !jobError;
      parts.finance.hidden = job.charging !== 'unknown' || job.state === 'unknown';
      text(parts.promptLabel, audio ? t('speechText') : t('prompt'));
      text(parts.prompt, (audio ? request.text : request.prompt) ?? t('noText')); text(parts.id, job.id); text(parts.hash, job.requestHash);
      const key = `${job.id}:${job.state}:${previewKey()}:${disabled()}`;
      if (lastPreview !== key) {
        lastPreview = key;
        const output = job.result ? previewView(job) : h('div', { class: 'record-preview-empty' }, mediaIcon(job.kind),
          h('strong', {}, job.state === 'submitting' ? (audio ? t('speechInProgress') : t('imageInProgress')) : job.state === 'prepared' ? t('waiting') : (audio ? t('noAudio') : t('noImage'))),
          h('p', {}, job.state === 'submitting' ? t('updating') : job.state === 'prepared' ? t('preparedOnly') : t('resultStored')));
        if (parts.preview.firstChild !== output) {
          if (parts.preview.contains(document.activeElement)) parts.close.focus({ preventScroll: true });
          parts.preview.replaceChildren(output);
        }
      }
      if (showing(job.id) && job.state === 'succeeded' && job.result) void loadResult(job);
    }
    function closeDetails(restoreFocus = true) {
      const id = selectedId;
      selectedId = null; ticket++; detailLoading = false; detailError = ''; lastPreview = '';
      selectedId = null; ticket++; detailLoading = false; detailError = ''; regenerating = false; lastPreview = '';
      const scrollX = window.scrollX, scrollY = window.scrollY;
      if (dialog?.open) dialog.close();
      dialog?.remove(); document.documentElement.classList.remove('generation-dialog-open');
      if (restoreFocus && id && live() && s.screen === 'records') {
        const target = returnFocus?.isConnected ? returnFocus : rows.get(id)?.action || filterButtons.get(filter)?.control;
        target?.focus({ preventScroll: true });
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      }
      returnFocus = null;
    }
    function dispose() { alive = false; closeDetails(false); root = null; selectedIds.clear(); rows.clear(); }
    return { view, update, showing, closeDetails, dispose };
  };
})();
