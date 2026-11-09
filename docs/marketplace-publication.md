# Marketplace publication contract — 0.5.4

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
The host is not updated as part of this release.

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

## Release validation

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
