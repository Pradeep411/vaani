/**
 * Vaani analytics client (v2.2): sign-in, consent and usage events for Firebase Auth + Firestore.
 *
 * Load it as a module from the app (it is self-contained, no build step):
 *   <script type="module" src="analytics-client.js"></script>   // or import it from another module
 *
 *   import * as VA from "./analytics-client.js";
 *   await VA.init(VAANI_FIREBASE_CONFIG, { appVersion: "2.2.0", googleClientId: "...apps.googleusercontent.com" });
 *   VA.onState(s => ...);                        // signed-out | needs-consent | ready | ...
 *   VA.renderGoogleButton(el);                   // or VA.sendEmailLink(email)
 *   await VA.giveConsent();                      // after the person ticks the consent box
 *   VA.track("meeting_done", { type: "sales", durS: 1820, lang: "hi-IN", engine: "sarvam" });
 *
 * What it can send: only the event names and props in EVENTS below. Every prop is an enum, a bounded integer or a
 * boolean, so transcript text, note text, note titles, attendee names, calendar event titles and AI keys cannot be
 * sent, by design. firestore.rules enforces the same schema on the server.
 *
 * Nothing is sent before consent: track() drops events until giveConsent() has stored consent for this account.
 * v2.2 integration (team/v23): usage stats are a separate, unticked opt-in (DECISIONS.md 1). giveConsent({stats})
 * stores the choice and a consent record (privacy/CONSENT.md) in the same write. Without the opt-in, only the
 * account basics are sent (sign_up, sign_in, consent_update, with no device class) and track() drops everything
 * else. setStats() changes the choice later; turning it off deletes the usage events already stored.
 * countAnon() is the only call for people under 18: an anonymous daily counter, no sign-in, no identifiers.
 * v2.2 fix round (team/SECURITY-AUDIT-v23.md): deletion finishes in one sitting through reauthAndDelete() when Firebase
 * wants a fresh sign-in, and a resumed deletion that meets a missing user doc no longer fails (A-01); declineConsent()
 * removes the Auth record of someone who says no (A-05); onlyEmail refuses other Google accounts before Firebase sees
 * them (A-05, admin); every flush moves a 24-hour window (A-10); the GIS credential carries a nonce (A-12); the saved
 * email-link address expires after an hour (A-16).
 * Events wait in IndexedDB (memory if IndexedDB is unavailable) and go up in batches of at most 25, no more than
 * one batch every 6 seconds, when online.
 *
 * Google sign-in uses Google Identity Services (the same script calendar.js already loads) and
 * signInWithCredential. Firebase's popup/redirect helpers are never loaded, so there is no firebaseapp.com iframe.
 * See spec/ARCHITECTURE.md section 3 for why.
 */

/* ======================================================================================= constants */

/** Firebase JS SDK version. Pinned: released 2026-09-09. Must match the CSP script-src path. */
export const SDK_VERSION = "12.19.0";
/** Where the Firebase ES modules are loaded from. */
export const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
/** Google Identity Services script (already allowed by the v2.2 CSP). */
export const GIS_SRC = "https://accounts.google.com/gsi/client";
/** The consent text version the app currently shows. Bump it when the privacy wording changes. */
export const CONSENT_VERSION = 1;
/** The notice text version stored in each consent record (privacy/CONSENT.md: "2.2.0-2026-11"). */
export const NOTICE_VERSION = "2.2.0-2026-11";
/** Events per batch. Must equal the 0..24 index range in firestore.rules. */
export const FLUSH_MAX = 25;
/** Minimum gap between batches. firestore.rules requires more than 5 seconds. */
export const FLUSH_GAP_MS = 6000;
/** Events older than this are dropped from the queue (the rules cap lag at 7 days). */
export const MAX_LAG_S = 604800;
/** A-10: flushes allowed in one 24-hour window per account (firestore.rules), so at most 12,500 events a day. */
export const WINDOW_MAX = 500;
/** A-16: how long the address an email link was sent to is remembered. */
export const LINK_EMAIL_MS = 60 * 60 * 1000;
/** Queue cap per browser; the oldest events go first. */
export const QUEUE_MAX = 500;
/** A new session_start after this much inactivity. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

const LS = {
  consent: "vaani.a.consent",   // "<uid>:<version>", lets events queue offline after a consent this browser saw
  active: "vaani.a.active",     // last activity time (ms), for session_start
  linkEmail: "vaani.a.linkEmail", // the email an email link was sent to, removed after sign-in
  pendingDelete: "vaani.a.del", // uid whose data is deleted but whose login still needs removing
  delLink: "vaani.a.delLink",   // the random value the "Sign in again to delete" link carries as del= (sec23-final D7)
  purge: "vaani.a.purge",       // uid whose usage events still need deleting after stats were turned off
};
/** Events that are account basics: sent with or without the usage-stats opt-in, never with a device class. */
export const ACCOUNT_EVENTS = Object.freeze(["sign_up", "sign_in", "consent_update"]);
const NO_DEVICE = Object.freeze({ dev: "none", os: "none", br: "none" });
const SS_SRC = "vaani.a.src";

/* ======================================================================================= schema */

const enumOf = (values, coerce) => ({ t: "enum", values: Object.freeze(values), coerce: coerce || null });
const intIn = (lo, hi) => ({ t: "int", lo, hi });
const BOOL = { t: "bool" };

/** Closed value lists. They mirror firestore.rules; tests/client.test.js fails if the two drift apart. */
export const ENUMS = Object.freeze({
  method: ["google", "email"],
  src: ["direct", "pwa", "meet", "teams", "zoom", "ext", "calendar", "link"],
  mode: ["meeting", "note"],
  meetingType: ["management", "sales", "client", "developer", "founder", "cx", "daily", "general", "interview",
    "oneonone", "lecture", "other"],
  recLang: ["en-IN", "en-US", "en-GB", "hi-IN", "kn-IN", "ta-IN", "te-IN", "mr-IN", "bn-IN", "gu-IN", "ml-IN",
    "pa-IN", "ur-PK", "es-ES", "fr-FR", "de-DE", "ar-SA", "pt-BR", "ru-RU", "zh-CN", "ja-JP", "id-ID", "it-IT",
    "ko-KR", "other"],
  trLang: ["en", "hi", "kn", "ta", "te", "mr", "bn", "gu", "ml", "pa", "ur", "es", "fr", "de", "ar", "pt", "zh", "ja",
    "other"],
  engine: ["sarvam", "openai", "anthropic", "gemini", "chrome", "basic"],
  calResult: ["ok", "denied", "error"],
  callVia: ["meet", "zoom", "teams"],
  shareVia: ["whatsapp", "email", "native", "copy", "download"],
  feature: ["recap", "followup", "todo_done", "search", "folder", "backup", "restore", "install", "key_added",
    "copy_stats", "theme", "dictation"],
  dev: ["phone", "tablet", "laptop", "extension"],
  os: ["android", "ios", "windows", "mac", "linux", "chromeos", "other"],
  br: ["chrome", "edge", "safari", "firefox", "samsung", "opera", "other"],
});

const P = {
  method: enumOf(ENUMS.method),
  src: enumOf(ENUMS.src),
  mode: enumOf(ENUMS.mode),
  type: enumOf(ENUMS.meetingType, "other"),
  lang: enumOf(ENUMS.recLang, "other"),
  to: enumOf(ENUMS.trLang, "other"),
  engine: enumOf(ENUMS.engine),
  call: BOOL,
  words: intIn(0, 200000),
};

/**
 * The event allowlist. `req` props must be present, `opt` props may be. `internal` events are sent by this module
 * itself, inside the user-doc write they describe, and are refused by track().
 * @type {Readonly<Record<string, {req: Object, opt: Object, internal?: boolean, soon?: boolean}>>}
 */
export const EVENTS = Object.freeze({
  sign_up: { req: { method: P.method }, opt: {}, internal: true },
  sign_in: { req: { method: P.method }, opt: {}, internal: true },
  consent_update: { req: { version: intIn(1, 1000) }, opt: {}, internal: true },
  session_start: { req: { src: P.src }, opt: {} },
  record_start: { req: { mode: P.mode }, opt: { call: BOOL } },
  meeting_done: { req: { type: P.type, durS: intIn(0, 43200), lang: P.lang, engine: P.engine }, opt: { call: BOOL, words: P.words }, soon: true },
  note_done: { req: { durS: intIn(0, 7200), lang: P.lang, engine: P.engine }, opt: { words: P.words }, soon: true },
  insights_open: { req: {}, opt: {} },
  calendar_connect: { req: { result: enumOf(ENUMS.calResult) }, opt: {} },
  calendar_disconnect: { req: {}, opt: {} },
  calendar_join: { req: { via: enumOf(ENUMS.callVia) }, opt: {} },
  share: { req: { via: enumOf(ENUMS.shareVia) }, opt: {} },
  translate: { req: { to: P.to, engine: P.engine }, opt: {} },
  ask: { req: { engine: P.engine }, opt: {} },
  feature_used: { req: { f: enumOf(ENUMS.feature) }, opt: {} },
  sign_out: { req: {}, opt: {} },
});

