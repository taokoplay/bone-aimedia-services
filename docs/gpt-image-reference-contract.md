# GPT Image reference-image contract

This additive Agent interface extends the text-only image contract. It does not
change existing text generation, credentials, output formats, model selection or
paid-request idempotency. The panel provides configuration and records; creation
uses Agent tools.

## Capability matching

The official OpenAI SDK documents image edits through `POST /images/edits`, with
ordered PNG, JPEG or WebP files. GPT Image 2 must omit `input_fidelity`. The plugin
also omits that optional parameter for other configured GPT models, leaving their
provider defaults intact. It never substitutes a different configured model.

| Layer | Implemented behavior |
| --- | --- |
| Model | Configured OpenAI-compatible `gpt-image-*` IDs, including the configured GPT Image 2/2.5/2.6 aliases |
| Text generation | Existing JSON `POST <baseUrl>/images/generations` |
| Reference generation | Multipart `POST <baseUrl>/images/edits`, repeated `image[]` parts |
| Host transport | `net.getCapabilities()` must advertise `binaryRequestBody: true` and `maxBinaryBodyBytes >= 16777216`; requests use `bodyBase64` |
| Local files | Host `fs.readPreview(path, {workspacePath})`, restricted to `bone-media/references/**` |
| Result | Existing single PNG result, verification, records and original export |

Provider support is not inferred from a configured name or a successful model
catalog query. An OpenAI-compatible gateway must actually implement the edit
endpoint. Real supplier compatibility and billing remain separately unverified.

OpenAI's model-level limits can be larger than this plugin's limits. The plugin
accepts 1–16 reference files, at most 4 MiB each and 12 MiB combined, with the
complete multipart body bounded to 16 MiB. PNG references use the existing PNG
validator, including its 4096-pixel edge limit; JPEG/WebP input checks validate
signatures/container structure, not a complete codec decode or artistic quality.
Masks, streaming, multiple output images, input-fidelity controls, image URLs and
remote result downloads are outside this interface.

