(() => {
  'use strict';
  const A = window.AIMedia;
  const t = A.i18n.scope('workflow');
  const { h, button, input, field, picker, section, note } = A;

  const purposes = { prompt: t('prompt'), negativePrompt: t('negativePrompt'), seed: t('seed'), width: t('width'), height: t('height'), steps: t('steps'), duration: t('duration'), fps: t('fps'), inputImage: t('inputImage'), firstFrame: t('firstFrame'), lastFrame: t('lastFrame'), referenceImage1: t('referenceImage1'), referenceImage2: t('referenceImage2'), referenceImage3: t('referenceImage3'), referenceImage4: t('referenceImage4'), referenceImage5: t('referenceImage5'), referenceImage6: t('referenceImage6'), referenceImage7: t('referenceImage7'), referenceImage8: t('referenceImage8') };
  const controlLabels = { text: t('text'), number: t('number'), boolean: t('boolean'), image: t('image'), audio: t('audio'), video: t('video'), seed: t('randomSeed'), width: t('width'), height: t('height') };

  A.newWorkflow = () => ({
    id: A.id('workflow'),
    name: '',
    kind: 'image',
    connectionId: null,
    definition: {},
    bindings: [],
    enabled: true
  });

  function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function parseComfyPrompt(val) {
    if (!isRecord(val)) throw new Error(t('apiObjectRequired'));
    const entries = Object.entries(val);
    if (!entries.length || entries.length > 300) throw new Error(t('nodeCountRequired'));
    const prompt = {};
    for (const [nodeId, rawNode] of entries) {
      if (!isRecord(rawNode) || typeof rawNode.class_type !== 'string' || !rawNode.class_type || !isRecord(rawNode.inputs)) {
        throw new Error(t('nodeStructureRequired'));
      }
      prompt[nodeId] = {
        class_type: rawNode.class_type,
        inputs: { ...rawNode.inputs },
        ...(rawNode._meta ? { _meta: { ...rawNode._meta } } : {})
      };
    }
    return prompt;
  }

  function listMediaWorkflowFields(prompt) {
    const fields = [];
    for (const [nodeId, node] of Object.entries(prompt)) {
      const nodeTitle = node._meta?.title?.trim() || node.class_type;
      for (const [inp, val] of Object.entries(node.inputs || {})) {
        if (typeof val === 'string') {
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'string', editable: true });
        } else if (typeof val === 'number' && Number.isFinite(val)) {
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'number', editable: true });
        } else if (typeof val === 'boolean') {
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'boolean', editable: true });
        } else if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string' && Object.hasOwn(prompt, val[0]) && typeof val[1] === 'number') {
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'linked', editable: false, reason: t('linkedInput') });
        } else {
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'complex', editable: false, reason: t('complexInput') });
        }
      }
    }
    return fields;
  }

  function createFieldBinding(field, purpose) {
    return { purpose: purpose || 'prompt', nodeId: field.nodeId, input: field.input };
  }

  function validateBindings(definition) {
    if (!definition || !definition.prompt) return [];
    const issues = [];
    const keys = new Set();
    const targets = new Set();
    for (const b of (definition.bindings || [])) {
      if (keys.has(b.key)) issues.push({ message: t('duplicateKey', { p1: b.key }) });
      keys.add(b.key);
      const target = `${b.nodeId}\\0${b.input}`;
      if (targets.has(target)) issues.push({ message: t('duplicateTarget', { p1: b.nodeId, p2: b.input }) });
      targets.add(target);
      const node = definition.prompt[b.nodeId];
      if (!node) {
        issues.push({ message: t('missingNode', { p1: b.nodeId }) });
      } else if (!Object.hasOwn(node.inputs || {}, b.input)) {
        issues.push({ message: t('missingInput', { p1: b.nodeId, p2: b.input }) });
      }
    }
    return issues;
  }

  A.parseWorkflow = (draft, text) => {
    if (!draft.name.trim()) throw new Error(t('nameRequired'));
    if (new TextEncoder().encode(text).length > 200 * 1024) throw new Error(t('jsonTooLarge'));
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(t('invalidJson')); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('apiObjectRequired'));

    let definition;
    if (parsed.schemaVersion === 1 && isRecord(parsed.prompt)) {
      definition = parseComfyPrompt(parsed.prompt);
    } else {
      definition = parseComfyPrompt(parsed);
    }
    const rawNodes = definition;
    // 校验绑定目标是否合法
    const used = new Set(), targets = new Set();
    for (const binding of (draft.bindings || [])) {
      if (!Object.hasOwn(rawNodes, binding.nodeId) || !Object.hasOwn(rawNodes[binding.nodeId]?.inputs || {}, binding.input)) {
        throw new Error(t('missingTarget'));
      }
      const target = JSON.stringify([binding.nodeId, binding.input]);
      if ((binding.purpose && used.has(binding.purpose)) || targets.has(target)) {
        throw new Error(t('duplicateBinding'));
      }
      if (binding.purpose) used.add(binding.purpose);
      targets.add(target);
    }
    return { ...A.clone(draft), definition };
  };

  A.workflowView = C => {
    const s = C.state, d = s.draft;
    const set = (key, value, render = false) => { d[key] = value; C.touch(); if (render) C.render(); };

    // 保证 definition 结构完备
    let promptObj = {};
    if (d.definition) {
      promptObj = d.definition.prompt || (d.definition.schemaVersion === 1 ? {} : d.definition);
    }

    const rawNodeEntries = Object.entries(promptObj);
    const nodeIds = rawNodeEntries.map(([id]) => id);
    if (!s.selectedNodeId || !nodeIds.includes(s.selectedNodeId)) {
      s.selectedNodeId = nodeIds[0] || '';
    }
    const workflowKey = nodeIds.length ? `${d.kind}:${JSON.stringify(promptObj)}` : '';
    if (workflowKey && s.workflowMatchKey !== workflowKey && !s.workflowMatchPending && typeof C.matchWorkflow === 'function') {
      s.workflowMatchKey = workflowKey; s.workflowMatchPending = true;
      Promise.resolve().then(() => C.matchWorkflow({ kind: d.kind, definition: promptObj })).then(result => {
        if (!s.alive || s.draft !== d || s.workflowMatchKey !== workflowKey) return;
        s.workflowMatch = result; s.workflowMatchPending = false; C.render();
      }).catch(() => {
        if (!s.alive || s.draft !== d || s.workflowMatchKey !== workflowKey) return;
        s.workflowMatch = null; s.workflowMatchPending = false; C.render();
      });
    }
    const match = s.workflowMatchKey === workflowKey ? s.workflowMatch : null;

    const basics = h('div', { class: 'duty-card' },
      field(t('name'), input(t('name'), d.name, value => set('name', value), { maxlength: 128, placeholder: t('nameExample'), disabled: s.busy })),
      field(t('connection'), picker(t('workflowConnection'), d.connectionId, [{ value: null, label: t('unbound') }, ...s.data.profiles.filter(p => p.provider === 'comfyui').map(p => ({ value: p.id, label: p.name + (p.enabled ? '' : t('disabledSuffix')) }))], value => set('connectionId', value, true), s.busy), t('connectionHelp')),
      field(t('mediaType'), picker(t('mediaType'), d.kind || 'image', Object.entries(A.kinds).map(([value, label]) => ({ value, label })), value => set('kind', value, true), s.busy)),
      field(t('status'), A.toggle(t('enable'), d.enabled, value => set('enabled', value, true), s.busy)));

    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('importFile'), hidden: true, onchange: async e => {
      const selected = e.target.files?.[0]; if (!selected || s.busy) return;
      const epoch = s.epoch, version = s.editVersion, ticket = ++s.importTicket;
      s.importing = true; C.render();
      try {
        if (selected.size > 200 * 1024) throw new Error(t('fileTooLarge'));
        const text = await selected.text();
        if (epoch !== s.epoch || ticket !== s.importTicket || !s.alive) return;
        if (version !== s.editVersion) { s.importing = false; C.message(t('staleImport'), 'error'); return; }
        s.jsonText = text; s.importing = false; C.touch();
        try {
          const res = A.parseWorkflow({ ...d, name: d.name || 'import' }, text);
          d.definition = res.definition;
          s.notice = { text: t('fileImported'), type: 'success' };
        } catch (error) {
          s.notice = { text: error.message, type: 'error' };
        }
        C.render();
      } catch (error) {
        if (epoch === s.epoch && ticket === s.importTicket && s.alive) {
          s.importing = false;
          C.message(error.message === t('fileTooLarge') ? error.message : t('fileReadFailed'), 'error');
        }
      }
    } });

    const parseBtn = button(t('parseJson'), () => {
      try {
        const res = A.parseWorkflow(d, s.jsonText);
        d.definition = res.definition;
        const count = Object.keys(res.definition?.prompt || res.definition || {}).length;
        C.message(t('parsed', { p1: count }), 'success');
      } catch (err) {
        C.message(err.message, 'error');
      }
    }, { class: 'duty-test-btn', disabled: s.busy || !s.jsonText?.trim() });

    const importBtn = button(s.importing ? t('readingFile') : t('importJson'), () => file.click(), { class: 'duty-test-btn', disabled: s.busy || s.importing });
    const jsonActions = h('div', { class: 'inline' }, importBtn, parseBtn);

    const definitionCard = h('div', { class: 'duty-card' },
      h('div', { class: 'block' },
        h('textarea', { id: 'workflow-json', class: 'code', 'aria-label': 'API JSON', spellcheck: 'false', placeholder: t('jsonPlaceholder'), disabled: s.busy, oninput: e => { s.jsonText = e.target.value; C.touch(); } }, s.jsonText)),
      note(t('jsonHelp')),
      file);
    const applySuggestedBindings = () => {
      if (!match?.suggestedBindings?.length) return;
      d.bindings = match.suggestedBindings.map(binding => ({ ...binding }));
      C.touch(); C.render();
    };
    const applyOutputCandidate = candidate => {
      d.outputs = [{ kind: d.kind, nodeId: candidate.nodeId, field: candidate.field, index: candidate.index }];
      d.executable = false;
      C.touch(); C.render();
    };
    const matchingCard = nodeIds.length ? h('div', { class: 'duty-card', 'data-workflow-matches': '' },
      s.workflowMatchPending && note(t('matching')),
      match && note(t('matchSummary', { p1: match.inputs.length, p2: match.outputCandidates.length })),
      match?.inputs?.length ? h('div', { class: 'duty-workflow-match-list' }, match.inputs.map(item => h('div', { class: 'duty-workflow-match-row' },
        h('span', {}, `${item.title || item.classType} · ${item.nodeId}.${item.input}`),
        h('strong', {}, purposes[item.purpose] || item.purpose)))) : match && note(t('noMatchedInputs')),
      match?.suggestedBindings?.length ? button(t('applySuggestedBindings'), applySuggestedBindings, { class: 'fetch-supplier-btn', disabled: s.busy }) : null,
      match?.outputCandidates?.length ? h('div', { class: 'duty-workflow-output-candidates' },
        note(t('outputCandidates')),
        match.outputCandidates.map(candidate => button(t('useOutputCandidate', { p1: candidate.title || candidate.classType, p2: candidate.nodeId }), () => applyOutputCandidate(candidate), { class: 'quiet', disabled: s.busy }))) : match && note(t('noMatchedOutput'))
    ) : null;

    // 节点真实输入与绑定编辑器（DutyDeck WorkflowDefinitionEditor 风格）
    const allFields = listMediaWorkflowFields(promptObj);
    const visibleFields = allFields.filter(f => f.nodeId === s.selectedNodeId);

    const nodeSelector = picker(t('selectNode'), s.selectedNodeId, nodeIds.map(nid => {
      const node = promptObj[nid];
      return { value: nid, label: `${node?._meta?.title || node?.class_type || 'Node'} · ${nid}` };
    }), value => { s.selectedNodeId = value; C.render(); }, s.busy);

    const nodeFieldsList = h('div', { class: 'duty-node-fields-list' });
    const suggestedByTarget = new Map((match?.inputs || []).map(item => [`${item.nodeId}\u0000${item.input}`, item]));
    const purposeOptions = Object.entries(purposes).map(([value, label]) => ({ value, label }));
    if (!visibleFields.length) {
      nodeFieldsList.append(A.empty(t('noInputs'), t('selectOtherNode')));
    } else {
      visibleFields.forEach(fieldItem => {
        const target = `${fieldItem.nodeId}\u0000${fieldItem.input}`;
        const suggestion = suggestedByTarget.get(target);
        const binding = (d.bindings || []).find(item => item.nodeId === fieldItem.nodeId && item.input === fieldItem.input);
        const isBound = Boolean(binding);
        const itemBox = h('div', { class: 'duty-field-item' },
          h('label', { class: 'duty-field-check-row' },
            h('input', {
              type: 'checkbox',
              checked: isBound,
              disabled: !fieldItem.editable || s.busy,
              onchange: e => {
                const checked = e.target.checked;
                let bindings = d.bindings || [];
                if (!checked) {
                  bindings = bindings.filter(item => !(item.nodeId === fieldItem.nodeId && item.input === fieldItem.input));
                } else {
                  const purpose = suggestion?.purpose || 'prompt';
                  if (bindings.some(item => item.purpose === purpose)) {
                    e.target.checked = false;
                    C.message(t('duplicatePurpose'), 'error');
                    return;
                  }
                  bindings = [...bindings, createFieldBinding(fieldItem, purpose)];
                }
                d.bindings = bindings;
                C.touch(); C.render();
              }
            }),
            h('div', { class: 'duty-field-meta' },
              h('span', { class: 'duty-field-name' }, `${fieldItem.nodeTitle} · ${fieldItem.input}`),
              h('span', { class: 'duty-field-value' }, t('defaultValue', { p1: JSON.stringify(fieldItem.value), p2: fieldItem.reason ? ` · ${fieldItem.reason}` : '' })),
              suggestion && h('span', { class: 'duty-field-suggestion' }, t('matchedPurpose', { p1: purposes[suggestion.purpose] || suggestion.purpose })))
          ),
          isBound && field(t('bindingPurposeLabel'), picker(t('bindingPurpose', { p1: fieldItem.input }), binding.purpose, purposeOptions, value => {
            if ((d.bindings || []).some(item => item !== binding && item.purpose === value)) {
              C.message(t('duplicatePurpose'), 'error');
              return;
            }
            binding.purpose = value; C.touch(); C.render();
          }, s.busy))
        );
        nodeFieldsList.append(itemBox);
      });
    }

    const nodeInspectionCard = h('div', { class: 'duty-card duty-workflow-nodes-card' },
      field(t('node'), nodeSelector),
      nodeFieldsList);

    // 保持原有简单绑定行的兼容性（针对自动化测试）
    const legacyBindings = h('div', { class: 'duty-card' });
    if (!(d.bindings || []).length) legacyBindings.append(A.empty(t('noBindings'), t('bindingsHelp')));
    (d.bindings || []).forEach((binding, index) => {
      const update = (key, value) => { binding[key] = value; C.touch(); };
      legacyBindings.append(h('div', { class: 'model-row binding-row' },
        h('div', {}, h('label', {}, t('purpose')), picker(t('bindingPurpose', { p1: index + 1 }), binding.purpose || 'prompt', Object.entries(purposes).map(([value, label]) => ({ value, label })), value => { update('purpose', value); C.render(); }, s.busy)),
        h('div', {}, h('label', { for: `binding-node-${index}` }, t('nodeId')), input(t('bindingNode', { p1: index + 1 }), binding.nodeId, value => update('nodeId', value), { id: `binding-node-${index}`, disabled: s.busy })),
        h('div', {}, h('label', { for: `binding-input-${index}` }, t('inputField')), input(t('bindingInput', { p1: index + 1 }), binding.input, value => update('input', value), { id: `binding-input-${index}`, disabled: s.busy })),
        button('', () => { d.bindings.splice(index, 1); C.touch(); C.render(); }, { class: 'model-remove-btn', 'aria-label': t('removeBinding', { p1: index + 1 }), title: t('removeBinding', { p1: index + 1 }), disabled: s.busy })));
      legacyBindings.querySelector(`.model-row:last-child .model-remove-btn`)?.append(A.svgIcon('x', 14));
    });

    const addBindingBtn = button(t('addBinding'), () => {
      d.bindings = d.bindings || [];
      d.bindings.push({ purpose: 'prompt', nodeId: '', input: '' });
      C.touch(); C.render();
    }, { class: 'fetch-supplier-btn', disabled: s.busy || (d.bindings && d.bindings.length >= 12) });

    const outputRule = d.outputs?.[0] || { kind: d.kind || 'image', nodeId: '', field: ({ image: 'images', video: 'videos', audio: 'audio' })[d.kind || 'image'], index: 0 };
    const outputFields = { image: 'images', video: 'videos', audio: 'audio' };
    const setOutput = (key, value) => {
      const next = { ...outputRule, kind: d.kind, field: outputFields[d.kind], [key]: key === 'index' ? Number(value) : value };
      if (!next.nodeId) { d.outputs = []; d.executable = false; }
      else d.outputs = [next];
      C.touch(); C.render();
    };
    const outputCard = h('div', { class: 'duty-card' },
      field(t('outputKind'), picker(t('outputKind'), outputRule.kind, Object.entries(A.kinds).filter(([key]) => ['image', 'video', 'audio'].includes(key)).map(([value, label]) => ({ value, label })), value => { d.kind = value; setOutput('kind', value); }, s.busy)),
      field(t('outputNode'), input(t('outputNode'), outputRule.nodeId || '', value => setOutput('nodeId', value.trim()), { maxlength: 128, placeholder: t('outputNodeExample'), disabled: s.busy })),
      field(t('outputIndex'), input(t('outputIndex'), String(outputRule.index ?? 0), value => setOutput('index', value), { type: 'number', min: 0, max: 99, step: 1, disabled: s.busy })),
      note(t('outputHelp')),
      A.toggle(t('executable'), d.executable === true && d.outputs?.length > 0, value => { if (value && !(d.outputs || []).length) { C.message(t('outputNodeRequired'), 'error'); return; } d.executable = value; C.touch(); C.render(); }, s.busy));

    const view = h('div', { class: 'duty-editor' },
      section(t('basics'), basics),
      section('ComfyUI API JSON', definitionCard, jsonActions),
      matchingCard,
      section(t('outputRule'), outputCard),
      nodeIds.length ? section(t('nodeParameters'), nodeInspectionCard) : null,
      section(t('bindings'), legacyBindings, addBindingBtn),
      section(t('nodeCheck'), h('div', { class: 'duty-card' }, note(s.probe ? A.probeText(s.probe) : t('nodeCheckHelp')), s.probe?.nodeTypes?.length ? note(t('nodeTypes', { p1: s.probe.nodeTypes.join('、') })) : null),
        button(t('checkNodes'), () => C.probe(), { 'data-probe': '', class: 'fetch-supplier-btn', disabled: !C.canProbe() })));
    return view;
  };
})();