function checkValue(spec, v) {
  if (spec.t === "bool") return typeof v === "boolean" ? { ok: true, v } : { ok: false };
  if (spec.t === "int") {
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
    const r = Math.round(v);
    return { ok: true, v: Math.min(spec.hi, Math.max(spec.lo, r)) }; // durations and counts are clamped, never refused
  }
  if (spec.t === "enum") {
    if (typeof v === "string" && spec.values.includes(v)) return { ok: true, v };
    if (spec.coerce && typeof v === "string" && v.length <= 40) return { ok: true, v: spec.coerce };
    return { ok: false };
  }
  return { ok: false };
}

/**
 * Check an event against the allowlist and return the props exactly as they will be stored.
 * Unknown names, unknown props, missing required props and wrong types are refused. Numbers are rounded and
 * clamped; a meeting type or language outside the list becomes "other".
 * @param {string} name event name
 * @param {Object} [props] event props
 * @param {{allowInternal?: boolean}} [o]
 * @returns {{ok: true, props: Object} | {ok: false, error: string}}
 */
export function validateEvent(name, props, o = {}) {
  const def = Object.prototype.hasOwnProperty.call(EVENTS, name) ? EVENTS[name] : null;
  if (!def) return { ok: false, error: `unknown event "${String(name).slice(0, 40)}"` };
  if (def.internal && !o.allowInternal) return { ok: false, error: `"${name}" is sent by the client itself` };
  const p = props == null ? {} : props;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "props must be an object" };
  const out = {};
  for (const k of Object.keys(p)) {
    if (p[k] === undefined) continue;
    const spec = def.req[k] || def.opt[k];
    if (!spec) return { ok: false, error: `"${name}" has no prop "${k.slice(0, 40)}"` };
    const r = checkValue(spec, p[k]);
    if (!r.ok) return { ok: false, error: `"${name}.${k}" has a value outside the allowed list or range` };
    out[k] = r.v;
  }
  for (const k of Object.keys(def.req)) if (!(k in out)) return { ok: false, error: `"${name}" needs "${k}"` };
  return { ok: true, props: out };
}

/**
 * Map the app's engine label (note.engine, or the provider id) to the engine enum.
 * @param {string} label e.g. "Sarvam AI", "Claude", "on-device AI", "Vaani's basic engine", "openai"
 * @returns {"sarvam"|"openai"|"anthropic"|"gemini"|"chrome"|"basic"}
 */
export function engineFromLabel(label) {
  const s = String(label || "").toLowerCase();
  if (s.includes("sarvam")) return "sarvam";
  if (s.includes("openai")) return "openai";
  if (s.includes("claude") || s.includes("anthropic")) return "anthropic";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("on-device") || s === "chrome") return "chrome";
  return "basic";
}

/**
 * Work out device class, OS and browser from the user agent. Categories only; the user agent itself is never sent.
 * @param {{userAgent?: string, maxTouchPoints?: number, userAgentData?: {mobile?: boolean}}} [nav] defaults to navigator
 * @param {string} [src] launch source; meet, teams, zoom and ext mean the Chrome extension window
 * @returns {{dev: string, os: string, br: string}}
 */
