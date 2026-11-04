// Vaani for Mac: document-start user script (top frame only).
// Shipped in Vaani.app/Contents/Resources and injected by the app before any
// page script runs. Defines window.__VAANI_DESKTOP__ on the real Vaani page
// only.
//
// What it protects (security audit L-05, re-audit N-02, N-03):
//  * Native messages go to exactly ONE callback: the first caller of
//    connect() wins and the slot then locks.
//  * The per-load nonce never leaves this closure: it is taken out of
//    `hello` before delivery, and added back only by the post() capability
//    that connect() returns. Page scripts cannot read it.
//  * Messages are delivered as null-prototype copies, and the functions used
//    here (Object.create, Reflect.apply, the message handler's postMessage)
//    are captured now, before any page script can patch them.
//  * connect() itself sends `ready`, so `ready` from any other script cannot
//    take the handshake (native also resets it if `hello` reaches nobody).
//  * _deliver() only accepts calls that carry the per-web-view token the app
//    writes into this script before injecting it (re-audit F-01). The token
//    lives only in this closure and in the app's callAsyncJavaScript
//    arguments, so page scripts cannot feed fake messages, overwrite the
//    nonce with a forged `hello`, or make the web app see fake audio.
// What it does NOT protect: a script that patches globals the web app's own
// code uses while it processes audio (for example a String or typed-array
// method, or the web app's own functions) can still read that audio, even
// if it loads after the bridge module. The web app must load its bridge
// module before any third-party script, and keep third-party scripts out of
// the page where it can.
(function () {
  'use strict';
  if (window.top !== window) return;
  if (location.origin !== 'https://pradeep411.github.io' || location.pathname.indexOf('/vaani/') !== 0) return;
  // Replaced by the app with a random token before injection. If it was not
  // replaced, the bridge is not defined at all (the placeholder is public).
  var deliverToken = '__VAANI_DELIVER_TOKEN__';
  if (deliverToken === '__VAANI_' + 'DELIVER_TOKEN__' || deliverToken.length < 32) return;
  var handlers = window.webkit && window.webkit.messageHandlers;
  var handler = handlers && handlers.vaaniDesktop;
  if (!handler || typeof handler.postMessage !== 'function') return;

  // Captured at document start.
  var rawPost = handler.postMessage;
  var apply = Reflect.apply;
  var create = Object.create;
  var keys = Object.keys;
  var freeze = Object.freeze;
  var defineProperty = Object.defineProperty;
  var isArray = Array.isArray;

  var listener = null;
  var nonce = null;

  // Plain JSON-like data only. Null-prototype objects: prototype getters set
  // by page scripts never fire while the web app reads a message.
  function copyIn(value, depth) {
    if (value === null || typeof value !== 'object' || depth > 8) return value;
    if (isArray(value)) {
      var a = [];
      for (var i = 0; i < value.length; i++) defineProperty(a, i, { value: copyIn(value[i], depth + 1), enumerable: true, writable: true, configurable: true });
      return a;
    }
    var o = create(null);
    var k = keys(value);
    for (var j = 0; j < k.length; j++) o[k[j]] = copyIn(value[k[j]], depth + 1);
    return o;
  }

  // Outbound object built with defineProperty, so Object.prototype setters
  // never see the fields (the nonce in particular).
  function copyOut(msg) {
    var out = {};
    var k = keys(msg);
    for (var j = 0; j < k.length; j++) {
      if (k[j] === 'nonce') continue;
      defineProperty(out, k[j], { value: msg[k[j]], enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  function send(out) { apply(rawPost, handler, [out]); }

  function post(msg) {
    if (msg === null || typeof msg !== 'object') return false;
    var out = copyOut(msg);
    defineProperty(out, 'v', { value: 1, enumerable: true, writable: true, configurable: true });
    if (nonce !== null) defineProperty(out, 'nonce', { value: nonce, enumerable: true, writable: true, configurable: true });
    send(out);
    return true;
  }

  var api = freeze({
    protocol: 1,
    platform: 'macos',
    handler: 'vaaniDesktop',
    // Returns a one-time, frozen capability { post(msg) }, or null if taken.
    connect: function (callback) {
      if (listener !== null || typeof callback !== 'function') return null;
      listener = callback;
      var cap = freeze({ post: post });
      var ready = {};
      defineProperty(ready, 'v', { value: 1, enumerable: true });
      defineProperty(ready, 'type', { value: 'ready', enumerable: true });
      defineProperty(ready, 'protocol', { value: 1, enumerable: true });
      send(ready);
      return cap;
    },
    // Called only by the app, with the token. Returns true if the connected
    // callback got it. Anything without the token is ignored.
    _deliver: function (msg, token) {
      if (token !== deliverToken) return false;
      if (listener === null || msg === null || typeof msg !== 'object') return false;
      if (msg.type === 'hello' && typeof msg.nonce === 'string') nonce = msg.nonce;
      var copy = copyIn(msg, 0);
      if (copy && typeof copy === 'object') delete copy.nonce;
      try { listener(copy); } catch (e) { /* the page's own error, not ours */ }
      return true;
    }
  });
  defineProperty(window, '__VAANI_DESKTOP__', {
    value: api, writable: false, configurable: false, enumerable: false
  });
})();
