# LibTV and ComfyUI integration research

This source check informs v0.2.0 navigation and read-only browsing. No account
was authenticated, no token was read and no generation task was submitted.

## LibTV

Observed public sources:

- [Official marketplace](https://github.com/liblib-ai/marketplace)
- [Official marketplace README](https://github.com/liblib-ai/marketplace/blob/main/README.md)
- [Protected-resource metadata](https://mcp.liblib.tv/.well-known/oauth-protected-resource)
- [Authorization-server metadata](https://mcp.liblib.tv/.well-known/oauth-authorization-server)

Both metadata endpoints returned HTTP 200 during this check. They identify
`https://mcp.liblib.tv/mcp` as the resource and `https://mcp.liblib.tv/` as the
issuer. Authorization, token and dynamic-registration endpoints are `/authorize`,
`/token` and `/register` on that origin. Scopes cover account read, project
read/write, media write, task write and export write. These are advertised
metadata only, not proof this plugin can log in or execute remote tools.

The official marketplace says it ships one production plugin named `libtv`,
using native HTTP Remote MCP and client-driven OAuth discovery. It does not
bundle a client ID, redirect URI, credentials or a local server. Its instructions
refer to a single `mcp_servers.libtv` entry and each user's own LibTV identity.
The README's Codex-specific installation commands are not PI-Desktop commands.

DutyDeck independently models one server named `libtv` per selected workspace.
`LibTvSettings.tsx` and `LibTvSettings.logic.ts` read that workspace's MCP config,
install the official entry if absent, perform OAuth through the host and verify
remote tools. Credentials are scoped by workspace/server, not copied into media
profiles. The same-name conflict path refuses to overwrite a nonofficial server.

**Conclusion:** a dedicated single LibTV entry fits the integration model. This
is a product-level configuration rule, not evidence that the LibTV platform
forbids multiple accounts or that multiple separate workspaces share credentials.
Bone's current SDK has no cross-plugin MCP management/OAuth invocation contract;
keep host authorization external and do not render a fake connected/login state.

The AutoGLM search helper was unavailable because its local token endpoint refused
the connection. Public official sources above were fetched directly instead.

## Dreamina

DutyDeck's `image-generation-dreamina-service.ts` treats login as the installed
CLI's local state. The CLI path is configuration, not an account selector.
Multiple profile rows would not create isolated logins. Per user instruction,
Bone now allows one Dreamina configuration. It continues not to read the CLI's
private session files or execute it through an undeclared process interface.

## ComfyUI read-only contracts

Compared with DutyDeck's `comfyui-client.ts` and the current public upstream:

- [ComfyUI server routes](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)
- [ComfyUI UserData manager](https://github.com/Comfy-Org/ComfyUI/blob/master/app/user_manager.py)

| Data | Request | Observed shape |
|---|---|---|
| Model folders | `GET /models` | Array of directory names |
| Models in folder | `GET /models/{folder}` | Array of model filenames |
| Saved remote workflows | `GET /userdata?dir=workflows&recurse=true&full_info=true` | Array of path/size/modified/created records |
| Workflow details | `GET /userdata/{encoded workflows/path}` | JSON; may be API format or a canvas layout |
| Server queue | `GET /queue` | queue_running/queue_pending tuples |
| Recent history | `GET /history?max_items=100` | Object keyed by prompt ID |

UserData listing paths are relative to the queried workflows directory. Detail
fetch must encode the full `workflows/<relativePath>` as one route parameter.
Reject traversal, absolute paths, URL-like paths and credential-bearing data.
A canvas workflow is not an executable API prompt; show it read-only rather
than claiming automatic conversion.

Queue/history are server-wide data, potentially including jobs created by other
clients. Display only task ID, queue number/state and safe result counts; omit
prompts, headers, extra_data and result URLs. No cancel/interrupt or submission
endpoint is needed for browsing. Missing/unsupported endpoints remain distinct
from an empty successfully read directory. Model presence is not proof a model
is loaded or compatible with a workflow.

## Versioning and compatibility

The upstream links track moving branches; details can change across ComfyUI
versions. Tests use protocol fixtures and unsupported responses. No live ComfyUI
instance was contacted in development. The implementation must report unsupported
or invalid responses without falling back to filesystem access or guessed URLs.
Existing duplicate Dreamina/LibTV profiles remain readable and visible; new
singletons cannot be multiplied, and consolidation is explicit and nondestructive.
