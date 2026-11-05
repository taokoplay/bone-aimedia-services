# ComfyUI workflow detail acceptance

## Confirmed defect

The workflow directory and each inspected detail endpoint returned HTTP 200.
The resource parser reused filename/metadata text validation for every string
inside a workflow. This rejected ordinary multiline notes, documentation links
and valid emoji even when the workflow structure was valid. The page then
reported a generic permission/address/service error.

The exact UserData path construction matches DutyDeck and remains unchanged:
`GET /userdata/{encodeURIComponent("workflows/" + listedPath)}`. Requests still
require membership in a previously validated directory and never follow redirects.

## Result

Workflow content has its own text validation. Newlines, tabs, valid Unicode and
ordinary HTTP/HTTPS links are preserved as plain text. The UI never interprets
markup or fetches those links. Known secrets, authentication fields/assignments,
credential-bearing and signed URLs (including encoded names), malformed Unicode,
non-text controls and prototype keys remain refused. Existing 200 KiB, depth and
node limits remain unchanged. Path/metadata validation is unchanged.

Safe diagnostic codes distinguish missing workflow files, invalid content,
size limits, stale directory membership, authentication, HTTP, JSON and network
failures. These codes reach both direct resource browsing and cached detail
reads. Failed detail requests retain the directory and existing snapshot; a retry
can succeed without resaving the connection. Canvas format is preview-only;
validated API format can be explicitly imported into a local draft.

## Verification performed

- New regression suite initially failed ordinary-text preview, cache recovery,
  and missing-file diagnosis; these now pass.
- Full Node suite: **139/139 passed**.
- Full isolated Chrome suite: **43/43 passed**. Cases 42 and 43 cover notes,
  links and emoji, plain-text HTML rendering, failure-specific messages, retained
  listings, retries and both remote/cached detail UI paths.
- Existing credential, traversal, schema, limit, stale-response and disposal
  coverage remains green. Accepted canvas details also survive an offline restart.
- Manifest synchronization and updated DevKit plugin validation passed. Existing
  static unused-secret-permission hints are unchanged (the entry injects the
  adapter rather than calling its methods directly).

Real-response diagnostics inspected three listed files without retaining their
bodies or printing prompt text. The final acceptance used an isolated temporary
configuration and the real settings-service browse path; four GET requests read
one directory and three details. No provider configuration or remote data changed,
no generation was submitted, and the temporary test directory was removed.

| Listed file | Response bytes | Before | After |
|---|---:|---|---|
| image_upscale_ultrasharp_4x_autovideo.json | 344 | API accepted | API accepted |
| video_minimax_h3_t2v_autovideo.json | 21,937 | Body rejected | Canvas accepted |
| LTX-2.3_T2V_I2V_Two_Stage_Distilled.json | 52,276 | Body rejected | Canvas accepted |

The live directory contained 28 entries. This verifies only the three inspected
files, not every workflow or generation compatibility. User credentials were not
read. Installed-app interaction and generation tests were not performed.

## Activation

Reload Bone AI Media Services from the plugin manager, then reopen its resource
view and refresh the workflow directory. This change includes entry-process
parsing code, so refreshing only the page does not update an older resident
plugin process. No configuration reset or Host API change is required by this fix.
