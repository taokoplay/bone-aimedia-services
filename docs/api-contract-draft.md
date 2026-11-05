# API contract draft — Bone AI Media Services

Status: future general-media proposal. Version 0.3.0 implements the bounded GPT
image subset through prepare_image/submit_image/get_image_job/list_image_jobs/
read_image_result; see gpt-image-usage-plan.md and configuration-contract.md.
Generic submit/query/cancel/export names below are proposals, not callable tools.

## Capability discovery

`get_capabilities({})` is read-only, network-free and credential-free. It returns
this plugin's identity and executable contract, not an inventory of every plugin:

```json
{
  "pluginId": "bone.aimedia.services",
  "contractVersion": 1,
  "pluginVersion": "<implemented-version>",
  "operations": [
    {
      "id": "image.generate",
      "execution": "configuration-only",
      "ready": false,
      "blockedBy": ["adapter-not-implemented"],
      "constraints": {"maxOutputs": 1}
    }
  ]
}
```

The example illustrates an unavailable operation, not a claim of current support.
Candidate operation IDs: `image.generate`, `image.edit`, `video.text`,
`video.image`, `video.first-last`, `audio.speech`, `audio.effects`, `audio.music`,
`workflow.run`. Declare only the operations actually implemented by an adapter.
Execution is `native`, `agent-mediated` or `configuration-only`. Readiness has
explicit reasons, such as missing credentials, unavailable transport or unknown
runtime capability. Cached probes include observation time and scope; they do not
turn a stored profile into a promise that the next generation will succeed.

If this tool cannot be discovered, Agent reports tools not exposed/available.
It must not infer that the plugin is uninstalled. Exact installed/enabled/granted
states require a separate authorized host inventory, absent from the current SDK.

`list_profiles({kind?, operation?})` returns stable profile IDs, public model and
voice choices, config revisions, default selection and opaque credential status.
No raw secrets, private local paths or signed download URLs appear in responses.

## Prepare an immutable request

`prepare_generation` creates no provider request and incurs no generation charge.
It validates the operation against actual capabilities and saves a normalized
immutable request with a content hash. Proposed input groups:

| Field | Rule |
|---|---|
| `requestKey` | Caller-stable idempotency key within the host-attested caller/project scope |
| `profileId`, `expectedProfileRevision` | Existing profile and exact revision; no silent fallback |
| `operation`, `modelId` | Declared adapter operation and allowed configured model |
| `prompt` | Bounded text, not interpreted as code or shell arguments |
| `spokenText`, `performanceDirection` | Separate for speech; no silently spoken stage directions |
| `inputs[]` | Role, authorized workspace-relative reference, expected hash; no private foreign-plugin path |
| `parameters` | Operation-specific validated fields, not arbitrary HTTP body/header overrides |
| `consumer` | Optional caller-supplied provenance: plugin ID, production/asset/shot ID, shot revision, content hash |
| `outputCount` | Explicit bounded integer; no unsolicited variants |

Operation-specific parameters include supported ratio/resolution/source duration,
seed where available, and voice/format for speech. The adapter rejects unsupported
combinations instead of silently downgrading first/last-frame input or dimensions.

Inputs are checked through host permissions, bounded, hashed and captured into
an immutable authorized input snapshot before submission. Validate active project
identity across awaits; record the actual hash and format. No URL in untrusted
prompt text becomes a fetch target. `consumer` is data, not authenticated caller
identity or permission. Host-attested context, when available, is separate.

Return `{jobId, revision, state:'prepared', requestHash, normalizedRequest,
capabilitySnapshot, estimatedCost}`. Estimated cost has source, currency/unit,
observation time and confidence, or is explicitly unknown. Limits and exact
numeric bounds are to be frozen with the first supported provider contracts.

## Submit once and recover uncertainty

`submit_generation({jobId,expectedRevision,requestHash,authorization})` rechecks
profile/input/operation validity and applicable host approval. Authorization
records requested output count, permitted scope and budget conditions; an Agent
assertion does not prove user consent or bypass host permission.

Persist `submitting` before dispatch. Concurrent submits for the same request
return the existing task or conflict; they do not issue a second provider call.
The provider's own idempotency token is used only where documented. A timeout
before receipt of a task ID becomes `unknown`, not automatically `failed` with
an invitation to submit again. Cross-process locks and durable request ownership
must be tested, not inferred from an in-memory promise queue.

`get_generation({jobId,refresh:false})` is a local read. `refresh:true` performs
only supported status/result recovery for this existing task. It never creates
a new task. Local prepared/submitting state, provider queued/running state,
download/verification state and terminal status are distinct.

Suggested state semantics:

- `prepared`: validated local request, not submitted.
- `submitting`: network/CLI dispatch began; provider acceptance may be unknown.
- `queued` / `running`: supported provider observation for a known task.
- `result-pending`: provider reports success; real bytes still unavailable or unchecked.
- `succeeded`: result bytes stored, format/size/hash verified; not quality approval.
- `failed`: confirmed failure with a safe code and known/unknown charging status.
- `unknown`: outcome unresolved, requires reconciliation; no blind resubmit.
- `cancelled`: confirmed terminal cancellation. Local polling stop alone is not this state.

Remote IDs, observations, last query time, recoverability and actual known costs
persist with monotonic revisions. A provider error is sanitized and classified,
not reflected verbatim with credentials, cookie headers or signed URLs.

`cancel_generation({jobId,expectedRevision})` returns cancellation scope and state:
`local-wait-stopped`, `queue-cancelled`, `remote-confirmed` or `unsupported`.
Never interrupt unrelated ComfyUI jobs. A cancellation request is not a refund
or proof the provider stopped. A local-wait stop leaves the remote task queryable.

## Result and export

A successful job returns result descriptors, not foreign private paths:

```json
{
  "resultId": "<real-id>",
  "kind": "video",
  "mimeType": "video/webm",
  "byteLength": 123456,
  "sha256": "<actual-64-hex-hash>",
  "metadata": {"durationSeconds": null, "measurementStatus": "not-measured"},
  "quality": "not-reviewed"
}
```

This is an illustrative descriptor only. Metadata is filled from actual probing,
never copied from the requested source duration as if measured. A valid file
signature does not prove complete decode or perceptual quality. Do not download
provider result URLs with API credentials intended for a different origin;
redirects and allowed download domains must be explicitly enforced.

`export_result({jobId,resultId,expectedSha256,workspacePath,relativePath,overwrite:false})`
requires the host's approved file-write/download capability and expected active
workspace. No escape, symlink overwrite, implicit replacement or cross-session
workspace drift. If the capability is absent, return a specific unsupported
result; do not reach into another plugin's files through Node fs.

Export returns the authorized workspace-relative path, kind, size and verified
SHA. Film Factory can then use its existing register_media and adopt_media tools.
The service does not mutate a consumer's work, adopt results or write approvals.

## Acceptance contract

- Reads/preparation never call provider generation or expose secrets.
- Missing tool/profile/model/capability cases cannot become false success.
- Repeated submit, timeout after acceptance, crash before remote-ID persistence,
  failed download and restart recovery have deterministic regression tests.
- Input hash mismatch, target-version drift, workspace switch and unapproved
  destination reject without replacing files or adopted media.
- Images, video and audio each have real byte/decode checks appropriate to format.
- Agent review remains outside execution: actual observations, scope and limits
  are retained; unavailable image/video/audio inspection remains not-verified.
- A standalone Agent request works with no Film Factory production. A Film
  Factory request retains source revision and explicit candidate/adoption stages.

No task in this document authorizes implementation-time paid calls. The first
real-provider acceptance must name the service, output quantity and budget scope.
