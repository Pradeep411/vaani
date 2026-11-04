// Vaani desktop bridge, web side. Reference module for protocol v1.
// Spec: desktop/WEB-BRIDGE-SPEC.md. Drop this file into the web app and call
// connectDesktopBridge() once on start-up. It does nothing outside the
// Vaani macOS app, so it is safe to ship to every browser.
//
// Audio arrives as 16 kHz mono signed 16-bit little-endian PCM in 250 ms
// chunks. Use pcm16ToFloat32() for Web Audio or encodeWav() to build a WAV
// file for the speech-to-text provider the user picked.

export const DESKTOP_ORIGIN = 'https://pradeep411.github.io';
export const DESKTOP_PATH_PREFIX = '/vaani/';
export const HANDLER_NAME = 'vaaniDesktop';
export const EVENT_NAME = 'vaani-desktop';
export const PROTOCOL = 1;

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** True only inside the Vaani macOS app, on the real Vaani page, top frame. */
export function isDesktopApp(win = globalThis.window) {
  try {
    if (!win || win.top !== win) return false;
    if (win.location.origin !== DESKTOP_ORIGIN) return false;
    if (!win.location.pathname.startsWith(DESKTOP_PATH_PREFIX)) return false;
    const flag = win.__VAANI_DESKTOP__;
    const handler = win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers[HANDLER_NAME];
    return !!(flag && flag.protocol === PROTOCOL && handler && typeof handler.postMessage === 'function');
  } catch (_) {
    return false;
  }
}

/** base64 PCM s16le -> Int16Array (explicit little-endian). */
export function decodePCM16(base64) {
  const bin = atob(base64);
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const lo = bin.charCodeAt(2 * i);
    const hi = bin.charCodeAt(2 * i + 1);
    const u = lo | (hi << 8);
    out[i] = u >= 0x8000 ? u - 0x10000 : u;
  }
  return out;
}

/** Int16Array -> Float32Array in [-1, 1]. */
export function pcm16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] < 0 ? int16[i] / 32768 : int16[i] / 32767;
  return out;
}

/** One or more Int16Array chunks -> WAV file bytes (Uint8Array). */
export function encodeWav(chunks, sampleRate = 16000) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  const frames = list.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + frames * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, frames * 2, true);
  let o = 44;
  for (const c of list) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, c[i], true);
  return new Uint8Array(buf);
}

/**
 * Connects to the desktop app. Returns null when not inside it.
 *
 * handlers (all optional):
 *   onHello(msg)                       native app version and audio format
 *   onSessionStart(msg)                a call started (msg.source.app, msg.capture)
 *   onAudio(int16, msg)                one 250 ms chunk, in order, no duplicates
 *   onNotice(msg)                      one plain line to show the user
 *   onSessionStop(msg)                 recording ended (msg.reason)
 */
export function connectDesktopBridge(handlers = {}, win = globalThis.window) {
  if (!isDesktopApp(win)) return null;
  const handler = win.webkit.messageHandlers[HANDLER_NAME];
  const post = (msg) => handler.postMessage(Object.assign({ v: PROTOCOL }, msg));
  const sessions = new Map(); // sessionId -> { nextSeq, resumeAsked }
  const call = (name, ...args) => {
    const fn = handlers[name];
    if (typeof fn === 'function') {
      try { fn(...args); } catch (e) { console.error('[vaani-desktop]', name, e); }
    }
  };

  function onEvent(event) {
    const m = event && event.detail;
    if (!m || typeof m !== 'object' || m.v !== PROTOCOL || typeof m.type !== 'string') return;
    if (m.sessionId !== undefined && !(typeof m.sessionId === 'string' && SESSION_ID.test(m.sessionId))) return;
    switch (m.type) {
      case 'hello':
        call('onHello', m);
        break;
      case 'session.start':
        if (!m.sessionId) return;
        if (!sessions.has(m.sessionId)) sessions.set(m.sessionId, { nextSeq: 0, resumeAsked: false });
        call('onSessionStart', m);
        break;
      case 'audio.chunk': {
        const s = sessions.get(m.sessionId);
        if (!s || !Number.isInteger(m.seq) || typeof m.data !== 'string') return;
        if (m.seq < s.nextSeq) return;                  // duplicate from a replay
        if (m.seq > s.nextSeq) {                        // gap: ask once for a replay
          if (!s.resumeAsked) {
            s.resumeAsked = true;
            post({ type: 'resume', sessionId: m.sessionId, fromSeq: s.nextSeq });
          }
          return;
        }
        s.nextSeq += 1;
        s.resumeAsked = false;
        call('onAudio', decodePCM16(m.data), m);
        break;
      }
      case 'capture.notice':
        if (typeof m.message === 'string') call('onNotice', m);
        break;
      case 'session.stop':
        if (sessions.has(m.sessionId)) call('onSessionStop', m);
        break;
      default:
        break; // newer message types are ignored
    }
  }

  win.addEventListener(EVENT_NAME, onEvent);
  post({ type: 'ready', protocol: PROTOCOL });

  return {
    /** Ask the desktop app to stop recording (the web Stop button). */
    stop(sessionId) {
      post(sessionId ? { type: 'stop', sessionId } : { type: 'stop' });
    },
    /** Notes are saved: the desktop app wipes its copy of the audio. */
    done(sessionId) {
      post({ type: 'session.done', sessionId });
      sessions.delete(sessionId);
    },
    disconnect() {
      win.removeEventListener(EVENT_NAME, onEvent);
    },
  };
}
