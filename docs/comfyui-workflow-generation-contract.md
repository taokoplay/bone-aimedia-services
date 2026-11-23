# ComfyUI workflow media generation contract

## Scope

The media service can execute saved ComfyUI API-format workflows for one image,
video or audio output. Canvas workflows remain preview-only. A workflow must be
saved, enabled, bound to an enabled ComfyUI connection, and carry an explicit
output rule before it is executable.

Remote workflow details are read through the existing host-mediated ComfyUI
resource APIs. Importing a remote API workflow stores its definition locally with
`origin: "comfyui-remote"`, the source profile, relative path, content SHA-256 and
sync time. A task records the workflow hash and continues to refer to that exact
local definition after a later remote refresh.

## Submission lifecycle

`generate_workflow_media` derives a stable `wf-` job ID from the workflow ID and
request key. It submits one `POST /prompt` request with a cloned prompt JSON and
records ComfyUI's `prompt_id`. Bindings replace only declared node inputs. The
original saved definition is never mutated.

Before saving a workflow, the panel and `list_workflows` inspect the API JSON's
actual node IDs, `class_type`, `_meta.title` and scalar `inputs`. They suggest
bindings for prompt, negative prompt, seed, width, height, steps, duration, FPS,
input image, first frame, last frame and up to eight reference images. Output
candidates are matched to the selected media kind (`images`, `videos` or
`audio`). Suggestions are advisory; only the explicitly saved `{ purpose,
nodeId, input }` bindings and output rules are executable.

For image-to-video workflows, a declared image binding and a supplied
`referenceImages` entry start a separate upload phase before `/prompt`. The
plugin reads only the staged workspace reference through the Host image reader,
rechecks its SHA-256, checks the Host `binaryRequestBody` capability and sends a
bounded multipart request to the fixed `/upload/image` endpoint through
`pi.net.fetch`. The ComfyUI response must contain a safe `name`, `subfolder` and
`type: "input"`; the resulting `subfolder/name` is an internal ComfyUI file
reference, not a public URL. The plugin writes that reference into a cloned API
prompt at the matched image input, then submits exactly one `/prompt` request.

Missing binary request support, a changed reference, an unsafe upload response
or an input mismatch stops before workflow submission. Stable hash-derived
filenames avoid duplicate uploads within a request, and a repeated workflow ID
and request key reads the existing job without uploading or submitting again.

The job polls `GET /history/{prompt_id}`. A successful history record is projected
through the saved output rule. The plugin constructs the `/view` URL from the
validated filename, subfolder and type fields returned by ComfyUI. Agent input
cannot provide an arbitrary URL, local path, request header or output filename.

The result download uses the host's bounded `pi.net.fetch` base64 response mode.
The plugin validates the declared extension, response MIME, byte limit, content
signature and SHA-256 before writing a private result file. Supported result
families are PNG/JPEG/WebP, MP4/WebM and MP3/WAV/OGG.

A timeout, host interruption, network error, oversized response or result write
failure remains `unknown` or `result-pending`. Repeating the same workflow ID and
request key reads the existing job and never posts a second prompt. Queue cancel
uses `POST /queue` with the exact recorded prompt ID and is limited to an explicit
queued-job action.

## Agent tools

- `list_workflows` returns local and remote source metadata, output kinds and an
  executable summary without returning workflow bodies.
- `generate_workflow_media` submits a selected workflow with a stable request key.
- `workflow_job` reads, lists and reads verified local results.
- `cancel_workflow_job` removes a queued prompt after explicit confirmation.
- `export_workflow_result` reports the result handoff boundary for the workspace
  export implementation.

## Records

ComfyUI jobs use the independent `wf-` namespace and appear in the unified local
records list with workflow name, media kind, profile, prompt ID, state, result
MIME, extension, byte count, SHA-256 and project snapshot when available. Server
queue/history browsing remains separate and is never mixed into plugin-owned
records.

## Compatibility

Existing image version 1/2/3 records, audio version 1/2 records, settings without
workflow origin fields, ComfyUI resource snapshots and the sixteen existing tools
remain readable. Old hosts without the binary response capability can still use
text and JSON operations, but ComfyUI result downloads stop before submission is
claimed as successful.
