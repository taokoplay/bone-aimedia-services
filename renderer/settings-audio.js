/* MiniMax speech form. Local preparation and explicit confirmation are separate actions. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, field, picker, note, section } = A;
  const supported = new Set(['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo']);
  const labels = { prepared: '待确认', submitting: '语音合成中', succeeded: '语音合成完成', failed: '语音合成失败', unknown: '提交结果未知', 'result-pending': '音频待读取' };
  const descriptions = {
    prepared: '请求已准备，尚未提交供应商。请核对文本和音色后确认付费合成。',
    submitting: '请求已提交，正在等待结果。仅更新本地任务，请勿重复提交。',
    succeeded: '音频已保存。通过完整性检查和浏览器解码后可试听、下载；内容未评审。',
    failed: '合成未完成，请查看错误说明。此任务不会自动重试。',
    unknown: '供应商可能已收费，提交结果尚不确定。请勿重复提交；重新读取仅检查本地记录。',
    'result-pending': '本地音频暂不可用。重新读取仅检查本地结果，不重新生成。'
  };
  const invalid = () => Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' });
  A.audioController = ({ state: s, invoke, render }) => {
    const draft = { profileId: '', modelId: '', voiceId: '', text: '', speed: 1 };
    let alive = true, active = null, preparing = false, confirming = false, attempted = false;
    let formError = '', jobError = '', requestId = null, requestKey = '', timer = null, readFlight = null;
    let root = null, detail = null, detailKey = '', previewSlot = null, lastPreview = '', statusSlot = null, nextSlot = null;
    let voiceTicket = 0, voiceLoading = false, voiceResult = null, voiceError = '';
    const live = () => alive && s.alive;
    const visible = () => live() && s.screen === 'audio' && !document.hidden;
    const disabled = () => s.busy || s.legacyBackend || !s.data;
    const eligible = () => (s.data?.profiles || []).filter(p => p.provider === 'minimax' && p.enabled && p.credentialConfigured);
    const models = profile => (profile?.models || []).filter(m => m.kind === 'audio' && supported.has(m.id));
    const preview = A.resultPreviewController({ live, disabled, showing: id => s.screen === 'audio' && active?.id === id, paint: updateDetails,
      read: (job, offset) => invoke('aimedia.audio.read', { jobId: job.id, expectedSha256: job.result.sha256, offset }) });
    function remember(job) {
      if (job?.kind !== 'audio' || typeof job.id !== 'string' || !job.id.startsWith('aud-') || !Number.isInteger(job.revision) || !job.request) throw invalid();
      if (active?.id === job.id && active.revision > job.revision) return;
      active = { ...job, request: { ...(active?.id === job.id ? active.request : {}), ...job.request } };
      if (attempted && active.state === 'prepared') active = { ...active, state: 'unknown', charging: 'unknown' };
    }
    function schedule() {
      clearTimeout(timer); timer = null;
      if (visible() && !disabled() && !readFlight && active?.state === 'submitting') timer = setTimeout(() => { timer = null; void refresh(); }, 1000);
    }
    async function refresh() {
      if (!visible() || disabled() || !active) { schedule(); return; }
      if (readFlight) return readFlight;
      const id = active.id;
      readFlight = (async () => {
        try {
          const job = await invoke('aimedia.audio.get', { jobId: id });
          if (!live() || active?.id !== id) return;
          if (job.id !== id) throw invalid();
          remember(job); jobError = '';
        } catch (error) { if (live() && active?.id === id) jobError = A.errorText(error); }
        finally { readFlight = null; if (live()) { updateDetails(); schedule(); } }
      })();
      return readFlight;
    }
    function repaint() {
      if (!visible()) return;
      A.replaceFormView(root, view, render);
    }
    function change(key, value) {
      if (draft[key] === value) return;
      draft[key] = value; requestId = null; formError = '';
      if (key === 'profileId') { draft.modelId = ''; draft.voiceId = ''; voiceTicket++; voiceLoading = false; voiceResult = null; voiceError = ''; }
      if (['profileId', 'modelId'].includes(key)) repaint();
    }
    async function fetchVoices() {
      if (disabled() || preparing || active || voiceLoading || !eligible().some(p => p.id === draft.profileId)) return;
      const ticket = ++voiceTicket, epoch = s.epoch, profileId = draft.profileId, revision = s.data.revision;
      voiceLoading = true; voiceError = ''; repaint();
      try {
        const result = await invoke('aimedia.probe', { profileId, expectedRevision: revision, catalog: 'voices' });
        if (!live() || ticket !== voiceTicket || epoch !== s.epoch || revision !== s.data.revision) return;
        if (!Array.isArray(result?.voices) || result.voices.some(v => typeof v.id !== 'string' || typeof v.name !== 'string')) throw invalid();
        voiceResult = result;
        if (result.catalogs?.voices?.status !== 'connected') voiceError = A.minimaxCatalogText(result, 'voices');
      } catch (error) { if (live() && ticket === voiceTicket && epoch === s.epoch) voiceError = A.errorText(error); }
      finally { if (live() && ticket === voiceTicket) { voiceLoading = false; repaint(); } }
    }
    function validate() {
      const profile = eligible().find(p => p.id === draft.profileId);
      if (!profile) return '请选择已启用且凭据已配置的 MiniMax 服务。';
      if (!models(profile).some(m => m.id === draft.modelId)) return '请明确选择已配置的 MiniMax 语音模型。';
      if (!draft.voiceId.trim() || draft.voiceId.length > 128 || /[\u0000-\u001f\u007f]/.test(draft.voiceId)) return '请填写或选择音色 ID，最多 128 个字符。';
      if (!draft.text.trim() || draft.text.length > 1000) return '请填写朗读文本，最多 1000 个字符。';
      if (!Number.isFinite(draft.speed) || draft.speed < .5 || draft.speed > 2) return '语速应在 0.5 到 2 之间。';
      return '';
    }
    async function prepare() {
      if (!live() || disabled() || preparing || active || voiceLoading) return;
      formError = validate();
      if (formError) { repaint(); document.getElementById('audio-form-error')?.focus(); return; }
      const key = JSON.stringify({ ...draft, expectedRevision: s.data.revision });
      if (!requestId || requestKey !== key) requestId = crypto.randomUUID();
      requestKey = key;
      const payload = { requestId, ...draft, expectedRevision: s.data.revision, operation: 'speech' };
      preparing = true; repaint();
      try { const job = await invoke('aimedia.audio.prepare', payload); if (live()) { remember(job); attempted = false; } }
      catch (error) { if (live()) formError = A.errorText(error); }
      finally { if (live()) { preparing = false; repaint(); schedule(); } }
    }
    async function submit() {
      if (!live() || disabled() || confirming || active?.state !== 'prepared' || attempted) return;
      const job = active, epoch = s.epoch;
      confirming = true;
      const accepted = await A.confirm('确认付费合成语音？', `将使用「${job.profileName}」的 ${job.request.modelId}，以音色 ${job.request.voiceId} 合成 1 段 MP3。\n预估费用未知，按供应商实际用量计费，可能产生费用。\n确认后不会自动重试；结果未知时也可能已收费。`, '合成 1 段语音');
      confirming = false;
      if (!accepted || !live() || disabled() || epoch !== s.epoch || active?.revision !== job.revision || attempted) return;
      attempted = true; active = { ...job, state: 'submitting', charging: 'unknown' }; updateDetails(); schedule();
      try {
        const result = await invoke('aimedia.audio.submit', { jobId: job.id, requestHash: job.requestHash, confirm: true });
        if (!live() || active?.id !== job.id) return;
        if (result.id !== job.id) throw invalid();
        remember(result);
      } catch (error) {
        if (!live() || active?.id !== job.id) return;
        const rejected = ['INVALID_ARGUMENT', 'CONFLICT', 'NOT_FOUND', 'DISABLED', 'CREDENTIAL_REQUIRED', 'CREDENTIAL_ERROR', 'CREDENTIAL_UNAVAILABLE', 'GENERATION_UNSUPPORTED', 'GENERATION_BUSY', 'GENERATION_REQUEST_CONFLICT'].includes(error.code);
        if (rejected) { attempted = false; active = job; jobError = `尚未提交生成请求。${A.errorText(error)}`; }
        else { if (active.state === 'submitting') active = { ...active, state: 'unknown', charging: 'unknown' }; jobError = '提交结果尚不确定，供应商可能已收费。请勿重复提交。'; }
      } finally { if (live()) { updateDetails(); schedule(); } }
    }
    function reset() {
      if (!active || !['prepared', 'succeeded', 'failed'].includes(active.state)) return;
      if (active.state !== 'prepared') { requestId = null; draft.text = ''; }
      active = null; attempted = false; jobError = ''; preview.clear(); repaint(); document.getElementById('audio-text')?.focus();
    }
    function updateDetails() {
      if (!visible() || !detail || !active) return;
      const key = `${active.id}:${active.revision}:${active.state}:${jobError}:${disabled()}`;
      if (detailKey !== key) {
        detailKey = key;
        const request = active.request, info = h('dl', { class: 'generation-request' });
        for (const [label, value] of [['服务', active.profileName], ['模型', request.modelId], ['音色 ID', request.voiceId], ['语速', `${request.speed} ×`], ['格式', 'MP3 · 1 段'], ['预估费用', '未知 · 按供应商计费'], ['任务 ID', active.id]]) info.append(h('dt', {}, label), h('dd', {}, value));
        const next = h('div', {},
          h('h3', {}, labels[active.state] || '状态待核对'), h('p', { class: 'note', role: 'status', 'data-generation-state': active.state }, descriptions[active.state] || '请重新读取本地任务核对。'), info,
          h('details', { class: 'record-disclosure' }, h('summary', {}, '朗读文本'), h('p', { class: 'record-prompt-text' }, request.text)),
          (jobError || active.error) && h('p', { class: 'generation-error', role: 'alert' }, jobError || A.errorText(active.error)),
          h('div', { class: 'generation-actions' }, active.state === 'prepared' && button('确认合成…', submit, { class: 'primary', disabled: disabled() || confirming }),
            button('重新读取本地任务', () => { if (preview.failed(active.id)) preview.clear(); void refresh(); }, { disabled: disabled() })));
        detail.setAttribute('data-generation-job', active.id);
        statusSlot.replaceChildren(next);
        nextSlot.replaceChildren(...(['prepared', 'succeeded', 'failed'].includes(active.state) ? [button(active.state === 'prepared' ? '编辑请求' : '新建请求', reset, { disabled: disabled() || confirming })] : []));
      }
      if (active.result && previewSlot && lastPreview !== preview.key()) {
        lastPreview = preview.key(); const node = preview.view(active);
        if (previewSlot.firstChild !== node) previewSlot.replaceChildren(node);
      }
      if (active.state === 'succeeded' && active.result) void preview.load(active);
    }
    function formPicker(label, key, options, locked) {
      const control = picker(label, draft[key], options, value => { change(key, value); if (key === 'voiceId') repaint(); }, locked);
      control.querySelector('summary').id = `audio-${key}-picker`; return field(label, control);
    }
    function view() {
      const profile = eligible().find(p => p.id === draft.profileId), locked = disabled() || preparing || Boolean(active);
      detailKey = ''; lastPreview = '';
      statusSlot = h('div'); previewSlot = h('div', { class: 'audio-preview-slot' }); nextSlot = h('div', { class: 'footer' });
      detail = h('div', { class: 'card generation-detail audio-task' }, statusSlot, previewSlot, nextSlot);
      root = h('div', { class: 'generation-view audio-view', 'data-audio-generation': '' },
        h('div', { class: 'heading' }, h('h2', {}, '声音 · 语音合成')),
        note('使用 MiniMax 将文本朗读为语音。不支持脚步声、环境音或其他音效合成。'),
        !eligible().length && note('请先在「配置」中保存并启用 MiniMax 服务、API Key 和语音模型。'),
        h('form', { novalidate: true, 'aria-label': '语音合成请求', onsubmit: event => { event.preventDefault(); void prepare(); } },
          h('fieldset', { disabled: locked }, h('div', { class: 'card' },
            formPicker('MiniMax 服务', 'profileId', [{ value: '', label: '请选择服务' }, ...eligible().map(p => ({ value: p.id, label: p.name }))], locked),
            formPicker('语音模型', 'modelId', [{ value: '', label: '请选择模型' }, ...models(profile).map(m => ({ value: m.id, label: `${m.name || m.id} · ${m.id}` }))], locked),
            field('音色 ID', h('div', { class: 'audio-voice-controls' }, h('input', { id: 'audio-voiceId', 'aria-label': '音色 ID', value: draft.voiceId, maxlength: 128, oninput: event => change('voiceId', event.target.value) }),
              button(voiceLoading ? '正在获取…' : '获取音色', fetchVoices, { id: 'audio-fetch-voices', disabled: locked || voiceLoading || !profile })), '明确填写 ID，或获取所选服务的账号音色后选择。不会自动选择音色。'),
            voiceResult?.voices.length > 0 && formPicker('账号音色', 'voiceId', [{ value: '', label: '请选择音色' }, ...voiceResult.voices.map(v => ({ value: v.id, label: `${v.name} · ${v.id}` }))], locked),
            (voiceResult || voiceLoading || voiceError) && h('p', { class: voiceError ? 'generation-error audio-voice-status' : 'note audio-voice-status', role: voiceError ? 'alert' : 'status' }, voiceError || (voiceLoading ? '正在读取账号音色目录，不会合成语音。' : A.minimaxCatalogText(voiceResult, 'voices'))),
            field('朗读文本', h('textarea', { id: 'audio-text', 'aria-label': '朗读文本', value: draft.text, rows: 5, maxlength: 1000, oninput: event => change('text', event.target.value) }), '最多 1000 个字符。输入需要朗读的内容。'),
            field('语速', h('input', { id: 'audio-speed', type: 'number', 'aria-label': '语速', value: draft.speed, min: .5, max: 2, step: .1, oninput: event => change('speed', event.target.value === '' ? NaN : Number(event.target.value)) }), '0.5–2 倍，默认 1 倍。'),
            field('输出与费用', h('p', {}, 'MP3 · 1 段 · 预估费用未知'), '准备请求只保存到本地；确认合成后可能产生费用。'))),
          formError && h('p', { id: 'audio-form-error', class: 'generation-error', role: 'alert', tabindex: -1 }, formError),
          !active && h('div', { class: 'footer' }, button(preparing ? '正在准备…' : '准备语音', null, { type: 'submit', class: 'primary', disabled: locked || voiceLoading }))),
        active && section('语音任务', detail));
      updateDetails(); return root;
    }
    function screenChanged() { voiceTicket++; voiceLoading = false; preview.clear(); schedule(); }
    function visibilityChanged() { schedule(); if (visible()) { updateDetails(); void refresh(); } }
    document.addEventListener('visibilitychange', visibilityChanged);
    return { view, refresh, screenChanged, dispose() { alive = false; voiceTicket++; clearTimeout(timer); preview.clear(); document.removeEventListener('visibilitychange', visibilityChanged); } };
  };
})();
