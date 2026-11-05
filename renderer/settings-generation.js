/* Local image jobs: preparation never submits; only explicit confirmation can charge. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, field, picker, section, note } = A;
  const sizes = ['1024x1024', '1536x1024', '1024x1536'];
  const qualities = { low: '低', medium: '中', high: '高' };
  const labels = { prepared: '待确认', submitting: '生成中', unknown: '提交结果未知', succeeded: '生成成功', failed: '生成失败', 'result-pending': '结果待读取' };
  const descriptions = {
    prepared: '请求已准备，尚未提交供应商。请核对固定参数后确认付费生成。',
    submitting: '请求已提交，正在等待结果。仅更新本地任务状态，请勿重复提交。',
    unknown: '供应商可能已收费，提交结果尚不确定。请勿重复提交；重新读取仅检查本地记录。',
    succeeded: '图片已保存到本地。PNG 校验不代表画面质量通过，请预览检查。',
    failed: '生成未完成，请查看下方安全错误说明。此任务不会自动重试。',
    'result-pending': '任务已有记录，但图片暂不可用。重新读取仅检查本地结果，不重新生成。'
  };
  const failure = code => Object.assign(new Error(code), { code });
  A.generationController = ({ state: s, invoke, render, message }) => {
    const draft = { profileId: '', modelId: '', prompt: '', size: sizes[0], quality: 'medium' };
    const jobs = new Map(), attempted = new Set(), reads = new Map();
    let alive = true, requestId = null, requestKey = null, activeId = null;
    let preparing = false, confirming = false, listLoading = false, listError = '', formError = '';
    let listTicket = 0, timer = null;
    const live = () => alive && s.alive;
    const visible = () => s.screen === 'image' && !document.hidden;
    const showing = id => s.screen === 'image' && activeId === id;
    const disabled = () => s.legacyBackend || !s.data || s.busy;
    const eligible = () => (s.data?.profiles || []).filter(p => p.provider === 'openai' && p.enabled && p.credentialConfigured);
    const models = profile => (profile?.models || []).filter(m => m.kind === 'image' && /^gpt-image-/.test(m.id));
    const resultPreview = A.resultPreviewController({ live, disabled, showing, paint,
      read: (job, offset) => invoke('aimedia.image.read', { jobId: job.id, expectedSha256: job.result.sha256, offset }) });
    const clearPreview = resultPreview.clear, loadResult = resultPreview.load, previewView = resultPreview.view;
    function paint() {
      if (!live() || !visible()) return;
      A.replaceFormView(document.querySelector('[data-generation]'), view, render);
    }
    function displayed(job) {
      return attempted.has(job.id) && job.state === 'prepared' ? { ...job, state: 'unknown', charging: 'unknown' } : job;
    }
    function remember(job) {
      if (!job || typeof job.id !== 'string' || !Number.isInteger(job.revision) || !job.request) throw failure('INVALID_RESPONSE');
      const old = jobs.get(job.id);
      if (old && old.revision > job.revision) return old;
      const next = { ...job, request: { ...old?.request, ...job.request } };
      jobs.set(job.id, next);
      return next;
    }
    function schedule() {
      clearTimeout(timer); timer = null;
      if (!live() || disabled() || !visible() || ![...jobs.values()].some(j => j.state === 'submitting')) return;
      timer = setTimeout(async () => {
        timer = null;
        if (!live() || disabled() || !visible()) return;
        const pending = [...jobs.values()].filter(j => j.state === 'submitting');
        await Promise.all(pending.map(async job => {
          try { await getJob(job.id); }
          catch (error) { if (live()) listError = A.errorText(error); }
        }));
        if (live()) { paint(); schedule(); }
      }, 1000);
    }
    async function refresh() {
      if (!live() || disabled()) { schedule(); return; }
      const ticket = ++listTicket;
      listLoading = true; listError = ''; paint();
      try {
        const result = await invoke('aimedia.image.list', {});
        if (!live() || ticket !== listTicket) return;
        if (!Array.isArray(result?.jobs) || result.jobs.length > 200) throw failure('INVALID_RESPONSE');
        for (const job of result.jobs) remember(job);
      } catch (error) {
        if (live() && ticket === listTicket) listError = A.errorText(error);
      } finally {
        if (live() && ticket === listTicket) { listLoading = false; paint(); schedule(); }
      }
    }
    async function getJob(id) {
      if (!live() || disabled()) return null;
      if (reads.has(id)) return reads.get(id);
      const epoch = s.epoch;
      const read = (async () => {
        try {
          const job = await invoke('aimedia.image.get', { jobId: id });
          if (!live()) return null;
          if (job.id !== id) throw failure('INVALID_RESPONSE');
          const current = remember(job);
          if (epoch === s.epoch && s.screen === 'image' && current.state === 'succeeded' && current.result && showing(id)) void loadResult(current);
          return current;
        } finally { reads.delete(id); }
      })();
      reads.set(id, read);
      return read;
    }
    async function reloadJob(id) {
      if (resultPreview.failed(id)) clearPreview();
      listError = '';
      try { await getJob(id); } catch (error) { if (live()) listError = A.errorText(error); }
      if (live()) { paint(); schedule(); }
    }
    function change(key, value) {
      if (draft[key] === value) return;
      draft[key] = value; requestId = null; formError = '';
      if (key === 'profileId') draft.modelId = '';
      if (key !== 'prompt') paint();
    }
    function validate() {
      const profile = eligible().find(p => p.id === draft.profileId);
      if (!profile) return '请选择已启用且凭据已配置的 OpenAI 服务。';
      if (!models(profile).some(m => m.id === draft.modelId)) return '请明确选择已配置的 GPT 图片模型。';
      if (!draft.prompt.trim() || draft.prompt.length > 8000) return '请填写提示词，最多 8000 个字符。';
      return '';
    }
    async function prepare() {
      if (!live() || disabled() || preparing || activeId) return;
      formError = validate();
      if (formError) { paint(); document.getElementById('generation-form-error')?.focus(); return; }
      const key = JSON.stringify({ ...draft, expectedRevision: s.data.revision });
      if (!requestId || requestKey !== key) requestId = crypto.randomUUID();
      requestKey = key;
      const payload = { requestId, ...draft, expectedRevision: s.data.revision };
      preparing = true; paint();
      try {
        const job = await invoke('aimedia.image.prepare', payload);
        if (!live()) return;
        remember(job); activeId = job.id;
      } catch (error) { if (live()) formError = A.errorText(error); }
      finally { if (live()) { preparing = false; paint(); schedule(); } }
    }
    async function submit(id) {
      const job = jobs.get(id);
      if (!live() || disabled() || confirming || !job || job.state !== 'prepared' || attempted.has(id) || typeof job.request.prompt !== 'string') return;
      confirming = true;
      const epoch = s.epoch;
      const accepted = await A.confirm('确认付费生成？', `将使用「${job.profileName}」的 ${job.request.modelId} 生成 1 张图片。\n预估费用未知，按供应商实际用量计费，可能产生费用。\n确认后不会自动重试；结果未知时也可能已收费。`, '生成 1 张');
      confirming = false;
      if (!accepted || !live() || disabled() || epoch !== s.epoch || jobs.get(id)?.revision !== job.revision || attempted.has(id)) return;
      attempted.add(id);
      jobs.set(id, { ...job, state: 'submitting', charging: 'unknown' }); paint();
      try {
        const result = await invoke('aimedia.image.submit', { jobId: id, requestHash: job.requestHash, confirm: true });
        if (!live()) return;
        if (result.id !== id) throw failure('INVALID_RESPONSE');
        const current = remember(result);
        if (current.state === 'succeeded' && current.result && showing(id)) void loadResult(current);
      } catch (error) {
        if (!live()) return;
        const rejected = ['INVALID_ARGUMENT', 'CONFLICT', 'NOT_FOUND', 'DISABLED', 'CREDENTIAL_REQUIRED', 'CREDENTIAL_ERROR', 'CREDENTIAL_UNAVAILABLE', 'GENERATION_UNSUPPORTED', 'GENERATION_BUSY', 'GENERATION_REQUEST_CONFLICT'].includes(error.code);
        if (rejected) {
          attempted.delete(id); jobs.set(id, job);
          message(`尚未提交生成请求。${A.errorText(error)}`, 'error');
        } else {
          const current = jobs.get(id);
          if (current.state === 'submitting') jobs.set(id, { ...current, state: 'unknown', charging: 'unknown' });
          message('提交结果尚不确定，供应商可能已收费。请勿重复提交，仅重新读取本地任务核对。', 'error');
        }
      } finally { if (live()) { paint(); schedule(); } }
    }
    function jobView(original) {
      const job = displayed(original), request = job.request;
      const info = h('dl', { class: 'generation-request' });
      for (const [key, value] of [['服务', job.profileName], ['模型', request.modelId], ['尺寸', request.size], ['质量', qualities[request.quality] || request.quality], ['数量', '1 张'], ['预估费用', '未知 · 按供应商计费'], ['任务 ID', job.id], ['请求摘要', job.requestHash]]) info.append(h('dt', {}, key), h('dd', {}, value));
      const canSubmit = job.state === 'prepared' && typeof request.prompt === 'string';
      return section('任务详情', h('div', { class: 'card generation-detail', 'data-generation-job': job.id },
        h('h3', { id: 'generation-job-heading', tabindex: -1 }, labels[job.state] || '状态待核对'),
        h('p', { class: 'note', 'data-generation-state': job.state, role: 'status' }, descriptions[job.state] || '请重新读取本地任务核对。不会自动提交或重试。'),
        job.charging === 'unknown' && job.state !== 'unknown' && note('费用状态未知，请以供应商账单为准。'), info,
        h('div', { class: 'generation-prompt' }, h('strong', {}, '固定提示词'), h('p', {}, typeof request.prompt === 'string' ? request.prompt : '正在读取任务详情…')),
        job.error && h('p', { class: 'generation-error', role: 'alert' }, A.errorText(job.error)),
        h('div', { class: 'generation-actions' }, canSubmit && button('确认生成…', () => submit(job.id), { class: 'primary', disabled: disabled() || confirming }),
          button('重新读取本地任务', () => reloadJob(job.id), { disabled: disabled() || reads.has(job.id) })),
        (job.state === 'succeeded' || job.state === 'result-pending') && previewView(job)));
    }
    function resetForm() {
      if (jobs.get(activeId)?.state !== 'prepared') { requestId = null; draft.prompt = ''; }
      activeId = null; formError = ''; clearPreview(); paint();
      document.getElementById('generation-prompt')?.focus();
    }
    function formPicker(label, key, options, locked) {
      const control = picker(label, draft[key], options, value => change(key, value), locked);
      control.querySelector('summary').id = `generation-${key}`;
      return field(label, control);
    }
    function view() {
      const profile = eligible().find(p => p.id === draft.profileId);
      const active = activeId && jobs.get(activeId);
      const locked = disabled() || preparing || Boolean(active);
      const form = h('form', { novalidate: true, onsubmit: e => { e.preventDefault(); void prepare(); }, 'aria-label': '图片生成请求' },
        h('fieldset', { disabled: locked }, h('div', { class: 'card' },
          formPicker('OpenAI 服务', 'profileId', [{ value: '', label: '请选择服务' }, ...eligible().map(p => ({ value: p.id, label: p.name }))], locked),
          formPicker('图片模型', 'modelId', [{ value: '', label: '请选择模型' }, ...models(profile).map(m => ({ value: m.id, label: `${m.name || m.id} · ${m.id}` }))], locked),
          field('提示词', h('textarea', { id: 'generation-prompt', 'aria-label': '提示词', rows: 5, maxlength: 8000, required: true, value: draft.prompt, oninput: e => change('prompt', e.target.value) }), '描述想要生成的画面，最多 8000 个字符。'),
          formPicker('图片尺寸', 'size', sizes.map(value => ({ value, label: value })), locked),
          formPicker('图片质量', 'quality', Object.entries(qualities).map(([value, label]) => ({ value, label })), locked),
          field('数量与费用', h('p', {}, '1 张 · 预估费用未知'), '按供应商计费。准备请求不会调用供应商；确认生成后可能产生费用。'))),
        formError && h('p', { id: 'generation-form-error', class: 'generation-error', role: 'alert', tabindex: -1 }, formError),
        !active && h('div', { class: 'footer' }, button(preparing ? '正在准备…' : '准备生成', null, { type: 'submit', class: 'primary', disabled: locked })));
      return h('div', { class: 'generation-view', 'data-generation': '' },
        h('div', { class: 'heading' }, h('h2', {}, '生图')),
        s.legacyBackend ? note('当前后台版本不支持生图，请重载插件后重新检查。') : note('仅支持已配置的 OpenAI GPT 图片模型。请明确选择服务和模型。'),
        form, active && jobView(active),
        active && ['prepared', 'succeeded', 'failed'].includes(displayed(active).state) && h('div', { class: 'footer' }, button(active.state === 'prepared' ? '编辑请求' : '新建请求', resetForm, { disabled: disabled() || confirming })),
        listError && h('p', { class: 'generation-error', role: 'alert' }, listError));
    }
    function screenChanged() {
      clearPreview(); schedule();
    }
    function dispose() {
      alive = false; listTicket++; clearTimeout(timer); clearPreview(); reads.clear(); jobs.clear(); attempted.clear();
      document.removeEventListener('visibilitychange', visibilityChanged);
    }
    function visibilityChanged() { schedule(); if (visible()) void refresh(); }
    document.addEventListener('visibilitychange', visibilityChanged);
    return { view, refresh, dispose, screenChanged };
  };
})();
