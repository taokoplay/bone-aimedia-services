# GPT request lifetime fix — 0.4.1

## Defect and evidence

The installed PI-Desktop 0.21.0 plugin worker binds host API promises to the
originating Agent tool invocation. Finishing that invocation rejects unresolved
host calls with PLUGIN_TOOL_ABORTED. The tool deadline is 110 seconds.

Version 0.4.0 dispatched pi.net.fetch asynchronously, then returned from
`generate_image` after waitMs (normally ten seconds). The legacy `submit_image`
tool returned immediately. A supplier response arriving later could be HTTP 200
at the host yet unavailable to the plugin. The adapter mapped the worker rejection
to NETWORK_ERROR, producing an unknown job instead of storing its PNG.

A frozen 0.4.0 source copy reproduced all three paths on the unchanged installed
client with a localhost supplier that waits twelve seconds before returning PNG:

| Entry | Initial Agent turn | HTTP 200 response | Later query/repeat | Requests |
|---|---:|---:|---|---:|
| generate_image, waitMs=1000 | 1,882 ms | 12,002 ms | unknown / NETWORK_ERROR | 1 |
| generate_image, default waitMs | 10,518 ms | 12,001 ms | unknown / NETWORK_ERROR | 1 |
| legacy submit_image | 414 ms | 12,014 ms | unknown / NETWORK_ERROR | 1 |

Host audit ordering independently showed tool completion before successful
net.fetch completion. The unit invocation fixture also failed before the fix.
This demonstrates the plugin defect; it does not prove every real supplier error
had no additional network cause.

## Fix

`image-generation.submitAndWait` calls the existing submit path and awaits that
job's active execution outside the serialized command queue. Modern and legacy
Agent tools both use it. The panel continues using asynchronous submit/poll.
There is one state machine, one durable claim and no duplicate provider dispatch.

New submissions retain their originating invocation through network completion,
PNG validation and result persistence. HTTP timeout is 90 seconds, reserving time
inside the host's 110-second tool deadline. waitMs remains schema-compatible but
only governs local observation of an existing task; it does not cut short a new
submission. Longer/unresponsive suppliers can still produce timeout/unknown.

PLUGIN_TOOL_ABORTED/TOOL_ABORTED now maps to TOOL_ABORTED with unknown outcome and
charging. TIMEOUT and genuine network failures remain distinct. Safe localized
UI messages explain the uncertainty. No raw exception, credential or response
body is reflected. No context detachment, direct Node network fallback, client
patch, permission widening, automatic retry or old-job rewrite was introduced.

## Verification

- Full Node regression: **250/250 passed**.
- Focused generation/Agent/lifetime tests: **27/27 passed**.
- Three new invocation regression cases: all failed before the fix, all pass now.
- JavaScript syntax checks and twelve-tool manifest synchronization passed.
- Real installed-client delayed acceptance: all three cases passed, exit 0:

| Entry | Initial Agent turn | HTTP 200 response | Submit/query/repeat | Requests |
|---|---:|---:|---|---:|
| generate_image, waitMs=0 | 12,790 ms | 12,004 ms | succeeded | 1 |
| generate_image, default waitMs | 13,419 ms | 12,056 ms | succeeded | 1 |
| legacy submit_image | 13,645 ms | 12,024 ms | succeeded | 1 |

Modern results reached the model as typed PNG blocks without Base64 text
flattening. Legacy result chunks matched the original PNG bytes. Host audit
ordering now shows HTTP completion before the originating tool finishes.
Source fingerprints matched the executed 0.4.1 snapshot and current source.

Reproduce with `tests/image-request-lifetime.e2e.cjs`; `--baseline` requires an
explicit frozen source root. All accounts, credentials and HTTP endpoints in this
acceptance are isolated synthetic fixtures. The test app required its bounded
forced-shutdown fallback; normal client shutdown is not claimed as verified.
The synthetic Keychain item and owned process were confirmed absent afterward.

Session evidence:
- `request-lifetime-baseline.log` and `request-lifetime-fixed.log`: unit regression.
- `request-lifetime-full-node.log`: full Node results.
- `image-request-lifetime-baseline.log`: actual-client failure reproduction.
- `image-request-lifetime-fixed.log`: actual-client fixed acceptance.
- `image-request-lifetime-lmgENe/evidence.json`: exact jobs, timings and fingerprints.

## Existing real jobs

The user's real task `img-fa209ee2-dba1-4aa6-9f62-51af666f1548` remains untouched.
No new real-provider image request was made during this repair. An old unknown
job cannot be declared successful/refunded or safely resubmitted merely because
the lifecycle defect is fixed; supplier records must resolve its billing outcome.
Install plugin 0.4.1 to use the corrected request lifecycle. The client stays unchanged.

## Browser regression

Final synthetic Chrome runs passed: settings **43/43** (197.917s), generation
**11/11** (49.366s), zero failures/skips. Logs: lifetime-settings-browser.log and
lifetime-generation-browser.log. Both CLI help checks ran first; neither suite
contacted a real supplier. Installation validation retains only the existing
permission notices; this release adds no permissions.
