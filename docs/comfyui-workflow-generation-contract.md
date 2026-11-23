# ComfyUI workflow media generation contract

## Scope

The media service executes one image, video or audio output from either a saved
local ComfyUI API-format workflow or a synchronized remote API-format workflow.
Canvas workflows remain preview-only. Local execution requires an enabled saved
workflow, a bound ComfyUI connection and an explicit output rule.

Remote execution requires a previously synchronized workflow directory. The
`list_remote_workflows` action reads only the private snapshot; it never fetches
workflow bodies implicitly. A remote workflow can be selected by its relative
path, a unique filename without `.json`, or the stable ID returned by the list.
Duplicate filenames require the path or stable ID. Reading a remote detail caches
its validated API/Canvas format, field matches and content SHA-256 without adding
the workflow to the local workflow list.

Importing a remote API workflow remains an explicit panel action. It stores the
definition locally with `origin: "comfyui-remote"`, the source profile, relative
path, content SHA-256 and sync time. A direct remote task creates a temporary
definition in memory and never changes the saved workflow list.

## Submission lifecycle

`generate_workflow_media` derives a stable `wf-` job ID from the selected
workflow identity and request key. It submits one `POST /prompt` request with a
cloned prompt JSON and records ComfyUI's `prompt_id`. Bindings replace only
declared node inputs. The original saved or remote snapshot definition is never
mutated. Remote requests record the source path and synchronized content hash;
if a later synchronization changes that hash, the same request key conflicts
before a second prompt is submitted.

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

- `list_workflows` returns saved local workflow metadata without workflow bodies.
- `list_remote_workflows` returns synchronized remote names, stable IDs, paths,
  formats, hashes, executable media kinds and field-match candidates. It does not
  fetch unsynchronized bodies or return default input values.
- `generate_workflow_media` submits a selected local or remote workflow with a
  stable request key. Duplicate remote names must be selected by path or ID.
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
workflow origin fields, ComfyUI resource snapshots and existing media tools remain
readable. Old hosts without the binary response capability can still use text and
JSON operations, but ComfyUI result downloads stop before submission is
claimed as successful.
