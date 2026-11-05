# Agent-driven image acceptance — 0.4.0

## Outcome

Implemented the approved Agent-first plugin plan without changing the client.
The normal Agent workflow works on the installed PI-Desktop 0.21.0: discovery,
configured-model resolution, single-call generation, typed image return, local
job recovery, permission-scoped export, Agent-side decoding and a visible image
in the conversation through a Markdown workspace-file reference. No plugin panel
was opened during the Agent E2E.

Full plan acceptance is not claimed: two existing-client limitations remain.
Plan-mode safe plugin tools are not exposed, and plugin image blocks do not get
the host's automatic GenerateImages card. Exported-image Markdown is a verified
visible-delivery path in a workspace; without one, automatic visible delivery
is limited on this client.

## Executed verification

- Full Node suite: **247 passed, 0 failed** (`agent-media-final.log`).
- Existing configuration browser suite: **43 passed** (`agent-settings-browser.log`).
- Generation browser suite: **11 passed** (`agent-generation-browser.log`).
- Agent model/resolution, provenance, duplicate submission, cancellation and
  recovery use real settings/image services with synthetic external boundaries.
- Original export tests: **44 passed**, including actual decoder subprocesses,
  exact PNG hashes, missing permissions/workspaces, partial writes, observed
  workspace changes, existing output refusal, traversal, symlinks and hardlinks.
- New cancellation test failed before the submission guard fix, then passed.
  Waiting cancellation now reaches the preclaim/predispatch path. Disposal aborts
  export's lifetime signal, and sanitized partial-export recovery reaches callers.
- Fresh host data-root mode 0755 test failed before correction, then passed.
  Read-only lookup recognizes no image store without mutating permissions; first
  preparation hardens directories to 0700. Existing image stores stay strict.
- Tool-manifest synchronization and plugin installer validation passed. Installer
  reports the expected high-risk grants and static unused-permission warnings:
  fs.read/write are used through the injected exporter, not literal main.js calls.

Only one optional code-review pass was used. Its three concrete findings were
fixed and covered by the cancellation/export regression tests.

## Real Agent E2E on the unchanged installed client

Fixture: `tests/agent-image.e2e.cjs` and `tests/agent-image-host-fixture.cjs`.
Final run uses the default **0755** initial plugin data directory, not a pre-fixed
private directory, an isolated client profile, a localhost model-protocol server,
and a localhost synthetic image supplier. The test server emits deterministic
Agent tool calls: this verifies tool plumbing and contracts, not the natural-
language reasoning ability of a live LLM provider.

Final report: **34 checks: 30 passed, 4 expected limitation observations,
0 unexpected failures; corePassed=true, passed=false, exit 1**. The four red
acceptance assertions are the two host limitations tested with both a probe and
the real plugin. They were not silently removed or counted as passing.

Evidence in the session scratch directory:

- `agent-image-XjihkC/evidence.json`
- `agent-image-XjihkC/real-plugin-export-preview.transcript.html`

Passed paths include installation into an existing session's next turn, fresh
session discovery, trusted session/turn context, updated descriptors, skill
loading without panel, disable/enable, project scope changes, application restart,
all 12 real tools, default model resolution, image content without Base64 text
flattening, same-key retry without another request, cross-session refusal,
scoped export, actual Agent Bash decoding, exact PNG bytes and visible decoded
Markdown image in the real transcript. Exactly **one localhost image request**.

The installed plugin worker forwards name/description/risk/schema but omits
planSafeActions. Its generated-image renderer only handles the built-in
GenerateImages tool name. These are verified artifact limitations; no client
patch, permission bypass, or impersonation of the built-in tool was used.

The test's three owned app processes needed the bounded forced-shutdown fallback.
This proves persisted restart recovery, not normal client shutdown behavior.
Synthetic Keychain items were cleaned by the fixture.

Installed Host SHA-256 remains:
`522f6168aa6446a44c3a2b306187cd8520497201be46d04fd0364319706cd259`.
The user's running client was not replaced or restarted.

## Authorized real-provider check

One request was prepared and submitted through the existing installed plugin's
compatible 0.3 API (the live dev instance remained 0.3 pending the new 0.4 export
grants). The adapter contract is unchanged; this is supplier connectivity evidence,
not an actual-provider test of the new simplified Agent entry.

- Service: configured 传贝GPT.
- Model: gpt-image-2.
- Output: one PNG, 1024x1024, low quality; blue ceramic cup prompt.
- Job: `img-fc76eca6-a70a-43fb-8b0e-8f632d7a0244`.
- Request hash: `2bde605143fca082de336473506c55c0b607790eb1a1a8491bc052b9fa3e1b36`.
- Prepared: 2026-11-05T04:45:50.797Z.
- Submitted: 2026-11-05T04:52:21.390Z.
- Final local status: **unknown**, code **NETWORK_ERROR**, charging **unknown**.
- No image bytes were obtained, no retry or alternative-model request was made.
- A subsequent DNS-only check resolved the endpoint; this does not explain the
  request failure or prove supplier availability, acceptance or billing.

The user should reconcile this task with provider records before intentionally
creating another billable request. Never claim this live supplier test passed or
that the unknown task was refunded.

## Delivery and remaining boundaries

The package is version 0.4.0 with existing eight tools plus four Agent-first tools.
New fs.read/fs.write grants are narrowed to bone-media/exports/**. Normal host
installation/update review applies; production grants were not manually edited.
Old settings/defaults remain unchanged and version-1 jobs remain readable.

The SDK has no atomic create/pinned-workspace text API. Export guards detect
observed changes and the decoder exclusively creates the PNG, but an unobserved
workspace ABA switch or hostile concurrent handoff replacement cannot be ruled
out by those host APIs. These limits are documented, not bypassed with plugin
Node filesystem access. Partial handoffs retain explicit recovery metadata.
