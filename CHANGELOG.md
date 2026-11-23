# Changelog

## 0.7.3

- Match ComfyUI API-format node fields and output candidates for prompt, dimensions, sampling, timing, frame and reference-image bindings.
- Add guarded image-to-video reference upload through the Host binary request contract; validate the returned ComfyUI input reference before writing it into a cloned prompt.
- Reject workflow inputs that contain the saved ComfyUI credential, preserve single-submission idempotency, and expose the new matching flow in the bilingual settings page.

## 0.7.2

- Remove the fixed per-media and unified generation-record caps; existing records remain readable and new records are retained until explicitly deleted.
- Add guarded batch deletion for local image, audio and ComfyUI records through the records page and `delete_generation_records` Agent tool.
- Keep unresolved submissions, unknown outcomes and result-recovery states protected from deletion; terminal record deletion removes associated private result files.

## 0.7.1

- Fix Agent image generation failures that were returned as completed tool calls when multiple models had no selected default.
- Return `MODEL_SELECTION_REQUIRED` or `MODEL_UNAVAILABLE`, mark structured failures as tool errors, and keep provider submission at zero until a model is explicitly selected.

## 0.7.0

- Add ComfyUI API workflow execution for image, video and audio outputs.
- Synchronize remote workflow definitions into local snapshots with source hashes and explicit output rules.
- Submit once, retain the ComfyUI prompt ID, reconcile the same task after reload, and download results through the host bounded binary response contract.
- Validate output paths, media signatures and SHA-256 before adding independent `wf-` jobs to unified Generation Records.
- Add `generate_workflow_media`, `workflow_job`, `cancel_workflow_job` and `export_workflow_result` while preserving the existing sixteen tools and image/audio records.
- Keep canvas workflows preview-only, server-wide history/queue separate, and unknown outcomes free of automatic resubmission.
- Mark structured Agent generation failures as tool errors so model-selection failures are not reported as successful calls.

## 0.6.2

- Support reference-image edits on text-only Hosts through the official JSON
  `images[].image_url` data-URL format, retaining multipart on capable Hosts.
- Keep scoped image reads, original-byte hashes, ordered request identity and
  existing task formats; missing binary fields select JSON with error redirects.
- Select a transport before submission and never retry another format after a
  provider rejection or unknown result. Preserve text/speech and all sixteen tools.
- Correct capability diagnostics and Agent guidance; binary upload is optional.

## 0.6.1

- Show the running plugin version in the panel badge and localized window title
  using the existing status handshake, replacing the stale fixed 0.5.4 label.
- Hide unavailable or invalid version metadata, discard obsolete handshake
  replies, and preserve active editor contents and focus during version updates.
- Add bridge and browser regressions for both locales, reloads and disposal.

## 0.6.0

- Add ordered GPT reference-image input to Agent and legacy preparation tools,
  with scoped PNG/JPEG/WebP reads, content hashes and multipart image edits.
- Require explicitly advertised Host binary HTTP capability; older Hosts keep
  text/speech generation and reject references before submission.
- Preserve text-only job formats and single-submission behavior; use version-3
  records for reference jobs and document the downgrade boundary.
- Keep plugin startup and text/speech tools available when optional reference
  capability discovery fails; report shared, sanitized Host support diagnostics.
- Remove redundant workspace queries before Host-pinned image reads while
  retaining post-read checks, content verification and cancellation handling.

## 0.5.4

- Keep only Configuration and Generation Records in the panel. Create images and
  speech from Agent conversations; remove the redundant manual forms/controllers.
- Preserve all sixteen Agent tools, compatible backend routes, project badges,
  compact columns, local progress, image preview, speech playback and downloads.
- Allow the configuration search field to shrink at 320px while keeping the add
  action readable, removing a narrow-screen horizontal overflow.
- Supply English and Simplified Chinese marketplace metadata and panel copy for
  publication. Preserve Chinese fallback on hosts without a locale API.
- Exercise Agent-to-record user paths, keyboard navigation and media cleanup in
  isolated browser tests. Existing credentials, tasks and permissions are unchanged.

## 0.5.3

- Rebalance records-table columns so channel/model no longer consumes most of
  the available width. Move status and time closer while preserving project
  badges, header alignment and narrow layouts.

## 0.5.2

- Show a small project-name badge below each image/speech task type. Long names
  truncate in the list and remain available through the title and accessible label.
- Capture the project at task preparation using host context. Preserve snapshots
  across project switches and restart; legacy or unverified associations remain
  explicitly unknown. Existing task formats, generation and permissions are unchanged.

## 0.5.1

- Republish the verified image/speech workflow with intact UTF-8 source files.
  The initial marketplace 0.5.0 MCP upload incorrectly converted non-ASCII
  text during request transport; the GitHub 0.5.0 asset was unaffected.
- Keep generation behavior, credentials, task storage and permissions unchanged.
  Prefer 0.5.1 when installing from the marketplace.

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
