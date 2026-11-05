(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, input, field, picker, section, note } = A;

  const purposes = { prompt: '提示词', negativePrompt: '负面提示词', seed: '种子', width: '宽度', height: '高度', steps: '步数' };
  const controlLabels = { text: '文本', number: '数字', boolean: '布尔值', image: '图片', audio: '音频', video: '视频', seed: '随机种子', width: '宽度', height: '高度' };

  A.newWorkflow = () => ({
    id: A.id('workflow'),
    name: '',
    kind: 'image',
    connectionId: null,
    definition: { schemaVersion: 1, prompt: {}, bindings: [], outputs: [] },
    bindings: [],
    enabled: true
  });

  function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function parseComfyPrompt(val) {
    if (!isRecord(val)) throw new Error('请导入 API 格式的 JSON 对象。');
    const entries = Object.entries(val);
    if (!entries.length || entries.length > 300) throw new Error('工作流需要 1–300 个 API 节点。');
    const prompt = {};
    for (const [nodeId, rawNode] of entries) {
      if (!isRecord(rawNode) || typeof rawNode.class_type !== 'string' || !rawNode.class_type || !isRecord(rawNode.inputs)) {
        throw new Error('每个 API 节点都需要 class_type 和 inputs 对象；请勿导入画布格式。');
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
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'linked', editable: false, reason: '该输入来自其他节点连线，不能直接覆盖。' });
        } else {
          fields.push({ nodeId, input: inp, classType: node.class_type, nodeTitle, value: val, valueKind: 'complex', editable: false, reason: '数组、对象或空值不能映射为填写项。' });
        }
      }
    }
    return fields;
  }

  function controlsForField(field) {
    if (field.valueKind === 'boolean') return ['boolean'];
    if (field.valueKind === 'number') return ['number', 'seed', 'width', 'height'];
    const controls = ['text'];
    if (field.classType === 'LoadImage' && field.input === 'image') controls.push('image');
    if (field.classType === 'LoadAudio' && field.input === 'audio') controls.push('audio');
    if (field.classType === 'LoadVideo' && field.input === 'file') controls.push('video');
    return controls;
  }

  function createFieldBinding(field, controlType) {
    const selectedControl = controlType || (field.valueKind === 'string' ? 'text' : field.valueKind);
    const isMedia = ['image', 'audio', 'video'].includes(selectedControl);
    const loader = selectedControl === 'image' ? 'LoadImage' : selectedControl === 'audio' ? 'LoadAudio' : selectedControl === 'video' ? 'LoadVideo' : undefined;
    const kind = isMedia ? selectedControl : selectedControl === 'text' ? 'text' : selectedControl === 'boolean' ? 'boolean' : 'number';
    return {
      key: `${field.nodeId}.${field.input}`,
      kind,
      nodeId: field.nodeId,
      input: field.input,
      ...(loader ? { loader } : {}),
      field: {
        classType: field.classType,
        valueKind: field.valueKind,
        label: field.input,
        controlType: selectedControl,
        required: true,
        ...(selectedControl === 'seed' ? { min: 0, step: 1 } : {}),
        ...(selectedControl === 'width' || selectedControl === 'height' ? { min: 1, step: 1 } : {})
      }
    };
  }

  function validateBindings(definition) {
    if (!definition || !definition.prompt) return [];
    const issues = [];
    const keys = new Set();
    const targets = new Set();
    for (const b of (definition.bindings || [])) {
      if (keys.has(b.key)) issues.push({ message: `绑定 key 重复：${b.key}` });
      keys.add(b.key);
      const target = `${b.nodeId}\\0${b.input}`;
      if (targets.has(target)) issues.push({ message: `节点输入被重复绑定：${b.nodeId}.${b.input}` });
      targets.add(target);
      const node = definition.prompt[b.nodeId];
      if (!node) {
        issues.push({ message: `节点已不存在：${b.nodeId}` });
      } else if (!Object.hasOwn(node.inputs || {}, b.input)) {
        issues.push({ message: `节点输入已不存在：${b.nodeId}.${b.input}` });
      }
    }
    return issues;
  }

  A.parseWorkflow = (draft, text) => {
    if (!draft.name.trim()) throw new Error('请填写工作流名称。');
    if (new TextEncoder().encode(text).length > 200 * 1024) throw new Error('工作流 JSON 不能超过 200 KiB。');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('JSON 格式无效，请检查括号、引号和逗号。原文已保留。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请导入 API 格式的 JSON 对象。');

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
        throw new Error('绑定目标不存在，请核对节点 ID 和输入字段。');
      }
      const target = JSON.stringify([binding.nodeId, binding.input]);
      if ((binding.purpose && used.has(binding.purpose)) || targets.has(target)) {
        throw new Error('绑定用途和目标不可重复。');
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

    const basics = h('div', { class: 'duty-card' },
      field('工作流名称', input('工作流名称', d.name, value => set('name', value), { maxlength: 128, placeholder: '例如：文生图高分辨率工作流', disabled: s.busy })),
      field('服务链接', picker('工作流服务链接', d.connectionId, [{ value: null, label: '未绑定' }, ...s.data.profiles.filter(p => p.provider === 'comfyui').map(p => ({ value: p.id, label: p.name + (p.enabled ? '' : ' · 已停用') }))], value => set('connectionId', value, true), s.busy), '可先保存为未绑定，再选择已保存的 ComfyUI 连接。'),
      field('媒体类型', picker('媒体类型', d.kind || 'image', Object.entries(A.kinds).map(([value, label]) => ({ value, label })), value => set('kind', value, true), s.busy)),
      field('使用状态', A.toggle('启用此工作流', d.enabled, value => set('enabled', value, true), s.busy)));

    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '导入 API JSON 文件', hidden: true, onchange: async e => {
      const selected = e.target.files?.[0]; if (!selected || s.busy) return;
      const epoch = s.epoch, version = s.editVersion, ticket = ++s.importTicket;
      s.importing = true; C.render();
      try {
        if (selected.size > 200 * 1024) throw new Error('文件不能超过 200 KiB。');
        const text = await selected.text();
        if (epoch !== s.epoch || ticket !== s.importTicket || !s.alive) return;
        if (version !== s.editVersion) { s.importing = false; C.message('导入期间内容已修改，已忽略迟到的文件内容。请按需重新导入。', 'error'); return; }
        s.jsonText = text; s.importing = false; C.touch();
        try {
          const res = A.parseWorkflow({ ...d, name: d.name || 'import' }, text);
          d.definition = res.definition;
          s.notice = { text: '文件已导入并解析有效，请核对绑定后保存。', type: 'success' };
        } catch (error) {
          s.notice = { text: error.message, type: 'error' };
        }
        C.render();
      } catch (error) {
        if (epoch === s.epoch && ticket === s.importTicket && s.alive) {
          s.importing = false;
          C.message(error.message === '文件不能超过 200 KiB。' ? error.message : '文件读取失败，原有内容已保留。', 'error');
        }
      }
    } });

    const parseBtn = button('解析 JSON', () => {
      try {
        const res = A.parseWorkflow(d, s.jsonText);
        d.definition = res.definition;
        const count = Object.keys(res.definition?.prompt || res.definition || {}).length;
        C.message(`JSON 解析有效 · 包含 ${count} 个 API 节点`, 'success');
      } catch (err) {
        C.message(err.message, 'error');
      }
    }, { class: 'duty-test-btn', disabled: s.busy || !s.jsonText?.trim() });

    const importBtn = button(s.importing ? '正在读取文件…' : '导入 JSON', () => file.click(), { class: 'duty-test-btn', disabled: s.busy || s.importing });
    const jsonActions = h('div', { class: 'inline' }, importBtn, parseBtn);

    const definitionCard = h('div', { class: 'duty-card' },
      h('div', { class: 'block' },
        h('textarea', { id: 'workflow-json', class: 'code', 'aria-label': 'API JSON', spellcheck: 'false', placeholder: '在此粘贴从 ComfyUI 导出的 API 格式 JSON', disabled: s.busy, oninput: e => { s.jsonText = e.target.value; C.touch(); } }, s.jsonText)),
      note('从 ComfyUI 导出 API 格式。最多 200 KiB、300 个节点；不要包含密钥或认证信息。'),
      file);

    // 节点真实输入与绑定编辑器（DutyDeck WorkflowDefinitionEditor 风格）
    const allFields = listMediaWorkflowFields(promptObj);
    const visibleFields = allFields.filter(f => f.nodeId === s.selectedNodeId);

    const nodeSelector = picker('选择查看节点', s.selectedNodeId, nodeIds.map(nid => {
      const node = promptObj[nid];
      return { value: nid, label: `${node?._meta?.title || node?.class_type || 'Node'} · ${nid}` };
    }), value => { s.selectedNodeId = value; C.render(); }, s.busy);

    const nodeFieldsList = h('div', { class: 'duty-node-fields-list' });
    if (!visibleFields.length) {
      nodeFieldsList.append(A.empty('该节点没有输入字段', '请选择其他节点配置输入'));
    } else {
      visibleFields.forEach(fieldItem => {
        const binding = (d.definition?.bindings || d.bindings || []).find(b => b.nodeId === fieldItem.nodeId && b.input === fieldItem.input);
        const isBound = Boolean(binding);
        const itemBox = h('div', { class: 'duty-field-item' },
          h('label', { class: 'duty-field-check-row' },
            h('input', {
              type: 'checkbox',
              checked: isBound,
              disabled: !fieldItem.editable || s.busy,
              onchange: e => {
                const checked = e.target.checked;
                let bindings = d.definition?.bindings || d.bindings || [];
                if (!checked) {
                  bindings = bindings.filter(b => !(b.nodeId === fieldItem.nodeId && b.input === fieldItem.input));
                } else {
                  bindings = [...bindings, createFieldBinding(fieldItem)];
                }
                if (d.definition) d.definition.bindings = bindings;
                d.bindings = bindings;
                C.touch(); C.render();
              }
            }),
            h('div', { class: 'duty-field-meta' },
              h('span', { class: 'duty-field-name' }, fieldItem.input),
              h('span', { class: 'duty-field-value' }, `默认值：${JSON.stringify(fieldItem.value)}${fieldItem.reason ? ` · ${fieldItem.reason}` : ''}`))
          )
        );

        if (binding?.field) {
          const controls = controlsForField(fieldItem);
          const metaGrid = h('div', { class: 'duty-binding-config-grid' },
            field('字段 Key', input(`字段 Key`, binding.key, val => { binding.key = val; C.touch(); }, { disabled: s.busy })),
            field('标签', input(`标签`, binding.field.label, val => { binding.field.label = val; C.touch(); }, { disabled: s.busy })),
            field('控件类型', picker('控件类型', binding.field.controlType, controls.map(c => ({ value: c, label: controlLabels[c] || c })), val => {
              const recreated = createFieldBinding(fieldItem, val);
              Object.assign(binding, recreated, { key: binding.key });
              binding.field.label = fieldItem.input;
              C.touch(); C.render();
            }, s.busy)),
            h('label', { class: 'inline-checkbox-label' },
              h('input', {
                type: 'checkbox',
                checked: binding.field.required,
                disabled: s.busy,
                onchange: e => { binding.field.required = e.target.checked; C.touch(); }
              }),
              '必填项')
          );
          itemBox.append(metaGrid);
        }
        nodeFieldsList.append(itemBox);
      });
    }

    const nodeInspectionCard = h('div', { class: 'duty-card duty-workflow-nodes-card' },
      field('节点', nodeSelector),
      nodeFieldsList);

    // 保持原有简单绑定行的兼容性（针对自动化测试）
    const legacyBindings = h('div', { class: 'duty-card' });
    if (!(d.bindings || []).length) legacyBindings.append(A.empty('暂无输入绑定', '按需关联提示词、种子或尺寸等输入。'));
    (d.bindings || []).forEach((binding, index) => {
      const update = (key, value) => { binding[key] = value; C.touch(); };
      legacyBindings.append(h('div', { class: 'model-row binding-row' },
        h('div', {}, h('label', {}, '用途'), picker(`绑定 ${index + 1} 用途`, binding.purpose || 'prompt', Object.entries(purposes).map(([value, label]) => ({ value, label })), value => { update('purpose', value); C.render(); }, s.busy)),
        h('div', {}, h('label', { for: `binding-node-${index}` }, '节点 ID'), input(`绑定 ${index + 1} 节点 ID`, binding.nodeId, value => update('nodeId', value), { id: `binding-node-${index}`, disabled: s.busy })),
        h('div', {}, h('label', { for: `binding-input-${index}` }, '输入字段'), input(`绑定 ${index + 1} 输入字段`, binding.input, value => update('input', value), { id: `binding-input-${index}`, disabled: s.busy })),
        button('', () => { d.bindings.splice(index, 1); C.touch(); C.render(); }, { class: 'model-remove-btn', 'aria-label': `移除绑定 ${index + 1}`, title: `移除绑定 ${index + 1}`, disabled: s.busy })));
      legacyBindings.querySelector(`.model-row:last-child .model-remove-btn`)?.append(A.svgIcon('x', 14));
    });

    const addBindingBtn = button('添加绑定', () => {
      d.bindings = d.bindings || [];
      d.bindings.push({ purpose: 'prompt', nodeId: '', input: '' });
      C.touch(); C.render();
    }, { class: 'fetch-supplier-btn', disabled: s.busy || (d.bindings && d.bindings.length >= 12) });

    const view = h('div', { class: 'duty-editor' },
      section('基本信息', basics),
      section('ComfyUI API JSON', definitionCard, jsonActions),
      nodeIds.length ? section('节点参数与表单绑定', nodeInspectionCard) : null,
      section('输入绑定', legacyBindings, addBindingBtn),
      section('节点检查', h('div', { class: 'duty-card' }, note(s.probe ? A.probeText(s.probe) : '保存并启用工作流及其连接后，可只读检查服务与节点类型。'), s.probe?.nodeTypes?.length ? note(`节点类型：${s.probe.nodeTypes.join('、')}`) : null),
        button('检查工作流节点', () => C.probe(), { 'data-probe': '', class: 'fetch-supplier-btn', disabled: !C.canProbe() })));
    return view;
  };
})();
