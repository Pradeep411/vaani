# Vaani desktop for macOS: security and privacy notes

Version 0.1.0. Applies to the code in this folder.

## What leaves the Mac

Nothing from the native app. The only network traffic is the notes window
(WKWebView) loading `https://pradeep411.github.io/vaani/` and whatever that
web app already sends to the AI providers the user chose (with the user's own
keys, stored by the web app on this Mac). The native layer has no analytics,
no crash reporter, no update checker, no telemetry, and no `URLSession` or
socket code. CI fails the build if the binary references `URLSession`,
`NSURLConnection`, `CFNetwork` or `nw_connection` symbols.

## Permissions, every one

| Permission | Where it is declared | Prompt the user sees | Why Vaani needs it | Without it |
| --- | --- | --- | --- | --- |
| Microphone | `NSMicrophoneUsageDescription` in Info.plist; entitlement `com.apple.security.device.audio-input` (hardened runtime) | macOS: "Vaani" would like to access the microphone, with our text: "Vaani records your voice during calls so the Vaani web app can make your meeting notes. Audio stays on this Mac except what you send to the AI service you chose." | Records the user's side of the call. Asked the first time the user taps Take notes, not at launch. | No recording. Vaani says so in one line and offers to open System Settings. |
| System Audio Recording (Core Audio tap, macOS 14.2+) | `NSAudioCaptureUsageDescription` in Info.plist | macOS asks to let Vaani record the computer's audio, with our text: "Vaani records the sound of your call app so your notes include the other people on the call. Vaani does not record your screen." Exact system wording varies by macOS version. It appears the first time a tap starts. Afterwards it is listed in System Settings, Privacy and Security, Screen and System Audio Recording, under "System Audio Recording Only". | Records the other people on the call, from the call app's process only (plus its helper processes), unmuted so the user still hears the call. | Vaani records the mic only and says so in one line. |
| Screen Recording | not requested | none | Not needed. Core Audio taps capture audio without ScreenCaptureKit. | |
| Detect which app uses the mic | no permission | none | Core Audio process objects (`kAudioHardwarePropertyProcessObjectList`, `kAudioProcessPropertyIsRunningInput`, `kAudioProcessPropertyBundleID`) are readable by any app. Vaani reads only: process ID, bundle ID, and "is using mic / speaker" flags. No window titles, no URLs, no screen content. | |
| Calendar, Contacts, Camera, Location, Accessibility, Automation (Apple Events), Input Monitoring | not requested | none | Not needed. Detection does not use the calendar. The web view is never given the camera. | |
| Open at login | `SMAppService.mainApp` (only when the user ticks "Open at login") | macOS may show a "Login item added" notification | Lets detection run after restart. | Vaani runs only when opened. |

