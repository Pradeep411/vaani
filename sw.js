/* Vaani offline cache: the app opens even without internet. Speech-to-text still needs the browser's speech service.
   Only same-origin GET responses for the files below and the page itself are cached. Network first, so online users
   always get the newest version. Every path is relative to this worker, so it works at /vaani/ and at / alike. */
const CACHE = "vaani-v8";
const FILES = ["./", "index.html", "app.css", "stt.js", "home.js", "insights.js", "calendar.js", "accounts.js"];
/* v2.2 accounts: cached so a signed-in person can open Vaani offline and usage events can wait in the queue.
   The admin page (admin.*) is never cached. */
const ACCOUNTS = ["accounts.css", "analytics-client.js", "firebase-config.js"];
const OPTIONAL = ["manifest.webmanifest", "icons/icon.svg"].concat(ACCOUNTS);
const BASE = new URL("./", self.location).href;
const ALLOW = new Set(FILES.concat(OPTIONAL).map(f => new URL(f, BASE).href));
const SHELL = new URL("./", BASE).href;
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(FILES.map(f => c.add(new Request(f, { cache: "reload" }))))
      /* an optional file that is missing never stops the update */
      .then(() => Promise.all(OPTIONAL.map(f => c.add(new Request(f, { cache: "reload" })).catch(() => {}))))
  ).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== self.location.origin) return;
  const nav = req.mode === "navigate";
  /* ?src=meet, ?src=ext and the plain address are the same page: navigations are stored once, without the query,
     and only the app shell is stored; other pages (privacy.html) are fetched live and fall back to the shell offline */
  const key = nav ? u.origin + u.pathname : u.href;
  if (!nav && !ALLOW.has(key)) return;
  e.respondWith(fetch(req).then(r => {
    if (r.ok && r.type === "basic" && ALLOW.has(key)) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); }
    return r;
  }).catch(() => caches.match(key).then(m => m || (nav ? caches.match(SHELL) : undefined))));
});
