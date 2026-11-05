# Changelog

## 0.5.0

- Add MiniMax speech synthesis through configured models and explicit voice IDs,
  with Agent generation, voice discovery, session-scoped jobs and MP3 export.
- Unify local image and audio records with state filters, modal playback/download,
  byte-derived audio metadata and local polling for newly created Agent jobs.
- Share durable storage, request lifecycle, concurrency and export safety while
  preserving image formats, old interfaces and credentials without migration.
- Add a speech page and regression coverage. Environmental sound effects, music,
  video and workflow execution remain unavailable; no local synthesis fallback.

## 0.4.3

- Combine the channel and model into one records-table cell: channel above,
  smaller muted model below. Preserve this order on narrow screens and keep
  status filtering, local updates and modal details unchanged.

## 0.4.2

- Merge Records and Task Queue into one local Generation Records page with
  compact channel/model/time columns and Generating/Completed/Failed filters.
  Uncertain outcomes remain visibly unresolved instead of being called failures.
- Open details in an accessible modal with image preview/download, requested and
  actual dimensions, and collapsible prompt/technical data. Preserve list scroll,
  dialog focus and stale-read protection during status updates.
- Remove mixed ComfyUI remote activity from the records page; keep the existing
  backend inspection contracts and configuration/resource browsing unchanged.

## 0.4.1

- Fix lost slow GPT image responses: Agent generation and legacy submit tools now
  retain their originating invocation until the single HTTP exchange and result
  persistence settle. The panel still submits asynchronously through the same engine.
- Bound HTTP waiting to 90 seconds inside the installed host's 110-second tool
  deadline; keep existing-job wait parameters without truncating new submissions.
- Classify host invocation interruption as TOOL_ABORTED/unknown, distinct from
  network failure and timeout. Preserve durable claims and never resubmit unknown jobs.
- Add lifecycle regressions and delayed real-client Agent acceptance.

## 0.4.0

- Add Agent-first model discovery, single-call generation, bounded local waiting
  and image result tools. Select explicit/session/default/unique models in order;
  return choices on ambiguity instead of silently switching services.
- Persist hashed session/request provenance in compatible version-2 image jobs.
  Retry stable request keys across turns/restarts without a second provider call.
- Return bounded typed PNG content and provide permission-scoped original export
  through a fixed decoder; the Agent never transcribes Base64 into a file.
- Retain all eight 0.3 tools and existing UI. Declare read-only plan-safe actions
  and narrow workspace export permissions; document installed-client boundaries.


## 0.3.0

- Add single-output GPT text-to-image through configured OpenAI-compatible services.
  Prepare requests locally, confirm billable submission, and persist exclusive
  dispatch claims so duplicate calls and restarts cannot resend the same task.
- Validate and store PNG bytes, dimensions and hashes; provide local job records,
  result preview/download and bounded Agent result reads without private paths.
- Add generation UI and five task tools. Report uncertain outcomes without retries;
  preserve existing credentials, settings, ComfyUI browsing and workflow behavior.
- Document usage, billing limits, unsupported URL-only output and later phases.

## 0.2.2

- Fix ComfyUI workflow previews rejected by filename-style text restrictions:
  preserve multiline notes, ordinary HTTP links and emoji in validated bodies.
  Keep credential/path/size protections, cache accepted previews across restart,
  and distinguish missing files, invalid content and HTTP failures in the UI.
- Restore read-only configuration loading when new page files meet an older
  resident entry. Keep load failures and retry actions visible across navigation,
  and recheck the protocol after backend recovery without changing saved data.
- Preserve media-panel business error codes across Electron IPC using a versioned
  JSON response. Show specific credential/permission failures without locking the
  editor as an unknown save; detect an outdated resident entry before writing.
  Retain uncertain-save protection for transport loss and ambiguous storage errors.
- Persist API credentials without a client upgrade: keep a random AES-256 key in
  macOS Keychain and atomically commit authenticated ciphertext with configuration.
  Remove the unsupported host secret permissions. Restore after reload/restart,
  preserve old data on failure, and report actual storage support/access status.
  Legacy host-encrypted data is retained and requires its original environment.
- Test ComfyUI connections with the lightweight system endpoint so large node
  catalogs do not falsely fail reachable services. Keep workflow checks separate.
- Persist and apply ComfyUI none/Bearer/custom-header authentication; preserve
  legacy optional Bearer behavior and revoke credentials on identity changes.
- Show safe, localized connection diagnostics and invalidate stale probe results
  when connection settings change.
- Update inline ComfyUI resource lists locally; retain editor/sidebar focus and
  scrolling during folder loads, and avoid page rebuilds on toast dismissal.
- Persist complete ComfyUI model catalogs, workflow listings and viewed workflow
  JSON in a private snapshot file. Reopen offline, show sync timestamps, retain
  successful snapshots on sync failure, and invalidate them on identity changes.
- Query MiniMax cloud models and account voices independently without requiring
  a selected audio model; preserve partial results and filter chat-only models.
- Merge remote MiniMax models with 18 labeled builtin candidates, display voices
  separately, and refresh credential state after save-before-discovery.
- Give MiniMax models and voices separate fetch buttons. Make the voice catalog
  read-only, remove the MiniMax default-voice control, and preserve legacy values.

## 0.2.1

- Refresh the configuration UI to a unified service list with a dedicated DutyDeck-style model configuration page.
- Add local provider icons, service-row editing, enable/disable toggles and custom provider selection.
- Add GPT Image 2 to the OpenAI image model catalog and support adding available models into enabled models.
- Keep generation execution unimplemented; this release changes configuration UX and model discovery presentation only.

## 0.2.0

- Separate Configuration, Records and Task Queue navigation. Combine image/video/
  audio model providers under Model Services; give Dreamina and LibTV dedicated
  singleton entries without deleting existing duplicate configurations.
- Verify LibTV's public HTTP MCP/OAuth metadata and official marketplace model;
  distinguish this plugin's single-entry policy from a global account restriction.
- Add explicit read-only ComfyUI model-folder/file browsing, remote workflow
  listings/details and safe API-workflow draft import. Canvas JSON is preview-only.
- Browse server-wide history and pending/running queues without exposing prompt
  payloads or claiming task ownership. No generation, remote cancellation or
  automatic background polling is introduced.
- Validate listed paths, response limits, endpoint compatibility and asynchronous
  configuration changes before displaying resource data.

## 0.1.0

- Establish an independent media configuration plugin with DutyDeck-inspired
  list/edit pages for generation models, audio, LibTV, connections and workflows.
- Migrate provider validation, atomic configuration storage, temporary credentials
  and explicit directory probes without importing any user configuration.
- Store standalone ComfyUI workflows with validated bindings and protected
  connection references. Node discovery does not execute workflows.
- Expose three read-only Agent discovery tools and accurate generation-unavailable
  capabilities. No paid generation, subprocess execution or result export.
- Provide isolated backend, entry-contract and browser user-path tests; keep
  production data, credentials and test servers out of distributable packages.
