/* Read-only local records. Stable rows and a native dialog preserve focus during polling. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button } = A;
  const states = {
    prepared: ['待确认', 'neutral'], submitting: ['生成中', 'progress'], succeeded: ['已完成', 'success'],
    failed: ['已失败', 'danger'], unknown: ['待核对', 'warning'], 'result-pending': ['待核对', 'warning']
  };
  const filters = [['all', '全部'], ['submitting', '生成中'], ['succeeded', '已完成'], ['failed', '已失败']];
  const qualities = { low: '低', medium: '中', high: '高' };
  const text = (node, value) => { const next = String(value ?? '—'); if (node.textContent !== next) node.textContent = next; };
  const stateInfo = state => states[state] || ['待核对', 'warning'];
  function badge(node, job) {
    const [label, tone] = stateInfo(job.state);
    text(node, label); node.className = `record-status record-status-${tone}`;
    node.setAttribute('data-generation-state', job.state);
  }
  function timestamp(node, value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) { text(node, '时间待核对'); node.removeAttribute('datetime'); return; }
    node.dateTime = date.toISOString();
    text(node, date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }));
  }
  function mediaIcon(kind = 'image') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    svg.innerHTML = kind === 'audio' ? '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>' : '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    return svg;
  }
  A.recordsController = ({ state: s, disabled, allJobs, getJob, refresh, listState, clearPreview, loadResult, previewView, previewKey }) => {
    let alive = true, root = null, filter = 'all', selectedId = null, ticket = 0;
    let dialog = null, parts = null, detailLoading = false, detailError = '', returnFocus = null, lastPreview = '';
    const rows = new Map(), filterButtons = new Map(), meta = new Map();
    let count, unresolved, list, empty, error, refreshButton;
    const live = () => alive && s.alive;
    const showing = id => live() && s.screen === 'records' && selectedId === id && Boolean(dialog?.open);
    const selected = () => allJobs().find(job => job.id === selectedId);
    function createRow(job) {
      const channel = h('span', { class: 'record-value record-channel-value' });
      const model = h('span', { class: 'record-value record-model-value' });
      const status = h('span');
      const time = h('time');
      const action = button('查看详情', event => { void open(job.id, event.currentTarget); }, { class: 'record-detail-button', 'aria-label': `查看任务 ${job.id}` });
      const cell = (label, content, className) => h('div', { class: `record-cell ${className}`, role: 'cell' }, h('span', { class: 'record-mobile-label', 'aria-hidden': 'true' }, label), content);
      const node = h('div', { class: 'record-row', role: 'row', 'data-record-job': job.id, 'data-record-kind': job.kind, [job.kind === 'audio' ? 'data-audio-job' : 'data-image-job']: job.id },
        h('div', { class: 'record-task', role: 'cell' }, h('span', { class: 'record-image-icon', 'aria-hidden': 'true' }, mediaIcon(job.kind)), h('strong', {}, job.kind === 'audio' ? '语音合成' : '图片生成')),
        h('div', { class: 'record-cell record-source', role: 'cell' }, channel, model),
        cell('状态', status, 'record-state'), cell('创建时间', time, 'record-time'),
        h('div', { class: 'record-action', role: 'cell' }, action));
      return { node, channel, model, status, time, action };
    }
    function view() {
      if (!root) {
        count = h('span', { class: 'records-total', 'aria-label': '记录总数' });
        refreshButton = button('刷新记录', () => { void refresh(); }, { id: 'records-refresh', class: 'records-refresh' });
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
          h('div', { class: 'records-heading' }, h('div', { class: 'records-title' }, h('h2', {}, '生成记录'), count), refreshButton),
          h('div', { class: 'records-toolbar' }, h('div', { class: 'record-filters', role: 'group', 'aria-label': '任务状态筛选' }, controls), unresolved),
          error,
          h('div', { class: 'records-table', role: 'table', 'aria-label': '生成记录', 'data-generation-list': '' },
            h('div', { class: 'records-columns', role: 'row' }, ['任务', '渠道 / 模型', '状态', '创建时间', '操作'].map(label => h('div', { role: 'columnheader' }, label))), list),
          empty, h('p', { class: 'records-caption' }, '仅显示本插件任务 · 图片、音频各最多 200 条 · 自动更新本地记录'));
      }
      update(); return root;
    }
    function update() {
      if (!live()) return;
      if (root) {
        const jobs = allJobs(), { loading, error: listError } = listState();
        text(count, jobs.length); refreshButton.disabled = disabled() || loading;
        refreshButton.setAttribute('aria-busy', String(loading));
        root.querySelector('[data-generation-list]').setAttribute('aria-busy', String(loading));
        for (const [value, { control, total }] of filterButtons) {
          text(total, value === 'all' ? jobs.length : jobs.filter(job => job.state === value).length);
          control.setAttribute('aria-pressed', String(filter === value));
        }
        const pending = jobs.filter(job => !['submitting', 'succeeded', 'failed'].includes(job.state)).length;
        text(unresolved, pending ? `${pending} 项待确认或待核对，见「全部」` : '');
        unresolved.hidden = !pending;
        const issue = s.legacyBackend ? '当前后台不支持读取生成记录，请重载插件。' : listError;
        text(error, issue); error.hidden = !issue;
        const visible = jobs.filter(job => filter === 'all' || job.state === filter);
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
          text(row.channel, job.profileName); row.channel.title = job.profileName || '';
          text(row.model, job.request.modelId); row.model.title = job.request.modelId || '';
          badge(row.status, job); timestamp(row.time, job.createdAt); row.action.disabled = disabled();
          if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] || null);
        });
        empty.hidden = Boolean(visible.length);
        text(empty, loading && !jobs.length ? '正在读取本地记录…' : issue && !jobs.length ? '记录暂不可用，请稍后刷新。' : !jobs.length ? '暂无生成记录。在「生图」或「声音」中创建，或通过 Agent 生成。' : '暂无此状态的任务');
      }
      updateDetails();
    }
    function ensureDialog() {
      if (dialog) return;
      const close = button('', () => closeDetails(), { class: 'record-dialog-close', 'aria-label': '关闭详情', autofocus: true });
      close.append(A.svgIcon('x', 20));
      const loading = h('p', { class: 'record-dialog-loading', role: 'status' }, '正在读取任务详情…');
      const errorText = h('p', { class: 'generation-error', role: 'alert' });
      const retry = button('重试读取', () => { close.focus({ preventScroll: true }); void readDetails(); }, { 'data-record-retry': '' });
      const failure = h('div', { class: 'record-dialog-failure', hidden: true }, errorText, retry);
      const status = h('span');
      const warning = h('p', { class: 'record-warning', role: 'status', hidden: true });
      const jobError = h('p', { class: 'generation-error', role: 'alert', hidden: true });
      const info = h('dl', { class: 'record-metadata' });
      for (const label of ['渠道', '模型', '创建时间', '请求尺寸', '实际尺寸', '质量', '数量', '格式', '时长', '采样率', '声道', '音色 ID', '语速']) {
        const value = label === '创建时间' ? h('time') : h('span');
        const dd = h('dd', {}, value), dt = h('dt', {}, label);
        meta.set(label, { value, dt, dd }); info.append(dt, dd);
      }
      const finance = h('p', { class: 'record-finance', hidden: true }, '费用状态未知，以供应商账单为准。');
      const preview = h('div', { class: 'record-preview', 'aria-label': '生成结果' });
      const prompt = h('p', { class: 'record-prompt-text' }), promptLabel = h('summary', {}, '提示词');
      const id = h('dd'), hash = h('dd');
      const content = h('div', { class: 'record-dialog-content', hidden: true },
        h('div', { class: 'record-detail-grid' }, preview, h('div', { class: 'record-detail-meta' },
          h('div', { class: 'record-detail-state' }, status), warning, jobError, info, finance)),
        h('details', { class: 'record-disclosure' }, promptLabel, prompt),
        h('details', { class: 'record-disclosure' }, h('summary', {}, '技术详情'),
          h('dl', { class: 'record-metadata record-technical' }, h('dt', {}, '任务 ID'), id, h('dt', {}, '请求摘要'), hash)));
      const body = h('div', { class: 'record-dialog-body' }, loading, failure, content);
      dialog = h('dialog', { class: 'record-dialog', 'aria-label': '生成详情' },
        h('header', { class: 'record-dialog-heading' }, h('h2', {}, '生成详情'), close), body);
      parts = { close, loading, failure, errorText, retry, status, warning, jobError, finance, preview, prompt, promptLabel, id, hash, body, content };
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
      text(parts.errorText, detailError);
      if (detailLoading || detailError) return;
      const job = selected();
      if (!job) return;
      dialog.setAttribute('data-generation-job', job.id);
      badge(parts.status, job);
      const request = job.request, audio = job.kind === 'audio';
      const values = { '渠道': job.profileName, '模型': request.modelId, '创建时间': job.createdAt,
        ...(audio ? { '格式': 'MP3', '时长': job.result && A.audioDuration(job.result.durationMs), '采样率': job.result && `${job.result.sampleRate} Hz`, '声道': job.result?.channels, '音色 ID': request.voiceId, '语速': `${request.speed} ×` }
          : { '请求尺寸': request.size?.replace('x', ' × '), '实际尺寸': job.result ? `${job.result.width} × ${job.result.height}` : null, '质量': qualities[request.quality] || request.quality, '数量': `${request.n || 1} 张` }) };
      for (const [label, item] of meta) {
        const value = values[label];
        item.dt.hidden = item.dd.hidden = value === null || value === undefined;
        if (label === '创建时间') timestamp(item.value, value); else text(item.value, value);
      }
      const warning = job.state === 'unknown' ? '提交结果待核对，可能已收费。请勿重复生成。' : job.state === 'result-pending' ? `本地${audio ? '音频' : '图片'}暂不可用，请刷新记录核对。不会重新生成。` : !states[job.state] ? '任务状态待核对，请刷新本地记录。' : '';
      text(parts.warning, warning); parts.warning.hidden = !warning;
      const jobError = job.error ? A.errorText(job.error) : job.state === 'failed' ? '生成未完成，此任务不会自动重试。' : '';
      text(parts.jobError, jobError); parts.jobError.hidden = !jobError;
      parts.finance.hidden = job.charging !== 'unknown' || job.state === 'unknown';
      text(parts.promptLabel, audio ? '朗读文本' : '提示词');
      text(parts.prompt, (audio ? request.text : request.prompt) ?? '此记录未提供文本。'); text(parts.id, job.id); text(parts.hash, job.requestHash);
      const key = `${job.id}:${job.state}:${previewKey()}:${disabled()}`;
      if (lastPreview !== key) {
        lastPreview = key;
        const output = job.result ? previewView(job) : h('div', { class: 'record-preview-empty' }, mediaIcon(job.kind),
          h('strong', {}, job.state === 'submitting' ? (audio ? '语音合成中' : '图片生成中') : job.state === 'prepared' ? '等待确认生成' : (audio ? '暂无可用音频' : '暂无可用图片')),
          h('p', {}, job.state === 'submitting' ? '正在更新本地任务状态' : job.state === 'prepared' ? '此处仅查看已准备的请求' : '结果保留在本地任务记录中'));
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
      if (id) clearPreview();
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
    function dispose() { alive = false; closeDetails(false); root = null; rows.clear(); }
    return { view, update, showing, closeDetails, dispose };
  };
})();
