# Unified generation records — 0.5.4 UI contract

## Intent and scope

The plugin has two destinations: Configuration and Generation Records.
Configuration remains the default; Agent conversations create image and speech
tasks. The manual Image and Audio forms and their controllers are removed.
All sixteen Agent tools, compatibility prepare/submit routes, saved settings,
credentials, tasks and output files retain their contracts. This navigation
change performs no migration, deletion or regeneration.

Records shows only plugin-owned tasks with one local refresh action. ComfyUI
server history/queue remains separate; its inspection APIs stay compatible.

## List and state

The unified list is ordered newest first and shows the saved channel name
(profileName), model ID, visible state and creation time. Channel and model share
one column: channel above, smaller muted model below, including on narrow screens.
Full job IDs, request
hashes, prompt text and billing explanations belong in details, not every row.
Image and speech records share the list; task labels distinguish media kind. Each
store retains 200 records, for a combined maximum of 400. Local polling while the
page is visible discovers newly created Agent tasks without a supplier request.

### Project label

Each task type has a second line containing an 11px muted, bordered project badge.
Long names stay on one line with ellipsis, full title and an accessible label.
No extra column or interaction is added.

New tasks capture a display-only project snapshot using host workspace/session
metadata. Agent capture requires the selected session ID to match the trusted
calling session; an observed session switch returns unknown. A matching workspace
name is preferred, with the session project folder name as fallback. Missing old
host APIs or unmatched background sessions remain unknown. No session transcript,
user-provided project field, broad permission or private database lookup is used.

The snapshot is stored separately as `<jobId>.project.json`, bound to the job ID,
request hash and Agent provenance digest. It contains only status/name, not paths
or raw session IDs. The existing private-file safeguards and exclusive publication
apply. A failed/interrupted snapshot write cannot lead to project reassignment;
the record is left without a label rather than backfilled on a retry. The main
image/audio record versions and existing public tool responses are unchanged.

Only unified records list/get add `project: {status: project|none|unknown, name?}`.
Missing snapshots display “未记录项目”; confirmed no-project tasks display
“无所属项目”. No historical task is assigned to the currently viewed project.
Snapshots do not imply project-level access isolation or change export destinations.

Acceptance covers panel image/audio preparation, Agent calls, reloading, idempotent
retries, project changes during capture, no-project and missing APIs, malformed or
linked metadata, and responsive badge layout/filter/detail behavior.

The local filter controls are All, Generating, Completed, Failed:

| Stored state | Label | Filter |
|---|---|---|
| submitting | Generating | Generating |
| succeeded | Completed | Completed |
| failed | Failed | Failed |
| prepared | Awaiting confirmation | All only |
| unknown | Needs reconciliation | All only |
| result-pending | Needs reconciliation | All only |

Unknown/pending results are never declared failed or refunded. The list retains
them as visible auxiliary states under All. Counts reflect current local state.
There is no manual state override and no provider-side refresh/resubmission.
Polling only observes local tasks and must preserve focused controls and scrolling.

## Detail dialog

Each row opens a named native modal dialog, not an inline block below the list.
The dialog provides loading/error/retry states and read-only details; opening it
never submits a prepared task. Generation runs through authorized Agent tools;
the page has no generation form, confirmation or resubmission action.

Successful results are hash-checked and browser-decoded before preview/playback
and download. Images show separate requested and actual dimensions; speech shows
format, encoded duration, sample rate, channels, voice and speed. Prompt/spoken
text and technical identifiers can be expanded without making the list taller.
Unknown/error explanations are contextual; normal success does not display a
large disclaimer stack. Audio playback must survive unrelated local polling.

ESC, the close button and an outside-backdrop click dismiss the dialog. Focus is
trapped while open and returns to the initiating row (or a stable list control if
that row disappeared from the filter). Opening/closing does not reset list scroll.
Status updates keep the same dialog shell; closing, switching pages or disposing
invalidates outstanding UI reads, stops audio playback and revokes object URLs.
Late results never reopen a closed dialog or steal focus.

