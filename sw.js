/* Vaani offline cache: the app opens even without internet. Speech-to-text still needs the browser's speech service. */
const CACHE = "vaani-v5";
const FILES = ["./", "index.html", "manifest.webmanifest", "icons/icon.svg", "app.css", "home.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const nav = e.request.mode === "navigate";
  /* ?src=meet and ?src=installed are the same page: offline, match it without the query string, and fall back to the app shell */
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); if (r.ok) caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: nav }).then(m => m || (nav ? caches.match("./") : undefined))));
});
