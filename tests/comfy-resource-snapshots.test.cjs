"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createPrivateJsonStorage } = require("../lib/private-json-storage.js");
const { createStorage } = require("../lib/media-provider-storage.js");
const { createResourceSnapshotStore, profileIdentity } = require("../lib/comfy-resource-snapshots.js");
const checkedAt = "2026-09-26T12:30:00.000Z";
const current = () => {};
const empty = () => ({ models: null, workflows: null, details: [] });
const profile = extra => ({ id: "comfy", provider: "comfyui", baseUrl: "http://localhost:8188", comfyUser: "", ...extra });
const models = () => ({ checkedAt, folders: [{ name: "checkpoints", items: [{ name: "nested/模型.safetensors" }] }] });
const fileInfo = (name = "nested/绘图.json") => ({ path: name, size: 100, modified: 1234, created: 1200 });
const workflows = () => ({ checkedAt, items: [fileInfo()] });
const definition = () => ({ "1": { class_type: "KSampler", inputs: { text: "A sunny day", seed: 1 } } });
const detail = (name = "nested/绘图.json") => ({ path: name, checkedAt, definition: definition(), format: "api", importable: true });
const snapshot = () => ({ models: models(), workflows: workflows(), details: [detail()] });
const entry = (extra = {}) => ({ profileId: "comfy", identity: profileIdentity(profile()), ...snapshot(), ...extra });
const document = () => ({ schemaVersion: 1, entries: [entry()] });
const bad = code => error => error.code === code && !/session-sensitive|Bearer abc|api_key=abc/.test(error.message);
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-snapshots-"));
  const root = path.join(parent, "private"); const file = path.join(root, "aimedia-resource-snapshots.json");
  const store = createResourceSnapshotStore(() => root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root, file, store };
}
async function unchanged(f, before) {
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.deepEqual(await fs.readdir(f.root), ["aimedia-resource-snapshots.json"]);
}
async function rejectsCorruption(f, raw) {
  await fs.mkdir(f.root, { recursive: true }); await fs.writeFile(f.file, raw);
  await assert.rejects(f.store.read(profile()), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.read(profile({ id: "absent" })), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.write(profile(), { models: models() }, current), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.invalidate(["comfy"], current), bad("STORAGE_ERROR"));
  await unchanged(f, raw);
}

test("private JSON storage rejects unsafe basenames and returns detached missing values without writes", async t => {
  const f = await fixture(t);
  const options = { filename: "test.json", maxBytes: 128, empty: { items: [] }, parse: value => value };
  for (const filename of ["", ".", "..", "../test.json", "/test.json", "a/b.json", "a\\b.json", "a:stream.json", ".hidden.json", "test.json\0", "test.json/", "test.json ", "a..json"]) {
    assert.throws(() => createPrivateJsonStorage(() => f.root, { ...options, filename }), bad("STORAGE_ERROR"));
  }
  const storage = createPrivateJsonStorage(() => f.root, options);
  const first = await storage.read(); first.items.push("mutated");
  assert.deepEqual(await storage.read(), { items: [] });
  await assert.rejects(fs.stat(f.root), { code: "ENOENT" });
  await storage.write({ items: ["saved"] }, current);
  assert.deepEqual(await storage.read(), { items: ["saved"] });
  const target = path.join(f.root, "test.json"); const before = await fs.readFile(target, "utf8");
  await assert.rejects(storage.write({ text: "x".repeat(129) }, current), bad("STORAGE_ERROR"));
  assert.equal(await fs.readFile(target, "utf8"), before);
  await fs.writeFile(target, " ".repeat(129));
  await assert.rejects(storage.read(), bad("STORAGE_ERROR"));
});

