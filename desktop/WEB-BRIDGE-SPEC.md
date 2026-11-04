# Vaani desktop bridge, protocol v1

How the Vaani macOS app hands call audio to the Vaani web app. The web app
does all transcription and note making, exactly as today. The desktop app
only detects calls, records audio, and passes it in.

Reference code the web developer can drop in: `web-bridge/vaani-desktop-bridge.js`
(tests: `node --test web-bridge/vaani-desktop-bridge.test.mjs`, which also run
the app's real document-start script `Resources/vaani-userscript.js`).
Native side: `Sources/VaaniCore/Bridge.swift`, `BridgeSession.swift`,
`Sources/Vaani/VaaniWindowController.swift`.

## 1. Where it runs

| Item | Value |
| --- | --- |
| Page the app loads | `https://pradeep411.github.io/vaani/?src=desktop` |
| Allowed origin | exactly `https://pradeep411.github.io` (https, default port, no user info) |
| Allowed path | `/vaani` or anything under `/vaani/` (no `.`/`..` segments, no `%2e`, `%2f`, `%5c`) |
| Frames | top frame only, both directions |
| Defined before page scripts run | `window.__VAANI_DESKTOP__ = { protocol: 1, platform: 'macos', handler: 'vaaniDesktop', connect(cb), _deliver(msg) }` (frozen, non-writable, non-configurable; only on the allowed origin and path, top frame) |
| Page to native | `window.webkit.messageHandlers.vaaniDesktop.postMessage(obj)` |
| Native to page | native calls `__VAANI_DESKTOP__._deliver(msg)`, which passes `msg` to the **one** callback registered with `connect(cb)` |

`connect(cb)` returns `true` for the first caller and `false` for every later
one: the slot locks. **The web app must load the bridge module and call
`connect` before it loads any third-party script** (Google sign-in, Firebase,
analytics), so only Vaani's own code receives call audio.

The web app is "in desktop mode" only when all of these are true:
`location.origin === 'https://pradeep411.github.io'`, path starts with
`/vaani/`, `window.top === window`, `window.__VAANI_DESKTOP__?.protocol === 1`
with a `connect` function, and `window.webkit.messageHandlers.vaaniDesktop`
exists. `?src=desktop` is a hint only.

In desktop mode the web app should **not** call `getUserMedia` for meeting
notes; audio comes from the bridge. Its own dictation may still call it:
WebKit then shows its standard permission prompt, only while the notes window
is on screen; the camera is always denied.

Known limit in v1: Google sign-in (calendar) does not work inside the Mac
window (its frames are blocked and its pop-ups open in the default browser,
which does not sign in the Mac window). The web app should hide or explain
calendar sign-in in desktop mode and point to the browser version.

## 2. Native checks (already built)

1. Navigation: the top frame may only show the allowed page. A link to any
   other `https`, `http` or `mailto` URL opens in the default browser only
   after a real mouse click in the notes window within the last second, at
   most one per second; scripted clicks and redirects are cancelled. Iframes
   from any other origin are cancelled; `about:blank`/`about:srcdoc` are
   allowed for iframes only. `window.open` never makes a second web view.
   `file:`, `javascript:`, `data:`, custom schemes are refused. Server
   redirects of the top frame to another origin are cancelled at the
   response stage too.
2. Downloads (notes export via `a[download]` or blob links) are allowed only
   while the top page is the allowed page, and always go through a macOS
   Save sheet.
3. Inbound messages are dropped unless: the message comes from the top frame;
   the frame's security origin is `https` + `pradeep411.github.io` + port 0/443;
   the web view's current URL passes the path rule; the body is a JSON object
   of at most 8 KB with `v === 1` and a known `type`; `sessionId`, if present,
   matches `^[A-Za-z0-9-]{1,64}$`; and, for every type except `ready`,
   `nonce` equals the nonce sent in this page load's `hello`.
4. Outbound: before every send, native re-checks that the current page URL is
   the allowed page. Messages are passed as a typed argument to
   `callAsyncJavaScript` in the page world; no data is ever spliced into
   script text. The only script native runs is:
   `const b = window.__VAANI_DESKTOP__; return !!(b && b._deliver(msg));`
5. Catch-up is batched: at most 200 chunks per 250 ms tick, one catch-up at a
   time, live chunks queue behind it so order is kept. A repeated `ready` in
   the same page load is ignored; `ready` across reloads and `resume` are
   each honoured at most once per 5 s (later `ready` is deferred, not lost).

## 3. Messages

All messages carry `v: 1`. Unknown `type` values must be ignored by both
sides (forward compatible). Field order does not matter.

### Page to native

| type | fields | when | native does |
| --- | --- | --- | --- |
| `ready` | `protocol: 1` (no nonce needed) | once per page load, after `connect` | sends `hello` (with this load's `nonce`); if a session exists, `session.start` (with `firstSeq`), any `capture.notice`, then every kept `audio.chunk` from `firstSeq` in batches, then `session.stop` if it has ended |
| `resume` | `sessionId`, `fromSeq` (int, 0 or more), `nonce` | the page saw a gap in `seq` | re-sends kept chunks with `seq >= fromSeq`, then `session.stop` if ended. If `fromSeq` is older than the oldest kept chunk, first sends `capture.notice` code `gap` with `firstSeq` |
| `stop` | `sessionId` (optional), `nonce` | the user pressed Stop in the web app | stops recording (same as the menu-bar Stop) if the id matches or is absent |
| `session.done` | `sessionId`, `nonce` | notes for that session are saved | releases its in-memory copy of the audio. Only honoured after `session.stop` |

```js
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'ready', protocol: 1 });
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'resume', sessionId, fromSeq: 12, nonce });
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'stop', sessionId, nonce });
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'session.done', sessionId, nonce });
```

### Native to page

```js
// After "ready" (once per page load)
{ v: 1, type: 'hello', protocol: 1, platform: 'macos', nativeVersion: '0.1.0', nonce: '<per page load>',
  audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, chunkMs: 250 } }

// A recording started (user tapped "Take notes", or "Take notes now")
{ v: 1, type: 'session.start', sessionId: 'UUID', startedAt: '2026-11-04T10:15:00.000Z',
  source: { app: 'Zoom', bundleId: 'us.zoom.xos', kind: 'meeting' },   // kind: meeting | call | huddle | browser | other
  capture: 'mic+app',          // 'mic+app' | 'mic+system' (all Mac sound) | 'mic-only'
  firstSeq: 0,                 // oldest chunk still kept; above 0 if the page joined late
  audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, chunkMs: 250 },
  notice: '...' }              // present when capture is degraded or system-wide

// Every 250 ms while recording (last chunk of a session may be shorter)
{ v: 1, type: 'audio.chunk', sessionId: 'UUID', seq: 0, frames: 4000, data: '<base64 PCM s16le>' }

// One plain line for the user (show it once, calmly)
{ v: 1, type: 'capture.notice', sessionId: 'UUID', code: 'tap-unavailable', message: '...' }
//   code: tap-unavailable  system audio could not be recorded, mic only
//         tap-silent       the all-sound tap has heard nothing; permission may be off
//         mic-denied       microphone permission is off
//         system-wide      recording all Mac sound for this session (told first or chosen)
//         mic-only         the user chose mic only for this session
//         gap              audio before `firstSeq` is gone; carries `firstSeq`

// Recording ended
{ v: 1, type: 'session.stop', sessionId: 'UUID', reason: 'user', lastSeq: 239, totalFrames: 958000 }
//   reason: user | call-ended | web-requested | no-answer | error | quit
//   no-answer: "Still taking notes?" (after 2 h, or every hour for manual sessions) was not answered
```

Audio format: 16,000 Hz, 1 channel, signed 16-bit little-endian PCM, base64.
It is the user's mic and the call app's sound mixed together (all Mac sound
when `capture` is `mic+system`; the mic alone when `mic-only`). This is the
format Sarvam and most speech-to-text APIs accept as WAV; `encodeWav()` in
the reference module builds the file.

## 4. Sequence

```
page loads ──► connect(cb), postMessage ready ─► native: hello {nonce}
                                                 (if a session is live:
                                                  session.start {firstSeq}, notices,
                                                  kept chunks in batches, stop)
user taps "Take notes" in the pill ───────────► native: session.start
                                                 audio.chunk seq 0,1,2... every 250 ms
page sees seq jump 7 -> 9 ─► resume {fromSeq 8, nonce} ► native: chunks 8, 9, ...
call app off the mic for 60 s, Stop, or no answer to "Still taking notes?"
                                              ─► native: session.stop
page saves notes ─► session.done {nonce} ─────► native releases its audio copy
```

Rules for the page:

- Load the module and call `connect` before any third-party script.
- Echo the `nonce` from `hello` on every message except `ready` (the
  reference module does this).
- For a session it did not know, start at `firstSeq` (not 0), and tell the
  user once that the start of the call was not kept if `firstSeq > 0`.
- Process chunks strictly in `seq` order per session; drop duplicates, ask
  `resume` once on a gap and drop chunks until the missing one arrives. On a
  `gap` notice, jump to its `firstSeq`. The reference module does all this.
- A `session.start` for a session the page already knows is a replay, not a
  new meeting.
- Show the user what is being recorded: `capture` `mic+system` means all Mac
  sound.
- **Render every string from native with `textContent`, never `innerHTML`.**
  Treat `source.app`, `source.bundleId`, `message` and `notice` as untrusted
  text (they come from app bundles on the user's disk; native strips control
  and bidi characters and caps names at 64 characters, but does not escape
  HTML).
- Send `session.done` only after the notes are safely stored.
- Never send audio anywhere except the user's own chosen provider, as today.

## 5. Native memory and lifetime

- Audio is never written to disk by the native app. Chunks are kept in memory
  (cap: 30 minutes, about 58 MB; oldest dropped first) so a page that loads
  late or reloads can catch up.
- The copy is released on `session.done`, 10 minutes after `session.stop`,
  when a new session starts, or when the app quits.
- If the page never says `ready` within 15 s of a recording starting, the menu
  bar shows: "The Vaani web app has not connected yet. Your audio is kept on
  this Mac until it does."
- Closing the notes window ends the page's own mic capture; with no session
  to deliver, the page is unloaded and rebuilt on next open.

## 6. Versioning

`v` and `protocol` are 1. A breaking change bumps both; the native app will
keep accepting v1 pages for at least one release. New optional fields and
new message types are not breaking and must be ignored by old code.

## 7. Minimal integration (web app)

```js
// Import this FIRST, before any third-party script tag or import.
import { connectDesktopBridge, encodeWav } from './vaani-desktop-bridge.js';

const chunks = new Map(); // sessionId -> Int16Array[]
const bridge = connectDesktopBridge({
  onSessionStart: (m) => {
    if (!chunks.has(m.sessionId)) chunks.set(m.sessionId, []);
    statusEl.textContent = `Recording in ${m.source.app}`;            // textContent, never innerHTML
    if (m.capture === 'mic+system') noteEl.textContent = 'Recording your mic and all Mac sound.';
  },
  onAudio: (pcm, m) => { chunks.get(m.sessionId).push(pcm); feedLiveTranscriber?.(pcm); },
  onNotice: (m) => { noteEl.textContent = m.message; },
  onSessionStop: async (m) => {
    const wav = encodeWav(chunks.get(m.sessionId));
    await makeNotesWithUsersProvider(wav);      // existing pipeline
    bridge.done(m.sessionId);
    chunks.delete(m.sessionId);
  },
});
// bridge is null in a normal browser: keep the existing getUserMedia flow there.
```
