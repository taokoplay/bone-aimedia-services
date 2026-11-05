# GPT image generation acceptance — 0.3.0

## Delivered behavior

Single-output GPT text-to-image through the saved OpenAI-compatible endpoint.
The plugin prepares an immutable local request, explicitly confirms potentially
billable submission, dispatches once, validates/stores PNG bytes, and exposes
persistent records, preview/download and bounded Agent result reads.

Configuration, Keychain credentials, global defaults, ComfyUI resources and
workflow behavior are preserved. No PI-Desktop client source or installed binary
was changed. No new host API or permission was introduced.

## Executed checks

- `node --test tests/*.test.cjs`: 185 passed, 0 failed.
- `python3 tests/settings.browser.py`: 43 passed, 0 failed.
- `python3 tests/generation.browser.py`: 11 passed, 0 failed.
- Real Electron IPC fixture: passed structured errors, legacy read-only behavior,
  write refusal and uncertain-save protection. The fixture exits its own process
  explicitly after cleanup; it does not claim OS graceful-shutdown acceptance.
- Tool-manifest synchronization and JavaScript syntax checks passed.
- PluginCheck passed with only the existing network/Agent permission notice.
- Current installed PI-Desktop 0.21.0, isolated profile: real panel preparation,
  confirmation, one localhost image request, PNG decode, actual download bytes,
  result recovery after restart, and duplicate-submit prevention passed. Keychain
  save/reload/restart/replacement/clear regression also passed in that run.
- The isolated app's four exits exceeded the normal-quit grace period and required
  termination of its owned test process. This verifies restart/crash recovery,
  not the existing client's normal shutdown behavior.

Tests use synthetic credentials and generated PNG fixtures. No real provider
account, paid generation, user API key or production settings were used.

## Concrete issues fixed during acceptance

- A globally retained publication lock could block all future jobs after a crash.
  Atomic exclusive publication and 200 fixed capacity reservations now isolate
  interruption to the affected job/slot; submission claims are never stolen.
  Independent-process tests cover interruption after slot/job/claim/image writes.
- Graceful disposal now drains already-dispatched responses. A forced process exit
  without received bytes still yields unknown and never resends the paid request.
- A committed PNG can be validated and read even if the final job record write
  was interrupted. Recovery performs no network request or implicit disk reset.
- Definite pre-dispatch conflicts stay prepared/editable and display "not submitted".
- A local history refresh previously detached an open model picker. Expanded
  state and option focus now survive repaint; the deterministic failing case passes.
- The Electron download test now observes the plugin's own session partition,
  rather than the main window session, and verifies the actual saved file bytes.

One bounded review was performed. Its concrete findings above were addressed and
covered by targeted tests; no repeated broad review cycle was run.

## Real-provider status and limits

A live read-only capability call reported plugin 0.3.0, config revision 15,
working Keychain access and a ready GPT operation for the configured OpenAI profile.
This is a local readiness check, not proof that the third-party service accepts
these parameters or returns valid PNG output.

No real supplier generation was submitted in this implementation turn. The current
conversation's tool catalog did not expose newly registered prepare/submit/read
names despite the updated runtime and manifest. The plugin page is available;
Agent sessions must discover the refreshed tool catalog before using those tools.
Do not substitute a different generator and label it a test of this plugin.

Supported output is Base64 PNG up to 16 MiB; URL-only responses remain
result-pending. Image editing, video/audio generation, remote job recovery and
pricing estimation are not implemented. Storage is bounded to 200 permanent
reservations; automatic cleanup/reclamation is not implemented. Usage and staged
extension plans are documented in gpt-image-usage-plan.md.