test("config adapter preserves filename, temporary prefix, errors, mode and the 8 MiB cap", async t => {
  const f = await fixture(t); const storage = createStorage(() => f.root);
  const value = { revision: 0, profiles: [], defaults: { image: null, video: null, audio: null }, workflows: [] };
  assert.deepEqual(await storage.read(), value);
  const rename = fs.rename; const names = [];
  const mock = t.mock.method(fs, "rename", async (from, to) => { names.push(path.basename(from)); return rename(from, to); });
  await storage.write(value, current); mock.mock.restore();
  assert.match(names[0], /^\.aimedia-settings-[a-f0-9-]{36}\.tmp$/);
  const file = path.join(f.root, "aimedia-settings.json");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(storage.write({ text: "x".repeat(8 * 1024 * 1024) }, current), {
    code: "STORAGE_ERROR", message: "Provider configuration could not be saved safely. Existing session state was preserved.",
  });
  for (const code of ["CONFLICT", "DISPOSED"]) {
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(storage.write(value, () => { throw error; }), found => found === error);
  }
  assert.equal(await fs.readFile(file, "utf8"), before);
  await fs.writeFile(file, "{broken");
  await assert.rejects(storage.read(), {
    code: "STORAGE_ERROR", message: "Provider configuration could not be read safely. Repair the configuration file before continuing.",
  });
});

test("missing snapshot read and invalidation create neither directory nor file", async t => {
  const f = await fixture(t);
  const first = await f.store.read(profile()); first.details.push(detail());
  assert.deepEqual(await f.store.read(profile()), empty());
  await f.store.invalidate(["comfy"], current);
  await assert.rejects(fs.stat(f.root), { code: "ENOENT" });
  await fs.mkdir(f.root);
  assert.deepEqual(await f.store.read(profile()), empty());
  await f.store.invalidate([], current);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("catalog, list and preview user path survives restart with detached data and private permissions", async t => {
  const f = await fixture(t); const modelInput = models();
  await f.store.write(profile(), { models: modelInput }, current);
  modelInput.folders[0].items[0].name = "mutated";
  await f.store.write(profile(), { workflows: workflows() }, current);
  const detailInput = detail(); const result = await f.store.write(profile(), { details: [detailInput] }, current);
  assert.deepEqual(result, snapshot());
  detailInput.definition["1"].inputs.text = "mutated";
  result.details[0].definition["1"].inputs.text = "also mutated";
  result.models.folders.length = 0;
  const restarted = createResourceSnapshotStore(() => f.root);
  assert.deepEqual(await restarted.read(profile()), snapshot());
  const read = await restarted.read(profile()); read.workflows.items[0].path = "mutated.json";
  assert.deepEqual(await restarted.read(profile()), snapshot());
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), document());
});

test("identity uses only selected public fields; renames, enabled state and credentials do not change it", async t => {
  const f = await fixture(t); const p = profile();
  const expected = createHash("sha256").update(JSON.stringify([p.id, p.provider, p.baseUrl, "", "legacy", ""])).digest("hex");
  assert.equal(profileIdentity(p), expected);
  await f.store.write(p, snapshot(), current);
  for (const extra of [{ name: "Renamed" }, { enabled: false }, { credentialUpdate: { action: "replace", value: "session-sensitive" } }, { comfyUser: undefined }, { headerName: "" }]) {
    assert.equal(profileIdentity(profile(extra)), expected);
    assert.deepEqual(await f.store.read(profile(extra)), snapshot());
  }
  for (const extra of [{ id: "other" }, { provider: "openai" }, { baseUrl: "https://remote.example" }, { comfyUser: "other-user" }, { authKind: "none" }, { authKind: "bearer" }, { headerName: "X-Token" }]) {
    assert.notEqual(profileIdentity(profile(extra)), expected);
    assert.deepEqual(await f.store.read(profile(extra)), empty());
  }
  assert.equal(profileIdentity(profile({ authKind: "header", headerName: "X-Key" })), profileIdentity(profile({ authKind: "header", headerName: "x-key" })));
  const changed = profile({ baseUrl: "https://remote.example" });
  assert.deepEqual(await f.store.write(changed, { models: models() }, current), { ...empty(), models: models() });
  assert.deepEqual(await f.store.read(p), empty());
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).entries.length, 1);
});

