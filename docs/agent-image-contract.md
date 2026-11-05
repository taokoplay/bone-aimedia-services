# Agent-driven images — 0.4.1 contract

The approved plan is `.pi/plan/agent-驱动生图-安装发现-模型选择-调用与图片交付-20261105-1215.md`
in the host workspace. This implementation changes the plugin only.

## Entry points

Four additive Agent tools reuse the existing image engine. The eight 0.3 tools
and panel routes keep their names, arguments and response shapes.

| Tool | Input | Behavior |
|---|---|---|
| media_catalog | action=list; optional kind | Local models, stable modelRef, readiness reasons, saved defaults and constraints |
| generate_image | prompt, requestKey; optional modelRef, size, quality, waitMs | Resolve, prepare, submit once and retain the originating call until HTTP/result persistence settles (90-second HTTP deadline) |
| image_job | action=get/wait/list/result; jobId except list; waitMs only for wait | Local read, at most 15 seconds waiting, or typed PNG result |
| export_image_result | jobId | Permission-scoped export handoff; never generates |

Tool responses contain `content` blocks plus `structuredContent` metadata. Safe
errors use `{ok:false,error:{code}}`, preserving business codes across the host's
exception serialization. Caller/session IDs cannot be supplied in arguments.
`media_catalog.list` and all four image_job actions are declared plan-safe;
generate/export require host-attested Agent mode. Plan/Goal cannot generate.

Starting in 0.4.1, new submissions cannot return after the short waitMs interval.
The installed worker cancels unresolved host API promises when their originating
tool finishes. Both generate_image and legacy submit_image therefore await the
shared engine's active execution, outside its command queue. Panel submit remains
asynchronous. waitMs (0–10000) retains its schema and applies only to local waiting
for an existing task; it is not the duration of a newly submitted HTTP exchange.
HTTP uses a 90000ms timeout to reserve parsing/storage time under the host's 110s
tool deadline. This is a bounded compatibility fix, not support for indefinitely
running providers. No context detachment, direct-network fallback or resend occurs.

## Model resolution

modelRef is `media:<encoded profile id>:<encoded model id>`. Catalog results carry
names for natural-language matching and IDs for exact routing. Only configured
OpenAI gpt-image-* image models have an implemented executor. Enablement and
restored credentials determine local readiness, not provider availability.

Precedence: explicit modelRef; most recent explicit selection in this session;
valid saved defaults.image/profile.modelId; unique ready candidate; otherwise a
structured selection-required result with choices. An explicit unavailable model
never silently falls back. Remembered selections and defaults must still be ready.
Configuration is read at call time; defaults are never automatically changed.

## Idempotency and context

The host must provide sessionId, turnId and operating mode. A requestKey is a
short stable task label, reused for retries. Deterministic job IDs are derived
from the session and key; the same prompt can still be deliberately regenerated
with a new key. The turn hash records provenance, but does not break retry identity
across turns. User authorization remains scoped to the actual requested output;
installation grants do not authorize unlimited generations or automatic retries.

New jobs use private record version 2 with a validated agentRequest version 1:
sessionHash, turnHash, requestKeyHash, inputHash, modelRef and explicitModel. Old
version-1 records remain readable. Public 0.3 responses omit this source metadata.
This is the same image-job store, not a parallel credential or task repository.
An existing request is checked before current model resolution, so config changes
cannot redirect a retry. Changed intent under the same key returns a conflict.

The simplified job interface lists/reads only source-bound jobs for the calling
session. Legacy plugin-wide tools and the settings page retain their established
scope; this addition does not claim universal project isolation of old records.

Cancellation may interrupt local host-API waiting; it does not establish remote
cancellation or a refund. PLUGIN_TOOL_ABORTED is reported as TOOL_ABORTED with
unknown outcome/charging. Network errors, HTTP timeout and invocation interruption
remain distinct; none authorizes automatic resubmission. Runtime disposal drains
requests when possible. Existing unknown jobs are not rewritten or retried.

## Images and file delivery

Successful results up to 4 MiB are returned as typed image content, never as an
ordinary text dump of Base64. Result metadata includes the task, SHA-256, byte count
and dimensions. Larger original PNGs remain in private storage (maximum 16 MiB)
and return export-required. Images are not labeled artistically reviewed.
Model receipt and visible transcript rendering are separate acceptance checks;
the host's built-in GenerateImages card is not assumed available to plugin tools.

Export uses only host fs.stat/readText/writeText within bone-media/exports/**.
It writes random unique `.image.json` and fixed `.decode.cjs` handoff files and
returns a short command. The Agent uses its own authorized execution tool to run
the decoder from the reported workspace. The decoder checks canonical Base64,
length, hashes, expected paths and file identities; creates the PNG exclusively;
verifies it; and removes only its unchanged handoff files after success.
No file content is copied through model text. No arbitrary destination is accepted.

No workspace, missing permission, changed workspace, corrupt handoff, symlink,
existing output or failed write yields a claimed exported PNG. The original image
remains available. Old host text-write APIs lack atomic create and an expected-root
argument: random names plus checks cannot exclude a hostile concurrent writer or
an unobserved A→B→A workspace switch inside an individual host call. The decoder
provides exclusive PNG creation; the plugin does not claim stronger host guarantees.
These limits are recorded rather than bypassing filesystem permission enforcement.


## Verified installed-client boundaries

The unchanged installed PI-Desktop 0.21.0 receives typed plugin images in the
model context but does not show a dedicated generated-image card for plugin
tools. Exporting, decoding through Agent Bash, and returning a Markdown image of
the workspace PNG has been verified in the actual transcript. No workspace means
the original remains in plugin storage but this client has no automatic inline
plugin-image card; do not claim user-visible delivery merely from typed transport.

The installed plugin worker omits planSafeActions when forwarding registerTool.
Thus the plugin declares the appropriate read actions, and its own mode checks
are tested, but those tools are not offered in Plan mode on this client version.
Normal Agent mode works. No client patch or permission bypass is used.

The host may represent a structured plugin failure as a completed tool event;
Agent callers must inspect structuredContent.ok/error, not only the event status.
## Installation and verification

Register tools and the skill at onStartup; opening a panel is not required.
The manifest explicitly adds fs.read/fs.write with the narrow export scope; host
install/update approval remains necessary. Basic generation does not use those
filesystem APIs. Tool descriptors and plan-safe actions are synchronized mechanically.

Acceptance includes a real Agent session using a localhost model protocol server
and synthetic image provider on the unchanged installed client: fresh session,
next turn after install, descriptor update, restart, disable/enable and project
scope. It also checks trusted execution context, typed image transport and visible
output. Service tests cover selection, retries, conflicts, cancellation, old jobs
and cross-session access. Export tests decode actual temporary files and exercise
negative cases. Actual-provider evidence is reported separately from these tests.
