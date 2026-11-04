// Node tests for the reference bridge module and the shipped user script:
//   node --test web-bridge/vaani-desktop-bridge.test.mjs
// The real document-start script (Resources/vaani-userscript.js) is run in a
// fake window, and native messages go through its _deliver(), exactly like
// the app's callAsyncJavaScript dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  connectDesktopBridge, isDesktopApp, decodePCM16, pcm16ToFloat32, encodeWav,
} from './vaani-desktop-bridge.js';

const USER_SCRIPT = readFileSync(fileURLToPath(new URL('../Resources/vaani-userscript.js', import.meta.url)), 'utf8');

function fakeWindow({ origin = 'https://pradeep411.github.io', pathname = '/vaani/', userScript = true, handler = true, top } = {}) {
  const posted = [];
  const win = { location: { origin, pathname, search: '?src=desktop' }, posted };
  win.top = top === undefined ? win : top;
  if (handler) win.webkit = { messageHandlers: { vaaniDesktop: { postMessage: (m) => posted.push(m) } } };
  if (userScript) vm.runInNewContext(USER_SCRIPT, { window: win, location: win.location, Object });
  return win;
}

// What the app does: callAsyncJavaScript(dispatchScript, { msg }).
const deliver = (win, msg) => {
  const b = win.__VAANI_DESKTOP__;
  return !!(b && b._deliver(msg));
};
const b64 = (int16) => Buffer.from(new Uint8Array(new Int16Array(int16).buffer)).toString('base64');

test('user script defines the flag only on the real page, top frame', () => {
  assert.ok(fakeWindow().__VAANI_DESKTOP__);
  assert.equal(fakeWindow({ origin: 'https://evil.example' }).__VAANI_DESKTOP__, undefined);
  assert.equal(fakeWindow({ pathname: '/other/' }).__VAANI_DESKTOP__, undefined);
  assert.equal(fakeWindow({ top: {} }).__VAANI_DESKTOP__, undefined);
  const w = fakeWindow();
  assert.throws(() => { 'use strict'; w.__VAANI_DESKTOP__ = {}; }, TypeError, 'cannot be replaced');
  assert.ok(Object.isFrozen(w.__VAANI_DESKTOP__));
});

test('only activates inside the app on the real page', () => {
  assert.equal(isDesktopApp(fakeWindow()), true);
  assert.equal(isDesktopApp(fakeWindow({ userScript: false })), false);
  assert.equal(isDesktopApp(fakeWindow({ handler: false })), false);
  assert.equal(connectDesktopBridge({}, fakeWindow({ origin: 'http://pradeep411.github.io' })), null);
});

test('L-05: first caller wins; later scripts cannot listen', () => {
  const win = fakeWindow();
  let legit = 0;
  assert.ok(connectDesktopBridge({ onHello: () => legit++ }, win));
  let spy = 0;
  assert.equal(win.__VAANI_DESKTOP__.connect(() => spy++), false, 'slot is locked');
  assert.equal(connectDesktopBridge({}, win), null, 'a second module instance is refused');
  deliver(win, { v: 1, type: 'hello', nonce: 'n-1' });
  assert.equal(legit, 1);
  assert.equal(spy, 0);
});

test('handshake, nonce echo, ordered audio, duplicate and gap handling', () => {
  const win = fakeWindow();
  const got = { audio: [], starts: 0, stops: 0, notices: [] };
  const bridge = connectDesktopBridge({
    onSessionStart: () => got.starts++,
    onAudio: (pcm, m) => got.audio.push([m.seq, Array.from(pcm)]),
    onNotice: (m) => got.notices.push(m.message),
    onSessionStop: () => got.stops++,
  }, win);
  assert.deepEqual(win.posted[0], { v: 1, type: 'ready', protocol: 1 });
  deliver(win, { v: 1, type: 'hello', nonce: 'load-1' });

  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 0, data: b64([1]) });
  assert.equal(got.audio.length, 0, 'no audio before session.start');

  deliver(win, { v: 1, type: 'session.start', sessionId: 's1', firstSeq: 0, source: { app: 'Zoom' }, capture: 'mic+app' });
  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 0, data: b64([1, -2]) });
  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 0, data: b64([9]) });   // duplicate
  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 2, data: b64([3]) });   // gap
  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 3, data: b64([4]) });   // still gap, no 2nd resume
  assert.deepEqual(win.posted.slice(1), [{ v: 1, type: 'resume', sessionId: 's1', fromSeq: 1, nonce: 'load-1' }]);
  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 1, data: b64([2]) });
  deliver(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 2, data: b64([3]) });
  assert.deepEqual(got.audio, [[0, [1, -2]], [1, [2]], [2, [3]]]);

  deliver(win, { v: 1, type: 'capture.notice', sessionId: 's1', code: 'tap-unavailable', message: 'Recording your mic only.' });
  deliver(win, { v: 1, type: 'session.stop', sessionId: 's1', reason: 'call-ended', lastSeq: 2, totalFrames: 4 });
  assert.equal(got.starts, 1);
  assert.equal(got.stops, 1);
  assert.deepEqual(got.notices, ['Recording your mic only.']);

  bridge.done('s1');
  bridge.stop();
  assert.deepEqual(win.posted.slice(-2), [
    { v: 1, type: 'session.done', sessionId: 's1', nonce: 'load-1' },
    { v: 1, type: 'stop', nonce: 'load-1' },
  ]);
});