test("patches preserve other catalogs, replace details explicitly, and clear details with workflow refreshes", async t => {
  const f = await fixture(t); await f.store.write(profile(), snapshot(), current);
  assert.deepEqual(await f.store.write(profile(), { models: null }, current), { ...snapshot(), models: null });
  assert.deepEqual(await f.store.write(profile(), { models: models() }, current), snapshot());
  assert.deepEqual(await f.store.write(profile(), { workflows: workflows() }, current), { ...snapshot(), details: [] });
  await f.store.write(profile(), { details: [detail()] }, current);
  assert.deepEqual(await f.store.write(profile(), { workflows: workflows(), details: [detail()] }, current), snapshot());
  assert.deepEqual(await f.store.write(profile(), { workflows: null }, current), { ...empty(), models: models() });
  const before = await fs.readFile(f.file, "utf8");
  for (const patch of [{}, { unknown: null }, { models: undefined }, { details: null }, { details: [detail()] }, { workflows: null, details: [detail()] }, Object.create({ models: null }), JSON.parse('{"__proto__":{},"models":null}')]) {
    await assert.rejects(f.store.write(profile(), patch, current), bad("INVALID_ARGUMENT"));
  }
  await unchanged(f, before);
});

test("API, canvas and unknown details are revalidated rather than trusting persisted importability", async t => {
  const f = await fixture(t);
  for (const [value, format, importable] of [[definition(), "api", true], [{ nodes: [{ id: 1, type: "KSampler" }], links: [] }, "canvas", false], [{ description: "Preview only" }, "unknown", false]]) {
    const item = { ...detail(), definition: value, format, importable };
    await f.store.write(profile(), { workflows: workflows(), details: [item] }, current);
    assert.deepEqual((await f.store.read(profile())).details, [item]);
    const before = await fs.readFile(f.file, "utf8");
    await assert.rejects(f.store.write(profile(), { details: [{ ...item, importable: !importable }] }, current), bad("INVALID_ARGUMENT"));
    await assert.rejects(f.store.write(profile(), { details: [{ ...item, format: "forged" }] }, current), bad("INVALID_ARGUMENT"));
    await unchanged(f, before);
  }
});

test("invalidation removes only requested IDs, survives restart and avoids no-op writes", async t => {
  const f = await fixture(t); const other = profile({ id: "other" });
  await f.store.write(profile(), snapshot(), current); await f.store.write(other, { models: models() }, current);
  const before = await fs.readFile(f.file, "utf8"); const stat = await fs.stat(f.file);
  await f.store.invalidate(["missing"], current); await f.store.invalidate([], current);
  assert.equal((await fs.stat(f.file)).ino, stat.ino); await unchanged(f, before);
  await f.store.invalidate(["comfy", "comfy"], current);
  const restarted = createResourceSnapshotStore(() => f.root);
  assert.deepEqual(await restarted.read(profile()), empty());
  assert.deepEqual(await restarted.read(other), { ...empty(), models: models() });
  await restarted.invalidate(["other"], current);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), { schemaVersion: 1, entries: [] });
});

test("secrets are never stored or hashed and known secret copies are rejected at every resource boundary", async t => {
  const f = await fixture(t); const secret = "session-sensitive"; const secrets = [secret];
  await f.store.write(profile({ credentialUpdate: { action: "replace", value: secret } }), snapshot(), current, secrets);
  const before = await fs.readFile(f.file, "utf8");
  assert.equal(before.includes(secret), false);
  assert.equal(before.includes(createHash("sha256").update(secret).digest("hex")), false);
  const patches = [
    { models: { checkedAt, folders: [{ name: secret, items: [] }] } },
    { models: { checkedAt, folders: [{ name: "checkpoints", items: [{ name: `${secret}.bin` }] }] } },
    { workflows: { checkedAt, items: [fileInfo(`${secret}.json`)] } },
    { details: [{ ...detail(), definition: { description: secret }, format: "unknown", importable: false }] },
    { details: [{ ...detail(), definition: { [secret]: "value" }, format: "unknown", importable: false }] },
  ];
  for (const patch of patches) await assert.rejects(f.store.write(profile(), patch, current, secrets), bad("INVALID_ARGUMENT"));
  await assert.rejects(f.store.write(profile({ id: secret }), { models: models() }, current, secrets), bad("INVALID_ARGUMENT"));
  await unchanged(f, before);
  await f.store.write(profile(), patches[1], current);
  const containing = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.store.read(profile(), secrets), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.write(profile(), { details: [] }, current, secrets), bad("STORAGE_ERROR"));
  assert.deepEqual(await f.store.read(profile({ comfyUser: "other" }), secrets), empty());
  await unchanged(f, containing);
});

