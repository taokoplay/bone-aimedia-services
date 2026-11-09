'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = path.join(__dirname, '../renderer');
const dictionaryFiles = fs.readdirSync(path.join(renderer, 'i18n')).filter(file => file.endsWith('.js'));
const holders = text => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
function runtime(overrides = {}) {
  const context = vm.createContext({ window: {}, setTimeout, clearTimeout, ...overrides });
  const load = file => vm.runInContext(fs.readFileSync(path.join(renderer, file), 'utf8'), context, { filename: file });
  load('settings-i18n.js');
  const i18n = context.window.AIMedia.i18n, tables = new Map();
  const register = i18n.register.bind(i18n);
  i18n.register = (scope, copy) => { tables.set(scope, copy); register(scope, copy); };
  for (const file of dictionaryFiles) load(`i18n/${file}`);
  return { context, i18n, tables, load };
}
const baseline = runtime();
for (const [scope, copy] of baseline.tables) {
  test(`${scope}: explicit English and Chinese keys and placeholders match`, () => {
    assert.deepEqual(Object.keys(copy).sort(), ['en', 'zh-CN']);
    assert.deepEqual(Object.keys(copy.en).sort(), Object.keys(copy['zh-CN']).sort());
    for (const key of Object.keys(copy.en)) {
      for (const locale of ['en', 'zh-CN']) {
        assert.equal(typeof copy[locale][key], 'string', `${scope}.${key}`);
        assert.ok(copy[locale][key].trim(), `${scope}.${key} is empty`);
        assert.doesNotMatch(copy[locale][key], /<\/?[A-Za-z][^>]*>/, `${scope}.${key} contains markup`);
      }
      assert.deepEqual(holders(copy.en[key]), holders(copy['zh-CN'][key]), `${scope}.${key}`);
    }
    const file = path.join(renderer, `settings-${scope === 'shell' ? 'bootstrap' : scope}.js`);
    if (fs.existsSync(file)) {
      for (const [, key] of fs.readFileSync(file, 'utf8').matchAll(/\bt\('([^']+)'/g)) {
        assert.ok(Object.hasOwn(copy.en, key), `Missing used key: ${scope}.${key}`);
      }
    }
  });
}

test('host locale negotiation normalizes supported locales and falls back for unsupported known locales', async () => {
  for (const [reply, expected] of [
    ['en', 'en'], ['en-US', 'en'], ['fr-FR', 'en'], ['zh-TW', 'en'], ['zh-CN', 'zh-CN'],
    ['zh', 'zh-CN'], ['zh_Hans', 'zh-CN'], [{ locale: 'en' }, 'en'], [{ locale: 'zh-CN' }, 'zh-CN'],
    [undefined, 'zh-CN'], [null, 'zh-CN'], [{}, 'zh-CN'], ['', 'zh-CN']
  ]) {
    const { i18n } = runtime();
    const channels = [];
    await i18n.initialize(async channel => { channels.push(channel); return reply; });
    assert.equal(i18n.locale, expected);
    assert.deepEqual(channels, ['app.getLocale']);
    await i18n.initialize(() => { throw Error('Must not negotiate twice'); });
    assert.equal(i18n.locale, expected);
  }
});

test('old hosts and missing bridges retain the exact Chinese labels', async () => {
  for (const invoke of [undefined, () => { throw Error('Unknown channel'); }, async () => { throw Error('Unknown channel'); }]) {
    const { i18n } = runtime();
    await i18n.initialize(invoke);
    assert.equal(i18n.scope('app')('addService'), '添加服务');
    assert.equal(i18n.scope('records')('project', { p1: '用户项目' }), '所属项目：用户项目');
  }
});

test('unresponsive or late locale replies cannot stall startup or change initialized labels', async () => {
  const timers = new Map(); let next = 0, resolveLocale;
  const { i18n } = runtime({
    setTimeout(callback) { const id = ++next; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const ready = i18n.initialize(() => new Promise(resolve => { resolveLocale = resolve; }));
  await Promise.resolve();
  for (const callback of timers.values()) callback();
  await ready;
  assert.equal(i18n.locale, 'zh-CN');
  assert.equal(timers.size, 0);
  resolveLocale('en');
  await Promise.resolve();
  assert.equal(i18n.scope('ui')('image'), '图片');
});

test('every translated template preserves hostile parameter text without recursive substitution', async () => {
  const hostile = '<img src=x onerror=alert(1)> 中文 & $& $` $\' {p1} {p2} ${user} \\n';
  for (const locale of ['en', 'zh-CN']) {
    const { i18n, tables } = runtime();
    await i18n.initialize(async () => locale);
    for (const [scope, copy] of tables) {
      const t = i18n.scope(scope);
      for (const [key, value] of Object.entries(copy[locale])) {
        const params = Object.fromEntries(holders(value).map(name => [name, hostile]));
        const expected = value.split(/(\{[A-Za-z0-9_]+\})/).map(part => /^\{[A-Za-z0-9_]+\}$/.test(part) ? hostile : part).join('');
        assert.equal(t(key, params), expected, `${locale}:${scope}.${key}`);
      }
    }
    assert.throws(() => i18n.scope('app')('deleteDescription', Object.create({ p1: hostile })), /Missing locale parameter/);
    assert.throws(() => i18n.scope('app')('__proto__'), /Unknown locale key/);
  }
});

test('provider localization uses stable IDs without mutating names, descriptions, or models', async () => {
  const { context, i18n } = runtime();
  await i18n.initialize(async () => 'en');
  const provider = Object.freeze({ id: 'xiaomi', name: '小米 MiMo', description: '原始描述', defaultModels: Object.freeze([{ id: 'model', name: '用户模型' }]) });
  assert.equal(context.window.AIMedia.providerName(provider), 'Xiaomi MiMo');
  assert.match(context.window.AIMedia.providerDescription(provider), /Xiaomi speech/);
  assert.equal(provider.name, '小米 MiMo');
  assert.equal(provider.defaultModels[0].name, '用户模型');
  const unknown = { id: 'external', name: '任意 <用户> 名称', description: '用户输入 {p1}' };
  assert.equal(context.window.AIMedia.providerName(unknown), unknown.name);
  assert.equal(context.window.AIMedia.providerDescription(unknown), unknown.description);
});
