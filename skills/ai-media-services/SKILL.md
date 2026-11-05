---
name: ai-media-services
description: "Use configured Bone AI media models from Agent conversations: GPT 生图, 文生图, MiniMax 语音合成, 文本朗读, generate images or speech. Discover models and voices, submit one authorized task, query unified local records and export PNG/MP3 originals. Environmental sound effects and music are not implemented."
---

# Agent-driven Bone AI media services

Use this plugin when the user requests it or names one of its configured services.
Do not silently substitute the host GenerateImages tool or another generator.
The Configuration page is for setup; daily generation is driven from conversation.
Version 0.5 adds MiniMax speech tools while retaining the twelve image/discovery tools.

## Discover and select

1. Discover actual names with ToolSearch (media_catalog; generate_image/image_job/
   export_image_result; generate_audio/audio_job/audio_voices/export_audio_result).
   Host prefixes are not part of the local names.
2. Call media_catalog with action=list and kind=image or audio. It returns modelRef,
   operation-specific constraints, defaults and ready/blockedBy evidence.
3. If the user named a service/model, match both and pass its exact modelRef.
   An unavailable explicit target is a reason to report/clarify, never to switch.
4. Otherwise omit modelRef: the plugin uses this session's most recent explicit
   selection, a valid saved default, or the unique ready candidate, in that order.
   selection-required returns choices; ask one concise model-selection question.
   Do not choose the first item merely because it was listed first.

Configured OpenAI gpt-image-* text-to-image and supported MiniMax speech-* models
are implemented. Other image/video/audio models and ComfyUI workflows may appear
with unavailable operations. Readiness does not prove supplier access or entitlement.
No tool installation or model registration into the client's global settings is
required beyond installing/enabling this plugin with the applicable host grants.

## Speech generation

For speech, use audio_voices with the selected MiniMax modelRef when an explicit
voice ID is needed. This is a read-only supplier query and does not generate or
set a default voice. Choose a voice matching the user's request; ask a concise
question if the requested voice cannot be determined. Do not invent voice IDs.

Call generate_audio with operation=speech, the exact text to speak, an explicit
voiceId and stable requestKey; optional modelRef, speed (0.5–2, default 1) and waitMs.
Text is bounded to 1000 characters and the result is one MP3. Model resolution,
host invocation lifetime, uncertainty and no-retry rules are the same as images.
Use audio_job get/wait/list/result for the same job, never generate again to read it.
The shared process budget permits at most two active image/audio requests.

Footsteps, ambience, environmental sound effects and music are NOT speech. When
asked for these, explain that this plugin does not implement the requested
operation. Never send the sound-effect description as speech, silently synthesize
locally, invent a provider API, or mark an external file as a plugin-generated job.

Completed speech is automatically visible in Generation Records with channel,
model and state. The detail dialog provides browser-decoded playback and download.
audio_job.result returns verified metadata and an export next action, not an
unsupported audio content block or a Base64 text dump. For conversation delivery,
call export_audio_result and execute the returned fixed decoder as below; verify
the MP3 exists, then return a clickable file link or a local audio-player preview.
Structural MP3 validation is not a listening-quality review. No workspace prevents
Agent export, but the original audio remains available in the plugin's records.

## Generate and resume

Call generate_image with prompt and a stable short requestKey, e.g. blue-cup-1.
Optionally supply modelRef, size (1024x1024, 1536x1024, 1024x1536), quality
(low/medium/high) and waitMs (0–10000). Defaults are square, medium, one PNG.
The plugin owns configuration revisions, request hashes and prepare/submit steps.
Do not ask the user to copy IDs, open the panel or confirm there.

Version 0.4.1 keeps a newly dispatched request inside its originating Agent tool
invocation until the HTTP exchange and result persistence finish. HTTP timeout is
90 seconds; do not interrupt after ten seconds or create another request key.
waitMs remains accepted for local waiting on existing tasks, not for truncating
new submissions. Legacy submit_image follows the same ownership rule.

A clear user request for one image or spoken audio authorizes that specified operation;
do not ask again for the same scope. The host can still enforce its own approval.
Installation grants are not blanket permission for unlimited charges. Never invent
pricing, refunds or a budget guarantee. Do not add unrequested variants.

