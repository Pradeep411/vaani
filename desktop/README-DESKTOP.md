# Vaani for Mac (first version, 0.1.0)

Vaani sits in your menu bar. When any call starts on your Mac (Zoom, Teams,
WhatsApp, FaceTime, Slack huddle, Webex, or Google Meet in any browser), a
small bar appears at the top of the screen:

> **Meeting detected · Zoom**
> Take notes with Vaani?  [Not now] [Take notes]

Tap **Take notes** and Vaani records your voice and the call app's sound, and
the Vaani web app (the same one at pradeep411.github.io/vaani) makes the
notes. It does not need the call to be on your calendar. It never asks to
record your screen.

Needs: a Mac with macOS 14.2 (Sonoma) or later. Built for Apple Silicon
(M1, M2, M3, M4).

**Important for this first build:** the web app still has to add the small
"desktop bridge" described in `WEB-BRIDGE-SPEC.md`. Until it does, the Mac app
detects calls and records, but the notes window will not receive the audio.
The menu bar will say "The Vaani web app has not connected yet."

## Install (unsigned test build)

This build is not signed by Apple yet, so macOS asks you to confirm once.

1. Only install a build from the **main** branch, never from a pull request
   and never just "the latest run". On GitHub: **Actions**, **Desktop macOS**,
   set the **Branch** filter to `main` and **Event** to `push`, open the run
   whose commit matches the one you were told about, and download
   `Vaani-macOS-unsigned-macos-15` under Artifacts. (When releases exist, use
   the file attached to the GitHub Release instead.) Check the `.sha256` file
   next to it matches the one you were given. Unzip it until you see
   **Vaani.app**.
   Do not install the `NOSANDBOX-diagnostic` file; it is only for testing.
2. Drag **Vaani.app** into your **Applications** folder.
3. Open it:
   - **macOS 15 (Sequoia) or later:** double-click Vaani. macOS says it
     cannot check it. Click **Done**. Open **System Settings**, then
     **Privacy & Security**, scroll down to the line about Vaani, and click
     **Open Anyway**. Type your Mac password, then click **Open**.
   - **macOS 14 (Sonoma):** right-click (or Control-click) Vaani, choose
     **Open**, then click **Open** again.
4. A small wave icon appears in the menu bar at the top right. That is Vaani.

If macOS says the app "is damaged", the download was flagged. Open Terminal
and paste this one line, then try step 3 again:

```
xattr -dr com.apple.quarantine /Applications/Vaani.app
```

Your notes window starts empty the first time: Vaani for Mac keeps its own
private copy of the web app's settings and keys (macOS keeps it apart from
other apps), so add your AI key again inside the Vaani window.

## The two permission prompts

You see each one once, the first time you tap **Take notes**.

1. **Microphone.** macOS asks if Vaani can use the microphone. Click
   **Allow**. This records your side of the call.
2. **System audio recording.** macOS asks if Vaani can record the
   computer's audio. Click **Allow**. This lets Vaani record the other people
   on the call. You still hear the call normally. This is not screen
   recording, and Vaani never sees your screen.

What Vaani records with that permission:
- Normally, only the call app's own sound (Zoom, Teams, Chrome for Meet, and
  so on).
- **All Mac sound** in these cases, and Vaani always tells you first:
  FaceTime calls, or a call app whose own sound Vaani cannot find (the bar
  says "Records your mic and all Mac sound"), **Take notes now** with no call app on the mic (the
  menu item says "with all Mac sound"), or when you turn on **Record all Mac
  sound** in settings. If Vaani cannot hear the call app at all, it asks
  "Record all Mac sound for this call?" and does nothing until you choose.
  No answer means mic only.

If you said no by mistake: **System Settings**, **Privacy & Security**, then
**Microphone** (turn Vaani on), or **Screen & System Audio Recording**, under
**System Audio Recording Only** (turn Vaani on). If system audio is off,
Vaani still records your mic and tells you so in one line.

Note: because this test build is unsigned, macOS forgets these choices each
time you install a new build. The signed version will remember them.

## Everyday use

- **Take notes:** tap it on the bar when a call starts.
- **Not now:** hides the bar for this call only. The next call asks again.
- **Stop:** click the menu-bar icon (red dot while recording), then
  **Stop taking notes**. The notes window title also says "Vaani, taking notes".