export function deviceInfo(nav, src) {
  const n = nav || (typeof navigator !== "undefined" ? navigator : {});
  const ua = String(n.userAgent || "");
  const touchMac = /Macintosh/.test(ua) && (n.maxTouchPoints || 0) > 1;
  let os = "other";
  if (/Android/i.test(ua)) os = "android";
  else if (/iPhone|iPad|iPod/.test(ua) || touchMac) os = "ios";
  else if (/CrOS/.test(ua)) os = "chromeos";
  else if (/Windows/.test(ua)) os = "windows";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "mac";
  else if (/Linux/.test(ua)) os = "linux";
  let br = "other";
  if (/SamsungBrowser/.test(ua)) br = "samsung";
  else if (/OPR\/|Opera/.test(ua)) br = "opera";
  else if (/Edg\/|EdgA\/|EdgiOS\//.test(ua)) br = "edge";
  else if (/Firefox\/|FxiOS\//.test(ua)) br = "firefox";
  else if (/Chrome\/|CriOS\//.test(ua)) br = "chrome";
  else if (/Safari\//.test(ua)) br = "safari";
  let dev = "laptop";
  if (["meet", "teams", "zoom", "ext"].includes(src)) dev = "extension";
  else if (/iPad|Tablet/.test(ua) || touchMac || (/Android/i.test(ua) && !/Mobile/.test(ua))) dev = "tablet";
  else if ((n.userAgentData && n.userAgentData.mobile) || /Mobi|iPhone|iPod|Android/.test(ua)) dev = "phone";
  return { dev, os, br };
}

/**
 * The event document exactly as firestore.rules expects it. `at` is the server's clock; `lag` says how many
 * seconds the event waited in the queue, so the dashboard can place it at the time it happened.
 * @param {{uid: string, name: string, p: Object, t: number, dev: string, os: string, br: string, v: string}} item
 * @param {number} now ms
 * @param {*} serverTs the Firestore serverTimestamp() sentinel
 * @returns {Object}
 */
export function buildEventDoc(item, now, serverTs) {
  const lag = Math.min(MAX_LAG_S, Math.max(0, Math.round((now - item.t) / 1000)));
  return { uid: item.uid, name: item.name, at: serverTs, lag, dev: item.dev, os: item.os, br: item.br, v: item.v, p: item.p };
}

/**
 * A 16-character [A-Za-z0-9] key from crypto.getRandomValues: the flush key and event id prefix.
 * @returns {string}
 */
export function randomKey() {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = new Uint8Array(16); globalThis.crypto.getRandomValues(b);
  let s = ""; for (let i = 0; i < 16; i++) s += abc[b[i] % 62];
  return s;
}

/**
 * A BCP-47 tag the rules accept, from navigator.language.
 * @param {string} [l]
 * @returns {string}
 */
export function cleanLocale(l) {
  // A-11: the same short-tag shape firestore.rules accepts (en, en-IN, zh-Hant-TW); anything else is "en"
  const s = String(l || "").trim();
  const m = /^([A-Za-z]{2,3})((?:-[A-Za-z0-9]{2,4}){0,2})$/.exec(s);
  return m ? m[1].toLowerCase() + m[2] : "en";
}
/** A-11: the notice languages firestore.rules accepts (English and the 22 Eighth Schedule languages). */
export const NOTICE_LANGS = Object.freeze(["en", "as", "bn", "brx", "doi", "gu", "hi", "kn", "ks", "kok", "mai", "ml", "mni",
  "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur"]);

/* ======================================================================================= queue */

/**
 * The offline queue: IndexedDB "vaani-analytics", store "q", with an in-memory fallback.
 * Items: { k, uid, name, p, t, dev, os, br, v, fk, tries }. fk is the flush key while a batch is in flight.
 */
function makeQueue() {
  let dbp = null; const mem = []; let memK = 0; let useMem = false;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        if (typeof indexedDB === "undefined") { useMem = true; return res(null); }
        const r = indexedDB.open("vaani-analytics", 1);
        r.onupgradeneeded = () => {
          const s = r.result.createObjectStore("q", { keyPath: "k", autoIncrement: true });
          s.createIndex("uid", "uid");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => { useMem = true; res(null); };
      } catch { useMem = true; res(null); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      if (!db) return res(fn(null));
      const t = db.transaction("q", mode); const s = t.objectStore("q"); let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    /** @param {Object} item */
    async add(item) {
      return tx("readwrite", async (s) => {
        if (!s || useMem) { mem.push({ ...item, k: ++memK }); while (mem.length > QUEUE_MAX) mem.shift(); return; }
        s.add(item);
        const n = await req(s.count());
        if (n > QUEUE_MAX) { // drop the oldest
          let drop = n - QUEUE_MAX; const c = s.openCursor();
          await new Promise((res) => { c.onsuccess = () => { const cur = c.result; if (!cur || drop <= 0) return res(); cur.delete(); drop--; cur.continue(); }; c.onerror = () => res(); });
        }
      });
    },
    /** @param {string} uid @returns {Promise<Object[]>} oldest first */
    async all(uid) {
      return tx("readonly", async (s) => {
        if (!s || useMem) return mem.filter((i) => i.uid === uid);
        return req(s.index("uid").getAll(uid));
      });
    },
    /** @param {number[]} ks @param {Object} patch */
    async patch(ks, patch) {
      return tx("readwrite", async (s) => {
        if (!s || useMem) { mem.forEach((i) => { if (ks.includes(i.k)) Object.assign(i, typeof patch === "function" ? patch(i) : patch); }); return; }
        for (const k of ks) { const it = await req(s.get(k)); if (it) s.put(Object.assign(it, typeof patch === "function" ? patch(it) : patch)); }
      });
    },
    /** @param {number[]} ks */
    async remove(ks) {
      return tx("readwrite", async (s) => {
        if (!s || useMem) { for (let i = mem.length - 1; i >= 0; i--) if (ks.includes(mem[i].k)) mem.splice(i, 1); return; }
        ks.forEach((k) => s.delete(k));
      });
    },
    /** @param {string} uid */
    async clear(uid) {
      const items = await this.all(uid).catch(() => []);
      return this.remove(items.map((i) => i.k));
    },
  };
}

/* ======================================================================================= state */

const S = {
  status: "loading", // loading | unconfigured | signed-out | unverified | needs-consent | delete-pending | ready | error
  declineTok: null,  // ID token held while the consent step is open: a closed tab removes the new login (R-1)
  autoResume: false, // this page load opened the link that confirms a deletion: finish it without asking
  configured: false, analytics: true, opts: null,
  fb: null, auth: null, db: null,
  user: null, profile: null, consent: false, isNew: false,
  pendingLogin: null, // "google" | "email" while a fresh sign-in is being recorded
  listeners: new Set(), timer: null, backoff: 0, lastFlush: 0, flushing: null, deleting: false,
  device: null, src: "direct", q: null, gisReady: null, gisInit: false, error: null,
  provisional: null, // uid from this browser's stored consent: lets events queue while offline before auth loads
  stats: false,      // the usage-stats opt-in for the signed-in account (users/{uid}.stats)
  win: null,         // A-10: {at, n} of the 24-hour flush window, as last seen
  gisMode: "signin", // "signin" or "reauth": what a Google credential from the button is for
  rawNonce: "",      // A-12: the nonce whose SHA-256 GIS puts in the ID token
  deleted: "",       // "done" after a deletion finished at a resumed sign-in, "failed" if it could not
  reauth: null,      // {provider} while a deletion waits for a fresh sign-in
};

function ls(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { /* storage blocked: the module still works, without offline consent memory */ }
  return null;
}
function log(...a) { if (S.opts && S.opts.debug) console.info("[vaani-analytics]", ...a); }
function code(e) { return (e && (e.code || e.name)) || "unknown"; }

/**
 * The current state, as passed to onState listeners.
 * @returns {{status: string, user: {uid: string, email: string, provider: string}|null, isNew: boolean,
 *   consentVersion: number, error: string|null}}
 */
export function getState() {
  const u = S.user;
  return {
    status: S.status,
    user: u ? { uid: u.uid, email: u.email, provider: providerOf(u), name: u.displayName || "" } : null,
    isNew: S.isNew,
    stats: !!S.stats,
    consentGiven: !!(S.profile && S.profile.consentVersion),
    deleted: S.deleted,
    reauth: S.reauth ? { provider: S.reauth.provider } : null,
    consentVersion: S.opts ? S.opts.consentVersion : CONSENT_VERSION,
    error: S.error,
  };
}
function emit(status) {
  if (status) S.status = status;
  const st = getState();
  S.listeners.forEach((fn) => { try { fn(st); } catch (e) { console.error(e); } });
}

/**
 * Resolves when the latest sign-in state has been fully handled (including recording a fresh login), so the app
 * can reload safely afterwards.
 * @returns {Promise<void>}
 */
export function whenSettled() { return Promise.resolve(S.handling).then(() => {}, () => {}); }

/**
 * Subscribe to state changes. The callback runs at once with the current state.
 * Statuses: "loading", "unconfigured" (placeholder config: everything is a no-op), "signed-out", "unverified",
 * "needs-consent" (show the consent screen, then call giveConsent), "ready", "error".
 * @param {(state: ReturnType<typeof getState>) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onState(fn) {
  S.listeners.add(fn);
  try { fn(getState()); } catch (e) { console.error(e); }
  return () => S.listeners.delete(fn);
}

function providerOf(u) {
  const p = u && u.providerData && u.providerData[0] && u.providerData[0].providerId;
  return p === "google.com" ? "google" : "email";
}

/* ======================================================================================= init */

function configLooksReal(c) {
  if (!c || typeof c !== "object") return false;
  for (const k of ["apiKey", "authDomain", "projectId", "appId"]) {
    if (typeof c[k] !== "string" || !c[k] || /VAANI_|REPLACE|YOUR_|<|>/i.test(c[k])) return false;
  }
  return true;
}
function localHost() {
  return typeof location !== "undefined" && ["localhost", "127.0.0.1"].includes(location.hostname);
}
function launchSrc(given) {
  const ok = (s) => ENUMS.src.includes(s);
  let s = null;
  try { s = sessionStorage.getItem(SS_SRC); } catch { /* blocked */ }
  if (!s) {
    let q = given;
    if (!q && typeof location !== "undefined") q = new URLSearchParams(location.search).get("src");
    if (q === "installed") q = "ext";
    if (q === "pwa" || (!q && typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches)) q = "pwa";
    s = ok(q) ? q : "direct";
    try { sessionStorage.setItem(SS_SRC, s); } catch { /* blocked */ }
  }
  return s;
}

/**
 * Start the client. Safe to call before the Firebase project exists: with the placeholder config it settles in
 * the "unconfigured" status and every other call is a harmless no-op (sign-in calls reject with "not-configured").
 * @param {{apiKey: string, authDomain: string, projectId: string, appId: string}} config VAANI_FIREBASE_CONFIG
 * @param {Object} [opts]
 * @param {string} [opts.appVersion="2.2.0"] x.y or x.y.z
 * @param {string} [opts.googleClientId] OAuth web client ID of the Firebase project (for the Google button)
 * @param {number} [opts.consentVersion=CONSENT_VERSION]
 * @param {string} [opts.src] launch source; defaults to ?src= or the installed-app display mode
 * @param {boolean} [opts.analytics=true] false for the admin dashboard: sign-in only, no events
 * @param {string} [opts.sdkBase=SDK_BASE] where the Firebase modules load from (self-hosting)
 * @param {{auth?: string, firestoreHost?: string, firestorePort?: number}} [opts.emulator] honoured on localhost only
 * @param {boolean} [opts.debug=false]
 * @returns {Promise<ReturnType<typeof getState>>}
 */
export async function init(config, opts = {}) {
  S.opts = { appVersion: "2.2.0", consentVersion: CONSENT_VERSION, analytics: true, sdkBase: SDK_BASE, debug: false, ...opts };
  if (!/^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/.test(S.opts.appVersion)) S.opts.appVersion = "0.0";
  S.analytics = S.opts.analytics !== false;
  S.src = launchSrc(S.opts.src);
  S.device = deviceInfo(undefined, S.src);
  S.q = makeQueue();
  // "<uid>:<version>:<stats 0|1>". Only an account that opted in to usage stats may queue events offline.
  const mark = /^([A-Za-z0-9]{1,128}):([0-9]{1,4})(?::([01]))?$/.exec(ls(LS.consent) || "");
  S.provisional = mark && Number(mark[2]) >= S.opts.consentVersion && mark[3] === "1" && S.analytics ? mark[1] : null;
  if (!configLooksReal(config)) { S.configured = false; emit("unconfigured"); return getState(); }
  S.configured = true; S.cfg = { apiKey: String(config.apiKey) };
  try {
    const base = S.opts.sdkBase;
    const [app, auth, fs] = await Promise.all([
      import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore-lite.js"),
    ]);
    S.fb = { app, auth, fs };
    const fa = app.initializeApp(config);
    // initializeAuth without popupRedirectResolver: the firebaseapp.com iframe and apis.google.com are never loaded
    S.auth = auth.initializeAuth(fa, { persistence: [auth.indexedDBLocalPersistence, auth.browserLocalPersistence] });
    S.db = fs.getFirestore(fa);
    if (S.opts.emulator && localHost()) {
      if (S.opts.emulator.auth) auth.connectAuthEmulator(S.auth, S.opts.emulator.auth, { disableWarnings: true });
      if (S.opts.emulator.firestoreHost) fs.connectFirestoreEmulator(S.db, S.opts.emulator.firestoreHost, S.opts.emulator.firestorePort || 8080);
    }
    auth.onAuthStateChanged(S.auth, (u) => { S.handling = handleUser(u).catch((e) => { S.error = code(e); log("auth state", e); emit("error"); }); });
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => schedule(500));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") { ls(LS.active, String(Date.now())); schedule(0); } else maybeSession();
      });
    }
  } catch (e) {
    S.error = code(e); log("init failed", e); emit("error");
    maybeSession(); // offline start: queue the session under the stored consent, if any
  }
  return getState();
}