Mic access inside the notes window (the web app's own dictation) is granted
only to the top frame of `https://pradeep411.github.io/vaani/`; camera is
always denied (`requestMediaCapturePermissionFor` in
`VaaniWindowController.swift`).

## Entitlements (hardened runtime)

`Resources/Vaani.entitlements` contains exactly one key:
`com.apple.security.device.audio-input`. No JIT, no unsigned executable
memory, no `disable-library-validation`, no `allow-dyld-environment-variables`,
no Apple Events, no camera. `scripts/build-app.sh` fails if the signed app has
any other `com.apple.*` entitlement.

App Sandbox is **not** enabled in 0.1.0. Reason: Core Audio process taps and
the process-object list have not been verified inside the sandbox, and this
build is not for the Mac App Store. Turning the sandbox on (with
`com.apple.security.network.client` for the web view and
`com.apple.security.files.user-selected.read-write` for the Save panel) is a
follow-up once a signed build can be tested on a real Mac.

## Audio data handling

- Mic and tap audio live only in memory: a small mixer queue (capped at 30 s
  per source) and the bridge replay buffer (capped at 30 minutes, about 58 MB).
- Nothing is written to disk by the native app. No temp files.
- The replay buffer is wiped when the web app says `session.done`, 10 minutes
  after recording stops, when a new recording starts, and on quit.
- The tap is private (`isPrivate`) and the aggregate device is private, so no
  other app can see or open them. Both are destroyed on stop.
- The web view uses the default WebKit data store
  (`~/Library/WebKit/io.github.pradeep411.vaani.desktop/`), separate from
  Safari. That is where the web app's on-device keys and notes live, exactly
  as they do in a browser profile.

## Web view hardening

- Locked to one origin and path (`NavigationPolicy.isAllowedPage`): https only,
  host `pradeep411.github.io`, default port, no user info, path `/vaani` or under
  `/vaani/`, dot segments and encoded `.`/`/`/`\` rejected. Unit tested with
  look-alike hosts, userinfo tricks, other repos on the same host, and
  traversal attempts (`BridgeTests`).
- Other sites: user-clicked links open in the default browser; everything else
  (script redirects, iframes, popups, `file:`, `javascript:`, `data:`) is
  cancelled. Top-frame responses from other origins (server redirects) are
  cancelled too.
- No second web view is ever created (`createWebViewWith` returns nil).
- `javaScriptCanOpenWindowsAutomatically = false`; fraudulent-site warning on;
  Web Inspector stays off (WebKit default for release apps).
- Bridge messages are checked for frame, origin, page URL, size (8 KB),
  version, type and session ID format before use; unknown types are dropped.
  Outbound data is passed as a typed `callAsyncJavaScript` argument, never
  concatenated into script source.
- If the WebContent process crashes, the page is reloaded from the fixed URL
  and must handshake again.

Residual risk: anything that can run script in the real Vaani page (for
example a compromised GitHub Pages deploy or a malicious dependency of the
web app) could receive call audio while a recording is running. That page
already handles the same audio in the browser today, so the trust boundary
does not move. Keep the web app's own CSP and dependency hygiene in place.

## Detection privacy

Vaani polls the Core Audio process list once a second. It keeps only the
current list in memory. It never logs which apps used the mic. The prompt
appears only after a call app holds the mic for 3 s (20 s for other apps),
never for ignored apps (dictation tools, Siri, Voice Memos, Vaani), never
during a recording, never again for a call the user said "Not now" to, and
not for 60 s after a recording ends.

## Build, signing and CI

- No third-party Swift packages. No CocoaPods. No downloaded binaries in the
  app. Only Apple frameworks: AppKit, SwiftUI, WebKit, AVFoundation,
  CoreAudio, ServiceManagement, Foundation.
- CI (`.github/workflows/desktop-mac.yml`): `permissions: contents: read`;
  actions pinned to full commit SHAs (checkout v4.2.2, upload-artifact v4.6.2);
  `persist-credentials: false`; no `pull_request_target`.
- The unsigned build is ad-hoc signed with the hardened runtime so it can run
  on Apple Silicon. Gatekeeper will still warn because it is not notarized.
- The optional signing job runs only when all six signing secrets exist, never
  on pull requests. Secrets are passed through step `env`, never inlined into
  scripts. The certificate goes into a temporary keychain with a random
  password, which is deleted at the end (`if: always()`); key files are
  removed right after use. This repository's code never creates, stores or
  prints credentials.
- No auto-update in 0.1.0. A future updater must verify signatures
  (for example Sparkle with EdDSA) before it ships.

## Known limitations to verify on a real Mac

1. Exact wording of the System Audio Recording prompt (varies by macOS).
2. Whether the tap buffer is always the last input buffer of the aggregate
   device when the output device also has inputs (USB headsets).
3. FaceTime and some browsers play call audio from a system or helper
   process. Vaani taps helpers by bundle prefix and falls back to "all Mac
   sound except Vaani" for FaceTime, and automatically if the app-only tap
   stays silent while the app plays sound.
4. With an ad-hoc signature, macOS ties permissions to this exact build, so
   each new unsigned build asks for permissions again. A Developer ID build
   keeps them.
5. A denied System Audio Recording permission produces silence, not an error
   (Apple gives no API to check it). Vaani detects 10 s of digital silence
   while the call app plays sound and shows one line.
