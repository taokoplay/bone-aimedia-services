/* Load modules in dependency order after the optional host locale request. */
(() => {
  'use strict';
  const i18n = window.AIMedia.i18n;
  const t = i18n.scope('shell');
  const base = new URL('.', document.currentScript.src);
  let alive = true;
  window.addEventListener('pagehide', () => { alive = false; }, { once: true });
  const load = name => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(`settings-${name}.js`, base).href;
    script.onload = () => { script.onload = script.onerror = null; resolve(); };
    script.onerror = () => { script.onload = script.onerror = null; reject(new Error(`Failed to load settings-${name}.js`)); };
    document.head.append(script);
  });
  async function start() {
    await i18n.initialize(window.pluginBridge?.invoke?.bind(window.pluginBridge));
    if (!alive) return;
    document.documentElement.lang = i18n.locale;
    document.title = t('title');
    const root = document.getElementById('app');
    root.setAttribute('aria-label', t('settings'));
    root.querySelector('[role="status"]').textContent = t('loading');
    document.getElementById('no-script').textContent = t('noScript');
    root.hidden = false;
    try {
      for (const name of ['ui', 'bridge', 'profile', 'workflow', 'remote', 'preview', 'records', 'records-page', 'app']) {
        if (!alive) return;
        await load(name);
      }
    } catch (error) {
      if (!alive) return;
      console.error(error);
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = t('loadFailed');
      root.replaceChildren(notice);
    }
  }
  void start();
})();
