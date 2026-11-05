# Generation records redesign acceptance — 0.4.2

## Delivered behavior

Records and Task Queue are merged into Generation Records. Configuration and the
optional Generate page remain available. The records page has one local refresh
control, state filters with counts, and a unified list of channel, model, state
and creation time. It no longer mixes ComfyUI server history into plugin records.

Details open in a native modal. Completed images are verified, decoded and
available for download. Requested and actual dimensions are separate. Prompts and
technical IDs are collapsed. The modal keeps its shell during state updates,
contains keyboard focus, closes with Escape/close/backdrop, and restores list
focus and scroll. Unknown results remain Needs reconciliation, not Failed.

No storage schema, credential, generation, Agent tool, permission or output-file
contract changes are part of this redesign. Existing task records remain intact.

Main implementation: `renderer/settings-records.js`,
`renderer/settings-generation.js`, `renderer/settings-generation.css`,
`renderer/settings-app.js` and `renderer/index.html`.

## Executed checks

| Check | Result |
|---|---|
| `node --test tests/*.test.cjs` | 250 passed; 0 failed, skipped or cancelled |
| `python3 -B tests/settings.browser.py` | 43 passed |
| `python3 -B tests/generation.browser.py` | 11 passed, including the final modal-keyboard revision |
| `python3 -B tests/records.browser.py` | 7 passed on the final modal-keyboard revision |
| `node scripts/sync-manifest.cjs --check` | 12 tool descriptors matched version 0.4.2 |
| `node --check` for records/generation/app renderer modules | Passed |

The Node suite ran before the final renderer-only keyboard fix; no backend code
changed afterward. The records and generation browser suites were rerun after
that fix. Configuration code was unchanged after its successful suite.

The new browser suite enters through the real plugin and panel bridge with
isolated storage and synthetic supplier responses. It verifies:

- Six persisted states, exact filters/counts, historical channel/model labels and
  no remote requests from list/detail refresh.
- Verified PNG preview/download with matching SHA-256, actual/requested dimensions,
  prompt disclosure, forward/reverse Tab traversal and Escape focus restoration.
- Generating to Completed while retaining the dialog and focused close button;
  a task disappearing from the Generating filter after completion.
- Closing a dialog before a delayed detail read resolves, then navigating away.
- Unknown results excluded from Failed, and recovery from a detail-read failure.
- Scroll restoration and no horizontal overflow at 1160px dark, 390px dark and
  320px light; empty state and main-navigation keyboard interaction.

An initial records run reported 6 passed and 1 failed: native Chromium dialog
focus could leave its controls after repeated Tab presses. Explicit boundary
wrapping for visible, enabled controls fixed this. The regression now checks
both Tab and Shift+Tab, including expanded prompt content.

## Visual evidence

Fixture screenshots were inspected for the desktop list and desktop/narrow modal
layouts. Screenshots show a synthetic 32 x 32 PNG, not a real generated artwork.
All imagery, service labels and jobs in these screenshots come from test fixtures.

Session evidence files:

- `records-node.log`
- `records-settings-regression.log`
- `records-generation-final.log`
- `records-browser-fixed.log`
- `records-1160-dark.png`, `records-390-dark.png`, `records-320-light.png`
- `record-dialog-1160-dark.png`, `record-dialog-390-dark.png`,
  `record-dialog-320-light.png`

These temporary logs/screenshots are not included in the plugin package.

## Acceptance limits

The user's installed PI-Desktop client was not changed or restarted. Version
0.4.2 has not been installed into the user's live plugin runtime during these
checks. These results establish isolated browser behavior and backend regressions,
not live installed-client UI acceptance. No real provider generation was submitted
for this redesign. Existing unknown tasks and their billing state were not changed.

Earlier 0.4.1 actual-provider success and installed-client Agent acceptance remain
historical evidence, described in the existing acceptance documents. No paid API,
client update or host-code modification is required by this UI change.

## 0.4.3 follow-up: channel and model in one column

The channel and model now share one semantic table cell. Channel appears above
the smaller muted model label at desktop and narrow widths. The five table
headers are Task, Channel / Model, State, Created, Action.

The strengthened existing records test failed against 0.4.2 because the labels
occupied separate cells. After the markup/CSS change, all 7 records browser tests
passed (93.619 seconds). The suite verifies the shared cell, five headers and
actual vertical alignment at 1160px dark, 390px dark and 320px light, alongside
the existing filter, state-update, preview/download and modal-lifecycle checks.
Session logs are `records-stacked-baseline.log` and `records-stacked-final.log`.

Backend suites were not rerun for this presentation-only follow-up. No supplier
request or live installation was performed; backend contracts remain unchanged.