function consentMark(uid) { return `${uid}:${S.opts.consentVersion}:${S.stats ? 1 : 0}`; }

async function handleUser(u) {
  S.user = u || null; S.profile = null; S.consent = false; S.isNew = false; S.error = null; S.stats = false;
  if (!u || u.uid !== S.provisional) S.provisional = null;
  if (!u) { emit("signed-out"); return; }
  if (!u.emailVerified) { emit("unverified"); return; }
  if (!S.analytics) { S.pendingLogin = null; emit("ready"); return; } // admin page: sign-in only, no profile, no events
  if (ls(LS.pendingDelete) === u.uid) {
    // the link that confirms a deletion was opened here: that click is the answer
    if (S.autoResume) { await resumeDeleteOnce(); return; }
    // otherwise a deletion that stopped part way is never finished silently: the app says so and asks (R-2)
    emit("delete-pending"); return;
  }
  const { fs } = S.fb;
  let snap = null;
  try { snap = await fs.getDoc(fs.doc(S.db, "users", u.uid)); } catch (e) {
    // offline at start: trust a consent this browser stored for this account, keep queueing, sync later
    const m = /^([A-Za-z0-9]{1,128}):([0-9]{1,4})(?::([01]))?$/.exec(ls(LS.consent) || "");
    if (m && m[1] === u.uid && Number(m[2]) >= S.opts.consentVersion) {
      S.consent = true; S.stats = m[3] === "1"; emit("ready"); maybeSession(); return;
    }
    throw e;
  }
  if (!snap.exists()) {
    // R-1: a login restored at page load with no account behind it was left at the consent step (the tab was
    // closed). Remove it quietly. A sign-in from the last 2 minutes is kept: that is a reload or a second tab.
    if (!S.pendingLogin && !recentSignIn(u)) { await dropOrphan(u); return; }
    // a login removed when the page was left (armDecline) can still hold a valid ID token: check it still exists
    if (!S.pendingLogin) {
      try { await u.reload(); } catch (e) {
        if (/user-not-found|user-token-expired|invalid-user-token|user-disabled/.test(code(e))) { await S.fb.auth.signOut(S.auth).catch(() => {}); return; }
      }
    }
    S.isNew = true; armDecline(u); emit("needs-consent"); return;
  }
  S.profile = snap.data();
  S.win = winOf(S.profile);
  // another tab or a reload may have flushed moments ago; the server's flushAt is the one the rules check
  if (S.profile.flushAt && S.profile.flushAt.toMillis) S.lastFlush = Math.max(S.lastFlush, S.profile.flushAt.toMillis());
  S.stats = S.profile.stats === true;
  if (!(S.profile.consentVersion >= S.opts.consentVersion)) { emit("needs-consent"); return; }
  S.consent = true; ls(LS.consent, consentMark(u.uid));
  emit("ready");
  if (S.pendingLogin && S.analytics) await recordLogin();
  if (!S.stats && ls(LS.purge) === u.uid) purgeStats().catch((e) => log("purge", code(e)));
  maybeSession();
  schedule(1000);
}

function recentSignIn(u) {
  const t = Date.parse((u.metadata && u.metadata.lastSignInTime) || "");
  return isFinite(t) && Date.now() - t < 2 * 60000;
}
/* R-1: delete a login nobody consented for. Firebase only allows this soon after the sign-in; if it is too late, the
   login is signed out here and stays in Firebase Authentication until the owner removes it (privacy-v22.html). */
async function dropOrphan(u) {
  S.declineTok = null;
  try { await S.fb.auth.deleteUser(u); return; } catch (e) { log("orphan login kept", code(e)); }
  await S.fb.auth.signOut(S.auth).catch(() => {});
}
/* R-1: while the consent step is open, keep a fresh ID token; if the page goes away without an answer, ask Firebase
   to delete the new login (a keepalive request, so it survives the tab closing). */
function armDecline(u) {
  S.declineTok = null;
  u.getIdToken().then((t) => { if (S.user === u && S.isNew && !S.consent) S.declineTok = t; }).catch(() => {});
  if (S.declineArmed || typeof window === "undefined") return;
  S.declineArmed = true;
  window.addEventListener("pagehide", () => {
    const t = S.declineTok; S.declineTok = null;
    if (!t || !S.isNew || S.consent || S.profile || !S.cfg) return;
    const emu = S.opts.emulator && S.opts.emulator.auth && localHost() ? String(S.opts.emulator.auth).replace(/\/$/, "") + "/identitytoolkit.googleapis.com" : "https://identitytoolkit.googleapis.com";
    try {
      fetch(emu + "/v1/accounts:delete?key=" + encodeURIComponent(S.cfg.apiKey), { method: "POST", keepalive: true, credentials: "omit", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: t }) }).catch(() => {});
    } catch { /* nothing more can be done from a closing page */ }
  });
}

/* ======================================================================================= sign-in */

function needAuth() {
  if (!S.configured) throw Object.assign(new Error("Sign-in is not set up yet."), { code: "not-configured" });
  if (!S.auth) throw Object.assign(new Error("Sign-in is still loading."), { code: "not-ready" });
}

function loadGis() {
  if (S.gisReady) return S.gisReady;
  S.gisReady = new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.id) return res();
    let s = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (!s) { s = document.createElement("script"); s.src = GIS_SRC; s.async = true; document.head.appendChild(s); }
    const done = () => (window.google && google.accounts && google.accounts.id ? res() : setTimeout(done, 50));
    s.addEventListener("load", done); s.addEventListener("error", () => { S.gisReady = null; rej(new Error("gis-load")); });
    if (window.google && google.accounts) done();
  });
  return S.gisReady;
}
/**
 * The claims in a Google ID token, read without checking the signature (Firebase checks it). Used only to refuse an
 * account before Firebase is asked (admin page) and to name the account in a re-sign-in. Accepts the emulator's
 * unsigned JSON tokens too.
 * @param {string} t
 * @returns {Object}
 */
