# GPT image generation: implementation and usage

Current UI: plugin 0.5.4 on the existing PI-Desktop 0.21.0 client.
Agent conversation is the generation entry. The panel contains Configuration and
Generation Records; manual generation forms are removed. See
[the Agent contract](agent-image-contract.md) for model resolution, simplified
tools, typed image delivery and scoped export.

## First supported path

OpenAI-compatible `POST <saved baseUrl>/images/generations`, configured
`gpt-image-*` models only, one PNG image per request. Model IDs are forwarded
exactly as configured; compatibility is not inferred from a catalog entry.
Parameters: prompt (1–8000 characters), size (1024x1024, 1536x1024, 1024x1536),
quality (low, medium, high; default medium), n=1, output_format=png.
GPT models return b64_json by default; do not send DALL-E response_format.
No model, endpoint or credential fallback after preparing a request.

## User workflow

1. Save an enabled OpenAI service and Keychain credential in Configuration.
   Existing global defaults are unchanged.
2. Ask the Agent for one image with the desired service/model, prompt, size and
   quality. media_catalog lists the actual configured modelRef values.
3. Within the user's authorized request, generate_image prepares and submits once
   using a stable requestKey. Pricing remains provider-defined.
4. The Agent tool stays active through the request and local persistence. The
   records page can observe progress without starting another generation.
5. After success, preview/download the decoded PNG from records or use the Agent's
   export_image_result and fixed decoder for a workspace file. Records survive
   reload; ComfyUI server history/queue stays separate.
6. Timeouts, disconnects and interrupted processes show an uncertain outcome.
   Check provider billing/history before intentionally preparing a new paid job;
   the plugin never automatically resubmits or claims that local stop is cancellation.

## Agent workflow

Prefer media_catalog -> generate_image -> image_job -> export_image_result.
The legacy prepare_image/submit_image/get_image_job/read_image_result tools remain
compatible. Repeated submission reads the original job. Since 0.4.1 both Agent
submit entry points retain their invocation until HTTP and persistence settle;
the request deadline is 90 seconds. A short local wait does not terminate a new
submission. See [request-lifetime acceptance](acceptance-image-request-lifetime.md)
for the fixed slow-response failure and compatibility limits.
Get/list are local reads. The export tool returns a fixed decoder that the Agent
executes with its authorized tool, checking byte count and SHA-256 before linking
the original PNG. Do not transcribe Base64 into a file. No private plugin path,
API key or signed URL is returned.
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
remain prepared/not-submitted, not potentially charged unknown outcomes.

Credentials stay inside the settings service/adapter. HTTP uses pi.net.fetch with
redirect=error, a bounded timeout, fixed endpoint and no caller-supplied headers.
Responses/errors are sanitized; no raw provider body is exposed. URL-only results
are result-pending because the current host offers text HTTP only; no direct Node
network fallback or credential forwarding to a different origin is used.

## Acceptance

Synthetic service-path tests cover prepare→submit→result→restart→read, duplicate
submission across instances, request identity conflict, unavailable profile/key,
configuration drift, HTTP failure, timeout/unknown, URL-only replies, invalid or
oversized PNG, storage errors and disposal. Browser tests cover configuration,
registered Agent generation, progress, preview/download and retained local records.
Credential, model, ComfyUI and workflow suites cover retained settings behavior.
Historical installed-client acceptance used an isolated profile and synthetic
provider; current isolated tests do not prove live provider access or quality.

## Later phases

Image editing/reference images, multiple outputs, provider URL downloads, remote
job reconciliation, video and budget estimation require separate contracts and
acceptance. MiniMax speech is covered by audio-generation-contract.md.
