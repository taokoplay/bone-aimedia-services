/* Locale is resolved once before any module initializes its display labels. */
(() => {
  'use strict';
  const tables = new Map();
  let locale = 'zh-CN', ready;
  const normalize = value => {
    const candidate = typeof value === 'string' ? value : value?.locale;
    if (typeof candidate !== 'string' || !candidate.trim()) return 'zh-CN';
    return /^(zh|zh-cn|zh-hans(?:-cn)?)$/i.test(candidate.trim().replaceAll('_', '-')) ? 'zh-CN' : 'en';
  };
  const i18n = {
    get locale() { return locale; },
    register(scope, copy) {
      if (tables.has(scope)) throw new Error(`Duplicate locale scope: ${scope}`);
      for (const entries of Object.values(copy)) Object.freeze(entries);
      tables.set(scope, Object.freeze(copy));
    },
    scope(scope) {
      if (!tables.has(scope)) throw new Error(`Unknown locale scope: ${scope}`);
      return (key, params = {}) => {
        const copy = tables.get(scope)[locale];
        if (!Object.hasOwn(copy, key)) throw new Error(`Unknown locale key: ${scope}.${key}`);
        // Replace once using a callback: dollar signs, braces and markup in user
        // values remain literal text. Rendering continues through text nodes.
        return copy[key].replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
          if (!Object.hasOwn(params, name)) throw new Error(`Missing locale parameter: ${scope}.${key}.${name}`);
          return String(params[name]);
        });
      };
    },
    initialize(invoke, timeoutMs = 1000) {
      if (!ready) ready = (async () => {
        let timer;
        try {
          const value = await Promise.race([
            Promise.resolve().then(() => typeof invoke === 'function' ? invoke('app.getLocale') : undefined),
            new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
          ]);
          locale = normalize(value);
        } catch {
          // Older hosts do not expose app.getLocale; preserve their Chinese UI.
          locale = 'zh-CN';
        } finally { clearTimeout(timer); }
        return locale;
      })();
      return ready;
    }
  };
  window.AIMedia = { i18n };
})();
