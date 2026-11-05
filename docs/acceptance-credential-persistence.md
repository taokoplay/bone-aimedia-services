# Encrypted credential persistence acceptance

## Current plugin-only implementation (0.2.2)

The user requires the installed client to remain unchanged. The current plugin
uses macOS Keychain and Node AES-256-GCM; it does not call pi.secrets and declares
no host secret permissions. Random key material travels over stdin to the fixed
system security executable and never enters argv, config files or logs.
Version-2 ciphertext commits atomically with configuration. Existing version-1
host ciphertext is retained and rejected with CREDENTIAL_LEGACY, not reset.
The current runtime contract is documented in configuration-contract.md.

Verified: isolated real Keychain add/read/delete and the actual plugin entry's
save/restore/authenticate/clear lifecycle passed without host secret APIs.
Full Node regression: 147/147 passed. Full Chrome UI regression: 43/43 passed.
Real Electron panel regression passed structured errors, legacy read-only loading,
write refusal and uncertain-save protection. PluginCheck and tool-manifest sync
passed; only existing network/Agent permission grant warnings remain.
The installed client's Host SHA-256 remains
`522f6168aa6446a44c3a2b306187cd8520497201be46d04fd0364319706cd259`;
its version remains 0.21.0 with no local-build marker. A read-only live tool call
reported plugin 0.2.2, macOS support and unchanged config revision 13.

Current-client acceptance is `tests/credential-packaged.e2e.cjs`, launched with
PI_DESKTOP_APP pointing to the installed app and a temporary data directory.
It uses synthetic credentials, the real Keychain, localhost HTTP and an isolated
copy of the plugin; it never installs or replaces the client.
The test waits for this client's plugin-restored logs before loading the fixture,
avoiding a startup race, and does not enable the legacy screenshot capture flag.

Final current-client run passed (exit 0): UI save, plugin reload, application
restart, replacement/restart and clear/restart all succeeded. Two localhost
authenticated requests verified the initial and replacement synthetic keys.
Ciphertext version/backend and no-plaintext public/disk/log results were checked.
All four test app exits exceeded the eight-second normal-quit allowance and
terminated only the owned isolated process before relaunch. Therefore this proves
restart/crash recovery, not graceful-shutdown behavior of the existing client.
Interrupted runs' owned processes and known test Keychain items were cleaned up.
No user credential, generation request, client update or production grant change
was used. No remaining plugin storage blocker was found in this macOS environment.

## Historical host-dependent experiment — superseded

Everything below this heading records the previous approach and its tests.
It is not installation guidance for the current plugin. Do not run its client
installer or replace PI-Desktop. The installed 0.21.0 client lacked those APIs,
so repeated restarts could not make that earlier plugin save credentials.
The replacement client was built and tested in isolation, but never installed.

## Result and migration

API credentials are sealed by the Host and committed with public configuration
in one atomic private file. Reload and Host restart restore credentials; the
panel and Agent receive only a configured flag. Replace, clear, deletion and
connection identity changes retain their existing meaning. Encryption/storage
failures retain old data; decryption failures refuse reads/saves and allow retry
after the original key, permissions or data is restored. Definite encryption
failures preserve the editor draft and permit retry; uncertain storage outcomes
still require rereading. Legacy configs remain readable. Keys already lost by
the old memory-only implementation must be entered once again.

The host uses its existing private machine-key file and AES-256-GCM, not an OS
keychain. Ciphertext is bound to the plugin ID and cannot be moved independently
of the host key. Both secrets permissions require explicit grants.

## Executed verification

- Reproduced restart credential loss before the fix with a failing regression.
- Plugin Node suite: 129/129 passed, including encrypted persistence, old config,
  corruption, wrong identity/key, write/encryption failure retention and disposal.
- Full isolated Chrome suite: 37/37 passed. After adding failure recovery,
  targeted cases 10, 11 and 38 passed (38 distinct browser scenarios covered).
- Real media entry -> actual child proxy -> Electron broker -> rebuilt Rust Host:
  passed save, both-process restart, authenticated synthetic model request,
  replacement, clear, permission revocation/recovery and log nonreflection.
- SDK: 388 source/generated test executions passed; SDK/shared/i18n builds and
  SDK/i18n/desktop typechecks passed.
- Electron permission/child/lifecycle regression group: 35/35 passed. Permission
  matrix tests: 16/16 passed. DevKit checker tests: 11/11 passed, build passed.
- Rust: 13 new crypto/RPC tests, 4 existing provider-secret tests and 9 existing
  registry/install/permission tests passed (26 total). Cargo build, fmt and Clippy
  passed. Clippy reports one unchanged transcripts.rs warning.
- Updated DevKit full plugin check and manifest synchronization passed. Static
  unused-permission hints occur because entry code injects pi.secrets into the
  credential module; the actual use is exercised by full-process acceptance.
- git diff --check passed. No real account, paid API or user's running app used.

## Reproduce real-process acceptance

Build the matching Host and SDK/shared packages in the task worktree, then run:

```bash
PI_DESKTOP_SOURCE=/path/to/PI-Desktop-worktree \
PI_DESKTOP_HOST_BIN=/path/to/new/pi-desktop-host-core \
node --experimental-strip-types tests/credential-host.e2e.mjs
```

The script creates and cleans an isolated Host data directory, uses the real
media plugin entry and mocks only the external provider HTTP response.

## Candidate and remaining integration

