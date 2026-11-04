// Regression test for security re-audit N-02, ported from the auditor's
// cso-desktop/probes2/nonce-probe.mjs. Same JS realm as in WKWebView: the
// shipped user script, the real bridge module, and a hostile script loaded
// LATER (for example a compromised third-party SDK). Runs in its own process
// because it patches globals.
//   node --test web-bridge/cso-probe-nonce.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('N-02: a later script cannot steal the nonce or forge an accepted message', async () => {
  const sent = [];                                   // what native receives
  class UserMessageHandler { postMessage(m) { sent.push(JSON.parse(JSON.stringify(m))); } }
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.location = { origin: 'https://pradeep411.github.io', pathname: '/vaani/' };
  globalThis.webkit = { messageHandlers: { vaaniDesktop: new UserMessageHandler() } };
  const TOKEN = 'fedcba9876543210fedcba9876543210';   // the app's per-web-view token
  const src = readFileSync(fileURLToPath(new URL('../Resources/vaani-userscript.js', import.meta.url)), 'utf8')
    .replace('__VAANI_DELIVER_TOKEN__', TOKEN);
  new Function(src)();                               // document start
  const { connectDesktopBridge } = await import('./vaani-desktop-bridge.js');
  let audioToApp = 0;
  const bridge = connectDesktopBridge({ onAudio: () => audioToApp++ });   // web app connects first
  assert.ok(bridge);
  assert.deepEqual(sent[0], { v: 1, type: 'ready', protocol: 1 });

  // ---- hostile script, loaded later ----
  const loot = { nonces: new Set(), audio: 0, outbound: [] };
  assert.equal(window.__VAANI_DESKTOP__.connect(() => {}), null, 'later connect() refused');
  for (const prop of ['sessionId', 'nonce', 'type', 'v']) {
    Object.defineProperty(Object.prototype, prop, {
      configurable: true,
      get() { if (typeof this.nonce === 'string') loot.nonces.add(this.nonce); return undefined; },
      set(v) { if (prop === 'nonce') loot.nonces.add(v); },
    });
  }
  const realAtob = globalThis.atob;
  globalThis.atob = (s) => { loot.audio++; return realAtob(s); };
  const realPost = UserMessageHandler.prototype.postMessage;
  UserMessageHandler.prototype.postMessage = function (m) { loot.outbound.push(m && m.nonce); return realPost.call(this, m); };

  // ---- native delivers (callAsyncJavaScript -> _deliver) ----
  const N = 'NONCE-1234';
  const hello = { v: 1, type: 'hello', protocol: 1 };
  Object.defineProperty(hello, 'nonce', { value: N, enumerable: true });   // own data property, as WebKit builds it
  window.__VAANI_DESKTOP__._deliver(hello, TOKEN);
  for (const prop of ['sessionId', 'nonce', 'type', 'v']) delete Object.prototype[prop];
  window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'session.start', sessionId: 'S', firstSeq: 0, source: { app: 'Zoom' } }, TOKEN);
  for (let i = 0; i < 3; i++) window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'audio.chunk', sessionId: 'S', seq: i, data: 'AAABAA==' }, TOKEN);
  bridge.stop('S');

  assert.equal(audioToApp, 3, 'the web app still works');
  assert.equal(loot.nonces.has(N), false, 'no prototype getter or setter saw the nonce');
  assert.equal(loot.outbound.includes(N), false, 'a patched postMessage never sees the nonce');
  assert.equal(loot.audio, 0, 'a later atob wrapper does not see audio (module captured atob at load)');
  assert.equal(sent.at(-1).nonce, N, 'native got the stop with the nonce');

  // A forged session.done can only carry a guessed nonce; native rejects it
  // (BridgeSession nonce check, Swift test testReaudit_N02_ForgedMessageRejected).
  UserMessageHandler.prototype.postMessage = realPost;
  webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'session.done', sessionId: 'S', nonce: [...loot.nonces][0] ?? null });
  assert.notEqual(sent.at(-1).nonce, N);
});
