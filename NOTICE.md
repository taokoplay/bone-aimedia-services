# Source and licensing notes

Bone AI Media Services is distributed under GNU AGPL-3.0-only; see LICENSE.
The configuration validation, storage and probe modules were adapted from the
Bone Film Factory media-provider prototype in the same development project.
They remain subject to their applicable AGPL terms.

The UI layout and workflow are informed by DutyDeck's media settings source:
MediaSettings, MediaSettingsPage, ImageGenerationSettings and settings primitives.
The new plugin does not depend on DutyDeck Electron IPC, application stores,
private user data or credentials. See docs/ui-design.zh-CN.md for source locations
and deliberate behavior differences.

The PI-Desktop scaffold established the plugin entry and panel structure. No
third-party model service, account, voice, generated asset, font or media right
is granted by this project's software license. Provider names identify compatible
configuration targets; they are not endorsements or promises of availability.

No proprietary relicensing of upstream contributions is asserted here. Any
alternative commercial agreement must cover only rights its licensors may grant;
AGPL-compliant commercial use remains permitted under the AGPL.
