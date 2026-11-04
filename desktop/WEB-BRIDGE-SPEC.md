# Vaani desktop bridge, protocol v1

How the Vaani macOS app hands call audio to the Vaani web app. The web app
does all transcription and note making, exactly as today. The desktop app
only detects calls, records audio, and passes it in.

Reference code the web developer can drop in: `web-bridge/vaani-desktop-bridge.js`
(tests: `node --test web-bridge/vaani-desktop-bridge.test.mjs`).
Native side: `Sources/VaaniCore/Bridge.swift`, `BridgeSession.swift`,
`Sources/Vaani/VaaniWindowController.swift`.

## 1. Where it runs

| Item | Value |
| --- | --- |
| Page the app loads | `https://pradeep411.github.io/vaani/?src=desktop` |
| Allowed origin | exactly `https://pradeep411.github.io` (https, default port, no user info) |
| Allowed path | `/vaani` or anything under `/vaani/` (no `.`/`..` segments, no `%2e`, `%2f`, `%5c`) |
| Frames | top frame only, both directions |
| Page to native | `window.webkit.messageHandlers.vaaniDesktop.postMessage(obj)` |
| Native to page | `window` receives `CustomEvent('vaani-desktop', { detail: obj })` |
| Flag set before page scripts run | `window.__VAANI_DESKTOP__ = { protocol: 1, platform: 'macos', version, handler: 'vaaniDesktop', event: 'vaani-desktop' }` (frozen, non-writable, only on the allowed origin and path) |

The web app is "in desktop mode" only when all of these are true:
`location.origin === 'https://pradeep411.github.io'`, path starts with
`/vaani/`, `window.top === window`, `window.__VAANI_DESKTOP__?.protocol === 1`,
and `window.webkit.messageHandlers.vaaniDesktop` exists. `?src=desktop` is a
hint only (the SPA may rewrite the URL); do not rely on it alone.

In desktop mode the web app should **not** call `getUserMedia` for meeting
notes. Audio comes from the bridge. (Its own dictation feature may still use
`getUserMedia`; the app allows the microphone for the allowed origin only and
never the camera.)

## 2. Native checks (already built)

1. Navigation: the top frame may only show the allowed page. A user-clicked
   link to any other `https`, `http` or `mailto` URL opens in the default
   browser; script redirects to other sites are cancelled; iframes from any
   other origin are cancelled; `window.open` never makes a second web view
   (real links go to the browser). `file:`, `javascript:`, `data:` are refused.
   Server redirects of the top frame to another origin are cancelled at the
   response stage too.
2. Downloads (notes export via `a[download]` or blob links) are allowed only
   while the top page is the allowed page, and always go through a macOS
   Save panel.
3. Inbound messages are dropped unless: the message comes from the top frame;
   the frame's security origin is `https` + `pradeep411.github.io` + port 0/443;
   the web view's current URL passes the path rule; the body is a JSON object
   of at most 8 KB with `v === 1` and a known `type`; `sessionId`, if present,
   matches `^[A-Za-z0-9-]{1,64}$`.
4. Outbound: before every send, native re-checks that the current page URL is
   the allowed page. Messages are passed as a typed argument to
   `callAsyncJavaScript` in the page world; no data is ever spliced into
   script text. The only script native runs is:
   `window.dispatchEvent(new CustomEvent('vaani-desktop', { detail: msg })); return true;`

## 3. Messages

All messages carry `v: 1`. Unknown `type` values must be ignored by both
sides (forward compatible). Field order does not matter.

### Page to native

| type | fields | when | native does |
| --- | --- | --- | --- |
| `ready` | `protocol: 1` | once the page has added its event listener; again after every reload | sends `hello`; if a session exists, sends `session.start`, any `capture.notice`, every buffered `audio.chunk` from the oldest kept, and `session.stop` if it has ended |
| `resume` | `sessionId`, `fromSeq` (int, 0 or more) | the page saw a gap in `seq` | re-sends buffered chunks with `seq >= fromSeq`, then `session.stop` if ended. Ignored for any other session |
| `stop` | `sessionId` (optional) | the user pressed Stop in the web app | stops recording (same as the menu-bar Stop) if the id matches or is absent |
| `session.done` | `sessionId` | notes for that session are saved | wipes its in-memory copy of the audio. Only honoured after `session.stop` |

```js
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'ready', protocol: 1 });
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'resume', sessionId, fromSeq: 12 });
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'stop', sessionId });
webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'session.done', sessionId });
```