test("public credential syntax and unsafe paths cannot enter persisted resource metadata or definitions", async t => {
  const f = await fixture(t); await f.store.write(profile(), snapshot(), current);
  const before = await fs.readFile(f.file, "utf8");
  for (const name of ["Bearer abc", "Basic abc", "api_key=abc", "Authorization: abc", "sk-123456789", "https://user:pass@host", "../bad", "%252e%252e", "a\\b", "//host/file"]) {
    const patches = [
      { models: { checkedAt, folders: [{ name, items: [] }] } },
      { models: { checkedAt, folders: [{ name: "models", items: [{ name }] }] } },
      { workflows: { checkedAt, items: [fileInfo(`${name}.json`)] } },
    ];
    for (const patch of patches) await assert.rejects(f.store.write(profile(), patch, current), bad("INVALID_ARGUMENT"));
  }
  for (const value of [{ description: "Bearer abc" }, { password: "abc" }, { headers: {} }, { description: "api_key=abc" }, JSON.parse('{"__proto__":{}}'), { constructor: {} }]) {
    await assert.rejects(f.store.write(profile(), { details: [{ ...detail(), definition: value, format: "unknown", importable: false }] }, current), bad("INVALID_ARGUMENT"));
  }
  await unchanged(f, before);
});

test("malformed JSON, schema versions, duplicate JSON members and prototype keys fail without reset", async t => {
  const f = await fixture(t);
  for (const raw of ["{broken", "null", "[]", JSON.stringify({ ...document(), schemaVersion: 2 }), JSON.stringify({ ...document(), extra: 1 }),
    '{"schemaVersion":1,"schemaVersion":1,"entries":[]}', '{"schemaVersion":1,"schema\\u0056ersion":1,"entries":[]}',
    '{"schemaVersion":1,"entries":[],"__proto__":{}}',
    JSON.stringify(document()).replace('"class_type":"KSampler"', '"class_type":"Hidden","class_type":"KSampler"'),
    JSON.stringify(document()).replace('"inputs":{', '"inputs":{"constructor":{},'),
  ]) await rejectsCorruption(f, raw);
});

test("disk validation checks every required field, record, timestamp and duplicate before returning any profile", async t => {
  const f = await fixture(t);
  const mutations = [
    d => { d.entries[0].extra = true; }, d => { d.entries[0].identity = "not-a-hash"; }, d => { d.entries[0].profileId = "bad id"; },
    d => { d.entries.push(structuredClone(d.entries[0])); },
    d => { d.entries[0].models.extra = true; }, d => { d.entries[0].models.folders[0].extra = true; },
    d => { d.entries[0].models.folders[0].items[0].extra = true; },
    d => { d.entries[0].models.folders.push(structuredClone(d.entries[0].models.folders[0])); },
    d => { d.entries[0].models.folders[0].items.push(structuredClone(d.entries[0].models.folders[0].items[0])); },
    d => { d.entries[0].workflows.extra = true; }, d => { d.entries[0].workflows.items[0].extra = true; },
    d => { d.entries[0].workflows.items.push(fileInfo()); }, d => { d.entries[0].workflows.items[0].path = "not-json.txt"; },
    d => { d.entries[0].workflows.items[0].size = -1; }, d => { d.entries[0].workflows.items[0].modified = "1234"; },
    d => { d.entries[0].workflows.items[0].created = 1.5; },
    d => { d.entries[0].details[0].extra = true; }, d => { d.entries[0].details[0].format = "canvas"; },
    d => { d.entries[0].details[0].importable = "true"; }, d => { d.entries[0].details.push(detail()); },
    d => { d.entries[0].details[0].path = "absent.json"; }, d => { d.entries[0].workflows = null; },
    d => { d.entries[0].details[0].definition = { "1": { class_type: "Bad", inputs: null } }; },
    d => { d.entries.push(entry({ profileId: "other", models: { checkedAt, folders: [{ name: "../invalid", items: [] }] } })); },
    d => { d.entries[0].models.folders[0].items = [{ name: "Bearer abc" }]; },
  ];
  const selectors = [d => d, d => d.entries[0], d => d.entries[0].models, d => d.entries[0].models.folders[0], d => d.entries[0].models.folders[0].items[0], d => d.entries[0].workflows, d => d.entries[0].workflows.items[0], d => d.entries[0].details[0]];
  for (const select of selectors) for (const key of Object.keys(select(document()))) mutations.push(d => { delete select(d)[key]; });
  for (const invalid of ["2026-02-30T12:30:00.000Z", "2026-09-26", "2026-09-26T12:30:00+00:00", "not-a-date", 1234, null]) {
    for (const select of [d => d.entries[0].models, d => d.entries[0].workflows, d => d.entries[0].details[0]]) mutations.push(d => { select(d).checkedAt = invalid; });
  }
  for (const mutate of mutations) { const value = document(); mutate(value); await rejectsCorruption(f, JSON.stringify(value)); }
});