- **Stops by itself:** one minute after the call app lets go of the
  microphone (the call ended). If you are muted and your call app closes the
  mic, Vaani keeps going for up to 5 minutes while the app still plays the
  call. After 2 hours on a call (every hour for **Take notes now**), the bar
  asks **Still taking notes?**; if you do not answer within 2 minutes, Vaani
  stops.
- **Take notes now:** from the menu bar, if you missed the bar.
- **Open Vaani:** shows the notes window. Closing the window stops the page
  using the microphone; if no call is being delivered, the page is unloaded.
- The red menu-bar dot also shows whenever the notes page itself uses your
  microphone (for example its own dictation, which asks you first).

### Google sign-in (calendar) does not work inside the Mac window

In this first version, Google sign-in from the web app does not work inside
the Vaani for Mac window: the app does not allow Google's sign-in frames and
pop-ups. Clicking it opens Google in your normal browser, but that does not
sign in the Mac window. For calendar features, use
https://pradeep411.github.io/vaani in your browser. Meeting detection on the
Mac does not need the calendar.

## Turn detection off

- **Off for everything:** click the menu-bar icon and untick
  **Detect calls automatically**.
- **Off for one app:** menu-bar icon, **Ignored apps…**, **Add app…**, pick
  the app. Dictation tools (Wispr Flow, Superwhisper, MacWhisper), Siri and
  macOS Dictation, and Voice Memos are ignored from the start.
- **Stop Vaani completely:** menu-bar icon, **Quit Vaani**. Untick
  **Open at login** if you turned it on.

## Privacy in one paragraph

Vaani's Mac app sends nothing anywhere itself. It loads the Vaani web page,
and the web page sends audio only to the AI service you chose with your own
key, the same as in the browser. The Mac app's notes window also uses
Apple's Safe Browsing check, like Safari. Audio is kept in memory only, never
saved to disk by the Mac app, and released once your notes are made (or 10
minutes after the call, or when you quit); the web page keeps its own copy as
it does in a browser. The Mac app has no analytics. The web app's optional
usage stats work as in the browser (off unless you opt in). No automatic
updates. Details: `SECURITY-NOTES.md`.

---

## Checks on a real Mac (before calling this done)

These cannot be tested in CI. Tick each on the owner's Mac, with the normal
(sandboxed) build first:

- [ ] Vaani starts and the menu-bar icon appears (sandbox on).
- [ ] Zoom app call: bar says "Meeting detected · Zoom" within about 3 s.
      If no bar ever appears in the sandboxed build but it does in the
      `NOSANDBOX-diagnostic` build, the sandbox hides the Core Audio process
      list: report it.
- [ ] Microsoft Teams (new): "Meeting detected · Microsoft Teams".
- [ ] WhatsApp voice or video call: "Call detected · WhatsApp".
- [ ] FaceTime: "Call detected · FaceTime" with "Records your mic and all Mac
      sound". If it names a different app, write that name down for the
      developer (its ID goes in `AppCatalog.swift`).
- [ ] Slack huddle: "Huddle detected · Slack".
- [ ] Google Meet in Chrome, Safari, Arc, Edge, Brave, Firefox: "Meeting detected · <browser>".
- [ ] Bar never takes focus from the call window; shows over a full-screen call.
- [ ] Wispr Flow / Superwhisper / Siri dictation: no bar.
- [ ] Not now: no bar again for the same call; a new call asks again.
- [ ] Take notes: both permission prompts appear once; call audio still audible.
- [ ] The other side is recorded with the sandboxed build (if it is silent
      only when sandboxed, the tap does not work in the sandbox: report it).
- [ ] Mute yourself in Zoom for 10 minutes: recording keeps going.
- [ ] Leave a Meet call but keep a YouTube tab playing: recording stops about
      a minute after leaving.
- [ ] Leave the call: recording stops about a minute later; no bar for 60 s.
- [ ] Switch from speakers to AirPods mid-call: other side still recorded.
- [ ] Deny System Audio Recording: Vaani asks "Record all Mac sound for this
      call?"; "Mic only" gives one line "Recording your mic only for this call."