export function tokenClaims(t) {
  try {
    const s = String(t || "");
    if (s.charAt(0) === "{") return JSON.parse(s);
    const p = s.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(p + "===".slice((p.length + 3) % 4)))));
  } catch { return {}; }
}
export async function sha256Hex(text) {
  const h = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function onGoogleCredential(r) {
  const t = r && r.credential; const raw = S.rawNonce;
  const fail = (e) => { S.error = code(e); emit(S.status); };
  // A-05: the admin page names the one account it serves; any other is refused before Firebase sees it, so no
  // Firebase Auth record is ever made for a curious visitor
  if (S.opts.onlyEmail) {
    const c = tokenClaims(t);
    if (String(c.email || "").toLowerCase() !== String(S.opts.onlyEmail).toLowerCase() || c.email_verified === false) {
      S.refused = String(c.email || ""); return fail({ code: "not-owner" });
    }
  }
  if (S.gisMode === "reauth") { reauthAndDelete(t, raw).catch(fail); return; }
  signInWithGoogleIdToken(t, raw).catch(fail);
}
async function gisInit() {
  needAuth();
  if (!S.opts.googleClientId) throw Object.assign(new Error("googleClientId is missing"), { code: "no-client-id" });
  await loadGis();
  if (!S.gisInit) {
    // A-12: GIS puts SHA-256(raw) in the ID token; Firebase checks it against the raw nonce, so a leaked token
    // cannot be replayed into another sign-in
    S.rawNonce = randomKey() + randomKey();
    google.accounts.id.initialize({
      client_id: S.opts.googleClientId, callback: onGoogleCredential, nonce: await sha256Hex(S.rawNonce),
      ux_mode: "popup", auto_select: false, itp_support: true, use_fedcm_for_prompt: true, context: "signin",
    });
    S.gisInit = true;
  }
}
/** @returns {string} the email GIS reported for an account the admin page refused, if any */
export function refusedEmail() { return S.refused || ""; }

/**
 * Render Google's "Continue with Google" button into an element. Clicking it opens Google's own sign-in
 * (FedCM or a Google popup), then signs in to Firebase with the returned ID token.
 * @param {HTMLElement} el an empty container
 * @param {{theme?: "outline"|"filled_blue"|"filled_black", width?: number, text?: string}} [o]
 * @returns {Promise<void>}
 */
export async function renderGoogleButton(el, o = {}) {
  await gisInit();
  S.gisMode = o.mode === "reauth" ? "reauth" : "signin";
  // Google's own button (40 px, "large"), drawn rectangular; the app scales it in a wrapper to 52 px with the
  // email button's 14 px corners (design S5), so the width asked for is the wrapper's width ÷ 1.3
  google.accounts.id.renderButton(el, {
    type: "standard", theme: o.theme || "outline", size: "large", text: o.text || "continue_with", shape: "rectangular",
    logo_alignment: "center", width: Math.round(Math.min(400, Math.max(200, o.width || 320))),
  });
}

/**
 * Show Google One Tap (FedCM in Chrome). Optional; the button is the main path.
 * @returns {Promise<void>}
 */
export async function showOneTap() {
  await gisInit();
  google.accounts.id.prompt();
}

/**
 * Sign in to Firebase with a Google ID token (from Google Identity Services). Counts as a login.
 * @param {string} idToken the JWT in the GIS credential response
 * @returns {Promise<{uid: string, email: string}>}
 */
function googleCredential(idToken, rawNonce) {
  const { auth } = S.fb;
  return rawNonce ? new auth.OAuthProvider("google.com").credential({ idToken, rawNonce }) : auth.GoogleAuthProvider.credential(idToken);
}
export async function signInWithGoogleIdToken(idToken, rawNonce) {
  needAuth();
  if (typeof idToken !== "string" || idToken.length < 20) throw Object.assign(new Error("No Google token"), { code: "bad-token" });
  const { auth } = S.fb;
  S.pendingLogin = "google";
  try {
    const r = await auth.signInWithCredential(S.auth, googleCredential(idToken, rawNonce));
    return { uid: r.user.uid, email: r.user.email };
  } catch (e) { S.pendingLogin = null; throw e; }
}

/**
 * Email a sign-in link (passwordless: there is no password to leak). The address is kept in localStorage only
 * until the link is used, so the same browser can finish without asking again.
 * @param {string} email
 * @param {{continueUrl?: string}} [o] defaults to this page with ?auth=link
 * @returns {Promise<void>}
 */
export async function sendEmailLink(email, o = {}) {
  needAuth();
  const e = String(email || "").trim();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw Object.assign(new Error("That email address doesn't look right."), { code: "bad-email" });
  const url = o.continueUrl || `${location.origin}${location.pathname}?auth=link`;
  await S.fb.auth.sendSignInLinkToEmail(S.auth, e, { url, handleCodeInApp: true });
  ls(LS.linkEmail, JSON.stringify({ e, t: Date.now() }));
}
/**
 * The address the last email link was sent to, if that was within the last hour (A-16). Older ones are removed.
 * @returns {string}
 */
export function savedLinkEmail() {
  let v = null; try { v = JSON.parse(ls(LS.linkEmail) || "null"); } catch { v = null; }
  if (v && typeof v.e === "string" && typeof v.t === "number" && Date.now() - v.t < LINK_EMAIL_MS && Date.now() >= v.t) return v.e;
  if (ls(LS.linkEmail) != null) ls(LS.linkEmail, null);
  return "";
}
/** Forget the saved email-link address ("Use a different email"). */
export function forgetLinkEmail() { ls(LS.linkEmail, null); }

/**
 * True when this page was opened from a sign-in email link.
 * @returns {boolean}
 */
export function isEmailLinkReturn() {
  return !!(S.auth && typeof location !== "undefined" && S.fb.auth.isSignInWithEmailLink(S.auth, location.href));
}

/**
 * Finish an email-link sign-in. Without an email argument it uses the address saved by sendEmailLink; if the link
 * was opened on another device, it rejects with code "need-email" and the app should ask for the address.
 * Removes the one-time code from the address bar afterwards. Counts as a login.
 * @param {string} [email]
 * @returns {Promise<{uid: string, email: string}>}
 */
export async function completeEmailLink(email) {
  needAuth();
  const e = String(email || savedLinkEmail() || "").trim();
  if (!e) throw Object.assign(new Error("Which email did you use?"), { code: "need-email" });
  S.pendingLogin = "email";
  // the link "Sign in again to delete" sends carries del=<the random value saved when it was sent>: opening that
  // link is the confirmation (A-01). Any other del= (a forged or old link) is not, so the app asks (R-2, sec23-final D7)
  try { const want = ls(LS.delLink); S.autoResume = !!want && new URL(location.href).searchParams.get("del") === want; } catch { S.autoResume = false; }
  try {
    const r = await S.fb.auth.signInWithEmailLink(S.auth, e, location.href);
    ls(LS.linkEmail, null);
    // a link that confirms a deletion: the same account signs in again, which may not count as a change of user,
    // so the deletion is finished here (A-01)
    if (ls(LS.pendingDelete) === r.user.uid && S.autoResume) { stripLinkParams(); S.user = r.user; await resumeDeleteOnce(); }
    return { uid: r.user.uid, email: r.user.email };
  } catch (err) { S.pendingLogin = null; throw err; } finally { stripLinkParams(); }
}
function stripLinkParams() {
  try {
    const u = new URL(location.href);
    ["apiKey", "oobCode", "mode", "lang", "continueUrl", "tenantId", "auth", "del"].forEach((k) => u.searchParams.delete(k));
    history.replaceState(history.state, "", u.pathname + (u.search || "") + u.hash);
  } catch { /* nothing to strip */ }
}

/* ======================================================================================= consent */

/**
 * True when this account has consented to the current consent version (events are being recorded).
 * @returns {boolean}
 */
export function hasConsent() { return !!(S.user && S.consent); }

/**
 * The consent record for users/{uid}/consents/{flushKey} (privacy/CONSENT.md, "Consent record: fields to store").
 * No IP address, user agent or location: only what was shown, what was chosen, how and when.
 * @param {string} uid
 * @param {"given"|"stats_on"|"stats_off"|"reconsent"} event
 * @param {boolean} stats the usage-stats choice this record states
 * @param {Object} rec { notice_version, notice_hash, notice_lang, policy_url, method?, surface? } from the app
 * @param {*} serverTs serverTimestamp() sentinel
 * @returns {Object}
 */
export function consentRecord(uid, event, stats, rec, serverTs) {
  const r = rec || {};
  const d = new Date(); const off = -d.getTimezoneOffset(); const sg = off >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 23) + sg + pad(off / 60) + ":" + pad(off % 60);
  const here = typeof location !== "undefined" ? location.origin + location.pathname.replace(/[^/]*$/, "") : "";
  return {
    uid, event,
    notice_version: String(r.notice_version || NOTICE_VERSION), notice_hash: String(r.notice_hash || ""),
    notice_lang: cleanLocale(r.notice_lang || "en"), policy_url: String(r.policy_url || here + "privacy.html"),
    account_consent: true, age_confirmed_18: true, stats_consent: !!stats,
    method: r.method || (providerOf(S.user) === "google" ? "checkbox+google_button" : "checkbox+email_link"),
    surface: ["web", "extension_window", "pwa"].includes(r.surface) ? r.surface
      : S.src === "pwa" ? "pwa" : ["meet", "teams", "zoom", "ext"].includes(S.src) ? "extension_window" : "web",
    app_version: S.opts ? S.opts.appVersion : "0.0", ts_server: serverTs, ts_client: local,
  };
}

/**
 * Store consent for the signed-in person. For a new person this creates users/{uid} and records the sign-up;
 * for a returning person on an older consent version it records the new version. Call it only after the person
 * actively agreed (a required unticked box they ticked, then a button).
 * The account basics are always kept; usage stats only when o.stats is true (a second, unticked box).
 * @param {{stats?: boolean, record?: Object}} [o] record: see consentRecord()
 * @returns {Promise<void>}
 */