test('ignores malformed or foreign messages', () => {
  const win = fakeWindow();
  let calls = 0;
  connectDesktopBridge({ onSessionStart: () => calls++, onHello: () => calls++ }, win);
  for (const bad of [null, 'x', { type: 'hello' }, { v: 2, type: 'hello' },
    { v: 1, type: 'session.start', sessionId: '../x' }, { v: 1, type: 'session.start' },
    { v: 1, type: 'eval', code: 'alert(1)' }]) {
    deliver(win, bad);
  }
  assert.equal(calls, 0);
});

// Ported from the CSO probe (cso-desktop/probes/bridge-probe.mjs), asserting the fixes.
test('CSO probe 1: plain browser stays inert', () => {
  const browser = fakeWindow({ userScript: false, handler: false });
  let fed = 0;
  assert.equal(connectDesktopBridge({ onAudio: () => fed++ }, browser), null);
  assert.equal(deliver(browser, { v: 1, type: 'audio.chunk', sessionId: 'x', seq: 0, data: 'AAA=' }), false);
  assert.equal(fed, 0);
});

test('CSO probe 2: globals faked by another script no longer activate the bridge', () => {
  const posted = [];
  const spoof = fakeWindow({ userScript: false, handler: false });
  spoof.__VAANI_DESKTOP__ = { protocol: 1 };   // old-style spoof, no connect()
  spoof.webkit = { messageHandlers: { vaaniDesktop: { postMessage: (m) => posted.push(m) } } };
  assert.equal(isDesktopApp(spoof), false);
  assert.equal(connectDesktopBridge({}, spoof), null);
  assert.equal(posted.length, 0);
});

test('CSO probe 3 (L-03): page that joins after the 30 min cap gets audio', () => {
  const w3 = fakeWindow();
  let got = 0;
  connectDesktopBridge({ onAudio: () => got++ }, w3);
  deliver(w3, { v: 1, type: 'hello', nonce: 'n' });
  deliver(w3, { v: 1, type: 'session.start', sessionId: 'S', firstSeq: 1200 });
  for (let s = 1200; s < 1210; s++) deliver(w3, { v: 1, type: 'audio.chunk', sessionId: 'S', seq: s, data: 'AAA=' });
  assert.equal(got, 10);
  assert.equal(w3.posted.filter((m) => m.type === 'resume').length, 0);

  // Older native without firstSeq: the gap notice moves the page on.
  const w4 = fakeWindow();
  let got4 = 0;
  connectDesktopBridge({ onAudio: () => got4++ }, w4);
  deliver(w4, { v: 1, type: 'hello', nonce: 'n' });
  deliver(w4, { v: 1, type: 'session.start', sessionId: 'S' });
  deliver(w4, { v: 1, type: 'audio.chunk', sessionId: 'S', seq: 1200, data: 'AAA=' });
  assert.equal(w4.posted.filter((m) => m.type === 'resume').length, 1);
  deliver(w4, { v: 1, type: 'capture.notice', sessionId: 'S', code: 'gap', firstSeq: 1200, message: 'gap' });
  for (let s = 1200; s < 1205; s++) deliver(w4, { v: 1, type: 'audio.chunk', sessionId: 'S', seq: s, data: 'AAA=' });
  assert.equal(got4, 5);
});

test('PCM helpers', () => {
  assert.deepEqual(Array.from(decodePCM16(b64([0, 32767, -32768, -1]))), [0, 32767, -32768, -1]);
  assert.deepEqual(Array.from(decodePCM16(Buffer.from([0x00, 0x00, 0xff, 0x7f]).toString('base64'))), [0, 32767],
    'same little-endian bytes the Swift PCM16 test checks');
  const f = pcm16ToFloat32(new Int16Array([32767, -32768, 0]));
  assert.equal(f[0], 1); assert.equal(f[1], -1); assert.equal(f[2], 0);
  const wav = encodeWav([new Int16Array([1, 2]), new Int16Array([3])], 16000);
  assert.equal(wav.length, 44 + 6);
  assert.equal(Buffer.from(wav.slice(0, 4)).toString(), 'RIFF');
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getInt16(48, true), 3);
});