- [ ] Notes window: a page `alert()` shows as a sheet; export notes opens a
      Save sheet; scripted links do not open the browser, clicked ones do.
- [ ] Close the notes window while not recording: macOS's orange mic dot is
      off and the menu shows no page-mic line.
- [ ] VoiceOver on: the bar is announced; both buttons are labelled.
- [ ] Reduce Motion on: the bar fades in without sliding.

## For developers

```
cd desktop
swift test                    # pure-Swift logic (also runs on Linux)
bash scripts/build-app.sh     # macOS: build/Vaani.app + build/Vaani-macOS-arm64.zip (sandbox on)
SANDBOX=0 bash scripts/build-app.sh   # diagnostic only: build-nosandbox/...
node --test web-bridge/vaani-desktop-bridge.test.mjs
```

Layout:

| Path | What |
| --- | --- |
| `Sources/VaaniCore/` | Pure Swift, no Apple-only frameworks: detector state machine, app catalog and ignore list, settings, resampler and mixer, PCM, bridge protocol, URL policy, tap planning, text cleaning, open and reload limits. Portable to the Windows phase. |
| `Sources/Vaani/` | macOS app (all files inside `#if os(macOS)`): Core Audio process list, mic and system-audio tap capture, pill, menu bar, notes window, settings window. |
| `Tests/VaaniCoreTests/` | 75 unit tests, including regression tests for every finding in the security audit. |
| `Resources/` | Info.plist, entitlements (sandboxed, and the diagnostic one), and `vaani-userscript.js`, the bridge's document-start script (also run by the Node tests). |
| `web-bridge/` | Reference JS module for the web app, plus Node tests. |
| `.github/workflows/desktop-mac.yml` | CI. Move to the repo root `.github/workflows/` when this folder lands as `desktop/`. |

How detection works:

- Once a second Vaani reads the Core Audio process list
  (`kAudioHardwarePropertyProcessObjectList`) and, per process,
  `kAudioProcessPropertyIsRunningInput`, `IsRunningOutput`, `PID` and
  `BundleID`. That tells it *which* app holds the mic, the same signal Granola
  uses ("By detecting that your microphone is in use, Granola will prompt
  you"). Fallback if that list is unavailable:
  `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input.
- Helper processes are grouped with their app by bundle-ID prefix
  (`com.google.Chrome.helper` is Chrome). Safari's mic runs in the shared
  `com.apple.WebKit.GPU` process, shown as Safari; only the GPU process that
  holds the call's mic is tapped.
- Known call apps prompt after 3 s, other apps after 20 s. A call counts as
  the same call until the app lets go of the mic for 15 s.
- Auto-stop: 60 s after the call app last used the mic. Speaker use keeps a
  native call app "on" for at most 5 minutes after its last mic use; it never
  counts for browsers. Long sessions get "Still taking notes?" (2 h for calls,
  1 h for Take notes now or unknown apps) and stop if unanswered for 2 min.
- System audio uses a Core Audio process tap (`CATapDescription`, unmuted,
  private) on the call app's processes inside a private aggregate device,
  as in Apple's sample. All-Mac-sound taps exclude Vaani and are only used
  when the user was told first or chose it.

Sources:

- Granola notifications: https://docs.granola.ai/help-center/taking-notes/notifications
- Apple, Capturing system audio with Core Audio taps (macOS 14.2+, `NSAudioCaptureUsageDescription`, permission prompt on first start): https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
- Process-object detection in practice (side-huddle): https://docs.rs/crate/side-huddle/0.2.1/source/src/platform/darwin/detect.rs
- `kAudioDevicePropertyDeviceIsRunningSomewhere` misreports some Bluetooth mics: https://developer.apple.com/forums/thread/741026
- AudioCap sample (tap + aggregate device pattern, no public permission-check API): https://github.com/insidegui/AudioCap
- Silent taps when permission is off, start-mic-first advice: https://dev.to/nickdelv/2000-buffers-of-nothing-3i8
- Helper processes and output-device changes: https://dev.to/thalesbmc/macos-still-has-no-volume-mixer-so-i-built-one-53lp
- No API to query System Audio Recording permission: https://developer.apple.com/forums/thread/771864