export async function giveConsent(o = {}) {
  needAuth();
  if (!S.user) throw Object.assign(new Error("Sign in first."), { code: "signed-out" });
  const { fs } = S.fb; const uid = S.user.uid; const ver = S.opts.consentVersion;
  const ref = fs.doc(S.db, "users", uid);
  const method = providerOf(S.user);
  const stats = o.stats === true;
  // the record must prove which words were shown: the app passes the SHA-256 of the notice text
  if (!o.record || !/^[0-9a-f]{64}$/.test(String(o.record.notice_hash || ""))) {
    throw Object.assign(new Error("The consent record needs the notice's SHA-256."), { code: "no-notice" });
  }
  let withLogin = !!S.pendingLogin;
  S.declineTok = null; // answered: a closing tab must not remove this login any more
  // sec23-final D1/D4: a new login may have been deleted meanwhile (the page was left and came back from the
  // back-forward cache, or another tab cleaned it up as an orphan). Its ID token stays valid for up to an hour, and
  // the rules can't see that the login is gone, so ask Firebase Auth before an account doc is written for it.
  if (!S.profile) {
    try { await S.user.reload(); } catch (e) {
      if (/user-not-found|user-token-expired|invalid-user-token|user-disabled/.test(code(e))) {
        await S.fb.auth.signOut(S.auth).catch(() => {});
        throw Object.assign(new Error("This sign-in has ended. Sign in again."), { code: code(e) });
      }
    }
  }
  const attempt = (tries) => withRetry(async () => {
    const key = randomKey(); const b = fs.writeBatch(S.db); const now = Date.now();
    const evs = [];
    S.stats = stats; // item() reads it: without the opt-in, the account events carry no device class
    if (!S.profile) {
      b.set(ref, {
        email: S.user.email, provider: method, createdAt: fs.serverTimestamp(), lastLoginAt: fs.serverTimestamp(),
        loginCount: 1, plan: "free", locale: cleanLocale(navigator.language), consentVersion: ver,
        consentAt: fs.serverTimestamp(), flushAt: fs.serverTimestamp(), flushKey: key,
        stats, statsAt: fs.serverTimestamp(), winAt: fs.serverTimestamp(), winN: 1,
      });
      b.set(fs.doc(S.db, "users", uid, "consents", key), consentRecord(uid, "given", stats, o.record, fs.serverTimestamp()));
      evs.push(item("sign_up", { method }, now));
    } else {
      const up = { consentVersion: ver, consentAt: fs.serverTimestamp(), flushAt: fs.serverTimestamp(), flushKey: key,
        stats, statsAt: fs.serverTimestamp(), ...winUpdate() };
      b.set(fs.doc(S.db, "users", uid, "consents", key), consentRecord(uid, "reconsent", stats, o.record, fs.serverTimestamp()));
      evs.push(item("consent_update", { version: ver }, now));
      if (withLogin) {
        Object.assign(up, { loginCount: fs.increment(1), lastLoginAt: fs.serverTimestamp(), locale: cleanLocale(navigator.language) });
        evs.push(item("sign_in", { method: S.pendingLogin }, now));
      }
      b.update(ref, up);
    }
    evs.forEach((e, i) => b.set(fs.doc(S.db, "events", `${key}_${i}`), buildEventDoc(e, now, fs.serverTimestamp())));
    await b.commit();
  }, tries);
  try {
    try { await attempt(withLogin ? 1 : 3); } catch (e) {
      // the rules count at most one login a minute; consent must not fail because of that
      if (!withLogin) throw e;
      withLogin = false; await attempt(3);
    }
  } catch (e) {
    // an earlier attempt may have landed with its answer lost: if the stored consent is current, that is success
    const snap = await fs.getDoc(ref).catch(() => null);
    if (!(snap && snap.exists() && snap.data().consentVersion >= ver)) throw e;
  }
  S.pendingLogin = null; S.consent = true; S.lastFlush = Date.now();
  const snap = await fs.getDoc(ref).catch(() => null);
  S.profile = snap && snap.exists() ? snap.data() : (S.profile || {});
  S.stats = S.profile.stats === true;
  S.win = winOf(S.profile);
  ls(LS.consent, consentMark(uid));
  emit("ready");
  maybeSession();
}

/* ---------- A-10: the 24-hour flush window ---------- */
function winOf(p) {
  return p && p.winAt && p.winAt.toMillis ? { at: p.winAt.toMillis(), n: Number(p.winN) || 0 } : null;
}
// a fresh window only when this clock says a day (and 10 minutes for clock drift) has passed; otherwise +1
function winUpdate() {
  const { fs } = S.fb;
  if (S.win && Date.now() - S.win.at > 86400000 + 600000) return { winAt: fs.serverTimestamp(), winN: 1 };
  return { winN: fs.increment(1) };
}
function winAfter(up) {
  if (up.winN === 1) S.win = { at: Date.now(), n: 1 }; else if (S.win) S.win.n += 1;
}

/**
 * Say no at the consent step. For someone new (no account yet), the Firebase Auth record that sign-in just made is
 * deleted, so nothing is kept about a person who declined (A-05); then sign out. Someone who already has an account
 * and declines a newer notice is only signed out: their account stays until they delete it.
 * @returns {Promise<{removed: boolean}>}
 */
export async function declineConsent() {
  needAuth();
  const u = S.user; let removed = false; S.declineTok = null;
  if (u && !S.profile) {
    try { await S.fb.auth.deleteUser(u); removed = true; } catch (e) { log("decline: login kept", code(e)); }
  }
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch { /* GIS not loaded */ }
  if (!removed) await S.fb.auth.signOut(S.auth).catch(() => {});
  return { removed };
}

/**
 * Turn the usage-stats opt-in on or off (Settings). Writes the choice and a consent record ("stats_on" or
 * "stats_off") in one flush. Turning it off drops this account's queued usage events and deletes the usage events
 * already stored (the account events stay: they are the required account basics). If that deletion is cut short
 * (offline, closed tab), it resumes at the next start.
 * @param {boolean} on
 * @param {Object} [record] see consentRecord(); method defaults to "settings_toggle"
 * @returns {Promise<{stats: boolean, purged?: number}>}
 */
export async function setStats(on, record) {
  needAuth();
  if (!S.user || !S.consent) throw Object.assign(new Error("Sign in first."), { code: "signed-out" });
  const want = on === true; const uid = S.user.uid; const { fs } = S.fb;
  if (want === S.stats) return { stats: S.stats };
  if (!want) { // nothing queued for later may go up once the person said no
    const items = await S.q.all(uid).catch(() => []);
    await S.q.remove(items.filter((i) => !ACCOUNT_EVENTS.includes(i.name)).map((i) => i.k)).catch(() => {});
  }
  const before = S.stats;
  S.stats = want;
  const rec = { method: "settings_toggle", ...(record || {}) };
  if (!/^[0-9a-f]{64}$/.test(String(rec.notice_hash || ""))) {
    throw Object.assign(new Error("The consent record needs the notice's SHA-256."), { code: "no-notice" });
  }
  try {
    await withRetry(() => flushOnce({
      user: { stats: want, statsAt: fs.serverTimestamp() }, events: [],
      consent: (key) => consentRecord(uid, want ? "stats_on" : "stats_off", want, rec, fs.serverTimestamp()),
    }), 3);
  } catch (e) {
    // a lost answer may still have landed
    const snap = await fs.getDoc(fs.doc(S.db, "users", uid)).catch(() => null);
    if (!(snap && snap.exists() && snap.data().stats === want)) { S.stats = before; throw e; }
  }
  S.lastFlush = Date.now();
  ls(LS.consent, consentMark(uid));
  emit("ready");
  if (want) { maybeSession(); return { stats: true }; }
  ls(LS.purge, uid);
  const purged = await purgeStats().catch((e) => { log("purge", code(e)); return -1; });
  return { stats: false, purged };
}

/**
 * Delete this account's stored usage events (not the account events), after stats were turned off. The rules allow
 * it only while users/{uid}.stats is false. Pages through the account's events 400 at a time.
 * @returns {Promise<number>} how many were deleted
 */
export async function purgeStats() {
  if (!S.user || S.stats || !S.fb) return 0;
  const { fs } = S.fb; const uid = S.user.uid; let n = 0; let last = null;
  for (;;) {
    const parts = [fs.collection(S.db, "events"), fs.where("uid", "==", uid), fs.orderBy("at"), fs.limit(400)];
    if (last) parts.splice(3, 0, fs.startAfter(last));
    const snap = await fs.getDocs(fs.query(...parts));
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1];
    const del = snap.docs.filter((d) => !ACCOUNT_EVENTS.includes(d.data().name));
    if (del.length) { const b = fs.writeBatch(S.db); del.forEach((d) => b.delete(d.ref)); await b.commit(); n += del.length; }
    if (snap.size < 400) break;
  }
  ls(LS.purge, null);
  return n;
}

/** @returns {boolean} true when the signed-in account opted in to usage stats */
export function hasStats() { return !!(S.user && S.consent && S.stats); }

function plainValue(v) {
  if (v && typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plainValue);
  if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach((k) => { o[k] = plainValue(v[k]); }); return o; }
  return v;
}

/**
 * Everything this account holds, for "Download my data": the sign-in profile, the account document, every consent
 * record and every event (account and usage). Times are ISO strings. Notes are not part of it: they never leave
 * the browser.
 * @returns {Promise<Object>}
 */
