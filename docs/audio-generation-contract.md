# MiniMax speech and unified records — 0.5.0

## Scope and provider evidence

This release adds text-to-speech only. The user explicitly chose to retain the
current PI-Desktop client and implement MiniMax speech before environmental sound
effects. Footsteps, ambience and music are not speech and must never be silently
converted into spoken descriptions or locally synthesized substitutes.

The official [MiniMax HTTP speech reference](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
specifies `POST /v1/t2a_v2`, `stream:false`, `output_format:hex`, an explicit
`voice_setting.voice_id`, and audio settings. The plugin requests MP3, 32000 Hz,
128000 bit/s and mono. Speed accepts 0.5–2; volume and pitch remain 1 and 0.

The existing host `net.fetch` returns bodyText, so JSON hex delivery is compatible
without client changes. The official [ElevenLabs sound-effects reference](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
returns encoded binary audio; this release does not implement that path or bypass
the host using direct Node networking. The MiniMax documented voice effects
(echo/telephone/robotic) are not general environmental sound synthesis.

Supported configured model IDs: speech-2.8-hd/turbo, speech-2.6-hd/turbo,
speech-02-hd/turbo and speech-01-hd/turbo. Text is bounded to 1000 Unicode code
points; ordinary newline/tab paragraph text is accepted. Voice IDs are explicit,
bounded and reject control characters. Prompts/voice IDs cannot contain known
credentials. Account voice discovery does not choose or persist a default voice.

## Agent entry points

| Tool | Contract |
|---|---|
| media_catalog | Existing tool now reports audio.speech for supported MiniMax models; readiness remains local configuration evidence |
| audio_voices | Explicit modelRef, Agent mode; reads the account voice catalog without generation |
| generate_audio | Required operation:speech, text, voiceId and requestKey; optional modelRef, speed and waitMs |
| audio_job | Session-scoped get/wait/list/result; result verifies bytes and returns export-required metadata, never Base64 text |
| export_audio_result | Session-scoped MP3 handoff using existing workspace fs grants and an Agent-authorized decoder |

Model resolution remains explicit -> session -> saved exact default -> unique
ready candidate -> choices. An explicit unavailable model never switches silently.
The same session/requestKey derives one aud-UUID task. Different text, voice, speed
or model under an existing key conflicts. Existing jobs are read before current
configuration resolution, including after restart. Agent mode is required for
writes and network voice discovery; local audio_job reads remain plan-safe in the
manifest, subject to the installed host's known discovery limitation.

Fresh generation holds its originating tool invocation through the 90-second HTTP
request and persistence. waitMs does not truncate a fresh request. Permission
rejection before dispatch is not-submitted; transport loss, timeout and invocation
interruption retain uncertain charging. No automatic retry or refund claim.

## Shared lifecycle and storage

The common engine owns claims, dispatch, result persistence, recovery and cleanup.
Image wrappers retain existing exports, record versions, directory, markers and
public response shapes. Audio has a separate audio-jobs directory with aud-UUID
IDs, .json records, .submitted markers, .mp3 results and 200 permanent slots.
There is no migration or rewriting of image records. Both generators share one
process-local two-request budget, retained through output persistence.

Audio private records use version 1 for panel jobs and version 2 for validated
hashed Agent provenance. Public jobs add kind:audio and omit private provenance;
list summaries omit text. The states remain prepared, submitting, succeeded,
failed, unknown and result-pending. Unknown tasks are never treated as failed.

Storage retains 0700 directories, 0600 files, bounded reads, no-follow/inode checks,
exclusive publication and permanent claims. A saved MP3 with an interrupted final
JSON write can be recovered without another provider request. Forced process exit
may leave an uncertain claimed job; it never enables resubmission.

## Audio verification and delivery

MP3s are bounded to 16 MiB and 600 seconds. Structural validation checks every
MPEG Layer III frame extent, sample-rate/channel consistency, bounded ID3 metadata
and an optional ID3v1 trailer. Duration, sample rate and channels derive from the
encoded bytes rather than supplier metadata. Verification is explicitly
mp3-frames-validated; this does not claim full decoding or listening quality.

The panel verifies chunk offsets, byte count and SHA-256, then browser-decodes
before offering playback and download. Metadata duration may include encoder
padding. Closing/navigating/disposal stops playback, clears sources and revokes
Blob URLs; local updates must not replace a playing control or reset its position.

Agent export uses host workspace.get/fs.stat/readText/writeText in the existing
bone-media/exports/** scope. Unique .audio.json and .decode.cjs handoffs produce an
exclusive .mp3 file only after the Agent executes the fixed decoder. The decoder
checks hashes, length, paths and file identities and removes only unchanged owned
handoffs after success. Existing image export contracts remain compatible. No
extra shell/network/file permissions are declared. Existing SDK text-write and
workspace-switch race limitations remain documented in agent-image-contract.md.

## Panel and unified records

Additive routes:

- aimedia.audio.prepare/submit/get/list/read: speech lifecycle and bounded local
  result chunks, mirroring the image routes.
- aimedia.records.list: merge image/audio summaries newest-first, limit 400.
- aimedia.records.get: explicit kind and jobId; add kind to image copies only.
- aimedia.records.read: kind, jobId, expectedSha256 and offset; route only matching
  kind/ID prefixes to the corresponding store.

Existing image routes and response shapes are unchanged. The unified record page
polls local records while visible to discover new Agent tasks, preserves row and
modal identity, and performs no supplier status query. Failed reads remain visible
and do not cause retries of generation. Historical channel/model metadata is used.

## Representative acceptance paths

1. Configure an enabled MiniMax speech model with a synthetic credential; discover
   voices, explicitly choose one, enter text/speed, prepare and confirm once.
2. Observe submitting -> succeeded in the same task, then open the unified records
   dialog, browser-decode/play audio and download matching original bytes.
3. Generate an image and speech through the real Agent-tool entry and confirm both
   appear in the unified list. Restart, query/export and retry the same requestKey
   without another generation POST.
4. Deny cross-session result/export access, invalid mode, unsupported effects and
   wrong-kind record access. Cover provider rejection, timeout, malformed hex and
   absent/corrupt results without unsafe fallback or secret reflection.
5. Verify playback stops on close/navigation/disposal, late reads cannot reopen a
   dialog, status polling preserves focus/playback, and narrow light/dark layouts
   remain usable. Verify original image suites after shared-module extraction.

Tests use isolated storage and synthetic HTTP/MP3 fixtures. Actual MiniMax account
availability, cost, voice quality and live installed-client acceptance require a
separately authorized real generation; they are not inferred from these tests.

Executed checks and remaining live-acceptance limits are recorded in
[the 0.5.0 acceptance report](acceptance-audio-generation.md).
