# Acceptance — Bone AI Media Services 0.1.0

## Delivered scope

An independent, runnable configuration/discovery plugin at
`/Users/xutaoyu/CodeSource/PI-Plugins/bone-aimedia-services`, created from the
PI-Desktop panel-basic scaffold and then adapted to a docked settings view.
Five DutyDeck-inspired list/edit pages cover generation models, audio, LibTV,
ComfyUI connections and standalone local workflows. The first release does not
submit generation, run a CLI, perform OAuth, download generated results or export
media. Capability output remains explicit about all unimplemented operations.

Provider configuration, workflow storage and three read-only Agent contracts
are independent of Film Factory. No pre-existing production, credential or
provider settings were migrated or modified.

## Checks executed

- **49 Node tests passed**, zero failures/skips: 42 backend tests and seven real
  entry/Agent/bridge tests. Includes retained prototype validation, standalone
  workflow CRUD/CAS/references, secret exclusion, storage safety, probe scoping,
  lifecycle races, unavailable tool registration and generation-unavailable state.
- **18 Chrome/Playwright scenarios passed**, covering list → edit → save,
  structured models, OpenAI/Xiaomi discovery, MiniMax voices, explicit defaults,
  protected connection references, standalone workflows, failed/CAS/uncertain
  saves, reload key loss, input/import races, keyboard focus and host appearance.
- Lists, profile editors and workflow editors checked at 1440/900/600/390 widths
  in dark/light themes. Twenty-four screenshots were captured. Desktop dark
  screenshots were visually inspected through the built-in preview. No pixel
  comparison against a running DutyDeck instance was claimed.
- Following two backend review fixes, five relevant provider/workflow/readiness
  browser scenarios were rerun and passed. Following a credential-button layout
  correction, the masked-key and responsive scenarios were rerun and passed.
- Runtime JavaScript and test syntax checked. Runtime/manifest synchronization
  verified exactly three tools. Plugin check passed with expected high-risk
  permission notices for Agent registration/prompts and explicit network access.
- Markdown links/fences, JSON examples, skill metadata and portable runtime paths
  were verified. Package contents/hash are checked after clean staging.

All tests use temporary private storage and injected/synthetic provider HTTP.
No live provider API, real account key, paid generation, native desktop automation
or restart of the user's host was used.

## Review fixes

One bounded independent backend review identified two concrete status defects.
Both were reproduced by failing registered-entry tests before correction:

1. Missing workflow node types were conflated with ComfyUI connection failure.
   Probe results now retain profile/workflow scope and separate connectionStatus
   from workflowCompatible; Agent summaries preserve that attribution.
2. Panel capabilities reported a reachable Agent tool even when tool registration
   was missing/denied. Panel responses now use actual registration state; a
   successful Agent invocation still establishes reachability for that call.

No repeated broad review was started. These changes do not enable generation or
change the deliberate process-memory credential policy.

## Installation and development notes

The scaffold tool interpreted the supplied absolute directory as relative to the
host checkout. Its generated files were moved to the canonical source directory;
a compatibility symlink at the scaffold-created path points to that single source
so the temporary development entry is not silently broken. The earlier planning
files were preserved in session scratch and restored to the canonical docs.
No host registry or permission grants were edited manually.

Current-session tool discovery did not expose the new get_capabilities tool after
source changes. Treat live tool availability and native permission/upgrade UX as
unverified until the package or canonical development directory is installed/
reloaded through the host and its permissions are reviewed. Do not equate the
isolated registration test with the user's current session being authorized.
The scaffold's compatibility entry is unnecessary after a successful package
installation, but should not be removed while an active development load relies
on it. No automatic host shutdown is required or performed.

## Limits

- Credentials are not persisted: reload/unload clears process memory.
- Dreamina CLI and LibTV MCP login/execution remain external.
- Provider probes establish only the observed model/voice/node directory access.
- No generation submission, result export, media review certification or final
  video rendering is implemented. Future APIs in planning docs are proposals.
- Source has not been initialized as a Git repository or pushed/published.
- Film Factory's pending source and commercial-license edits are preserved.

The distributable contains runtime modules, skills, license/notice and maintained
documentation. Tests, fixture HTTP servers, screenshots, private configuration,
credentials and scratch state are excluded by the clean packaging script.