export async function exportMyData() {
  needAuth();
  if (!S.user) throw Object.assign(new Error("Sign in first."), { code: "signed-out" });
  const { fs } = S.fb; const u = S.user; const uid = u.uid;
  const snap = await fs.getDoc(fs.doc(S.db, "users", uid));
  const cons = await fs.getDocs(fs.query(fs.collection(S.db, "users", uid, "consents"), fs.limit(500)));
  const events = []; let last = null;
  for (;;) {
    const parts = [fs.collection(S.db, "events"), fs.where("uid", "==", uid), fs.orderBy("at"), fs.limit(500)];
    if (last) parts.splice(3, 0, fs.startAfter(last));
    const es = await fs.getDocs(fs.query(...parts));
    es.docs.forEach((d) => events.push({ id: d.id, ...plainValue(d.data()) }));
    if (es.size < 500) break;
    last = es.docs[es.docs.length - 1];
  }
  return {
    app: "vaani", kind: "account-data", exported: new Date().toISOString(),
    note: "Everything your Vaani account holds. Your notes are not here: they stay in your browser.",
    signIn: {
      uid, email: u.email || "", name: u.displayName || "", provider: providerOf(u), emailVerified: !!u.emailVerified,
      created: u.metadata && u.metadata.creationTime ? new Date(u.metadata.creationTime).toISOString() : "",
      lastSignIn: u.metadata && u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).toISOString() : "",
    },
    account: snap.exists() ? plainValue(snap.data()) : null,
    consents: cons.docs.map((d) => ({ id: d.id, ...plainValue(d.data()) })),
    events,
  };
}

// rules allow one flush every 5 s; a write right after another one waits and tries again
async function withRetry(fn, tries = 3) {
  const wait = Math.max(0, FLUSH_GAP_MS - (Date.now() - S.lastFlush));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !["permission-denied", "unavailable", "aborted", "deadline-exceeded"].includes(code(e))) throw e;
      await new Promise((r) => setTimeout(r, FLUSH_GAP_MS * (i + 1)));
    }
  }
}

/* ======================================================================================= tracking */

function item(name, p, t, uid) {
  const d = (S.stats || (!S.user && S.provisional)) ? (S.device || deviceInfo(undefined, S.src)) : NO_DEVICE;
  return { uid: uid || S.user.uid, name, p, t: t || Date.now(), dev: d.dev, os: d.os, br: d.br, v: S.opts.appVersion, fk: null, tries: 0 };
}

/**
 * Record a usage event. Synchronous and never throws. Returns false (and sends nothing) when the event is not
 * in the allowlist, a prop is wrong, the client is unconfigured, nobody is signed in, or the person has not
 * consented yet. Events are queued, then sent in the next batch.
 * @param {string} name one of the names in EVENTS (not sign_up, sign_in or consent_update)
 * @param {Object} [props]
 * @returns {boolean} true when queued
 */
export function track(name, props) {
  try {
    if (!S.configured || !S.analytics || S.deleting) return false;
    // signed in with consent and the usage-stats opt-in; or, while auth is still loading or could not load
    // (offline start), the opted-in account whose consent this browser stored. Anything else is dropped: no events
    // before consent, and none at all without the opt-in.
    const uid = S.user ? (S.consent && S.stats ? S.user.uid : null)
      : (S.status === "loading" || S.status === "error") ? S.provisional : null;
    if (!uid) return false;
    const v = validateEvent(name, props);
    if (!v.ok) { log("refused:", v.error); return false; }
    ls(LS.active, String(Date.now()));
    S.q.add(item(name, v.props, Date.now(), uid)).then(() => schedule(EVENTS[name].soon ? 2000 : 30000)).catch((e) => log("queue", e));
    return true;
  } catch (e) { log("track", e); return false; }
}

function maybeSession() {
  if (!((S.consent && S.stats) || S.provisional) || !S.analytics) return;
  const last = Number(ls(LS.active) || 0);
  if (Date.now() - last > SESSION_GAP_MS) track("session_start", { src: S.src });
  else ls(LS.active, String(Date.now()));
}

function schedule(ms) {
  if (!S.configured || !S.analytics) return;
  const due = Math.max(ms, FLUSH_GAP_MS - (Date.now() - S.lastFlush), S.backoff);
  if (S.timer && S.timerAt <= Date.now() + due) return;
  clearTimeout(S.timer);
  S.timerAt = Date.now() + due;
  S.timer = setTimeout(() => { S.timer = null; flush().catch((e) => log("flush", e)); }, due);
}

/**
 * Send queued events now (one batch of at most 25; more batches follow automatically).
 * Only one tab flushes at a time (Web Locks). Safe to call any time; it does nothing when offline, signed out or
 * without consent.
 * @returns {Promise<number>} how many events were sent
 */
export async function flush() {
  if (!S.configured || !S.analytics || !S.user || !S.consent || S.deleting) return 0;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
  if (S.flushing) return S.flushing;
  // the rules accept one batch every 5 seconds: wait out the gap rather than be refused
  const gapped = () => {
    const wait = FLUSH_GAP_MS - (Date.now() - S.lastFlush);
    return wait > 0 ? new Promise((r) => setTimeout(r, wait)).then(() => flushOnce()) : flushOnce();
  };
  const p = (navigator.locks && navigator.locks.request)
    ? navigator.locks.request("vaani-analytics-flush", { ifAvailable: true }, (lock) => (lock ? gapped() : 0))
    : gapped();
  S.flushing = p.finally(() => { S.flushing = null; });
  return S.flushing;
}

async function flushOnce(extra) {
  const { fs } = S.fb; const uid = S.user.uid; const now = Date.now();
  let items = await S.q.all(uid);
  // 1. an earlier batch that never confirmed: if its first event exists, the whole batch landed
  const pending = [...new Set(items.filter((i) => i.fk).map((i) => i.fk))];
  for (const fk of pending) {
    const ks = items.filter((i) => i.fk === fk).map((i) => i.k);
    const snap = await fs.getDoc(fs.doc(S.db, "events", `${fk}_0`));
    if (snap.exists()) await S.q.remove(ks); else await S.q.patch(ks, { fk: null });
  }
  items = (await S.q.all(uid)).sort((a, b) => a.k - b.k);
  const stale = items.filter((i) => now - i.t > MAX_LAG_S * 1000 || i.tries >= 3).map((i) => i.k);
  if (stale.length) { await S.q.remove(stale); items = items.filter((i) => !stale.includes(i.k)); }
  const head = extra ? extra.events : [];
  const take = items.slice(0, FLUSH_MAX - head.length);
  if (!take.length && !head.length && !(extra && extra.user)) return 0; // a user-doc change (the stats switch) is written even with no events

  const key = randomKey();
  const b = fs.writeBatch(S.db);
  const win = winUpdate();
  b.update(fs.doc(S.db, "users", uid), { flushAt: fs.serverTimestamp(), flushKey: key, ...win, ...(extra ? extra.user : {}) });
  head.concat(take).forEach((it, i) => b.set(fs.doc(S.db, "events", `${key}_${i}`), buildEventDoc(it, now, fs.serverTimestamp())));
  if (extra && extra.consent) b.set(fs.doc(S.db, "users", uid, "consents", key), extra.consent(key));
  const ks = take.map((i) => i.k);
  await S.q.patch(ks, { fk: key });
  try {
    await b.commit();
    winAfter(win);
    await S.q.remove(ks);
    S.lastFlush = Date.now(); S.backoff = 0;
    if (items.length > take.length) schedule(FLUSH_GAP_MS);
    log("sent", head.length + take.length);
    return head.length + take.length;
  } catch (e) {
    const c = code(e);
    // a refused flush may be the window being full or out of date: read it again before the next try
    if (c === "permission-denied") { const snap = await fs.getDoc(fs.doc(S.db, "users", uid)).catch(() => null); if (snap && snap.exists()) S.win = winOf(snap.data()); }
    await S.q.patch(ks, (it) => ({ fk: null, tries: it.tries + (c === "permission-denied" ? 1 : 0) }));
    S.backoff = Math.min(600000, Math.max(15000, S.backoff * 2));
    schedule(S.backoff);
    log("batch failed", c);
    if (extra) throw e;
    return 0;
  }
}

async function recordLogin() {
  const method = S.pendingLogin; S.pendingLogin = null;
  const { fs } = S.fb; const now = Date.now();
  const wait = Math.max(0, FLUSH_GAP_MS - (now - S.lastFlush));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  try {
    await flushOnce({
      user: { loginCount: fs.increment(1), lastLoginAt: fs.serverTimestamp(), locale: cleanLocale(navigator.language) },
      events: [item("sign_in", { method }, now)],
    });
  } catch (e) {
    // the rules count at most one login a minute; a quick sign-out and sign-in again is not a second login
    log("login not counted", code(e));
  }
}

/* ======================================================================================= sign-out, delete */

/**
 * Sign out: sends what is queued (up to 4 seconds), clears this account's queue and signs out of Firebase and of
 * Google's automatic sign-in on this site.
 * @returns {Promise<void>}
 */
