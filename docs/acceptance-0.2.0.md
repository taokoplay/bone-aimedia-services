# Acceptance — Bone AI Media Services 0.2.0

## Delivered

- Three top-level pages: Configuration, Records and Task Queue.
- Model Services combines image/video/audio profiles with type filters.
- Dreamina and LibTV have dedicated singleton configuration entries; legacy
  duplicate entries remain visible and are never deleted automatically.
- ComfyUI supports explicit read-only browsing of model folders/files, remote
  workflow metadata/details, queue and history. API workflows can be imported
  as local drafts; canvas workflows remain preview-only.
- Records and queue distinguish this plugin's unimplemented local executor from
  server-wide ComfyUI data, which may include work created by other clients.
- No generation submission, remote cancellation, background polling, automatic
  retry or result export was added.

## Verification

- Node backend/entry/resource suite: **79 tests passed**, no failures/skips.
- Chrome/Playwright browser suite: **24 scenarios passed**, including original
  settings, singleton profiles, model resources, workflow detail/import,
  read-only history/queue, unsupported endpoints, stale navigation and four
  responsive widths in dark/light themes.
- No real ComfyUI, LibTV account, provider credential or paid generation was used.
  All remote responses were synthetic fixtures.
- ComfyUI protocol paths were cross-checked against DutyDeck's existing client
  and public ComfyUI source routes. LibTV MCP/OAuth metadata was read from its
  public protected-resource and authorization-server documents; login was not run.
- Manifest synchronization, JavaScript syntax, documentation links/fences/JSON
  examples and plugin structure checks passed. Generated runtime package was
  compared file-by-file against clean staging.

## Boundaries

- Remote queue/history results are server-wide; they do not prove this plugin
  owns or created any task. Prompt bodies, auth headers and raw result URLs are
  filtered from projections.
- Model presence does not prove checkpoint compatibility or generation quality.
  Remote workflow details are bounded; canvas JSON is not automatically converted.
- The plugin still has no native generation execution, task state machine,
  binary result export, encrypted persistent credential store or automatic
  installation inventory. These remain later phases.
- Installation/reload through the native host and permission prompt UX remain
  user-controlled checks. Do not restart PI-Desktop while other tasks run merely
  to validate this package.