Host branch: `fix/plugin-secret-persistence`.
Base/HEAD: `7260d0a00a75c198b01642313c8b7654e8c63940`; task edits are uncommitted.
Host task source fingerprint (sorted modified/new TS/TSX/MJS/Rust paths + bytes):
`165512aa4fa887ed700fea9ce7c0c8ad7dfcca0a6e1c4e56cc82f87a76215558`.
Tested Host binary SHA-256:
`48516f83a24595d6e1348ed28477b0fb580f4fcc4a54069468fa0f596dc472de`.

Remote refresh failed with GitHub LibreSSL SSL_ERROR_SYSCALL/timeouts. This is
local candidate evidence, not validation against the latest remote main or a
merged release. No commit, push, merge, package publication or running-app
replacement occurred. Deploy the matching updated Host before reloading this
plugin and explicitly approve its two secret permissions. The old running
installer does not recognize them; the updated SDK/DevKit does. Reviewed dev
loading and marketplace grants are supported. The existing local path/package
installer has no review payload, so first-time installs requiring these explicit
grants fail safely; use reviewed development loading for this source delivery.

## Follow-up: real panel IPC error propagation

The prior browser fixture reconstructed Error.code, unlike Electron's actual
ipcRenderer/contextBridge exception path. This masked a defect: definite
CREDENTIAL_UNAVAILABLE/PERMISSION_DENIED errors appeared as unknown save outcomes.
After changing the fixture to strip the code, browser case 38 reproduced the
reported message before the fix. The real Electron preload test also confirms
that a thrown custom code is absent at the page boundary.

The media panel now uses `aimedia.invoke` with a versioned JSON success/error
response; it restores only allowlisted codes locally. `aimedia.status` advertises
panelProtocol=1 so a newer page detects an older resident entry before writing.
Legacy direct calls and Agent tools remain compatible. Lost/malformed transport
responses never trigger a write retry or a false successful-save indication.

Verification after this change:

- Node full suite: 134/134 passed, including five new protocol regressions.
- Browser full suite: 37/38 passed; the remaining test expected a code on a raw
  bridge exception. Corrected it to use the page's new protocol and reran that
  case successfully. All 38 scenarios are covered; the full suite was not rerun
  after this test-only correction.
- `PI_DESKTOP_SOURCE=/path/to/host node tests/panel-electron.e2e.cjs`: passed
  using the production preload in a hidden, isolated Electron window. Covers
  missing crypto, denial, crypto failure, conflict, old entry, successful save,
  and a lost response after commit. Never attaches to the user's application.
- `tests/credential-host.e2e.mjs`, now using the actual renderer protocol helper,
  passed against the rebuilt Rust Host with real plugin child/broker wiring.
- Updated DevKit plugin check and manifest synchronization passed.

No running-app replacement, reload, permission mutation or user-key access was
performed. The missing-host-crypto condition still requires deploying the
matching Host implementation; protocol repair cannot supply encryption itself.
After deployment, reload the plugin entry and reopen its page. Preserve unsaved
edits before a reload. A legacy entry now shows an explicit reload instruction.

## Follow-up: configuration loading across entry versions

The protocol handshake also gated local reads, so new page files could hide
existing configuration served by an older resident entry. Separately, switching
tabs cleared the transient error notice, leaving only a generic not-ready state.
Both regressions were reproduced before the fix. A read-only capability call
confirmed that the live plugin could still return saved configuration; no user
keys, private files, provider requests or configuration writes were involved.

The page now allows only the four documented local read channels on legacy
entries, displays saved configuration read-only, and blocks writes and remote
requests until the new protocol is available. Reread/recheck resets protocol
discovery so backend updates are recognized. Loading failures have persistent
page state and a retry action that survives tab navigation. Decryption failures
remain fail-closed and recover after the original capability is restored.

Verification: full Node suite 135/135 and full Chrome suite 41/41 passed in one
run each. Browser cases 39-41 cover legacy configuration display, tab navigation,
retry recovery, decryption unavailability, unchanged revision/data and no network.
The real Electron fixture additionally reloads the actual page under a legacy
protocol and asserts that the saved service row and read-only message render.
Manifest synchronization and the updated DevKit plugin check passed.

This follow-up changes only plugin page behavior, fixtures and documentation;
no storage migration or running-app replacement was performed. Reopen the media
view to load the changed page files. Readable legacy configuration no longer
requires a Host upgrade just to view it; editing still requires the supported
entry protocol, and credential persistence requires the Host secret capability.

## Local application delivery prepared

The earlier remote-refresh block is resolved. The task worktree now contains
main `7dd5cbb47fc31632265ea16e9d6e4362e8aa5465` plus the uncommitted secret changes.
A complete macOS arm64 app (product 0.21.0, bundle build 0.21.0.1) was built with
task-local internal packages and existing external toolchains. Release Host tests
(13 new + 4 provider compatibility), 34 targeted Electron regressions, desktop
typecheck, runtime bundle, production build and package signature checks passed.

`tests/credential-packaged.e2e.cjs` exercised the actual packaged app, copied
media plugin and approved Host IPC grant path. It saved a fixture key via the UI,
confirmed ciphertext-only storage, restarted the application, restored the key,
and authenticated one localhost model request. One test exit needed termination
after the 12-second cleanup budget; the installer never force-quits user apps.

The verified delivery is under the sibling PI-Plugins directory
`deliverables/pi-desktop-secret-storage-7dd5cbb47/`. Its README records hashes,
local ad-hoc signature (not notarized), exact installation/rollback instructions
and validation limits. The installer passed its read-only package/baseline checks
and preserves the old app without reading or changing user data. Replacement of
the running installation remains a final user-controlled step. Restarting the
old application alone cannot activate interfaces absent from that package.
