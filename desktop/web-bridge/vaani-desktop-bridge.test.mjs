// Node test for the reference bridge module: node --test web-bridge/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectDesktopBridge, isDesktopApp, decodePCM16, pcm16ToFloat32, encodeWav, EVENT_NAME,
} from './vaani-desktop-bridge.js';

function fakeWindow({ origin = 'https://pradeep411.github.io', pathname = '/vaani/', flag = true, handler = true, top } = {}) {
  const target = new EventTarget();
  const posted = [];
  const win = {
    location: { origin, pathname, search: '?src=desktop' },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    posted,
  };
  win.top = top === undefined ? win : top;
  if (flag) win.__VAANI_DESKTOP__ = Object.freeze({ protocol: 1 });
  if (handler) win.webkit = { messageHandlers: { vaaniDesktop: { postMessage: (m) => posted.push(m) } } };
  return win;
}

const send = (win, msg) => win.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: msg }));
const b64 = (int16) => Buffer.from(new Uint8Array(new Int16Array(int16).buffer)).toString('base64');

test('only activates on the real page inside the app', () => {
  assert.equal(isDesktopApp(fakeWindow()), true);
  assert.equal(isDesktopApp(fakeWindow({ origin: 'https://evil.example' })), false);
  assert.equal(isDesktopApp(fakeWindow({ pathname: '/other/' })), false);
  assert.equal(isDesktopApp(fakeWindow({ flag: false })), false);
  assert.equal(isDesktopApp(fakeWindow({ handler: false })), false);
  assert.equal(isDesktopApp(fakeWindow({ top: {} })), false, 'iframes never');
  assert.equal(connectDesktopBridge({}, fakeWindow({ origin: 'http://pradeep411.github.io' })), null);
});

test('handshake, ordered audio, duplicate and gap handling', () => {
  const win = fakeWindow();
  const got = { audio: [], starts: 0, stops: 0, notices: [] };
  const bridge = connectDesktopBridge({
    onSessionStart: () => got.starts++,
    onAudio: (pcm, m) => got.audio.push([m.seq, Array.from(pcm)]),
    onNotice: (m) => got.notices.push(m.message),
    onSessionStop: () => got.stops++,
  }, win);
  assert.deepEqual(win.posted[0], { v: 1, type: 'ready', protocol: 1 });

  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 0, data: b64([1]) });
  assert.equal(got.audio.length, 0, 'no audio before session.start');

  send(win, { v: 1, type: 'session.start', sessionId: 's1', source: { app: 'Zoom' }, capture: 'mic+app' });
  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 0, data: b64([1, -2]) });
  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 0, data: b64([9]) });   // duplicate
  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 2, data: b64([3]) });   // gap
  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 3, data: b64([4]) });   // still gap, no 2nd resume
  assert.deepEqual(win.posted.slice(1), [{ v: 1, type: 'resume', sessionId: 's1', fromSeq: 1 }]);
  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 1, data: b64([2]) });
  send(win, { v: 1, type: 'audio.chunk', sessionId: 's1', seq: 2, data: b64([3]) });
  assert.deepEqual(got.audio, [[0, [1, -2]], [1, [2]], [2, [3]]]);

  send(win, { v: 1, type: 'capture.notice', sessionId: 's1', code: 'tap-unavailable', message: 'Recording your mic only.' });
  send(win, { v: 1, type: 'session.stop', sessionId: 's1', reason: 'call-ended', lastSeq: 2, totalFrames: 4 });
  assert.equal(got.starts, 1);
  assert.equal(got.stops, 1);
  assert.deepEqual(got.notices, ['Recording your mic only.']);

  bridge.done('s1');
  bridge.stop();
  assert.deepEqual(win.posted.slice(-2), [{ v: 1, type: 'session.done', sessionId: 's1' }, { v: 1, type: 'stop' }]);
});

test('ignores malformed or foreign messages', () => {
  const win = fakeWindow();
  let calls = 0;
  connectDesktopBridge({ onSessionStart: () => calls++, onHello: () => calls++ }, win);
  for (const bad of [null, 'x', { type: 'hello' }, { v: 2, type: 'hello' },
    { v: 1, type: 'session.start', sessionId: '../x' }, { v: 1, type: 'session.start' },
    { v: 1, type: 'eval', code: 'alert(1)' }]) {
    send(win, bad);
  }
  assert.equal(calls, 0);
});

test('PCM helpers', () => {
  assert.deepEqual(Array.from(decodePCM16(b64([0, 32767, -32768, -1]))), [0, 32767, -32768, -1]);
  const f = pcm16ToFloat32(new Int16Array([32767, -32768, 0]));
  assert.equal(f[0], 1); assert.equal(f[1], -1); assert.equal(f[2], 0);
  const wav = encodeWav([new Int16Array([1, 2]), new Int16Array([3])], 16000);
  assert.equal(wav.length, 44 + 6);
  assert.equal(Buffer.from(wav.slice(0, 4)).toString(), 'RIFF');
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getInt16(48, true), 3);
});
