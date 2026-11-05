# MiniMax speech workflow acceptance — 0.5.0

## Delivered scope

MiniMax text-to-speech now supports the complete configured-provider workflow:
voice discovery, explicit model/voice selection, preparation, one authorized
submission, durable state, unified image/audio records, browser playback/download
and session-scoped Agent export. Speech and image generators share a two-request
budget and common storage/lifecycle/export safety.

Environmental effects such as footsteps, music, image editing, video and ComfyUI
execution remain unsupported. Previously generated local audio files are not
imported or relabeled as provider-generated jobs. No host-client update, credential
migration, output overwrite or change to existing image task formats is required.

## Candidate identity

Development branch: `feat/audio-generation`.
Base: `bb69b78ce55415d44a67af8be1d88c4e7147bc63` (`origin/main`).
The base was refreshed before final validation and remains an ancestor of HEAD.
The candidate is the uncommitted request worktree; no commit, push, live plugin
installation or marketplace publication is claimed for 0.5.0.

## Executed checks

| Check | Result |
|---|---|
| `node --test tests/*.test.cjs` | 281 passed; no failures, cancellations or skips |
| `python3 -B tests/settings.browser.py` | 43 passed |
| `python3 -B tests/generation.browser.py` | 11 passed |
| `python3 -B tests/records.browser.py` | 7 passed |
| `python3 -B tests/audio.browser.py` | 9 passed |
| `node scripts/sync-manifest.cjs --check` | 16 registered tools match manifest |
| `node --check` for main/lib/tools/renderer JavaScript | Passed |
| Python browser-suite AST checks | Passed |
| `git diff --check` | Passed |
| README and new contract local links | Passed |
| Manifest permissions/fs scope/engine range against base | Unchanged |

Node coverage includes real plugin entry orchestration (voice catalog -> speech
submission -> mixed records -> local chunk read -> fixed decoder -> original MP3),
restart/idempotency, per-session ownership, explicit operation/model boundaries,
uncertain results, actual cross-media concurrency wiring, occupied-output and
handoff-tampering refusal. Existing image export and generation suites ran against
the extracted shared modules. The first full integration run had one stale test
expecting 12 tools; it was updated to the actual additive 16-tool contract, then
all tests passed. No behavior assertion was removed to hide a failure.

Browser suites use the real plugin entry/bridge with temporary storage and
synthetic supplier responses. Audio coverage exercises preparation/confirmation,
submitting/completed/failed/unknown records, automatic discovery of Agent-created
jobs, browser playback, download byte hash, non-overlapping local polling, modal
focus, closing/navigation/disposal cleanup, late results and corrupted result
handling. Image, configuration and existing record user paths also passed.

The synthetic MP3 fixture is eight MPEG-1 Layer III silence frames (32000 Hz,
mono, 9216 samples / 288 ms), not recorded speech or a paid provider result. It
was independently decoded by FFmpeg and Chrome AudioContext. Production validation
is honestly labeled mp3-frames-validated, with browser decoding before playback.

One optional read-only backend/Agent/export review found no actionable in-scope
defects. This is a static review, not additional runtime or supplier evidence.

## Visual inspection

Desktop speech form, mixed record list, audio dialog, 390px dark and 320px light
dialog screenshots were inspected. Channel remains above muted model text in a
single column. The audio dialog exposes controls, download and metadata without
expanding the list. Test text includes escaped HTML to exercise safe rendering.

Session evidence (not included in the release package):

- `audio-final-node.log`: final 281-test run.
- `audio-agent-final.log`: 6 focused Agent audio entry/export tests.
- `aimedia-settings-browser.log`, `aimedia-generation-browser.log`,
  `aimedia-records-browser.log`, `aimedia-audio-browser.log`.
- `audio-form-1160-dark.png`, `mixed-records-1160-dark.png`,
  `audio-detail-1160-dark.png`, `audio-detail-390-dark.png`,
  `audio-detail-320-light.png`.

## Limits and remaining live acceptance

No real MiniMax request was made, no live credentials were read, and no paid API
cost was incurred by this implementation task. Provider availability, account
entitlement, voice quality and actual recorded speech still require a separately
authorized test after the new plugin is installed. The user's PI-Desktop client
and installed 0.4.3 plugin were not modified during development.

PI-Desktop 0.21.0 can retain an already-open plugin view after installation.
If the old navigation remains visible after upgrading, save edits and wait for
active generation to finish, then disable/re-enable this plugin to rebuild its
view. Merely closing its tab may keep the cached page alive. This is a documented
host lifecycle limitation, not an instruction to delete plugin settings/history.