test("oversized disk data is rejected by the 32 MiB bound without truncating or replacing it", async t => {
  const f = await fixture(t); await fs.mkdir(f.root);
  const handle = await fs.open(f.file, "w");
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const before = await fs.stat(f.file);
  await assert.rejects(f.store.read(profile()), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.write(profile(), { models: models() }, current), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.invalidate(["comfy"], current), bad("STORAGE_ERROR"));
  const after = await fs.stat(f.file); assert.equal(after.size, before.size); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});

test("root symlinks, target symlinks, hardlinks and non-files reject without modifying targets", async t => {
  for (const kind of ["root-link", "file-link", "hardlink", "directory"]) {
    const f = await fixture(t); const target = path.join(f.parent, "target"); await fs.mkdir(target);
    const outside = path.join(target, "outside.json"); const raw = JSON.stringify(document()); await fs.writeFile(outside, raw);
    if (kind === "root-link") await fs.symlink(target, f.root);
    else {
      await fs.mkdir(f.root);
      if (kind === "file-link") await fs.symlink(outside, f.file);
      if (kind === "hardlink") await fs.link(outside, f.file);
      if (kind === "directory") await fs.mkdir(f.file);
    }
    await assert.rejects(f.store.read(profile()), bad("STORAGE_ERROR"));
    await assert.rejects(f.store.write(profile(), { models: models() }, current), bad("STORAGE_ERROR"));
    await assert.rejects(f.store.invalidate(["comfy"], current), bad("STORAGE_ERROR"));
    assert.equal(await fs.readFile(outside, "utf8"), raw);
    assert.deepEqual(await fs.readdir(target), ["outside.json"]);
  }
});

test("storage pins the private root for reads, writes and invalidation", async t => {
  const f = await fixture(t); let root = f.root;
  const store = createResourceSnapshotStore(() => root);
  await store.write(profile(), snapshot(), current); const before = await fs.readFile(f.file, "utf8");
  root = path.join(f.parent, "changed");
  await assert.rejects(store.read(profile()), bad("STORAGE_ERROR"));
  await assert.rejects(store.write(profile(), { models: null }, current), bad("STORAGE_ERROR"));
  await assert.rejects(store.invalidate(["comfy"], current), bad("STORAGE_ERROR"));
  await unchanged(f, before); await assert.rejects(fs.stat(root), { code: "ENOENT" });
});

test("temporary-file write, fsync, open and rename failures preserve disk and subsequent store reads", async t => {
  const f = await fixture(t); await f.store.write(profile(), snapshot(), current); const before = await fs.readFile(f.file, "utf8");
  for (const operation of ["open", "writeFile", "sync", "rename"]) {
    const open = fs.open; const rename = fs.rename;
    const failure = () => { throw Object.assign(new Error("private failure"), { code: "EIO" }); };
    const mock = operation === "rename"
      ? t.mock.method(fs, "rename", async (from, to) => { if (to === f.file) failure(); return rename(from, to); })
      : t.mock.method(fs, "open", async (...args) => {
        const temporary = path.basename(args[0]).startsWith(".aimedia-resource-snapshots-");
        if (temporary && operation === "open") failure();
        const handle = await open(...args);
        if (temporary) handle[operation] = async () => failure();
        return handle;
      });
    try {
      await assert.rejects(f.store.write(profile(), { models: null }, current), bad("STORAGE_ERROR"));
      await assert.rejects(f.store.invalidate(["comfy"], current), bad("STORAGE_ERROR"));
    } finally { mock.mock.restore(); }
    await unchanged(f, before); assert.deepEqual(await f.store.read(profile()), snapshot());
  }
});

