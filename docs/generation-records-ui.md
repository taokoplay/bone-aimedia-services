# Unified generation records — 0.4.3 UI contract

## Intent and scope

Replace the separate Records and Task Queue destinations with one Generation
Records page. It shows only plugin-owned generated-job records and a single local
refresh action. ComfyUI server history/queue is not mixed into this page. Existing
backend inspection contracts remain available for compatibility; service/resource
configuration and Agent generation are unchanged.

The main navigation is Configuration, Generate, Generation Records. Configuration
remains the default. No settings, credentials, tasks or output files are migrated,
deleted, regenerated or reclassified on disk by this UI change.

## List and state

The unified list is ordered newest first and shows the saved channel name
(profileName), model ID, visible state and creation time. Channel and model share
one column: channel above, smaller muted model below, including on narrow screens.
Full job IDs, request
hashes, prompt text and billing explanations belong in details, not every row.

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
never submits a prepared task. Generation confirmation remains on the Generate
page and in the existing authorized Agent tool.

Successful results are PNG hash-checked, browser-decoded, previewed and explicitly
downloadable using the existing local result path. Requested dimensions and actual
result dimensions have separate labels. Provider/model, quality, quantity and
creation time are readable. Prompt and technical identifiers can be expanded
without making the list taller. Unknown/error explanations are contextual; normal
success does not display a large disclaimer stack.

ESC, the close button and an outside-backdrop click dismiss the dialog. Focus is
trapped while open and returns to the initiating row (or a stable list control if
that row disappeared from the filter). Opening/closing does not reset list scroll.
Status updates keep the same dialog shell; closing, switching pages or disposing
invalidates outstanding UI reads and revokes object URLs. Late results never reopen
a closed dialog or steal focus. Existing job/request lifetime safety is unchanged.

## Validation

`tests/records.browser.py` uses the real plugin entry with temporary storage and
synthetic HTTP only. It covers six stored states, exact filtering, saved channel
and model display, local-only refresh, modal focus/ESC, successful preview/download,
requested-versus-actual dimensions, live state transition, read failure recovery,
late-response closure, narrow dark/light layouts and scroll preservation.

Existing generation and settings browser tests are updated only where navigation
or the deliberately removed mixed remote-activity surface changed. Backend/Agent
regression suites continue to verify the unchanged runtime contracts. Screenshots
are produced from isolated fixture data, never from user credentials or history.

Final test results and acceptance limits are recorded in
[the 0.4.2 acceptance report](acceptance-generation-records.md).
