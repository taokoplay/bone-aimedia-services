/* Shared accessible controls. All user and provider text is inserted as text. */
(() => {
  'use strict';
  const A = window.AIMedia = {};
  const h = A.h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'class') node.setAttribute('class', value);
      else if (['value', 'checked', 'disabled'].includes(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    children.flat(Infinity).forEach(child => {
      if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  };
  A.kinds = { image: '图片', video: '视频', audio: '音频' };
  A.capabilityText = model => {
    const kind = model.kind || 'image';
    if (kind === 'image') return '文生图 / 图生图';
    if (kind === 'video') return '文生视频 / 图生视频';
    if (kind === 'audio') return '语音合成';
    return '媒体生成';
  };
  A.svgIcon = (name, size = 16) => {
    const icons = {
      copy: '<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>',
      pencil: '<path d=\"M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z\"/><path d=\"m15 5 4 4\"/>',
      trash: '<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/>',
      eye: '<path d=\"M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>',
      eyeOff: '<path d=\"M9.88 9.88a3 3 0 1 0 4.24 4.24\"/><path d=\"M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68\"/><path d=\"M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61\"/><line x1=\"2\" x2=\"22\" y1=\"2\" y2=\"22\"/>',
      checkCircle: '<circle cx=\"12\" cy=\"12\" r=\"10\" stroke=\"#10b981\" stroke-width=\"1.75\" fill=\"none\"/><path d=\"m9 12 2 2 4-4\" stroke=\"#10b981\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',
      plus: '<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>',
      download: '<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"/>',
      x: '<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>',
      search: '<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>',
      testTube: '<path d=\"M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5h0c-1.4 0-2.5-1.1-2.5-2.5V2\"/><path d=\"M8.5 2h7\"/><path d=\"M14.5 16h-5\"/>',
      workflow: '<rect width=\"8\" height=\"8\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M7 11v4a2 2 0 0 0 2 2h4\"/><rect width=\"8\" height=\"8\" x=\"13\" y=\"13\" rx=\"2\"/>'
    };
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('class', `icon icon-${name}`);
    el.innerHTML = icons[name] || '';
    return el;
  };
  A.clone = value => structuredClone(value);
  A.id = prefix => `${prefix}-${crypto.randomUUID()}`;
  A.button = (text, action, attrs = {}) => h('button', { type: 'button', onclick: action, ...attrs }, text);
  A.input = (label, value, change, attrs = {}) => h('input', { 'aria-label': label, value, oninput: e => change(e.target.value), ...attrs });
  A.field = (label, control, description) => h('div', { class: 'field' },
    h('div', { class: 'field-copy' }, h('div', { class: 'row-title' }, label), description && h('p', {}, description)),
    h('div', { class: 'field-control' }, control));
  A.section = (title, content, action) => h('section', {}, h('div', { class: 'section-heading' }, h('h3', {}, title), action), content);
  A.note = text => h('p', { class: 'note' }, text);
  A.empty = (title, description) => h('div', { class: 'empty' }, h('strong', {}, title), h('p', {}, description));
  A.picker = (label, value, options, change, disabled = false) => {
    const selected = options.find(option => option.value === value);
    const details = h('details', { class: 'picker' });
    const summary = h('summary', { role: 'button', 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-disabled': String(disabled), tabindex: disabled ? -1 : 0 }, selected?.label || value || '未选择');
    const list = h('ul', { class: 'options', role: 'listbox', 'aria-label': label });
    const buttons = options.map(option => {
      const button = A.button(option.label, () => {
        details.open = false;
        change(option.value);
        if (summary.isConnected) summary.focus();
        else document.querySelector(`summary[aria-label="${CSS.escape(label)}"]`)?.focus();
      }, { role: 'option', 'aria-selected': String(option.value === value), disabled });
      list.append(h('li', { role: 'presentation' }, button));
      return button;
    });
    summary.addEventListener('click', e => { if (disabled) e.preventDefault(); });
    details.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(details.open));
      if (details.open) document.querySelectorAll('details.picker[open]').forEach(other => { if (other !== details) other.open = false; });
    });
    details.addEventListener('keydown', e => {
      if (disabled) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); details.open = false; summary.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); details.open = true;
        let index = buttons.indexOf(document.activeElement);
        if (e.key === 'Home') index = 0;
        else if (e.key === 'End') index = buttons.length - 1;
        else index = (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
    });
    details.addEventListener('focusout', e => { if (!details.contains(e.relatedTarget)) details.open = false; });
    details.append(summary, list);
    return details;
  };
  A.toggle = (label, checked, change, disabled) => h('label', { class: 'switch-line' },
    h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onchange: e => change(e.target.checked) }), label);
  A.confirm = (title, text, accept = '放弃修改') => new Promise(resolve => {
    const oldFocus = document.activeElement;
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'confirm-title' }, h('h2', { id: 'confirm-title' }, title), h('p', {}, text));
    const finish = value => { dialog.close(); dialog.remove(); if (oldFocus?.isConnected) oldFocus.focus(); resolve(value); };
    const cancel = A.button('取消', () => finish(false));
    dialog.append(h('div', { class: 'actions' }, cancel, A.button(accept, () => finish(true), { class: 'primary' })));
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
  A.cleanProfile = profile => {
    const keys = ['id', 'name', 'provider', 'enabled', 'baseUrl', 'models', 'modelId', 'voice', 'format', 'cliPath', 'comfyUser', 'authKind', 'headerName', 'workflow', 'bindings'];
    return Object.fromEntries(keys.filter(key => Object.hasOwn(profile, key)).map(key => [key, A.clone(profile[key])]));
  };
  A.errorText = error => ({
    CONFLICT: '配置已在其他页面更新。当前输入已保留，请重新读取后再编辑。',
    INVALID_ARGUMENT: '配置未通过校验。请检查名称、服务地址、模型及引用；输入已保留。',
    DISABLED: '请先保存并启用此配置。',
    PROBE_PENDING: '已有目录查询正在进行，请稍后再试。',
    NOT_FOUND: '配置已不存在，请重新读取。',
    STORAGE_ERROR: '无法保存配置，请检查本地存储后重新读取。',
    DISPOSED: '服务已重启，请重新读取配置；已保存密钥会自动恢复。',
    CREDENTIAL_UNAVAILABLE: '当前系统无法使用插件密钥存储；此版本支持 macOS 钥匙串，原配置已保留。',
    PLUGIN_RELOAD_REQUIRED: '插件后台尚未更新，请在插件管理中重载 Bone AI 媒体服务后重新打开页面。',
    CREDENTIAL_ERROR: '密钥无法安全保存或恢复，请检查登录钥匙串是否解锁、允许访问；原配置已保留。',
    CREDENTIAL_LEGACY: '配置使用旧版宿主加密格式，需要原加密环境才能恢复；原文件已保留。',
    GENERATION_UNSUPPORTED: '请选择已配置的 GPT 图片模型；当前仅支持 GPT 文生图。',
    GENERATION_BUSY: '已有图片任务正在生成，请等待后再提交。',
    GENERATION_LIMIT: '本地生图记录已达到容量上限，未提交新的生成请求。',
    GENERATION_UNKNOWN: '生成结果尚不确定，请先检查供应商记录，勿直接重复生成。',
    GENERATION_REQUEST_CONFLICT: '任务参数与已准备请求不一致，请重新核对。',
    RESULT_INVALID: '图片校验未通过，未作为成功结果保存；请检查供应商记录。',
    RESULT_UNAVAILABLE: '当前没有可读取的 PNG 结果；供应商可能仅返回了下载链接。',
    CREDENTIAL_REQUIRED: '请先在配置中保存所选服务的 API Key。',
    TOOL_ABORTED: '宿主工具调用已中断，尚未取得供应商结果；是否扣费未知，请勿重复提交。',
    TIMEOUT: '等待供应商响应超时，生成结果和费用仍需核对，请勿直接重复生成。',
    NETWORK_ERROR: '供应商请求未完成，生成结果和费用尚不确定，请检查网络及供应商记录。',
    PERMISSION_DENIED: '宿主未授权此操作，请检查插件权限。'
  }[error?.code] || '请求未完成，请检查服务状态后重新读取。');
  A.connectionProbeText = result => {
    if (result?.status === 'connected') return '连接正常 · 系统状态可访问';
    if (result?.connectionStatus === 'connected' && result.workflowCompatible === false) return '连接正常，但工作流所需节点不齐全。';
    const permissionCodes = ['PERMISSION_DENIED', 'HOST_PERMISSION_DENIED', 'NETWORK_PERMISSION_DENIED', 'NET_PERMISSION_DENIED', 'CAPABILITY_DENIED', 'FORBIDDEN', 'APPROVAL_REQUIRED'];
    const messages = {
      CREDENTIAL_REQUIRED: '请填写认证秘密并保存。',
      AUTHENTICATION_REQUIRED: '服务拒绝认证，请检查认证方式和认证秘密。',
      ENDPOINT_NOT_FOUND: '服务接口不存在，请检查地址及反向代理路径。',
      REDIRECT_DISALLOWED: '服务返回重定向，请填写最终的 ComfyUI 地址。',
      TIMEOUT: '连接超时，请检查服务和网络连接。',
      NETWORK_ERROR: '无法连接服务，请检查地址、端口及网络连接。',
      RESPONSE_TOO_LARGE: '接口响应超过 2 MiB，未完成目录检查。',
      INVALID_JSON: '接口未返回有效 JSON，请检查地址或代理登录页面。',
      INVALID_RESPONSE: '接口返回格式不符合 ComfyUI 协议。',
      HTTP_ERROR: '服务返回错误，请检查服务状态。'
    };
    const reason = permissionCodes.includes(result?.code) ? '宿主未授权网络访问，请检查插件权限。' : messages[result?.code] || '连接检查未完成，请检查服务状态后重试。';
    const stage = ['system_stats', 'object_info'].includes(result?.endpoint) ? `/${result.endpoint}：` : '';
    const status = Number.isInteger(result?.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599 ? `（HTTP ${result.httpStatus}）` : '';
    return `${result?.connectionStatus === 'connected' ? '连接正常，工作流尚未验证。' : ''}${stage}${reason}${status}`;
  };
  A.minimaxCatalogText = (result, kind = 'models') => {
    const label = kind === 'models' ? '云端模型' : '音色';
    const catalog = result?.catalogs?.[kind];
    if (!catalog) return kind === 'models' ? '内置目录可直接添加；点击右侧「从供应商获取」查询云端模型。' : '点击右侧「从供应商获取」查看账号音色。';
    const count = (result[kind] || []).length;
    if (catalog?.status === 'connected') return kind === 'models'
      ? count ? `已从云端获取 ${count} 个媒体模型，已与内置目录合并。` : '云端未返回媒体模型（已过滤聊天模型），仍可使用内置目录。'
      : count ? `已获取 ${count} 个账号音色。` : '账号未返回可用音色。';
    const reasons = { CREDENTIAL_REQUIRED: '请填写 API Key', AUTHENTICATION_REQUIRED: '认证失败，请检查 API Key', ENDPOINT_NOT_FOUND: '供应商未提供此目录接口', TIMEOUT: '请求超时', NETWORK_ERROR: '网络连接失败', INVALID_JSON: '接口未返回有效 JSON', INVALID_RESPONSE: '供应商返回错误或无效目录', RESPONSE_TOO_LARGE: '目录响应超过大小上限', PERMISSION_DENIED: '宿主未授权网络访问' };
    return `${label}查询未完成：${reasons[catalog?.code || result.code] || '请检查地址、凭据及服务状态'}。${kind === 'models' ? '内置目录仍可使用。' : ''}`;
  };
  A.probeText = result => ({ connected: '目录可访问 · 尚未验证生成能力', unavailable: '暂时无法访问目录，请检查地址、凭据和服务状态。', unsupported: '当前接入方式不支持此项目录查询。' }[result?.status] || '未获得有效的目录结果。');
  document.addEventListener('click', e => document.querySelectorAll('details.picker[open]').forEach(details => { if (!details.contains(e.target)) details.open = false; }));
})();