test("CONFLICT and DISPOSED guards propagate unchanged before commit and clean temporary files", async t => {
  const f = await fixture(t); await f.store.write(profile(), snapshot(), current); const before = await fs.readFile(f.file, "utf8");
  for (const code of ["CONFLICT", "DISPOSED"]) for (const guard of [1, 2]) {
    const error = Object.assign(new Error(code), { code }); let count = 0;
    await assert.rejects(f.store.write(profile(), { models: null }, () => { if (++count === guard) throw error; }), found => found === error);
    count = 0;
    await assert.rejects(f.store.invalidate(["comfy"], () => { if (++count === guard) throw error; }), found => found === error);
    await unchanged(f, before); assert.deepEqual(await f.store.read(profile()), snapshot());
  }
});

test("model directory, file, workflow listing and detail limits accept boundaries and reject overflow", async t => {
  const f = await fixture(t);
  const directories = Array.from({ length: 256 }, (_, i) => ({ name: `folder-${i}`, items: [] }));
  const files = Array.from({ length: 10000 }, (_, i) => ({ name: `model-${i}.safetensors` }));
  const listing = Array.from({ length: 10000 }, (_, i) => fileInfo(`flow-${i}.json`));
  const details = Array.from({ length: 64 }, (_, i) => detail(`flow-${i}.json`));
  const boundary = { models: { checkedAt, folders: [{ ...directories[0], items: files }, ...directories.slice(1)] }, workflows: { checkedAt, items: listing }, details };
  await f.store.write(profile(), boundary, current);
  assert.deepEqual(await f.store.read(profile()), boundary);
  const before = await fs.readFile(f.file, "utf8");
  for (const patch of [
    { models: { checkedAt, folders: [...directories, { name: "overflow", items: [] }] } },
    { models: { checkedAt, folders: [{ name: "models", items: [...files, { name: "overflow.bin" }] }] } },
    { workflows: { checkedAt, items: [...listing, fileInfo("overflow.json")] } },
    { details: [...details, detail("flow-64.json")] },
  ]) {
    await assert.rejects(f.store.write(profile(), patch, current), bad("INVALID_ARGUMENT")); await unchanged(f, before);
    await rejectsCorruption(f, JSON.stringify({ schemaVersion: 1, entries: [entry({ ...boundary, ...patch })] }));
    await fs.writeFile(f.file, before);
  }
});

test("profile count is bounded at 32 and whole serialized cache at 32 MiB", async t => {
  const f = await fixture(t); await fs.mkdir(f.root);
  const entries = Array.from({ length: 32 }, (_, i) => entry({ profileId: `p${i}`, identity: profileIdentity(profile({ id: `p${i}` })) }));
  const raw = JSON.stringify({ schemaVersion: 1, entries }); await fs.writeFile(f.file, raw);
  assert.deepEqual(await f.store.read(profile({ id: "p31" })), snapshot());
  await assert.rejects(f.store.write(profile(), { models: models() }, current), bad("INVALID_ARGUMENT"));
  await unchanged(f, raw);
  await rejectsCorruption(f, JSON.stringify({ schemaVersion: 1, entries: [...entries, entry()] }));
  await fs.writeFile(f.file, JSON.stringify(document())); const before = await fs.readFile(f.file, "utf8");
  const items = Array.from({ length: 10000 }, (_, i) => ({ name: `${"模".repeat(600)}-${i}.bin` }));
  const oversized = { checkedAt, folders: [{ name: "first", items }, { name: "second", items }] };
  await assert.rejects(f.store.write(profile(), { models: oversized }, current), bad("STORAGE_ERROR"));
  await unchanged(f, before); assert.deepEqual(await f.store.read(profile()), snapshot());
});
