# GPT image generation: implementation and usage plan

Target: plugin 0.3.0 on the existing PI-Desktop 0.21.0 client. No client changes.
Version 0.4.0 makes Agent conversation the primary entry. See
[the Agent contract](agent-image-contract.md) for model resolution, simplified
tools, typed image delivery and scoped export. The manual flow below remains
available for diagnostics and backward compatibility.

## First supported path

OpenAI-compatible `POST <saved baseUrl>/images/generations`, configured
`gpt-image-*` models only, one PNG image per request. Model IDs are forwarded
exactly as configured; compatibility is not inferred from a catalog entry.
Parameters: prompt (1–8000 characters), size (1024x1024, 1536x1024, 1024x1536),
quality (low, medium, high; default medium), n=1, output_format=png.
GPT models return b64_json by default; do not send DALL-E response_format.
No model, endpoint or credential fallback after preparing a request.

## User workflow

1. Save an enabled OpenAI service and Keychain credential, then choose a configured
   GPT image model on the Generate page. Existing global defaults are unchanged.
2. Enter a prompt, size and quality. Prepare creates an immutable local request;
   it does not call the provider or incur a generation charge.
3. Review the exact service/model/parameters and confirm generation of one image.
   Pricing is unknown unless the provider supplies an authoritative contract.
4. The panel records submission before dispatch and returns a local job ID immediately,
   and sends at most one provider request for that job. Closing the panel does not
   issue another request. Local status refresh never invokes generation.
5. After success, preview the decoded PNG and explicitly download it. Records
   survive reload. Existing ComfyUI server history/queue stays separate.
6. Timeouts, disconnects and interrupted processes show an uncertain outcome.
   Check provider billing/history before intentionally preparing a new paid job;
   the plugin never automatically resubmits or claims that local stop is cancellation.

## Agent workflow

Discover actual tools and capabilities, then list image profiles. Prepare the
exact selected profile/revision/model/prompt. Submit only within user authorization
and with the prepared request hash. Repeated submit reads the original job.
Since 0.4.1 both Agent submit entry points retain the invocation until their HTTP
request and result persistence settle; the request deadline is 90 seconds. The
short local wait setting does not terminate a newly submitted request. See
[request-lifetime acceptance](acceptance-image-request-lifetime.md) for the fixed
slow-response failure and current compatibility limits.
Get/list are local reads. Read successful result chunks (at most 64 KiB per call),
verify byte count and SHA-256, then use the Agent's existing authorized file tools
for workspace output. No private plugin path, API key or signed URL is returned.
Film Factory may register/adopt exported output through its own explicit tools;
this plugin does not modify works or certify visual quality.

## Durable execution and safety

Jobs live in a dedicated private directory, bounded to 200 permanent capacity
reservations. Immutable request IDs deduplicate preparation. Exclusive atomic
publication replaces global locks, so an interrupted publication affects only
its job or reserved slot. No reserved slot or submission claim is auto-reclaimed.
The durable per-job claim prevents two processes or a restarted process from
submitting the same job. State and output are synced before success.
Missing/corrupt data fails closed. A submitting job without a live worker or
recoverable image is reported unknown and never retried. Result validation covers
canonical Base64, PNG CRC/structure, dimensions, bounded decompression and filter
values. UI decode is a separate check; format validation is not artistic review.

Graceful disposal stops new work and drains already dispatched requests before
disposing settings. Host-enforced termination can interrupt that drain. If a PNG
was committed before its final job record, local get/list/read validates it and
recovers the result without dispatch or mutation. Definite pre-dispatch conflicts
remain prepared/editable in the UI, not potentially charged unknown outcomes.

Credentials stay inside the settings service/adapter. HTTP uses pi.net.fetch with
redirect=error, a bounded timeout, fixed endpoint and no caller-supplied headers.
Responses/errors are sanitized; no raw provider body is exposed. URL-only results
are result-pending because the current host offers text HTTP only; no direct Node
network fallback or credential forwarding to a different origin is used.

## Acceptance

Synthetic service-path tests cover prepare→submit→result→restart→read, duplicate
submission across instances, request identity conflict, unavailable profile/key,
configuration drift, HTTP failure, timeout/unknown, URL-only replies, invalid or
oversized PNG, storage errors and disposal. Browser tests cover form selection,
confirmation, progress, preview/download and retained local records. Existing
credential, model, ComfyUI and workflow suites remain green. Existing-client
acceptance uses an isolated profile and localhost synthetic provider.

The user's prior request authorizes one GPT test image after implementation.
Use the configured GPT service, an explicitly reported model, one low-quality
1024x1024 PNG and no automatic retries. Record actual outcome and provider limits;
do not claim a real-provider test passed from mocks alone.

## Later phases

Image editing/reference images, multiple outputs, provider URL downloads, remote
job reconciliation, video/audio execution and budget estimation require their own
contracts and acceptance. They are not marked ready in this release.
