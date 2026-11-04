# Vaani desktop for macOS: security and privacy notes

Version 0.1.0, after the fixes for `SECURITY-AUDIT-desktop-v1.md`
(H-01, M-01 to M-04, L-01 to L-08) and its re-audits (D-01, N-02 to N-06,
F-01).
Applies to the code in this folder.

## What leaves the Mac

Nothing is sent by the native code itself. Network traffic comes from the
notes window (WKWebView): loading `https://pradeep411.github.io/vaani/`,
whatever that web app already sends to the AI providers the user chose (with
the user's own keys), and WebKit's Safe Browsing lookups (the fraudulent-site
warning is on, as in Safari). The native layer has no analytics, no crash
reporter, no update checker, no telemetry, and no `URLSession` or socket
code. CI fails the build if the binary references `URLSession`,
`NSURLConnection`, `CFNetwork` or `nw_connection` symbols. The web app's own
optional usage stats (Firebase, off unless the user opts in) work as in the
browser.

## Permissions, every one

| Permission | Where it is declared | Prompt the user sees | Why Vaani needs it | Without it |
| --- | --- | --- | --- | --- |
| Microphone | `NSMicrophoneUsageDescription` in Info.plist; entitlement `com.apple.security.device.audio-input` | macOS: "Vaani" would like to access the microphone, with our text: "Vaani records your voice during calls so the Vaani web app can make your meeting notes. Audio stays on this Mac except what you send to the AI service you chose." | Records the user's side of the call. Asked the first time the user taps Take notes, not at launch. | No recording. Vaani says so in one line and offers to open System Settings. |
| System Audio Recording (Core Audio tap, macOS 14.2+) | `NSAudioCaptureUsageDescription` in Info.plist | macOS asks to let Vaani record the computer's audio, with our text: "Vaani records the sound of your call app so your notes include the other people on the call. For some calls, or when you choose it, Vaani records all Mac sound instead and tells you first. Vaani does not record your screen." Exact system wording varies by macOS version. It appears the first time a tap starts, and is then listed under System Settings, Privacy and Security, Screen and System Audio Recording, "System Audio Recording Only". | Records the other people on the call. | Vaani records the mic only and says so in one line. |
| Microphone inside the notes page (web app dictation) | WebKit, `requestMediaCapturePermissionFor` returns `.prompt` | WebKit's standard sheet asking whether pradeep411.github.io may use the microphone | The web app's own dictation feature. Only for the top frame of the allowed page, only while the notes window is on screen (shown, not minimised, Vaani not hidden). If the page holds the mic while the window is not on screen (WebKit may reuse an earlier grant), Vaani turns the page's capture off at once. Camera is always denied. | Web dictation unavailable in the Mac window. |
| Screen Recording | not requested | none | Not needed. Core Audio taps capture audio without ScreenCaptureKit. | |
| Detect which app uses the mic | no permission | none | Core Audio process objects. Vaani reads process ID, bundle ID and "using mic / speaker" flags; it also looks up that app's name and icon from the app bundle on disk to show in the pill. For the call being recorded, the cleaned app name and bundle ID are sent to the notes page (`source.app`, `source.bundleId`), so they can end up in notes and with the user's AI provider. No window titles, no URLs, no screen content. | |
| Calendar, Contacts, Camera, Location, Accessibility, Automation (Apple Events), Input Monitoring | not requested | none | Not needed. | |
| Open at login | `SMAppService.mainApp` (only when the user ticks "Open at login") | macOS may show a "Login item added" notification | Lets detection run after restart. | Vaani runs only when opened. |

## What gets recorded, and for how long (H-01, M-01)

- **Scope.** By default the tap covers only the call app's processes (and its
  helpers). A shared WebKit GPU process is included only if it is the one
  holding the call's mic, so a Safari call does not tap Mail or other apps'
  web views. All Mac sound (minus Vaani's own process) is used only when the
  user was told before recording (FaceTime, a call app whose sound cannot be
  found, "Take notes now" with no call app on the mic, or the "Record all Mac
  sound" setting; the pill or menu item says so), or when the user answered
  "Record all sound" to "Vaani cannot hear <app> directly". That question is
  asked only if the app-only tap has never delivered a single non-zero sample
  this session; no answer within 60 s means mic only. The page is told the
  scope: `capture` is `mic+app`, `mic+system` or `mic-only`, plus a notice.
- **Promise kept (re-audit N-05).** The scope the pill or menu item showed is
  passed to the recorder. If, when recording starts, the plan has become
  all Mac sound but the user was promised the call app only (for example the
  call's process changed in between), recording starts with the mic only and
  the "Record all Mac sound for this call?" question is asked first.
- **Length.** Recording stops 60 s after the call app last used the mic.
  Speaker use counts only for native call apps and only up to 5 minutes after
  the last mic use; for browsers it never counts. Every call session gets
  "Still taking notes?" after 2 hours (setting, 30 min to 4 h); "Take notes
  now" and sessions where the app cannot tell which app holds the mic get it
  every hour. No answer within 2 minutes stops the recording (reason
  `no-answer`). In fallback mode Vaani's own mic use no longer counts as the
  other app being on a call.

## Entitlements and App Sandbox (M-04)

The default build (`Resources/Vaani.entitlements`) is sandboxed and has
exactly these keys; `scripts/build-app.sh` fails on any difference:

| Key | Why |
| --- | --- |
| `com.apple.security.app-sandbox` | Contains the app. The web app's keys (localStorage) and notes (IndexedDB) live in `~/Library/Containers/io.github.pradeep411.vaani.desktop/`, which macOS 14+ protects from other apps. |
| `com.apple.security.device.audio-input` | Microphone (sandbox and hardened runtime share this key). |
| `com.apple.security.network.client` | The notes web view loads the Vaani page and the page talks to the user's providers. |
| `com.apple.security.files.user-selected.read-write` | Save panel (notes export), Open panel (file import, "Add app" in Ignored apps). |

Hardened runtime is on. No JIT, no unsigned executable memory, no
`disable-library-validation`, no `allow-dyld-environment-variables`, no Apple
Events, no camera.

**Must be verified on a Mac** (cannot be tested in CI): that the Core Audio
process list and the process tap with a private aggregate device both work
inside the sandbox. If the sandbox does block them, the fix goes in code (or
a documented temporary exception), never by shipping the diagnostic build.
Existing web data does not move into the container: the first sandboxed
launch starts with an empty notes window.

**The diagnostic build (re-audit D-01).** `SANDBOX=0` makes a separate,
test-only app used only to tell "the sandbox blocks taps or the process
list" apart from other faults on a test Mac:
- different bundle ID `io.github.pradeep411.vaani.desktop.diagnostic`, name
  and display name "Vaani DIAGNOSTIC", bundle `Vaani-DIAGNOSTIC-no-sandbox.app`,
  and an Info.plist key `VaaniDiagnosticBuild = true`, so it never replaces
  or impersonates Vaani;
- at runtime (key set, or no `APP_SANDBOX_CONTAINER_ID`, which fails safe):
  menu line and window title "Diagnostic build, sandbox off, not for daily
  use." / "Vaani DIAGNOSTIC: sandbox off, test only", "Open at login" not
  offered (and unregistered if found), and a non-persistent web data store,
  so no keys or notes are ever stored outside the sandbox;
- entitlements exactly `device.audio-input`;
- `build-app.sh` accepts only `SANDBOX=1` or `SANDBOX=0` (anything else
  fails) and refuses to sign `SANDBOX=0` with any real identity; the signing
  job builds with `SANDBOX=1` and refuses a bundle carrying the diagnostic key;
- CI builds and uploads it only on a manual run with "diagnostic" ticked,
  never on push.

## Audio data handling

- Mic and tap audio live only in memory: a small mixer queue (capped at 30 s
  per source) and the bridge replay buffer (capped at 30 minutes, about 58 MB).
- Nothing is written to disk by the native app. No temp files.
- The replay buffer is released (memory freed, not overwritten) when the web
  app says `session.done`, 10 minutes after recording stops, when a new
  recording starts, and on quit. The web page keeps its own copy, as it does
  in a browser.
- The tap is private (`isPrivate`) and the aggregate device is private, so no
  other app can see or open them. Both are destroyed on stop.
- Both drain and detection timers run in the run loop's common modes, so
  audio keeps draining and auto-stop keeps working while a menu is open or a
  panel is up; page alerts, confirms and file panels are sheets on the notes
  window (L-01).

## Web view hardening

- Locked to one origin and path (`NavigationPolicy.isAllowedPage`): https only,
  host `pradeep411.github.io`, default port, no user info, path `/vaani` or under
  `/vaani/`, dot segments and encoded `.`/`/`/`\` rejected. Unit tested with
  look-alike hosts, userinfo tricks, other repos on the same host, and
  traversal attempts.
- `about:blank` and `about:srcdoc` are allowed for iframes only; the top page
  can never be blanked (L-04).
- Other sites: a link opens in the default browser only after a real mouse
  click in the key notes window within the last second, at most one per
  second (scripted `a.click()` reports a link click too, so the click is
  checked natively). Script redirects, other-origin iframes, `file:`,
  `javascript:`, `data:`, custom schemes and anything else are cancelled.
  Top-frame responses from other origins (server redirects) are cancelled too.
- No second web view is ever created (`createWebViewWith` returns nil);
  `window.open` follows the same click rule.
- `javaScriptCanOpenWindowsAutomatically = false`; fraudulent-site warning on;
  Web Inspector stays off (WebKit default for release apps).
- Page microphone: prompted, only while the window is on screen; closing or
  minimising the window, or hiding Vaani, sets the page's capture state to
  none, and so does any capture-state change while not on screen (N-04).
  With no session to deliver, a closed page is unloaded (delegates and
  handlers removed); a page kept loaded to deliver a session is unloaded once
  that session is released (at the latest 10 minutes after it stops). The
  menu-bar icon turns red and the menu says "The Vaani notes window is using
  your microphone" whenever the page holds the mic (M-02).
- If the WebContent process crashes, the page reloads after 1 s, 5 s, then
  30 s; a fourth crash within 2 minutes stops reloading and shows a menu line
  (L-02).

## The bridge

- One message handler (`vaaniDesktop`), page world, top frame only. Inbound
  messages are checked for frame, origin, page URL, size (8 KB), version,
  type and session ID format; every type except `ready` (`stop`, `resume`,
  `session.done`) must also carry the per-load nonce from `hello` (new nonce
  on every page load); native refuses them without it (L-05, N-02).
- The nonce stays inside the user script's closure (N-02): it is taken out of
  `hello` before delivery and added back only by the one-time, frozen
  `post()` capability that `connect()` returns. That capability uses
  `Reflect.apply`, `Object.defineProperty` and the handler's `postMessage`
  captured at document start, and messages are delivered as null-prototype
  copies, so prototype getters, setters and a later-patched `postMessage`
  do not see the nonce. The reference module captures `atob` and
  `String.prototype.charCodeAt` when it loads.
- Only the app can deliver (F-01). Native writes a fresh random token (32
  hex characters, per web view) into the user script before injecting it and
  passes the same token as a `callAsyncJavaScript` argument on every
  delivery. `_deliver(msg, token)` ignores any call without it. The token is
  never in a page global or in the dispatch script's text, so a script
  already in the page cannot forge `hello` (to overwrite the nonce), fake
  audio, or fake a `session.stop`. If the placeholder is not replaced, the
  user script defines nothing and the bridge stays closed.
- Outbound: one fixed script through `callAsyncJavaScript` with the message as
  a typed argument, never concatenated into script source. It calls
  `window.__VAANI_DESKTOP__._deliver(msg, token)`, which hands the message to the
  single callback registered with `connect()`. The first caller wins and the
  slot locks. The defining script (`Resources/vaani-userscript.js`) runs at
  document start, only on the allowed origin and path, top frame, and the
  object is frozen and non-writable.
- `connect()` sends `ready` itself, and `_deliver` reports whether a
  listener took the message. If `hello` reaches nobody (another script sent
  `ready` before the web app connected), native resets the handshake so the
  web app's own `ready` is honoured (N-03).
- What this does and does not protect: the lock, the sealed nonce and the
  delivery token stop passive listeners, stray scripts, forged `stop` /
  `session.done` / `resume` messages, and fake deliveries into the page.
  They do **not** stop a script in the page from reading audio the web app
  processes: any script, even one that loads after the bridge module, can
  patch a global the web app's code uses on that audio (for example a String
  or typed-array method, or the web app's own functions) and see it. The
  reference module closes the two hooks it knows it uses (`atob`,
  `charCodeAt`) by capturing them at load; everything the rest of the web app
  does with the audio stays hookable. So: import the bridge module before any
  third-party script, keep third-party scripts off the page where possible,
  and treat any script on the page as able to hear a recording in progress.
- Catch-up after a page (re)load is batched (200 chunks per tick), one at a
  time; repeated `ready` from the same load is ignored and `ready`/`resume`
  are rate-limited to one per 5 s (L-02). `session.start` carries `firstSeq`;
  a `resume` from before the oldest kept chunk gets a `gap` notice (L-03).
- App names and bundle IDs are untrusted local text: control, format (bidi)
  and separator characters are stripped and names capped at 64 characters
  before use; the page must still render them with `textContent` (L-06).

Residual risk: anything that can run script in the real Vaani page before the
bridge connects (for example a compromised GitHub Pages deploy) could receive
call audio while a recording runs. That page already handles the same audio
in the browser, so the trust boundary does not move. Keep the web app's own
CSP and dependency hygiene in place.

## Detection privacy

Vaani polls the Core Audio process list once a second. It keeps only the
current list in memory and never logs which apps used the mic. The prompt
appears only after a call app holds the mic for 3 s (20 s for other apps),
never for ignored apps (dictation tools, Siri, Voice Memos, Vaani), never
during a recording, never again for a call the user said "Not now" to, and
not for 60 s after a recording ends. The pill has no keyboard default button,
so a stray Return cannot start a recording.

## Build, signing and CI

- No third-party Swift packages. No CocoaPods. No downloaded binaries in the
  app. Only Apple frameworks: AppKit, SwiftUI, WebKit, AVFoundation,
  CoreAudio, ServiceManagement, Foundation.
- CI (`.github/workflows/desktop-mac.yml`): `permissions: contents: read`;
  actions pinned to full commit SHAs (checkout v4.2.2, upload-artifact v4.6.2);
  `persist-credentials: false`; no `pull_request_target`.
- Pull-request runs build and test but upload no app (M-03). Only push and
  manual runs upload `Vaani-macOS-unsigned-<os>` with a `.sha256`. The
  README tells the owner to install only main-branch push builds (or a
  GitHub Release). Repository setting to turn on: require approval for
  workflow runs from all outside contributors.
- The unsigned build is ad-hoc signed with the hardened runtime so it can run
  on Apple Silicon. Gatekeeper will still warn because it is not notarized.
- The signing job runs only on a push to `main` or a `desktop-v*` tag, in the
  GitHub Environment `release` (L-07). That protection exists only after the
  owner sets it up: GitHub creates a named environment with no rules the
  first time a workflow uses it, and repository-level secrets stay readable
  from any branch. `OWNER-SETUP.md` lists the exact steps (required
  reviewer, deployment rules for `main` and `desktop-v*`, a tag ruleset,
  outside-contributor approval, secrets only at environment level). No
  signing secret may be added before those steps are done (N-06). Secrets are passed
  through step `env`, never inlined into scripts. The certificate goes into a
  temporary keychain with a random password, deleted at the end
  (`if: always()`); key files are removed right after use. This code never
  creates, stores or prints credentials.
- No auto-update in 0.1.0. A future updater must verify signatures
  (for example Sparkle with EdDSA) before it ships.

## Known limitations to verify on a real Mac

1. Core Audio process list and process taps inside the App Sandbox (see above).
2. Exact wording of the System Audio Recording prompt (varies by macOS).
3. Whether the tap buffer is always the last input buffer of the aggregate
   device when the output device also has inputs (USB headsets).
4. Whether Vaani's own WebKit GPU/WebContent processes appear as Core Audio
   process objects. If they do, an all-Mac-sound tap would include the notes
   page's own sound (the page does not normally play audio); they would need
   excluding by process.
5. WebKit's navigation type for scripted clicks, and whether `getUserMedia`
   works in an ordered-out window (both now guarded natively anyway).
6. With an ad-hoc signature, macOS ties permissions to this exact build, so
   each new unsigned build asks for permissions again. A Developer ID build
   keeps them.
7. A denied System Audio Recording permission produces silence, not an error
   (Apple gives no API to check it). Vaani asks or shows one line after 10 s
   of digital silence while the target plays sound, never before.