Record jobId when returned. If submitting, use image_job action=wait (at most
15000ms per call), then action=result to retrieve the completed image. All image_job
actions are local reads and never submit. Keep the same requestKey on a tool retry;
parameter changes under that key conflict. To deliberately generate another image,
use a new key only when the user requests it. Across turns/restarts, resume by
jobId or image_job action=list for this calling session. Do not bypass unknown state
by creating a new key or changing providers.

Unknown means provider acceptance or billing may be unresolved. failed is not a
refund guarantee. result-pending means no verified local media is available.
Host interruption can stop local result delivery without proving remote work was
cancelled. TOOL_ABORTED, TIMEOUT and NETWORK_ERROR all require checking the same
job and provider records before another billable request; none implies a refund.

## Return the picture and original file

Small successful PNGs are returned as typed image content, with a short task/result
record. Do not transcribe binary into text or paste a Base64 string in chat.
The tested 0.21.0 client passes typed images to the model but does not create a
plugin image card. To show the picture to the user, use the export/decoder workflow
and a Markdown image link to the verified workspace PNG. No workspace means this
visible delivery route is unavailable; keep the original job and explain the limit.
Images larger than the inline limit return export-required; the original remains
stored. A format/hash check is not a visual-quality verdict.

When the user needs a file, an inline result cannot be displayed by this client,
or the task requires a generated asset in the workspace:

1. Call export_image_result or export_audio_result with the corresponding jobId.
   This only writes within bone-media/exports/** and never generates or charges again.
2. A handoff-ready response includes workspacePath, command, outputPath, byteLength
   and sha256. The PNG/MP3 has NOT yet been created at this stage.
3. Run the fixed returned decoder using the Agent's own approved execution tool,
   with cwd set to workspacePath. Use structured cwd where supported or proper
   POSIX quoting; never interpolate untrusted shell text or reconstruct Base64.
   The generated decoder is fixed plugin code. It accepts no extra arguments.
4. Require a zero exit and `{ok:true,path,sha256,byteLength}` matching the tool result.
   The decoder creates the PNG/MP3 exclusively, verifies it and removes only unchanged
   handoff files. It will not overwrite an existing output or follow a symlink.
5. Return a clickable workspace file/image reference. Do not claim the output exists
   merely because handoff-ready was returned. If decode fails, retain the job and
   report the failure; a fresh export does not require or justify regeneration.

Export requires a local workspace and the installed fs.read/fs.write scope grant.
Lack of export capability does not mean generation failed. Never read private
plugin result paths or credentials, or write workspace files directly from plugin
Node code to bypass the host. The old SDK has non-atomic text writes; pre/post
workspace checks do not provide an atomic pinned-root guarantee.

## Modes, credentials and compatibility

media_catalog.list, image_job and audio_job get/wait/list/result declare plan-safe actions.
The installed PI-Desktop 0.21.0 worker drops this declaration, so Plan mode
does not expose these tools there. Report this host limitation rather than bypassing
the mode. Normal Agent mode discovery and execution are verified.
Generate/export require Agent mode. The host supplies session/turn identity;
never place a fake caller identity in tool arguments. Agent-first job access is
scoped to its originating session; legacy tools/page retain their plugin-wide scope.

Keys remain in encrypted plugin storage backed by macOS Keychain. Never ask the
user for keys in chat, include them in prompts, print them, or read other apps'
private storage. Failed decrypt/corrupt files are not an invitation to reset data.

If tools are missing, distinguish disabled/ungranted/out-of-project scope and
stale session catalog. Registration alone does not establish discoverability.
Do not promise same-turn hot addition. Report the actual compatibility evidence;
never require a client upgrade as a hidden part of this plugin-only workflow.

Existing get_capabilities/list_profiles/list_workflows and prepare_image/
submit_image/get_image_job/list_image_jobs/read_image_result remain available for
old callers. Prefer the simplified image/audio tools in new Agent workflows.

ComfyUI browsing is read-only; remote tasks may belong to others. Image editing,
video, environmental sound effects, music and remote reconciliation are not implemented.
Film Factory may register/adopt an exported workspace result with its own explicit
revision and authorization rules; generation never adopts or approves media.
See ../../docs/agent-image-contract.md and ../../docs/audio-generation-contract.md.
If an upgraded 0.21.0 client retains the old plugin page, save edits and wait for
generation to finish, then disable/re-enable this plugin to destroy the cached
view. Closing the tab or reloading only the plugin backend may reuse the old page.