export async function signOut() {
  if (!S.auth) return;
  if (S.user) {
    track("sign_out");
    await Promise.race([flush(), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    await S.q.clear(S.user.uid).catch(() => {});
  }
  ls(LS.consent, null); ls(LS.active, null);
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch { /* GIS not loaded */ }
  await S.fb.auth.signOut(S.auth);
}

/**
 * Delete the account: marks users/{uid} for deletion, deletes every event and consent record of this account, deletes
 * users/{uid}, then deletes the Firebase login. Firebase asks for a recent sign-in before removing a login. When it
 * does, the data is already gone and this resolves { done: false, needsSignIn: true, provider }: the person stays
 * signed in, and the app asks them to confirm with Google (reauthAndDelete) or with an email link, which finishes the
 * deletion. If they leave instead (cancelDelete), the next sign-in on this browser finishes it (A-01).
 * @returns {Promise<{done: boolean, needsSignIn?: boolean, provider?: string}>}
 */
export async function deleteAccount() {
  needAuth();
  const u = S.user;
  if (!u) throw Object.assign(new Error("Sign in first."), { code: "signed-out" });
  const { fs } = S.fb; const uid = u.uid;
  S.deleting = true; clearTimeout(S.timer);
  ls(LS.pendingDelete, uid);
  try {
    await S.q.clear(uid).catch(() => {});
    const ref = fs.doc(S.db, "users", uid);
    // 1. the mark (fails harmlessly if already marked or already gone)
    await fs.updateDoc(ref, { deleteAt: fs.serverTimestamp() }).catch((e) => log("mark", code(e)));
    // 2. events, 400 at a time
    for (;;) {
      const snap = await fs.getDocs(fs.query(fs.collection(S.db, "events"), fs.where("uid", "==", uid), fs.limit(400)));
      if (snap.empty) break;
      const b = fs.writeBatch(S.db); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit();
    }
    // 3. the consent records, then the user doc (both allowed only after the mark, or once the doc is gone)
    for (;;) {
      const cs = await fs.getDocs(fs.query(fs.collection(S.db, "users", uid, "consents"), fs.limit(400)));
      if (cs.empty) break;
      const b = fs.writeBatch(S.db); cs.docs.forEach((d) => b.delete(d.ref)); await b.commit();
    }
    // A-01: a resumed deletion finds the doc already gone; there is nothing to delete then
    const left = await fs.getDoc(ref);
    if (left.exists()) await fs.deleteDoc(ref);
    ls(LS.consent, null); ls(LS.active, null); ls(LS.purge, null);
    S.consent = false; S.profile = null; S.pendingLogin = null;
    // 4. the login
    return await deleteLogin(u);
  } finally {
    S.deleting = !!S.reauth; // still deleting while the fresh sign-in is asked for: nothing may be queued or sent
  }
}

async function deleteLogin(u) {
  const { auth } = S.fb;
  try {
    await auth.deleteUser(u);
  } catch (e) {
    if (code(e) === "auth/requires-recent-login") {
      S.reauth = { provider: providerOf(u), uid: u.uid };
      emit(S.status);
      return { done: false, needsSignIn: true, provider: providerOf(u) };
    }
    throw e;
  }
  S.reauth = null; S.deleting = false;
  ls(LS.pendingDelete, null); ls(LS.delLink, null);
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch { /* GIS not loaded */ }
  return { done: true };
}

/**
 * Finish a deletion that is waiting for a fresh Google sign-in: re-sign in with the Google ID token, then delete the
 * login. The token must belong to the same account.
 * @param {string} idToken @param {string} [rawNonce]
 * @returns {Promise<{done: boolean}>}
 */
export async function reauthAndDelete(idToken, rawNonce) {
  needAuth();
  const u = S.user;
  if (!u || !S.reauth) throw Object.assign(new Error("Nothing to confirm."), { code: "no-reauth" });
  // another Google account is refused here, before Firebase sees it: reauthenticating with it would make an Auth
  // record for that account first (the A-05 problem)
  if (String(tokenClaims(idToken).email || "").toLowerCase() !== String(u.email || "").toLowerCase()) {
    throw Object.assign(new Error("A different Google account."), { code: "auth/user-mismatch" });
  }
  await S.fb.auth.reauthenticateWithCredential(u, googleCredential(idToken, rawNonce));
  const r = await deleteLogin(u);
  if (r.done) { S.deleted = "done"; emit(S.status); }
  return r;
}

/**
 * Send the email link that confirms a deletion for an email-link account. Opening it signs in fresh, and the
 * deletion finishes by itself (the uid is kept in localStorage until it does).
 * @param {string} [continueUrl]
 */
export async function sendDeleteLink(continueUrl) {
  needAuth();
  if (!S.user || !S.reauth) throw Object.assign(new Error("Nothing to confirm."), { code: "no-reauth" });
  // sec23-final D7: the link carries a random value only this browser knows, so a crafted ?del= URL can't stand in for it
  const t = randomKey(); const u = new URL(continueUrl || `${location.origin}${location.pathname}?auth=link`, location.href);
  u.searchParams.set("del", t); ls(LS.delLink, t);
  await sendEmailLink(S.user.email, { continueUrl: u.href });
}

/**
 * Leave a deletion that waits for a fresh sign-in: sign out. The data is already deleted; the next sign-in on this
 * browser removes the login (resumeDelete).
 */
export async function cancelDelete() {
  S.reauth = null; S.deleting = false;
  await S.fb.auth.signOut(S.auth).catch(() => {});
}

/**
 * Finish a deletion that stopped part way, after the app has told the person and they chose to finish (R-2). The
 * outcome arrives as state: deleted "done", a re-sign-in request (reauth), or deleted "failed".
 */
export function resumePendingDelete() {
  needAuth();
  if (!S.user || ls(LS.pendingDelete) !== S.user.uid) return Promise.resolve();
  return resumeDeleteOnce();
}

/** The app has shown the "deleted" notice: clear it. */
export function ackDeleted() { S.deleted = ""; }

function resumeDeleteOnce() {
  if (!S.resuming) S.resuming = resumeDelete().finally(() => { S.resuming = null; });
  return S.resuming;
}
// the next sign-in after a deletion that stopped at "sign in again" (A-01)
async function resumeDelete() {
  S.provisional = null;
  try {
    const r = await deleteAccount();
    S.deleted = r.done ? "done" : "";
    if (!r.done) return; // still too old a sign-in (unlikely right after signing in): the panel asks again
    emit(S.status); // the sign-out was announced before this was known: announce the outcome
  } catch (e) {
    // sign out and say what happened. The pending mark stays, so the next sign-in here asks again (R-2): part of the
    // account may already be deleted, and only finishing it leaves nothing behind
    log("resume delete", code(e));
    S.reauth = null; S.deleting = false; S.deleted = "failed";
    await S.fb.auth.signOut(S.auth).catch(() => {});
    emit(S.status);
  }
}

/* ======================================================================================= under 18 */

/** The IST calendar day, yyyy-mm-dd. */
export function istDayOf(ms) { return new Date(ms + 330 * 60000).toISOString().slice(0, 10); }
/** Buckets of the anonymous counter. */
export const ANON_BUCKETS = Object.freeze(["open", "meeting", "note"]);

/**
 * Add one to today's anonymous counter for a bucket (people under 18: no account, no personal data).
 * The write is exactly { day, b, n: +1 } at anon/<day>_<bucket>: no uid, no device id, no user agent, no time of
 * day. Firebase Auth is not loaded. Returns false (and sends nothing) with the placeholder config or a bad bucket.
 * @param {Object} config VAANI_FIREBASE_CONFIG
 * @param {"open"|"meeting"|"note"} bucket
 * @param {{sdkBase?: string, emulator?: {firestoreHost?: string, firestorePort?: number}}} [opts]
 * @returns {Promise<boolean>}
 */
export async function countAnon(config, bucket, opts = {}) {
  try {
    if (!configLooksReal(config) || !ANON_BUCKETS.includes(bucket)) return false;
    const base = opts.sdkBase || SDK_BASE;
    if (!S.anon) {
      const [app, fs] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-firestore-lite.js")]);
      const fa = app.initializeApp(config, "vaani-anon");
      const db = fs.getFirestore(fa);
      if (opts.emulator && opts.emulator.firestoreHost && localHost()) fs.connectFirestoreEmulator(db, opts.emulator.firestoreHost, opts.emulator.firestorePort || 8080);
      S.anon = { fs, db };
    }
    const { fs, db } = S.anon; const day = istDayOf(Date.now());
    await fs.setDoc(fs.doc(db, "anon", `${day}_${bucket}`), { day, b: bucket, n: fs.increment(1) }, { merge: true });
    return true;
  } catch (e) { log("anon", code(e)); return false; }
}

/* ======================================================================================= admin */

/**
 * For admin.js only: the loaded Firestore module and database, to run the owner's read queries. The rules decide
 * what these can read; for anyone but the owner, every analytics read is refused.
 * @returns {{fs: Object, db: Object, auth: Object} | null}
 */
export function adminHandles() {
  return S.db ? { fs: S.fb.fs, db: S.db, auth: S.auth } : null;
}
