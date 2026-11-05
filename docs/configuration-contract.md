# Configuration and generation contract — 0.5.0

## Runtime and storage

Plugin ID `bone.aimedia.services`, view `settings`, command
`bone.aimedia.services.open`. Source is independent from Film Factory. There is
no production schema or dependency on a Film Factory installation.

Agent-first image orchestration is specified in agent-image-contract.md; speech
and unified records are specified in audio-generation-contract.md. Sixteen tools
reuse the settings/generation services, with no new credential source.
Image records read both version 1 and version 2; version 2 adds private hashed
Agent provenance. Existing public responses omit it. No settings migration or
automatic default change is performed. Export declares only workspace-scoped
fs.read/fs.write for bone-media/exports/**; generation is independent of export.

Agent submission holds its originating host invocation until the shared image/audio
execution settles and persists the result. The panel's submit/poll contract stays
asynchronous. New HTTP requests have a 90-second deadline under the installed
host's 110-second tool limit; existing-job waitMs is not a new-request timeout.
Invocation interruption is stored as TOOL_ABORTED/unknown, not NETWORK_ERROR.
No stored job migration, automatic retry or network permission change is made.
`createMediaProviderSettings({getDataPath, request, secrets})` owns one instance per
plugin-private directory. It reads/writes `aimedia-settings.json`, never the
workshop's media-providers.json. Public snapshots contain:

```text
revision
profiles[]
defaults { image, video, audio }
workflows[]
catalog[]
```

Credentials persist as plugin-encrypted ciphertext; probe results are session-only.
Public profiles add credentialConfigured and lastProbe, never a key or ciphertext.
Normalized persisted profiles contain id/name/provider/enabled/baseUrl/models/modelId/voice/format/
cliPath/comfyUser and compatibility workflow/bindings fields. New standalone
workflows are stored in the workflows collection instead of embedded in profiles.

v0.2 adds singletonConflicts for legacy duplicate Dreamina/LibTV entries and
read-only `aimedia.browse` resources for ComfyUI model folders/models, remote
workflows/details, server history and queue. Browse input is revision-bound,
GET-only and requires prior successful listing membership for detail paths.
Resource results are server-scoped metadata; they do not prove this plugin owns
the jobs, execute workflows or enable generation.

Each model has id/name/kind. Defaults are explicit existing enabled profile IDs
or null. No auto-selection occurs. Whole saves validate all references and
commit atomically under a serialized optimistic revision check. Missing files
read as an empty state without writes; corrupt files are reported, not reset.


## Generation records presentation

The visible navigation is Configuration, Image, Audio, Generation Records. The latter
merges image and speech jobs into one local list with kind and channel/model labels.
It uses local state filters and a modal detail view described in
generation-records-ui.md. Existing image records and routes remain compatible;
additive audio/records routes are described in audio-generation-contract.md.
ComfyUI history/queue APIs remain compatible but are not mixed into this list.
## Panel bridge

The page reads `aimedia.status.panelProtocol` before dispatch. Version 1 uses
`aimedia.invoke {channel, payload?}`. An older resident entry remains readable:
only `aimedia.get`, `aimedia.status`, `aimedia.capabilities` and local
`aimedia.resourceSnapshot` may use their legacy direct channels. The page shows
the saved configuration in read-only mode; mutations and remote requests still
require the new protocol. Explicit reread/recheck resets the capability probe
so an upgraded entry becomes editable without reopening the page. Responses are
`{protocol: "aimedia.panel.v1", ok: true, result}` or
`{protocol: "aimedia.panel.v1", ok: false, error: {code}}`. Only allowlisted
safe codes cross this response; there is no raw error text, input or key.
The wrapper dispatches only existing aimedia channels and rejects recursion.
Legacy direct channels below retain their existing success/error contracts.

Electron's IPC/contextBridge exception path does not preserve custom Error.code.
The page therefore classifies only validated response errors, never parses error
messages or automatically retries a failed write. Missing crypto/denied grants
remain definite rejections with drafts intact. Transport loss, malformed replies
and storage uncertainty still require rereading before another save.

Initial load failures are persistent page state, not transient notices. The
reason and a retry button remain visible when switching tabs. Successful retry
clears that state. A decryption failure still refuses loading rather than
resetting credentials; restoring the host capability/permission permits retry.
This compatibility path never rewrites or migrates the stored configuration.

- `aimedia.get`: read a full public snapshot; no network.
- `aimedia.save`: `{expectedRevision,profiles,defaults,workflows?}`. Supplying
  workflows replaces the collection; omission preserves it. UI sends the complete
  intended set. Invalid data or stale revisions reject without partial changes.
- `aimedia.probe`: `{profileId,expectedRevision,workflowId?}` for an explicitly
  selected saved enabled profile. A supplied workflow must be saved, enabled
  and bound to that enabled ComfyUI connection. It is checked without execution.
- `aimedia.capabilities`: same generation-unavailable boundary as the Agent tool.
- `aimedia.status`: version, panelProtocol, registered tools and safe registration diagnostics.
- `aimedia.resourceSnapshot`: `{profileId,expectedRevision}` reads local catalogs
  only; returns `{profileId,revision,models,workflows}`. Missing catalogs are null.
- `aimedia.syncResources`: `{profileId,expectedRevision,resource}` where resource
  is `models` or `workflows`. Explicitly fetches and atomically saves one catalog,
  returning the same local snapshot envelope. Failed sync leaves old data intact.
- `aimedia.readResourceWorkflow`: `{profileId,expectedRevision,path}` returns a
  cached validated JSON body when present, otherwise reads the listed workflow
  from its saved server and caches it before returning. No task is submitted.

UI response/selection guards prevent late reads from overwriting current drafts.
Error responses use fixed safe messages and codes, not raw provider errors.
Main entry does not persist panel payloads or credential-bearing audit records.

## Persistent resource snapshots

The inline connection page automatically reads local catalogs on entry and shows
their last successful sync time. Folder selection uses the local model list with
no network. Explicit synchronization updates a complete category, retaining the
other category and the previous snapshot on failure. The existing `aimedia.browse`
route stays remote, explicit and non-persisting for older consumers/activity views.

`aimedia-resource-snapshots.json` is an independent private sidecar with
`schemaVersion: 1` and up to 32 profile entries. The settings file keeps its format.
Each entry stores a SHA-256 identity of public connection fields (ID, provider,
normalized endpoint, Comfy-User, auth kind and lowercased header name), model and
workflow catalogs, and up to 64 viewed workflow bodies. Credentials and credential
hashes are excluded. File creation uses mode 0600, bounded reads, filesystem-link
guards and exclusive temporary files followed by fsync and atomic rename.

Model sync requests the full folder listing and every folder's file names, with
at most four concurrent GETs. It does not download model weights. Limits are 256
folders and 10,000 files per folder; the sidecar is limited to 32 MiB. Workflow
sync stores up to 10,000 directory records, not unviewed JSON bodies. Reading a
listed workflow caches its validated body (at most 200 KiB); importing it creates
only a local draft that still requires explicit saving. Successful workflow
directory resync discards old cached bodies so future reads obtain current JSON.

Workflow bodies use content validation, separately from directory/path metadata.
Canvas notes and API input text can contain line breaks, tabs, well-formed Unicode
including emoji, and ordinary HTTP/HTTPS documentation links. They are displayed
as text only: links are not fetched or activated and markup is not interpreted.
Known secrets, credential fields/assignments, credential-bearing or signed URLs
(including percent-encoded parameter names), invalid Unicode, non-text controls,
prototype keys and existing depth/node/byte limits still reject. Canvas remains
preview-only; only validated API format can become an explicitly saved draft.

Resource failures return fixed safe codes and, for remote HTTP failures, a
bounded status number. Workflow file 404 is WORKFLOW_NOT_FOUND, not unsupported
directory API. Other detail-specific codes include WORKFLOW_TOO_LARGE,
WORKFLOW_INVALID and RESOURCE_LIST_STALE. HTTP/auth/JSON/timeout failures retain
their distinct codes. The cached detail route preserves these codes across the
panel response. Failed detail reads retain catalogs and never persist unsafe
content; a later successful retry does not require resaving provider settings.

All cached data is revalidated when read, including known-secret exclusion and
workflow format/importability. Corruption is reported without resetting files.
Read-only entry into a page never creates a missing snapshot file. Authenticated
snapshots can be read offline after restart after credentials are restored;
network synchronization uses the restored credential without re-entry.

Rename and enable/disable changes preserve snapshots. Endpoint/auth/user changes,
credential replacement/clear, and connection deletion invalidate affected entries
before the settings commit. If the subsequent config write fails, only cache data
may have been discarded; resources cannot leak across identities. Snapshot writes
and configuration saves share the service queue, and epoch/revision checks reject
late network results. Disposal drains issued writes before a replacement loads.

## Standalone workflows

Record shape: `{id,name,kind,connectionId,definition,bindings,enabled}`. Kind is
image/video/audio; connectionId is null or an existing ComfyUI profile. API-format
definition is a nonempty map from node ID to `{class_type,inputs,_meta?}`. Bindings
are `{purpose,nodeId,input}`, with unique purposes and targets, and must name a
real input. Supported purposes: prompt, negativePrompt, seed, width, height, steps.

The limit is 64 workflows, each ≤200 KiB / 300 nodes / 12 bindings. Known credential
fields, prototype keys and embedded authorization patterns reject. Existing session
secrets cannot be copied into nonsecret fields. Removing/changing a referenced
connection without explicitly unbinding/deleting its workflows rejects atomically.
Saving a workflow never contacts a server. A probe verifies node classes only;
model checkpoints, output compatibility and execution remain unverified.

## MiniMax cloud catalogs

MiniMax `aimedia.probe` accepts optional `catalog: models | voices` alongside
profileId and expectedRevision. Models request only `GET /models`; voices request
only read-only `POST /get_voice` with `voice_type: all`. Both use the saved
profile's Bearer credential without requiring a selected model. Other providers
reject catalog selection. Omitting catalog preserves the older combined query.
All issued requests settle before releasing the per-profile pending guard, and
configuration changes or disposal discard late results.

Responses separate `models: [{id,name,kind}]` and `voices: [{id,name}]`.
`catalogs` includes status/error metadata only for requested catalogs, and
`scope.catalog` records an explicit selection. Unrequested arrays are empty;
the panel retains the other catalog's previous result for the same identity.
For legacy combined queries, overall status is connected if either succeeds.
No generation is verified or submitted.

Models accept array/data/models envelopes with string or ID/name entries. Only
image, Hailuo, T2V/I2V and speech model families enter this media configuration;
chat-only results produce an explicit empty-media message. Voice groups accept
arrays or `{items}` for system, cloned and generated voices. Both lists are
deduplicated, sanitized and capped at 100; raw responses and credentials are not
reflected. Endpoint failures preserve the other endpoint's successful result.

The catalog exposes 18 MiniMax builtin candidates (2 image, 8 video, 8 speech)
separately from its existing three default models. The UI merges builtin and
remote candidates by ID and labels their source; it never claims builtin entries
were returned by the cloud. Model choices are saved explicitly. The voice catalog
is read-only: no use/selected buttons or MiniMax default-voice input are rendered.
Voice selection belongs to each generation request by the user or Agent. Existing
persisted voice values remain intact for compatibility; browsing or refreshing
never changes them. Each section has its own fetch button in the heading.
Changing/clearing the API key invalidates both cached results. Missing keys fail
locally before saves or requests; valid dirty/new drafts retain the existing
save-before-discovery behavior and authoritative credentialConfigured flag.

Acceptance: `tests/minimax-discovery.test.cjs` covers zero-model discovery,
classification, partial failures, empty-media results, limits, key redaction,
deduplication, targeted endpoint selection and late-response rejection. Browser
cases 33-36 cover independent refresh, read-only voices, unchanged saved values,
header-button placement, failure isolation, key changes and model save/reopen.

## Credentials and requests

Credential updates are preserve/replace/clear. Replace accepts a bounded secret
only in credentialUpdate. The plugin encrypts before committing configuration
and ciphertext together in `aimedia-settings.json`. Runtime state changes only
after the atomic write succeeds. Omitted updates preserve credentials only for
unchanged provider and endpoint. CLI/MCP providers do not accept API credentials.
Disposal drains issued storage work and clears memory; late results cannot
reinstall disposed state. The next instance retrieves the same Keychain key.

The internal envelope is `{version: 2, backend: "macos-keychain", ciphertext}`;
it is excluded from public save/read contracts. Decrypted payloads remain strict
`{version: 1, entries: [{id, identity, value}]}` records bound to public profiles.
AES-256-GCM uses a fresh 12-byte nonce and AAD containing the fixed plugin service
and SHA-256 of the resolved absolute data directory. The 32-byte random master
key lives in macOS Keychain, not beside the ciphertext. `/usr/bin/security -i`
receives the fixed add command and hex key through stdin; keys never enter argv,
environment variables, temp files or logs. Creation omits -U and -A; readback
verifies the committed item. Process output is bounded and errors sanitized.

No new host API or secret permission is required. Only macOS credentials are
supported. Missing/locked/denied/corrupt keys fail without overwriting data or
generating a replacement during restore. Failed reads can be retried after
repair. Clearing all credentials removes the envelope but keeps the random
Keychain key for subsequent saves. Keychain items are scoped to data directories;
copying a config to a new directory or machine does not migrate its credentials.
Ordinary legacy configs remain readable. Version-1 host-encrypted envelopes are
retained and rejected with CREDENTIAL_LEGACY: their original encryption environment
is required. Never reset them or try decrypting them with a new Keychain key.
Keys already lost by the old memory-only implementation must be entered again.

ComfyUI profiles optionally persist `authKind` (`none`, `bearer`, `header`) and
`headerName`. Header names are limited to `X-*` or `Authorization`, up to 80
characters; transport headers and CRLF are rejected. New panel connections use
explicit `none`. Legacy profiles without these fields keep optional Bearer
behavior; reads do not rewrite them, and legacy saves preserve an existing auth
mode. Selecting `none` clears the credential from memory and persisted settings.
Preserve only retains a ComfyUI credential while endpoint, auth mode, header
name and Comfy-User match. Explicit bearer/header requests without a credential
fail before network. Auth metadata and encrypted credentials survive restart.

All HTTP goes through injected host-mediated request, redirect=error, explicit
bounded timeout and response limits. Default service origins follow the catalog;
custom image HTTP/HTTPS and ComfyUI endpoints are validated. No URI credentials,
query-string auth, metadata service, wildcard or unsupported scheme is accepted.
A permission denial has no direct network fallback.

Read-only probes: OpenAI/Xiaomi models, MiniMax model/voice catalogs, ComfyUI
system status. A ComfyUI connection without a workflow requests only
`GET /system_stats`; a system object is required and device details are optional.
It returns `connectionStatus=connected`, `workflowCompatible=null` and an empty
node summary. It does not load `/object_info` or imply that zero nodes exist.
An embedded or explicitly selected saved workflow additionally requests
`/object_info` and validates node records and required classes. The 2 MiB response
limit remains in force. A catalog error preserves verified connection status and
leaves workflow compatibility unknown; missing required nodes yields false.

ComfyUI probe failures add an allowlisted `code`, a fixed endpoint discriminator
(`system_stats` or `object_info`) and an optional numeric `httpStatus`. They
distinguish authentication, missing endpoints, timeout, refused redirect, network,
invalid JSON/schema, oversized response and host permission denial. No response
body, headers, secret or raw host error is reflected. The panel translates these
fields to Chinese and clears stale connection status before retries and edits.
Entering/editing/saving a connection does not probe automatically. Unsaved edits
disable connection testing and resource synchronization until saved.

The inline ComfyUI snapshot owns its mounted resource view. Directory selection
and request progress update the resource content and selection state without
rebuilding the connection form or sidebar. The bounded directory/file columns
scroll independently, keeping page height stable while a snapshot loads. Successful
toast dismissal removes only that notice. Pending sync ignores further folder
clicks before mutating selection; cached folder changes never fetch remotely.
Reset/navigation discards the view updater and stale request results. Browser
acceptance covers scroll/focus retention, sync deduplication, failure retention,
notice expiry, restart/offline reads, identity changes and narrow layouts.

CLI/MCP and unsupported model operations return honest unsupported states.
Every probe result includes a scope identifying its profile and optional workflow.
Agent summaries retain connection state and the scoped workflow check separately.
Probe success never enables generation.

## Agent surface

The three discovery tools remain low-risk, read-only and network-free.
Five image tools are added: prepare_image (medium, local write), submit_image
(high, potentially billable), get_image_job, list_image_jobs and read_image_result
(low, local reads). The panel uses aimedia.image.prepare/submit/get/list/read.
See gpt-image-usage-plan.md for the exact request, state and export workflow.
Capability contractVersion remains 1 with additive generation constraints;
generationImplemented=true covers GPT text-to-image and MiniMax speech. Other
operations remain configuration-only. Readiness requires a supported configured
model, enabled service and restored credential, not a network probe.
credentialStorageStatus remains backend/support/last-access observation.

An actual Agent get_capabilities invocation establishes toolReachable=true for
that call. The panel response instead uses the actual get_capabilities registration
state and returns false when Agent tool registration was unavailable or denied.
list_profiles optionally filters kind and returns only public service/model
summaries plus a credential flag and last connection-check status. list_workflows
returns metadata, connection reference, node/binding counts; it omits definition
text. No tool claims another plugin's installation or provider execution state.

## Compatibility and acceptance

The imported prototype code is implementation reference only; no old private
configuration is migrated automatically. Existing works remain in Film Factory.
Implemented GPT and MiniMax speech subsets are described in gpt-image-usage-plan.md
and audio-generation-contract.md. Remaining ideas in api-contract-draft.md are proposals.

Tests use temporary private directories and synthetic HTTP. Run backend/entry
checks with `node --test tests/*.test.cjs` and browser user paths with
`python3 tests/settings.browser.py`. The latter starts its own real-plugin bridge
and cleans up on exit. Native host permission prompts and real-provider success
require separate explicit acceptance and are not inferred from these tests.
