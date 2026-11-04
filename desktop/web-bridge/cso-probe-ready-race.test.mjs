// Regression test for security re-audit N-03, ported from the auditor's
// cso-desktop/probes2/ready-race-probe.mjs: a script posts `ready` before
// the web app connects. Runs in its own process (patches globals).
//   node --test web-bridge/cso-probe-ready-race.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('N-03: an early ready cannot lock the web app out', async () => {
  const sent = [];
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.location = { origin: 'https://pradeep411.github.io', pathname: '/vaani/' };
  globalThis.webkit = { messageHandlers: { vaaniDesktop: { postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) } } };
  const TOKEN = 'fedcba9876543210fedcba9876543210';   // the app's per-web-view token
  const src = readFileSync(fileURLToPath(new URL('../Resources/vaani-userscript.js', import.meta.url)), 'utf8')
    .replace('__VAANI_DELIVER_TOKEN__', TOKEN);
  new Function(src)();

  // Early script: no connect, just "ready".
  webkit.messageHandlers.vaaniDesktop.postMessage({ v: 1, type: 'ready', protocol: 1 });
  // Native answers with hello; nobody is connected, so _deliver reports false
  // and native (BridgeSession.helloNotDelivered) resets the handshake.
  assert.equal(window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'hello', nonce: 'N1' }, TOKEN), false);

  const { connectDesktopBridge } = await import('./vaani-desktop-bridge.js');
  let hello = null;
  const b = connectDesktopBridge({ onHello: (m) => { hello = m; } });
  assert.ok(b, 'the web app connects');
  assert.deepEqual(sent.at(-1), { v: 1, type: 'ready', protocol: 1 }, 'its own ready goes out from connect()');
  // Native now honours that ready (Swift test testReaudit_N03_ReadyRace) and
  // sends a fresh hello, which reaches the web app.
  assert.equal(window.__VAANI_DESKTOP__._deliver({ v: 1, type: 'hello', nonce: 'N2' }, TOKEN), true);
  assert.ok(hello);
  b.stop();
  assert.equal(sent.at(-1).nonce, 'N2', 'later messages carry the right nonce');
});
