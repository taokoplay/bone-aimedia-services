(() => {
  'use strict';
  const protocol = 'aimedia.panel.v1';
  const codes = new Set(['INVALID_ARGUMENT', 'CONFLICT', 'STORAGE_ERROR', 'NOT_FOUND', 'DISABLED', 'DISPOSED', 'PROBE_PENDING', 'PERMISSION_DENIED', 'SYNC_FAILED', 'SYNC_UNSUPPORTED', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_ERROR', 'UNAVAILABLE']);
  codes.add('CREDENTIAL_LEGACY');
  codes.add('TOOL_ABORTED');
  for (const code of ['GENERATION_UNSUPPORTED', 'GENERATION_BUSY', 'GENERATION_LIMIT', 'GENERATION_UNKNOWN', 'GENERATION_REQUEST_CONFLICT', 'RESULT_INVALID', 'RESULT_UNAVAILABLE']) codes.add(code);
  for (const code of ['WORKFLOW_INVALID', 'WORKFLOW_TOO_LARGE', 'WORKFLOW_NOT_FOUND', 'RESOURCE_LIST_STALE', 'RESOURCE_UNSUPPORTED', 'AUTHENTICATION_REQUIRED', 'CREDENTIAL_REQUIRED', 'ENDPOINT_NOT_FOUND', 'TIMEOUT', 'NETWORK_ERROR', 'REDIRECT_DISALLOWED', 'INVALID_JSON', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'HTTP_ERROR', 'HOST_PERMISSION_DENIED', 'NETWORK_PERMISSION_DENIED', 'NET_PERMISSION_DENIED', 'CAPABILITY_DENIED', 'FORBIDDEN', 'APPROVAL_REQUIRED']) codes.add(code);
  const legacyReads = new Set(['aimedia.get', 'aimedia.status', 'aimedia.capabilities', 'aimedia.resourceSnapshot']);
  const failure = code => Object.assign(new Error(code), { code });
  window.AIMedia.createPanelInvoke = getBridge => {
    let ready, readOnly = false;
    const invoke = async (channel, payload) => {
      const bridge = getBridge();
      if (typeof bridge?.invoke !== 'function') throw failure('NO_BRIDGE');
      if (!channel.startsWith('aimedia.')) return bridge.invoke(channel, payload);
      // A newer page can outlive the resident entry. Preserve local reads on
      // older entries, but never downgrade writes or requests with side effects.
      if (!ready) ready = Promise.resolve().then(() => bridge.invoke('aimedia.status'))
        .catch(error => { ready = undefined; throw error; });
      const status = await ready;
      readOnly = status?.panelProtocol !== 1;
      if (readOnly) {
        if (!legacyReads.has(channel)) throw failure('PLUGIN_RELOAD_REQUIRED');
        return channel === 'aimedia.status' ? status : bridge.invoke(channel, payload);
      }
      const response = await bridge.invoke('aimedia.invoke', { channel, payload });
      if (response?.protocol !== protocol || typeof response.ok !== 'boolean') throw failure('BRIDGE_RESPONSE_INVALID');
      if (response.ok) {
        if (!Object.hasOwn(response, 'result')) throw failure('BRIDGE_RESPONSE_INVALID');
        return response.result;
      }
      if (!codes.has(response.error?.code)) throw failure('BRIDGE_RESPONSE_INVALID');
      throw failure(response.error.code);
    };
    invoke.isReadOnly = () => readOnly;
    invoke.reset = () => { ready = undefined; };
    return invoke;
  };
})();