### Native to page

```js
// After every "ready"
{ v: 1, type: 'hello', protocol: 1, platform: 'macos', nativeVersion: '0.1.0',
  audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, chunkMs: 250 } }

// A recording started (user tapped "Take notes", or "Take notes now")
{ v: 1, type: 'session.start', sessionId: 'UUID', startedAt: '2026-11-04T10:15:00.000Z',
  source: { app: 'Zoom', bundleId: 'us.zoom.xos', kind: 'meeting' },   // kind: meeting | call | huddle | browser | other
  capture: 'mic+app',                                                  // or 'mic-only'
  audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, chunkMs: 250 },
  notice: 'Recording your mic only. ...' }                             // present only when capture is degraded

// Every 250 ms while recording (last chunk of a session may be shorter)
{ v: 1, type: 'audio.chunk', sessionId: 'UUID', seq: 0, frames: 4000, data: '<base64 PCM s16le>' }

// One plain line for the user (show it once, calmly)
{ v: 1, type: 'capture.notice', sessionId: 'UUID', code: 'tap-unavailable', message: '...' }
//   code: tap-unavailable  system audio could not be recorded, mic only
//         tap-silent       the call app's sound has been silent; permission may be off
//         mic-denied       microphone permission is off

// Recording ended
{ v: 1, type: 'session.stop', sessionId: 'UUID', reason: 'user', lastSeq: 239, totalFrames: 958000 }
//   reason: user | call-ended | web-requested | error | quit
```

Audio format: 16,000 Hz, 1 channel, signed 16-bit little-endian PCM, base64.
It is the user's mic and the call app's sound mixed together (or the mic
alone when `capture` is `mic-only`). This is the format Sarvam and most
speech-to-text APIs accept as WAV; `encodeWav()` in the reference module
builds the file.

## 4. Sequence

```
page loads ──► postMessage ready ─────────────► native: hello
                                                 (if a session is live:
                                                  session.start, notices,
                                                  buffered chunks, stop)
user taps "Take notes" in the pill ───────────► native: session.start
                                                 audio.chunk seq 0,1,2... every 250 ms
page sees seq jump 7 -> 9 ─► resume fromSeq 8 ► native: chunks 8, 9, ...
call app quiet for 60 s, or Stop ─────────────► native: session.stop
page saves notes ─► session.done ─────────────► native wipes its audio copy
```

Rules for the page:

- Process chunks strictly in `seq` order per session; drop duplicates
  (`seq` lower than expected), ask `resume` once on a gap and drop chunks
  until the missing one arrives. The reference module does this.
- A `session.start` for a session the page already knows is a replay, not a
  new meeting.
- Send `session.done` only after the notes are safely stored.
- Never send audio anywhere except the user's own chosen provider, as today.

## 5. Native memory and lifetime

- Audio is never written to disk by the native app. Chunks are kept in memory
  (cap: 30 minutes, about 58 MB; oldest dropped first) so a page that loads
  late or reloads can catch up.
- The copy is wiped on `session.done`, 10 minutes after `session.stop`, when a
  new session starts, or when the app quits.
- If the page never says `ready` within 15 s of a recording starting, the menu
  bar shows: "The Vaani web app has not connected yet. Your audio is kept on
  this Mac until it does."

## 6. Versioning

`v` and `protocol` are 1. A breaking change bumps both; the native app will
keep accepting v1 pages for at least one release. New optional fields and
new message types are not breaking and must be ignored by old code.

## 7. Minimal integration (web app)

```js
import { connectDesktopBridge, encodeWav } from './vaani-desktop-bridge.js';

const chunks = new Map(); // sessionId -> Int16Array[]
const bridge = connectDesktopBridge({
  onSessionStart: (m) => { if (!chunks.has(m.sessionId)) chunks.set(m.sessionId, []); showRecording(m.source.app); },
  onAudio: (pcm, m) => { chunks.get(m.sessionId).push(pcm); feedLiveTranscriber?.(pcm); },
  onNotice: (m) => showOneLine(m.message),
  onSessionStop: async (m) => {
    const wav = encodeWav(chunks.get(m.sessionId));
    await makeNotesWithUsersProvider(wav);      // existing pipeline
    bridge.done(m.sessionId);
    chunks.delete(m.sessionId);
  },
});
// bridge is null in a normal browser: keep the existing getUserMedia flow there.
```
