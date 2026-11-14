/* Shared accessible controls. All user and provider text is inserted as text. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const t = A.i18n.scope('ui');
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
  A.kinds = { image: t('image'), video: t('video'), audio: t('audio') };
  A.capabilityText = model => {
    const kind = model.kind || 'image';
    if (kind === 'image') return t('imageCapability');
    if (kind === 'video') return t('videoCapability');
    if (kind === 'audio') return t('speech');
    return t('mediaCapability');
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
    const summary = h('summary', { role: 'button', 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-disabled': String(disabled), tabindex: disabled ? -1 : 0 }, selected?.label || value || t('unselected'));
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
  A.confirm = (title, text, accept = t('discard')) => new Promise(resolve => {
    const oldFocus = document.activeElement;
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'confirm-title' }, h('h2', { id: 'confirm-title' }, title), h('p', {}, text));
    const finish = value => { dialog.close(); dialog.remove(); if (oldFocus?.isConnected) oldFocus.focus(); resolve(value); };
    const cancel = A.button(t('cancel'), () => finish(false));
    dialog.append(h('div', { class: 'actions' }, cancel, A.button(accept, () => finish(true), { class: 'primary' })));
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
  A.cleanProfile = profile => {
    const keys = ['id', 'name', 'provider', 'enabled', 'baseUrl', 'models', 'modelId', 'voice', 'format', 'cliPath', 'comfyUser', 'authKind', 'headerName', 'workflow', 'bindings'];
    return Object.fromEntries(keys.filter(key => Object.hasOwn(profile, key)).map(key => [key, A.clone(profile[key])]));
  };
  A.errorText = error => ({
    CONFLICT: t('conflict'),
    INVALID_ARGUMENT: t('invalidArgument'),
    DISABLED: t('disabled'),
    PROBE_PENDING: t('probePending'),
    NOT_FOUND: t('notFound'),
    STORAGE_ERROR: t('storageError'),
    DISPOSED: t('disposed'),
    CREDENTIAL_UNAVAILABLE: t('credentialUnavailable'),
    PLUGIN_RELOAD_REQUIRED: t('reloadRequired'),
    CREDENTIAL_ERROR: t('credentialError'),
    CREDENTIAL_LEGACY: t('credentialLegacy'),
    GENERATION_UNSUPPORTED: t('generationUnsupported'),
    GENERATION_BUSY: t('generationBusy'),
    GENERATION_LIMIT: t('generationLimit'),
    GENERATION_UNKNOWN: t('generationUnknown'),
    GENERATION_REQUEST_CONFLICT: t('generationConflict'),
    RESULT_INVALID: t('resultInvalid'),
    RESULT_UNAVAILABLE: t('resultUnavailable'),
    CREDENTIAL_REQUIRED: t('credentialRequired'),
    TOOL_ABORTED: t('toolAborted'),
    TIMEOUT: t('timeout'),
    NETWORK_ERROR: t('networkError'),
    AUTHENTICATION_REQUIRED: t('authenticationRequired'),
    RATE_LIMITED: t('rateLimited'),
    HTTP_ERROR: t('httpError'),
    PERMISSION_DENIED: t('permissionDenied')
  }[error?.code] || t('requestFailed'));
  A.connectionProbeText = result => {
    if (result?.status === 'connected') return t('connectionHealthy');
    if (result?.connectionStatus === 'connected' && result.workflowCompatible === false) return t('nodesMissing');
    const permissionCodes = ['PERMISSION_DENIED', 'HOST_PERMISSION_DENIED', 'NETWORK_PERMISSION_DENIED', 'NET_PERMISSION_DENIED', 'CAPABILITY_DENIED', 'FORBIDDEN', 'APPROVAL_REQUIRED'];
    const messages = {
      CREDENTIAL_REQUIRED: t('enterSecret'),
      AUTHENTICATION_REQUIRED: t('connectionAuthentication'),
      ENDPOINT_NOT_FOUND: t('endpointMissing'),
      REDIRECT_DISALLOWED: t('redirect'),
      TIMEOUT: t('connectionTimeout'),
      NETWORK_ERROR: t('connectionNetwork'),
      RESPONSE_TOO_LARGE: t('responseTooLarge'),
      INVALID_JSON: t('invalidJson'),
      INVALID_RESPONSE: t('invalidResponse'),
      HTTP_ERROR: t('connectionHttp')
    };
    const reason = permissionCodes.includes(result?.code) ? t('networkPermission') : messages[result?.code] || t('connectionFailed');
    const stage = ['system_stats', 'object_info'].includes(result?.endpoint) ? `/${result.endpoint}：` : '';
    const status = Number.isInteger(result?.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599 ? `（HTTP ${result.httpStatus}）` : '';
    return `${result?.connectionStatus === 'connected' ? t('workflowUnverified') : ''}${stage}${reason}${status}`;
  };
  A.minimaxCatalogText = (result, kind = 'models') => {
    const label = kind === 'models' ? t('cloudModels') : t('voices');
    const catalog = result?.catalogs?.[kind];
    if (!catalog) return kind === 'models' ? t('builtinHelp') : t('voicesHelp');
    const count = (result[kind] || []).length;
    if (catalog?.status === 'connected') return kind === 'models'
      ? count ? t('cloudModelsLoaded', { p1: count }) : t('cloudModelsEmpty')
      : count ? t('voicesLoaded', { p1: count }) : t('voicesEmpty');
    const reasons = { CREDENTIAL_REQUIRED: t('keyMissing'), AUTHENTICATION_REQUIRED: t('authFailed'), ENDPOINT_NOT_FOUND: t('catalogUnsupported'), TIMEOUT: t('queryTimeout'), NETWORK_ERROR: t('queryNetwork'), INVALID_JSON: t('queryInvalidJson'), INVALID_RESPONSE: t('queryInvalidResponse'), RESPONSE_TOO_LARGE: t('queryTooLarge'), PERMISSION_DENIED: t('queryPermission') };
    return t('queryFailed', { p1: label, p2: reasons[catalog?.code || result.code] || t('checkService'), p3: kind === 'models' ? t('builtinAvailable') : '' });
  };
  A.probeText = result => ({ connected: t('catalogAccessible'), unavailable: t('catalogUnavailable'), unsupported: t('catalogUnsupportedMode') }[result?.status] || t('catalogInvalid'));
  document.addEventListener('click', e => document.querySelectorAll('details.picker[open]').forEach(details => { if (!details.contains(e.target)) details.open = false; }));
})();
