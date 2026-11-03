/**
 * Vaani admin dashboard: data shaping, with no DOM and no Firebase in it (tests/admin.test.js runs it in Node).
 * - IST day helpers (the dashboard counts days and hours in India Standard Time, UTC+05:30, no daylight saving)
 * - rollupDay(): one IST day of events into the daily/{day} document the rules allow the owner to store
 * - combine(): many daily roll-ups into everything the dashboard draws
 * - makeMock(): a seeded sample dataset for admin.html?mock=1
 * - toCsv(): CSV with spreadsheet-formula injection blocked
 */

export const IST_MS = 330 * 60000;
const DAY = 86400000;

/** @param {number} ms @returns {string} the IST calendar day, yyyy-mm-dd */
export function istDay(ms) { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
/** @param {string} day yyyy-mm-dd @returns {number} ms at 00:00 IST that day */
export function dayStart(day) { return Date.parse(`${day}T00:00:00Z`) - IST_MS; }
/** @param {number} ms @returns {{wd: number, h: number}} weekday (0 Monday .. 6 Sunday) and hour in IST */
export function istSlot(ms) { const d = new Date(ms + IST_MS); return { wd: (d.getUTCDay() + 6) % 7, h: d.getUTCHours() }; }
/**
 * The n complete IST days before today, oldest first.
 * @param {number} n @param {number} now ms @returns {string[]}
 */
export function pastDays(n, now) {
  const today = dayStart(istDay(now)); const out = [];
  for (let i = n; i >= 1; i--) out.push(istDay(today - i * DAY + 3600000));
  return out;
}

/** Duration buckets for meetings, in minutes. Labels avoid dashes (house copy rule). */
export const DUR_BUCKETS = [
  { k: "d0", max: 5, label: "Under 5 min", short: "<5" }, { k: "d1", max: 15, label: "5 to 15 min", short: "5-15" },
  { k: "d2", max: 30, label: "15 to 30 min", short: "15-30" }, { k: "d3", max: 60, label: "30 to 60 min", short: "30-60" },
  { k: "d4", max: 90, label: "1 to 1.5 hours", short: "60-90" }, { k: "d5", max: Infinity, label: "Over 1.5 hours", short: "90+" },
];
function durKey(sec) { const m = sec / 60; return DUR_BUCKETS.find((b) => m < b.max).k; }

/** Event to feature key, for the feature table. */
export function featureOf(e) {
  switch (e.name) {
    case "insights_open": return "insights";
    case "calendar_connect": return e.p && e.p.result === "ok" ? "calendar" : null;
    case "calendar_join": return "join";
    case "share": return "share";
    case "translate": return "translate";
    case "ask": return "ask";
    case "feature_used": return e.p && e.p.f ? e.p.f : null;
    default: return null;
  }
}
export const FEATURE_LABELS = {
  insights: "Insights", calendar: "Calendar connected", join: "Join from calendar", share: "Share", translate: "Translate",
  ask: "Ask a meeting", recap: "Weekly recap", followup: "Follow-up draft", todo_done: "To-do ticked", search: "Search",
  folder: "Folders", backup: "Backup", restore: "Restore", install: "Installed app", key_added: "Own AI key added",
  copy_stats: "Copy my stats", theme: "Theme changed", dictation: "Dictation",
};
export const TYPE_LABELS = {
  sales: "Sales", management: "Management", client: "Client", developer: "Developer or tech", founder: "Founders",
  cx: "Customer support", daily: "Daily team call", general: "General", interview: "Interview", oneonone: "One-on-one",
  lecture: "Lecture or class", other: "Other",
};
export const LANG_LABELS = {
  "en-IN": "English (India)", "en-US": "English (US)", "en-GB": "English (UK)", "hi-IN": "Hindi", "kn-IN": "Kannada",
  "ta-IN": "Tamil", "te-IN": "Telugu", "mr-IN": "Marathi", "bn-IN": "Bengali", "gu-IN": "Gujarati", "ml-IN": "Malayalam",
  "pa-IN": "Punjabi", "ur-PK": "Urdu", "es-ES": "Spanish", "fr-FR": "French", "de-DE": "German", "ar-SA": "Arabic",
  "pt-BR": "Portuguese", "ru-RU": "Russian", "zh-CN": "Chinese", "ja-JP": "Japanese", "id-ID": "Indonesian",
  "it-IT": "Italian", "ko-KR": "Korean", other: "Other",
};
export const DEV_LABELS = { laptop: "Laptop or desktop", extension: "Chrome extension", phone: "Phone", tablet: "Tablet" };

const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

/**
 * One IST day of events into a roll-up. Events are counted on the day they reached the server (`atMs`); the hour
 * heatmaps use the time they happened (`atMs - lag`).
 * @param {string} day yyyy-mm-dd
 * @param {{uid: string, name: string, atMs: number, lag: number, dev: string, p: Object}[]} events
 * @returns {Object} the daily/{day} document (without computedAt)
 */
export function rollupDay(day, events) {
  const r = {
    day, v: 1, n: { events: 0, sessions: 0, logins: 0, signups: 0, meetings: 0, notes: 0, meetingSec: 0 },
    users: {}, dev: {}, types: {}, dur: {}, lang: {}, feat: {}, heatS: {}, heatL: {},
  };
  for (const e of events) {
    r.n.events++;
    const u = r.users[e.uid] || (r.users[e.uid] = { s: 0, m: 0, l: 0, d: [], f: [] });
    if (e.dev && e.dev !== "none" && !u.d.includes(e.dev)) u.d.push(e.dev);
    const { wd, h } = istSlot(e.atMs - (e.lag || 0) * 1000); const hk = `${wd}-${h}`;
    const p = e.p || {};
    if (e.name === "session_start") { r.n.sessions++; u.s++; inc(r.heatS, hk); }
    else if (e.name === "sign_in" || e.name === "sign_up") {
      r.n.logins++; u.l++; inc(r.heatL, hk);
      if (e.name === "sign_up") r.n.signups++;
    } else if (e.name === "meeting_done") {
      r.n.meetings++; u.m++; r.n.meetingSec += p.durS || 0;
      inc(r.types, p.type || "other"); inc(r.dur, durKey(p.durS || 0)); inc(r.lang, p.lang || "other");
    } else if (e.name === "note_done") { r.n.notes++; inc(r.lang, p.lang || "other"); }
    const f = featureOf(e);
    if (f) { inc(r.feat, f); if (!u.f.includes(f)) u.f.push(f); }
  }
  for (const u of Object.values(r.users)) for (const d of u.d) inc(r.dev, d);
  return r;
}

/**
 * A-02: the daily/{day} document as stored. Totals only: the number of active people and, per device, how many
 * people used it that day. No uid and no per-person row, so a stored day says nothing about any one account, and
 * nothing in it needs removing when someone turns stats off or deletes their account.
 * @param {Object} r a roll-up from rollupDay (in memory, with its per-person map)
 * @returns {Object}
 */
export function toStored(r) {
  const users = r.users || {};
  const n = { ...r.n, dau: r.users ? Object.keys(users).length : (r.n.dau || 0) };
  const dev = r.users ? {} : { ...(r.dev || {}) };
  if (r.users) for (const u of Object.values(users)) for (const d of u.d) inc(dev, d);
  return { day: r.day, v: 2, n, dev, types: { ...r.types }, dur: { ...r.dur }, lang: { ...r.lang }, feat: { ...r.feat }, heatS: { ...r.heatS }, heatL: { ...r.heatL } };
}
/** People active on a roll-up's day: from the in-memory map, or the stored total. */
export const dauOf = (r) => (r.users ? Object.keys(r.users).length : (r.n && r.n.dau) || 0);

/**
 * Many roll-ups into the dashboard model.
 * Days kept in memory (the last 30 and today) carry who was active, so the distinct counts (this week, this month,
 * people per device and feature, meetings per person) come from them; older stored days add only their totals.
 * @param {Object[]} rolls daily roll-ups, oldest first, today's partial one last; at least 30 days for MAU
 * @param {number} range days shown (7, 30 or 90)
 * @returns {Object}
 */
export function combine(rolls, range) {
  const shown = rolls.slice(-range);
  const union = (list) => { const s = new Set(); list.forEach((r) => Object.keys(r.users || {}).forEach((u) => s.add(u))); return s; };
  const m = {
    days: shown.map((r) => r.day),
    signups: shown.map((r) => r.n.signups),
    dau: shown.map(dauOf),
    today: { dau: dauOf(rolls[rolls.length - 1]), signups: rolls[rolls.length - 1].n.signups },
    distinctDays: shown.filter((r) => r.users).length,
    wau: union(rolls.slice(-7)).size, mau: union(rolls.slice(-30)).size,
    active: 0, meetings: 0, meetingSec: 0, notes: 0, sessions: 0, logins: 0,
    types: {}, dur: {}, lang: {}, feat: {}, featUsers: {}, devUsers: {}, heatS: {}, heatL: {}, perUser: {},
  };
  const devSets = {}; const featSets = {};
  for (const r of shown) {
    m.meetings += r.n.meetings; m.meetingSec += r.n.meetingSec; m.notes += r.n.notes; m.sessions += r.n.sessions; m.logins += r.n.logins;
    for (const k of ["types", "dur", "lang", "feat", "heatS", "heatL"]) for (const [x, n] of Object.entries(r[k] || {})) inc(m[k], x, n);
    for (const [uid, u] of Object.entries(r.users || {})) {
      const pu = m.perUser[uid] || (m.perUser[uid] = { m: 0, s: 0, l: 0 });
      pu.m += u.m; pu.s += u.s; pu.l += u.l;
      u.d.forEach((d) => (devSets[d] || (devSets[d] = new Set())).add(uid));
      u.f.forEach((f) => (featSets[f] || (featSets[f] = new Set())).add(uid));
    }
  }
  m.active = Object.keys(m.perUser).length;
  for (const [d, s] of Object.entries(devSets)) m.devUsers[d] = s.size;
  for (const [f, s] of Object.entries(featSets)) m.featUsers[f] = s.size;
  // weeks start on Monday, IST
  m.weeks = [];
  shown.forEach((r) => {
    const wd = istSlot(dayStart(r.day) + 3600000).wd;
    if (!m.weeks.length || wd === 0) m.weeks.push({ day: r.day, n: 0 });
    m.weeks[m.weeks.length - 1].n += r.n.signups;
  });
  m.weekSignups = rolls.slice(-7).reduce((a, r) => a + r.n.signups, 0);
  return m;
}

/**
 * Login-count buckets from "at least n" counts (one count query per edge).
 * @param {number[]} atLeast counts of users with loginCount >= [1, 2, 4, 8, 16]
 * @returns {{label: string, n: number}[]}
 */
export function loginBuckets(atLeast) {
  const [a1, a2, a4, a8, a16] = atLeast;
  return [
    { label: "Once", n: a1 - a2 }, { label: "2 or 3 times", n: a2 - a4 }, { label: "4 to 7 times", n: a4 - a8 },
    { label: "8 to 15 times", n: a8 - a16 }, { label: "16 times or more", n: a16 },
  ];
}
export const LOGIN_EDGES = [1, 2, 4, 8, 16];

/**
 * CSV text. Cells that a spreadsheet would run as a formula (starting with = + - @, their full-width forms, any of
 * those after spaces, a tab or a carriage return) get a leading apostrophe.
 * @param {string[]} head @param {Array<Array<string|number>>} rows @returns {string}
 */
export function toCsv(head, rows) {
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    // A-18: also the full-width signs and a formula after leading spaces
    if (/^[\t\r]|^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/* ======================================================================================= mock */

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function pick(r, weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0); let x = r() * total;
  for (const [k, w] of Object.entries(weights)) { x -= w; if (x <= 0) return k; }
  return Object.keys(weights)[0];
}

/**
 * A seeded sample: people who sign up over 120 days and use Vaani on weekdays in IST working hours. Every email is
 * on example.com. Used only by admin.html?mock=1, always shown with a "Sample data" notice.
 * @param {number} now ms
 * @param {number} [seed]
 * @returns {{users: Object[], events: Object[]}}
 */
export function makeMock(now, seed = 2026) {
  const r = rng(seed); const users = []; const events = []; const span = 120;
  const start = dayStart(istDay(now)) - span * DAY;
  const HOURS = { 9: 6, 10: 10, 11: 11, 12: 8, 13: 4, 14: 7, 15: 10, 16: 10, 17: 8, 18: 5, 19: 3, 20: 2, 21: 2, 22: 1, 8: 2 };
  const TYPES = { sales: 22, management: 15, client: 14, developer: 12, founder: 8, cx: 7, daily: 9, general: 6, interview: 3, oneonone: 3, lecture: 1 };
  const LANGS = { "en-IN": 46, "hi-IN": 19, "en-US": 8, "kn-IN": 7, "ta-IN": 5, "te-IN": 4, "mr-IN": 3, "bn-IN": 2, "gu-IN": 2, "ml-IN": 2, "en-GB": 1, "ar-SA": 1 };
  const DEVS = { laptop: 55, extension: 20, phone: 22, tablet: 3 };
  const ENG = { basic: 40, chrome: 25, gemini: 15, sarvam: 12, openai: 5, anthropic: 3 };
  const FEAT = { insights_open: 30, share: 26, translate: 8, ask: 10, calendar_join: 9, recap: 6, todo_done: 25, search: 12, followup: 5, folder: 4 };
  const N = 146;
  for (let i = 0; i < N; i++) {
    const join = start + Math.floor(Math.pow(r(), 0.7) * span) * DAY;       // more people join recently
    const uid = `mock${String(i).padStart(4, "0")}`;
    const dev = pick(r, DEVS); const second = r() < 0.3 ? pick(r, DEVS) : dev;
    const pActive = 0.08 + r() * 0.55; const churnAt = r() < 0.35 ? join + Math.floor(r() * 50) * DAY : Infinity;
    const provider = r() < 0.78 ? "google" : "email";
    const u = { uid, email: `person${String(i + 1).padStart(3, "0")}@example.com`, provider, createdAt: 0, lastLoginAt: 0, loginCount: 0 };
    const at = (d, h) => d + h * 3600000 + Math.floor(r() * 3600000); // d is midnight IST, so h is an IST hour
    const ev = (name, t, p = {}, d = dev) => events.push({ uid, name, atMs: t, lag: r() < 0.05 ? Math.floor(r() * 7200) : 0, dev: d, p });
    const t0 = at(join, Number(pick(r, HOURS)));
    u.createdAt = t0; u.lastLoginAt = t0; u.loginCount = 1;
    ev("sign_up", t0, { method: provider }); ev("session_start", t0 + 1000, { src: dev === "extension" ? "meet" : "direct" });
    for (let d = join + DAY; d < Math.min(now, churnAt); d += DAY) {
      const wd = istSlot(d + 3600000).wd; const weekend = wd >= 5;
      if (r() > pActive * (weekend ? 0.35 : 1)) continue;
      const dv = r() < 0.75 ? dev : second;
      const t = at(d, Number(pick(r, HOURS)));
      if (t > now) continue;
      if (r() < 0.05) { ev("sign_in", t - 5000, { method: provider }, dv); u.loginCount++; u.lastLoginAt = t - 5000; }
      ev("session_start", t, { src: dv === "extension" ? pick(r, { meet: 6, zoom: 2, teams: 2 }) : "direct" }, dv);
      const meetings = Math.floor(r() * 3.2);
      for (let k = 0; k < meetings; k++) {
        const durS = Math.min(43200, Math.round(Math.exp(Math.log(1500) + (r() + r() + r() - 1.5) * 1.1)));
        const tm = Math.min(now, t + k * 3600000 + durS * 1000);
        ev("meeting_done", tm, { type: pick(r, TYPES), durS, lang: pick(r, LANGS), engine: pick(r, ENG), call: dv === "extension" }, dv);
      }
      if (r() < 0.35) ev("note_done", t + 60000, { durS: 20 + Math.floor(r() * 200), lang: pick(r, LANGS), engine: pick(r, ENG) }, dv);
      const nf = Math.floor(r() * 3);
      for (let k = 0; k < nf; k++) {
        const f = pick(r, FEAT);
        if (["recap", "todo_done", "search", "followup", "folder"].includes(f)) ev("feature_used", t + 120000, { f }, dv);
        else if (f === "share") ev("share", t + 120000, { via: pick(r, { whatsapp: 5, copy: 3, email: 2, native: 2, download: 1 }) }, dv);
        else if (f === "translate") ev("translate", t + 120000, { to: pick(r, { hi: 4, en: 3, kn: 1, ta: 1 }), engine: "chrome" }, dv);
        else if (f === "ask") ev("ask", t + 120000, { engine: pick(r, ENG) }, dv);
        else if (f === "calendar_join") ev("calendar_join", t - 60000, { via: "meet" }, dv);
        else ev(f, t + 120000, {}, dv);
      }
      if (r() < 0.01) ev("calendar_connect", t + 30000, { result: r() < 0.85 ? "ok" : "denied" }, dv);
    }
    users.push(u);
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return { users, events };
}
