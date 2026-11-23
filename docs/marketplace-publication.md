# Marketplace publication contract

The plugin center at https://plugins.aiuo.net/mcp requires an existing source
reference and complete English and Simplified Chinese display metadata. The
local manifest owns these values; submission copies them without reconstruction
or hand escaping. Agent tools, permissions, filesystem scope and activation
contracts must survive the platform's manifest reconstruction unchanged.

The marketplace name remains AI媒体生成服务 in Chinese and AI Media Services
in English. Panel translations use explicit keys and preserve placeholder names.
User-authored names, project labels, prompts, spoken text, model IDs, URLs and
workflow data remain literal data, not translation keys. Locale selection must
not replace a live editor or reset modal state, focus, scrolling or playback.
Older hosts without a locale API retain the existing Chinese panel experience.

One compatibility review is intentional: contributes.commands[].title remains a
plain string. The installed PI-Desktop 0.21.0 validator requires a nonempty string
for command titles, while view titles already support complete locale objects.
Changing the command title to an object would break installation on that client.
The Host binary request capability is maintained in PI-Desktop separately from this plugin. Version 0.7.3 requires that capability for image-to-video reference uploads; older Hosts reject that upload path before network I/O while retaining other supported operations.
## Version 0.7.9

This patch adds safe per-node Canvas metadata fallback for server-side full `/object_info` errors and records remote workflow preflight failures locally without submitting prompts or retrying stable requests.

## Version 0.7.8

This patch fixes remote ComfyUI workflow body reads by preserving `/userdata` path separators while encoding each safe path segment, with regression coverage for image-to-video submission.

## Version 0.7.7

This patch increases the bounded node-metadata response budget used only by the in-plugin Canvas converter and exposes safe request diagnostics for oversized or invalid ComfyUI responses.
## Version 0.7.6

This release keeps Canvas workflows inside the plugin flow: it reads ComfyUI `/object_info` metadata, converts links and widget values only when the mapping is complete, and otherwise leaves the workflow preview-only without saving or submitting.
## Version 0.7.5

This release adds direct execution of synchronized remote ComfyUI API workflows without importing them into Local workflows. The new `list_remote_workflows` tool exposes stable names, IDs, paths, formats, content hashes and field-match candidates from local snapshots; duplicate names require a path or stable ID. Remote content changes conflict with the same request key, while Canvas workflows remain preview-only.

## Version 0.7.1

This patch makes structured Agent image-generation selection failures explicit tool errors. Multiple ready models without a saved default return `MODEL_SELECTION_REQUIRED` and do not submit a provider request; invalid explicit model references return `MODEL_UNAVAILABLE`. The source remains compatible with the published 0.7.0 workflow and tool set.

## Version 0.7.4

This patch saves API-format remote workflow imports directly into Local workflows, shows a clear saved result, and explains the Canvas-format import boundary in the connection editor. Remote definitions remain read-only.

## Version 0.7.3

This release matches API-format ComfyUI node fields and output candidates, adds bilingual binding suggestions, and uploads scoped reference images through the Host binary request boundary before a single image-to-video prompt submission. Workflow inputs containing the saved ComfyUI credential are rejected before network I/O. The release candidate requires an executable API-format workflow and a Host with `binaryRequestBody` support for image-to-video.

The official publishing gate is read from https://plugins.aiuo.net/skill.md.
Passing its static checks does not establish translation correctness; runtime
locale checks and existing Chinese user paths are required as well.

The submission body is encoded once as UTF-8 JSON and passed to curl through
--data-binary with a private credential supplied separately on stdin. Before
submission, verify every runtime file against the tagged source and round-trip
the complete actual transport body. Never upload a pre-escaped JSON string.
A durable attempt record prevents blindly repeating an uncertain submission.

After submission, inspect version status and the official download resolver.
A catalog entry or approved state alone is insufficient to claim publication.
When a download is available, verify its size, SHA-256, complete runtime bytes,
and host manifest fields against source. Record any metadata-only differences.
No installed plugin, client, real credential, task history or paid provider is
changed by publication validation.

## Version 0.6.2

The plugin removes the binary-only gate by using OpenAI's documented JSON image
edit format with ordered data URLs on text-only Hosts. Binary-capable Hosts keep
multipart. This patch updates only the media plugin and does not require a Host
binary-upload extension for the JSON path. Scoped reads, hashes, request identity,
records, credentials and sixteen tools remain compatible. Selection happens before
submission; provider rejection or uncertainty never triggers another format retry.
Supplier JSON-edit support remains a separate real-provider verification.

## Version 0.6.1

Version 0.6.0 installed and ran correctly but retained a fixed 0.5.4 panel badge
and window title. The patch uses the running entry's existing status metadata
for both localized displays, with a hidden badge and base title when unavailable.
Bridge and real-browser regressions cover versions, reloads and editor/disposal
safety. No generation, storage, tool, permission or Host capability change is made.

## Version 0.6.0

The release preserves version 0.5.4's project labels, Agent-only configuration
and records panel, and English/Chinese runtime copy. Ordered GPT references are
an additive Agent input, with declared read-only reference scope, SHA-256 checks
and explicit Host binary-upload capability requirements. Older Hosts retain
text/speech operation; publishing this plugin does not update the Desktop host.
Reference jobs use private format version 3; text and speech records keep their
existing formats. Release notes and both locale safety notes state that user
images are sent to the selected provider only for authorized reference requests.

## Version 0.5.4 validation

The final localized source passed 301 Node tests and 70 browser tests: 43 settings,
8 records, 6 image, 7 audio and 6 locale user paths. The official i18n gate returned
0 failures and the command-title compatibility review documented above. The
installer check passed with the existing permission warnings; no grants changed.
Runtime tests cover English and Chinese configuration/discovery, workflows,
project labels, image/audio previews, literal user text, unavailable locale APIs,
late replies and startup disposal. Dictionary keys and placeholders match across
all nine tables. Generated copy-name suffixes preserve existing persisted naming.

The earlier local-only 0.5.4 package predates the publication-required locale work.
The final tagged-source package is stored separately under dist/release-v0.5.4.
The previous local package is retained when promoting the release artifact.
Publication status and downloaded-byte verification are recorded with release
artifacts, rather than inferred from these source-level tests.