## Validation

`tests/records.browser.py` uses the real plugin entry with temporary storage and
synthetic HTTP only. It covers six stored states, exact filtering, saved channel
and model display, local-only refresh, modal focus/ESC, successful preview/download,
requested-versus-actual dimensions, live state transition, read failure recovery,
late-response closure, narrow dark/light layouts and scroll preservation.

The image and audio browser suites enter through registered Agent tools, then
observe local records, decode and download original results, recover reads and
verify no duplicate generation on refresh/reload or same-key calls. Audio tests
also cover playback continuity and cleanup. Settings tests cover two-tab keyboard
navigation and the retained configuration forms. Backend/Agent regression suites
continue to verify runtime contracts. Screenshots use isolated fixture data.
See audio-generation-contract.md for media boundaries and acceptance paths.

Historical results and acceptance limits are recorded in
[the 0.4.2 acceptance report](acceptance-generation-records.md).

The 0.5.0 speech and mixed-record checks are recorded in
[the audio acceptance report](acceptance-audio-generation.md).

## 0.5.2 validation

Executed checks: 287 Node tests; 8 records, 9 audio and 11 image browser tests
passed. The new badge user path checks fixed project snapshots, unknown/none
labels, titles and accessible names, below-type alignment, 11px text, ellipsis,
filter/detail/reload behavior and 1160/730/390px dark plus 320px light layouts.
Desktop and narrow screenshot output was visually inspected. No real provider
request or installed-client modification was performed. The existing configuration
browser suite was not repeated because the configuration surface is unchanged.

Validation used the dedicated feat/generation-project-label worktree based on
ad03e75f4a1e8e3f5e98e8bdec88280fe38e5419. This report does not claim 0.5.2 is
installed, committed or published. Session logs: project-label-all-node.log,
project-label-records-final.log, project-label-audio-final.log and
project-label-image-final.log (not part of the release package).

## 0.5.3 spacing refinement

Desktop and medium-width grids distribute flexible width across task, source,
status and time instead of assigning the source column a double share. Source
width stays below 32% of the row in the responsive acceptance fixtures, and status
starts within the first 58%, reducing the empty gap after short model IDs.
Header and row grids use the same tracks; layouts at 700px and below retain their
existing stacked structure. The two targeted project-label/responsive browser
tests passed, including 1160/730/390/320px widths, dark/light, details and scroll
restoration. No generation or persistence logic changed in this refinement.

## 0.5.4 Agent-only panel acceptance

The two-tab navigation assertion failed against the former four-tab UI, then
passed after removing manual controllers and script imports. All sixteen tool
definitions and permission declarations match 0.5.3; generation backends are
unchanged by this UI revision. Configuration stays the initial destination.

Executed checks: 287 Node tests and 64 browser tests passed (43 configuration,
8 records, 6 Agent image, 7 Agent speech). The image/speech suites use registered
tools and real plugin wiring with isolated providers. They verify visible task
discovery, held-request progress, original-byte downloads, browser decoding,
restart/idempotency, uncertain outcomes without resubmission, late-read cleanup
and stable focus/playback. Record tests retain project labels and column alignment.

Responsive acceptance exposed a 5px configuration overflow at 320px. Allowing the
search group to shrink while preserving its add button fixed the failing check;
the full image suite and targeted configuration responsive test passed afterward.
The final speech rerun passed all 7 tests in 74.093s after an earlier 60-second
execution-tool cutoff. The interrupted run is not counted as a passing suite.
Desktop/narrow record and media-detail screenshots were visually inspected.

Manifest synchronization, JavaScript syntax, renderer imports, changed Markdown
links and git diff whitespace checks passed. Tests ran in the uncommitted
feat/generation-project-label worktree based on
ad03e75f4a1e8e3f5e98e8bdec88280fe38e5419, still the fetched origin/main.
No paid supplier, real credential/history, installed plugin or client was changed.
This acceptance does not claim live MiniMax access, listening quality, installation,
Git publication or marketplace publication. Historical reports above retain their
original version scope.
