// Regression test for security re-audit F-01, ported from the auditor's
// cso-desktop/probes3/nonce-probe-v3.mjs. Same JS realm as WKWebView: the
// shipped user script (with the app's token in place) at document start,
// the real bridge module, then a hostile script loaded LATER that tries
// every hook from earlier rounds plus Reflect.apply, Object.defineProperty,
// String.prototype.charCodeAt and a forged `hello` through _deliver.
// Runs in its own process because it patches globals.
//   node --test web-bridge/cso-probe-nonce-v3.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('F-01: forged hello via _deliver cannot overwrite the nonce; later hooks see nothing', async () => {
  const sent = [];
  class UserMessageHandler { postMessage(m) { sent.push(JSON.parse(JSON.stringify(m))); } }
  globalThis.window = globalThis; globalThis.top = globalThis;
  globalThis.location = { origin: 'https://pradeep411.github.io', pathname: '/vaani/' };
  globalThis.webkit = { messageHandlers: { vaaniDesktop: new UserMessageHandler() } };
  const TOKEN = '00112233445566778899aabbccddeeff';     // known only to the app and the user script
  const src = readFileSync(fileURLToPath(new URL('../Resources/vaani-userscript.js', import.meta.url)), 'utf8')
    .replace('__VAANI_DELIVER_TOKEN__', TOKEN);
  new Function(src)();
  const { connectDesktopBridge } = await import('./vaani-desktop-bridge.js');
  let appAudio = 0, appStarts = 0;
  const bridge = connectDesktopBridge({ onAudio: () => appAudio++, onSessionStart: () => appStarts++ });
  assert.ok(bridge);
  assert.deepEqual(sent[0], { v: 1, type: 'ready', protocol: 1 }, 'ready sent by the user script');

  // ---- hostile later script ----
  const keys = ['sessionId', 'nonce', 'firstSeq', 'notice', 'source', 'type', 'v'];
  const loot = { nonce: [], audioViaAtob: 0, audioViaCharCodeAt: 0 };
  const grab = (o) => { try { if (o && typeof o.nonce === 'string') loot.nonce.push(o.nonce); } catch (_) {} };
  for (const k of keys) {
    Object.defineProperty(Object.prototype, k, { configurable: true, get() { grab(this); return undefined; },
      set(v) { if (k === 'nonce') loot.nonce.push(v); } });
  }
  const ra = globalThis.atob; globalThis.atob = (s) => { loot.audioViaAtob++; return ra(s); };
  const rcc = String.prototype.charCodeAt; let counting = true;
  String.prototype.charCodeAt = function (i) { if (counting && i === 0 && this.length > 4) loot.audioViaCharCodeAt++; return rcc.call(this, i); };
  const rp = UserMessageHandler.prototype.postMessage;
  UserMessageHandler.prototype.postMessage = function (m) { grab(m); return rp.call(this, m); };
  const rap = Reflect.apply; Reflect.apply = function (f, t, a) { try { grab(a && a[0]); } catch (_) {} return rap(f, t, a); };
  const rdp = Object.defineProperty;
  Object.defineProperty = function (o, k, d) { if (k === 'nonce') loot.nonce.push(d && d.value); return rdp(o, k, d); };
  assert.equal(window.__VAANI_DESKTOP__.connect(() => {}), null, 'later connect() refused');

  // ---- native delivers, with the token, as callAsyncJavaScript does ----
  const N = 'NONCE-REAL-1';
  const deliver = (m) => window.__VAANI_DESKTOP__._deliver(JSON.parse(JSON.stringify(m)), TOKEN);
  try {
    deliver({ v: 1, type: 'hello', protocol: 1, nonce: N });
    deliver({ v: 1, type: 'session.start', sessionId: 'S', firstSeq: 0, source: { app: 'Zoom' } });
    for (let i = 0; i < 3; i++) deliver({ v: 1, type: 'audio.chunk', sessionId: 'S', seq: i, data: 'AAABAAIAAwA=' });
    bridge.stop('S');
  } finally {
    counting = false;
    for (const k of keys) delete Object.prototype[k];
    String.prototype.charCodeAt = rcc; Reflect.apply = rap; Object.defineProperty = rdp; globalThis.atob = ra;
  }
  assert.equal(appStarts, 1);
  assert.equal(appAudio, 3, 'the web app still gets its audio');
  assert.equal(loot.nonce.includes(N), false, 'nonce never reached a hostile hook');
  assert.equal(sent.at(-1).type, 'stop');
  assert.equal(sent.at(-1).nonce, N, 'stop reached native with the real nonce');
  assert.equal(loot.audioViaAtob, 0, 'atob hook saw no audio (captured at module load)');
  assert.equal(loot.audioViaCharCodeAt, 0, 'charCodeAt hook saw no audio in the reference module (captured at load)');

  // ---- forged hello via _deliver, no token: refused, nonce intact ----
  assert.equal(window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'hello', nonce: 'EVIL' }), false);
  assert.equal(window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'hello', nonce: 'EVIL' }, 'guess'), false);
  assert.equal(window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'audio.chunk', sessionId: 'S', seq: 3, data: 'AAA=' }), false);
  assert.equal(appAudio, 3, 'no fake audio delivered');
  bridge.stop('S');
  assert.equal(sent.at(-1).nonce, N, 'after the forged hello, Stop still carries the real nonce');
});