Official protocol source inspected for this implementation:
[OpenAI Python SDK image-edit parameter definition](https://github.com/openai/openai-python/blob/main/src/openai/types/image_edit_params.py).

## Agent input

`generate_image` and the legacy `prepare_image` accept an optional ordered
`referenceImages` array. Every item has exactly:

- `path`: a workspace-relative PNG/JPEG/WebP path below `bone-media/references/`.
- `sha256`: the lowercase 64-character SHA-256 of the original file bytes.

The Agent uses its own authorized file tools to stage the user-designated files
and calculate hashes. It preserves originals and does not overwrite an existing
staged file. Image bytes are never transcribed into tool arguments. Keep the
staged files until submission finishes. The plugin reads them through the Host;
it does not use Node filesystem access or a shell to bypass workspace permissions.
It does not delete staged user assets.

The file order is part of intent. Prompt, model, output parameters and every
reference path/hash enter the Agent input hash. Changing any of them under the
same `requestKey` produces `GENERATION_REQUEST_CONFLICT`. Intentional new images
require the user's authorization and a new request key.

## Validation and dispatch

New preparation checks syntax, host support, workspace identity, image type,
size, canonical Base64 and the supplied content hashes. The workspace fingerprint
is recorded with the prepared request. Repeated legacy preparation matches the
stored immutable request before reading staging files, so removed files do not
block access to an existing task. Before dispatch the files are read again and
verified against both the hashes and the captured workspace. Cancellation and
service/configuration checks run across these asynchronous reads.

The Host pins each preview read to the captured workspace. The plugin rechecks
after every read and once after image validation, so it does not repeat a
workspace query immediately before each already-pinned read. A switch after the
first image stops the sequence before any later image is read.

- Invalid arguments are rejected before file access or submission.
- `REFERENCE_UNSUPPORTED` reports an insufficient Host; it does not silently drop
  the references or generate from text alone.
- `REFERENCE_INVALID` reports an invalid/oversized image or multipart body.
- `REFERENCE_CHANGED` reports bytes that no longer match the supplied hash.
- `CONFLICT` reports a different workspace from the prepared reference source.
- Permission errors remain permission errors; no direct network/filesystem
  fallback is attempted.

Validation failures before HTTP are not submitted or charged by the plugin.
Failure after a durable claim is recorded as failed/not-submitted, and the claim
still prevents automatic resubmission. HTTP uncertainty retains the existing
unknown/charging-unknown semantics. An error is never evidence of a refund.

The provider receives original binary files with generic indexed filenames,
without local paths. `bodyBase64` is an internal Host transport encoding, not a
provider request field. The multipart form preserves UTF-8 prompt text and ordered
image bytes, with `n=1` and `output_format=png`.

Host workspace pinning and repeated checks do not promise atomic workspace
identity across the eventual external HTTP request. The bytes must still match
the user-specified hashes; the plugin makes no stronger filesystem guarantee than
the Host API supplies.

## Persistence and compatibility

Only reference-image tasks use private image-record version 3. They store ordered
path/hash descriptors and a workspace fingerprint, without reference Base64 or
copies of the source images. Agent source metadata remains session-scoped. Old
version-1/2 jobs stay readable and are not migrated or rewritten. Text-only jobs
retain their exact version-1/2 request/hash format; audio records are unchanged.
A successful existing request can be read/retried after restart even when its
staged reference files have been removed, without another provider call.

Older plugin builds do not understand version-3 records. Downgrading after creating
reference jobs is not supported; retain the compatible build and do not delete
records to work around a downgrade. An older Host can still run this plugin's
text/speech workflow and read already stored results, but cannot submit reference
jobs. The plugin requires an updated Host advertising binary transport for this
new feature; installing the plugin alone does not add that Host capability.

`media_catalog` includes `image.edit` only when Host reference input is available.
Both discovery tools and the panel expose the same `constraints.referenceImages`
status: `supported`, `blockedBy`, `requiredBinaryBodyBytes` and
`hostMaxBinaryBodyBytes` (null if unknown), alongside the plugin input bounds.
`get_capabilities` also includes these reasons in the `image.edit` operation's
`blockedBy`. The reasons describe Host support:

| Reason | Meaning |
| --- | --- |
| `host-capability-query-failed` | The optional local Host query failed; no raw error is exposed |
| `host-binary-image-input-required` | The Host did not advertise binary request bodies |
| `host-binary-body-limit-invalid` | The Host did not advertise a positive safe-integer body limit |
| `host-binary-body-limit-too-small` | The advertised limit is below the required 16 MiB |
| `host-http-api-required` | The Host HTTP API is absent |
| `host-workspace-api-required` | The workspace API is absent |
| `host-image-preview-api-required` | The scoped preview reader is absent |

Optional capability-query failures disable reference input without aborting
plugin initialization or disabling existing text/speech tools. The status is a
local snapshot refreshed on plugin reload, without background retries, provider
probes or automatic generation. Runtime workspace availability and permission
grants remain enforced at each actual read/request.
Credentials and configured models continue to determine local profile readiness.
No response claims supplier entitlement or a live-generation success.

## Acceptance scenario: IMAGE-REFERENCES

Preconditions: dedicated request worktrees, isolated temporary data/workspace,
updated Host binary transport, synthetic credentials and a localhost image
provider. No user's running instance or production provider is used.

1. Stage two reference PNGs and obtain their SHA-256 values.
2. Discover `image.edit` through the actual plugin entry's Agent tool registry.
3. Generate once with both references. Decode the real HTTP multipart form and
   verify exact ordered bytes, model, prompt and output fields; return a typed PNG.
4. Restart the plugin, remove one staged file and repeat the same request key.
   Read the original result with no additional provider request. Repeat through
   legacy `prepare_image` with its original request ID; changed intent must still
   conflict without reading missing staging files.
5. Change a reference hash under that key and require an intent conflict.
6. Modify a staged file after legacy preparation, or switch workspaces before or
   during the Host preview read. Require failed/not-submitted with the matching
   content/conflict error and zero HTTP requests.
7. Cancel a held reference read. Require TOOL_ABORTED with no prepared task or
   provider call.
8. Repeat on a Host lacking binary capability: reference requests fail before file
   reads/network while the original text generation still succeeds.
9. Check PNG/JPEG/WebP input, malformed Base64, MIME mismatch, byte-count/size
   limits, path traversal/URLs and the complete multipart size bound.
10. Fail the optional Host capability query or remove individual Host APIs.
    Require matching, sanitized reasons from catalog, Agent discovery and panel;
    reference requests must stop before image reads/HTTP while text generation
    still succeeds on hosts with HTTP support. Restore capability support and
    reload; the original reference request can then generate once.

Executable coverage: `tests/image-references.test.cjs` (real plugin entry,
filesystem fixtures and localhost HTTP), `tests/image-reference-schema.test.cjs`
(binary/format contracts), plus the existing image, Agent, storage, audio and
plugin-entry suites. Host permission, binary transport and worker-boundary
coverage belongs to the accompanying PI-Desktop request branch. These local
checks do not establish real-provider quality or installed-client acceptance.
