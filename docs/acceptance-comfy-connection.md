# ComfyUI connection regression acceptance

## Confirmed failure

A read-only diagnostic against the reported server returned HTTP 200 from both
`/system_stats` (1,131 bytes) and `/object_info` (4,412,853 bytes, 2,209 nodes).
Every inspected node had an input object. The old connection probe always fetched
both endpoints, so the 2 MiB response cap rejected the node catalog and surfaced
a generic connection error even though the server was reachable.

## Result

- A saved connection with no workflow now checks only `/system_stats`.
- System response validation still requires a system object; device details are
  optional. Invalid JSON and malformed records are not accepted as success.
- Workflow checks still validate node records separately. A failed catalog read
  retains verified connection status and leaves compatibility unknown.
- ComfyUI none, Bearer and custom-header modes persist and affect outgoing headers.
  Legacy optional Bearer remains compatible. Saved secrets now use host encryption
  and survive reload; see `acceptance-credential-persistence.md`.
- Connection diagnostics distinguish HTTP/auth, JSON/schema, size, timeout,
  redirect and host permission failures. The panel uses safe Chinese messages.
- Editing connection identity invalidates old results and disables testing until
  the connection is saved. A successful lightweight check never claims zero nodes.

## Checks actually executed

- Full Node suite: 88 passed, 0 failed.
- After the final legacy-auth validation adjustment: 41 affected Node tests passed.
- Full isolated Chrome suite: 27 passed, 1 navigation-helper timeout in test 07.
  That test expected a service row while still on the workflow category. It now
  selects the visible category controls before checking reference protection.
- Final targeted Chrome run: tests 07, 25, 26 and 27 all passed (4/4).
  Tests 25-27 cover save/test/model browsing with an oversized node catalog,
  auth-mode save/reopen/request headers, and localized failure/retry recovery.
- JavaScript syntax checks for lib, renderer and test files, plus Python parsing,
  passed.
- The corrected service logic was checked against the reported server using an
  isolated scratch configuration and a Node HTTP adapter. It returned connected
  with exactly one GET request. No generation was submitted and no user settings
  were changed. This was not an installed Electron-host UI acceptance run.

## Limits

The 2 MiB catalog response cap remains for explicit workflow checks. Large catalogs
may still report compatibility as unknown with a precise size error. Connection
success does not prove workflow execution or generation support. Backend changes
require a plugin reload; saved credentials now restore through the host encryption
API after reload. The host must support and grant both secret permissions.
