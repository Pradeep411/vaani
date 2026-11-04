// Vaani for Mac: document-start user script (top frame only).
// Shipped in Vaani.app/Contents/Resources and injected by the app before any
// page script runs. Defines window.__VAANI_DESKTOP__ on the real Vaani page
// only. Native audio goes to exactly ONE callback: the first caller of
// connect() wins and the slot then locks, so scripts loaded later (Google
// sign-in, Firebase, anything else) cannot listen in (security audit L-05).
(function () {
  'use strict';
  if (window.top !== window) return;
  if (location.origin !== 'https://pradeep411.github.io' || location.pathname.indexOf('/vaani/') !== 0) return;
  var listener = null;
  var api = Object.freeze({
    protocol: 1,
    platform: 'macos',
    handler: 'vaaniDesktop',
    connect: function (callback) {
      if (listener !== null || typeof callback !== 'function') return false;
      listener = callback;
      return true;
    },
    _deliver: function (msg) {
      if (listener === null) return false;
      try { listener(msg); } catch (e) { /* the page's own error, not ours */ }
      return true;
    }
  });
  Object.defineProperty(window, '__VAANI_DESKTOP__', {
    value: api, writable: false, configurable: false, enumerable: false
  });
})();
