# GPT Image reference-image contract

This additive Agent interface extends the text-only image contract. Existing
text generation, credentials, model selection, output formats and paid-request
identity remain compatible. Creation uses Agent tools; the panel provides
configuration and generation records.

## Protocol and transport selection

Official OpenAI image edits support JSON and multipart requests at
`POST /images/edits`. JSON requests use ordered `images` entries containing
`image_url`, which accepts a Base64 data URL. This documented format can travel
through the existing Host text HTTP API without a binary Host extension.

Sources:

- [Image edit API reference](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [OpenAI API changelog](https://developers.openai.com/api/docs/changelog): the
  February 9, 2026 entry adds `application/json` image-edit requests.

| Layer | Implemented behavior |
| --- | --- |
| Models | Configured OpenAI-compatible `gpt-image-*` IDs; no silent model substitution |
| Text generation | Existing JSON `POST <baseUrl>/images/generations` |
| References on text-only Hosts | JSON `POST <baseUrl>/images/edits` with ordered internal data URLs |
| References on binary-capable Hosts | Existing repeated multipart `image[]` files when the Host advertises binary bodies and at least 16777216 decoded bytes |
| File access | Host `fs.readPreview(path, {workspacePath})`, scoped to `bone-media/references/**` |
| Results | Existing verified single PNG, records, preview and original export |

Both edit formats share model, prompt, `n=1`, size, quality and
`output_format=png`. `input_fidelity` and `response_format` are omitted. Generic
indexed filenames are used for multipart; neither format sends local file paths.
A JSON data URL is an internal provider payload, never an Agent tool argument.
Remote reference URLs, File API uploads, masks, streaming and multiple outputs
remain outside this interface.

Transport is selected locally before submission, from the optional Host snapshot.
Missing binary fields or an invalid/small binary limit selects JSON. A sufficient
advertised binary capability retains multipart. HTTP, workspace discovery and
scoped image reads remain mandatory. Both paths require a successful capability
query advertising the `error` redirect policy before any reference is uploaded.
There is no direct Node network/filesystem fallback or permission bypass.

The selected gateway must actually implement the chosen edit format. Readiness
or a configured model name does not prove provider access or entitlement.
A provider rejection, timeout or uncertain response never triggers an automatic
retry with another transport, another model or another request key.

## Bounds

The plugin accepts 1–16 PNG/JPEG/WebP files, at most 4 MiB each and 12 MiB combined.
PNG checks include CRC/decompression validation and the existing 4096-pixel edge
limit. JPEG/WebP checks validate signatures and container structure, not full
codec decoding or artistic quality.

Multipart is bounded to 16 MiB including fields and boundaries. JSON is bounded
to 16 MiB plus 256 KiB, allowing Base64 expansion of 12 MiB of image data and
bounded prompt/field overhead. `maxRequestBodyBytes` reports the selected bound.
Neither bound claims a supplier's account-specific limit.

## Agent input and file validation

`generate_image` and legacy `prepare_image` accept optional ordered
`referenceImages`. Each item contains exactly:

- `path`: a workspace-relative PNG/JPEG/WebP under `bone-media/references/`.
- `sha256`: a lowercase 64-character SHA-256 of the original file bytes.

The Agent stages only user-designated originals with its authorized tools,
preserving originals and existing files. It computes hashes without transcribing
image Base64. Staged files remain until submission settles; the plugin does not
delete them.

New preparation checks input syntax, required Host APIs, workspace identity,
image type/size/canonical encoding and hashes. The workspace fingerprint enters
the prepared request. Repeated preparation looks up immutable task intent before
rereading files, so removed staging files do not block an existing task.

Immediately before dispatch, original bytes and workspace identity are validated
again. Host reads use the captured workspace pin; post-read and final checks,
configuration lifetime and cancellation checks remain enforced. A workspace
switch after the first image stops before later images are read. These checks
do not promise atomic identity through the eventual external HTTP operation.

- `REFERENCE_UNSUPPORTED`: a required Host API is unavailable; no references are
  silently dropped and no text-only generation is substituted.
- `REFERENCE_INVALID`: invalid or excessive image/request-body content.
- `REFERENCE_CHANGED`: original bytes no longer match the supplied hash.
- `CONFLICT`: workspace identity differs from the prepared reference source.
- Host permission failures remain permission failures.

Validation before HTTP does not submit a provider request. A failure after a
durable claim remains failed/not-submitted, preserving the claim. HTTP
uncertainty retains unknown/charging-unknown behavior; no refund is inferred.

## Identity and compatibility

Prompt, model, output parameters and ordered reference paths/hashes enter request
identity. A changed intent under the same `requestKey` returns
`GENERATION_REQUEST_CONFLICT`. Transport selection is not semantic image intent;
plugin reload or a new Host cannot turn the same completed/unknown task into a
fresh submission.

Only reference tasks use private image-record version 3. Records keep path/hash
descriptors and the workspace fingerprint, without image copies, Base64 or data
URLs. Existing version-1/2 image jobs and audio formats stay unchanged. Existing
reference jobs remain readable and resumable across this patch without migration.
A successful task remains available after staging files are removed.

Downgrading to a plugin predating reference-record support remains unsupported.
This patch removes the binary-only requirement introduced in 0.6.0: text-only
Hosts can now submit JSON references using their existing scoped APIs.

Discovery, Agent capabilities and panel share `constraints.referenceImages`:

- `supported` and `blockedBy`: availability of required Host APIs.
- `transport`: `json-data-url` or `multipart` for the selected path.
- `multipartBlockedBy`: sanitized optional binary-query/limit diagnostics.
- `requiredBinaryBodyBytes`: zero for JSON, 16777216 for multipart.
- `hostMaxBinaryBodyBytes`: the advertised positive safe integer, or null.
- `maxRequestBodyBytes`: the selected serialization bound.

Missing HTTP/workspace/preview methods remain blocking. Missing or failed
capability discovery, or absent `error` redirect support, returns
`host-redirect-error-required` before image reads/HTTP. Missing binary fields and
binary-limit reasons are multipart diagnostics rather than JSON blockers. No raw
Host error is exposed. Reload refreshes the snapshot without provider probes.

## Acceptance scenario: IMAGE-REFERENCES

Use isolated plugin data/workspaces, synthetic credentials and loopback HTTP.

1. Stage ordered PNGs and discover `image.edit` in the real plugin tool registry.
2. On a text-only Host, send JSON with two exact data URLs and verify decoded
   bytes, order, model/prompt/output fields and the typed PNG result.
3. On a binary-capable Host, verify the existing multipart body and byte order.
4. Reload, remove a staging file and repeat the same request. Recover the same
   task with no new HTTP submission, including across a JSON-to-multipart change.
5. Reverse references or change a hash under the same key and require a conflict.
6. Modify bytes after preparation, change workspace during a read, or cancel a
   held read. Require the existing refusal and zero provider requests.
7. Advertise error redirects with missing/invalid/insufficient binary fields.
   JSON remains available; discovery surfaces agree on the selected transport.
8. Remove required APIs, fail capability discovery or omit error redirects.
   References stop before reads/HTTP; existing text behavior remains compatible.
9. Return HTTP 400 or 503 for JSON edits. Keep the original failed/unknown task,
   with exactly one request and no automatic multipart retry.
10. Cover PNG/JPEG/WebP, request-body limits, malformed hashes, path traversal and
    canonical encoding. A capable Host still uses its original multipart path.

Executable coverage: `tests/image-references.test.cjs`,
`tests/image-reference-schema.test.cjs`, and existing Agent/image/storage/audio
and plugin-entry suites. An isolated actual-Host integration separately verifies
text-body compatibility. Local tests do not establish real-provider entitlement,
editing quality or installed-client upgrade completion.
