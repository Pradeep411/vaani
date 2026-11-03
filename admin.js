/**
 * Vaani admin dashboard (owner only). Reads Firestore through the owner rule in firestore.rules; with ?mock=1 it
 * uses a seeded sample instead and never loads Firebase.
 *
 * Data flow (live):
 *   1. Sign in with Google (analytics-client.js, analytics: false: the dashboard itself sends no events).
 *   2. daily/{day} roll-ups for the last 30 to 90 complete IST days: one query. Any missing complete day is built
 *      once from that day's events and stored, so each event is read by the dashboard at most once, ever.
 *   3. Today's events (partial day) are read live and rolled up in memory, never stored.
 *   4. users: count queries for totals and the sign-in buckets (one read per 1,000 people), then one page of people
 *      at a time, newest or oldest activity first ("Last active" is the account's last write, flushAt), or the people
 *      whose email starts with what the owner typed (Find by email).
 */
import * as VA from "./analytics-client.js";
import { VAANI_FIREBASE_CONFIG, VAANI_GOOGLE_SIGNIN_CLIENT_ID, VAANI_ADMIN_EMAIL } from "./firebase-config.js";
import {
  istDay, dayStart, pastDays, rollupDay, combine, loginBuckets, LOGIN_EDGES, toCsv, makeMock, toStored, dauOf,
  DUR_BUCKETS, FEATURE_LABELS, TYPE_LABELS, LANG_LABELS, DEV_LABELS,
} from "./admin-data.js";

const $ = (s) => document.querySelector(s);
const MOCK = new URLSearchParams(location.search).get("mock") === "1";
const NF = new Intl.NumberFormat("en-IN");
const PCT = new Intl.NumberFormat("en-IN", { style: "percent", maximumFractionDigits: 0 });
const DAYF = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const DAYY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const TIMEF = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SVGNS = "http://www.w3.org/2000/svg";
const PAGE = matchMedia("(max-width: 640px)").matches ? 10 : 25; // people per page: shorter on a phone, where each is a card
const SAMPLE_OWNER = "owner@example.com";

// users: one page; pages[i] is the cursor that starts page i; sort is "desc" (most recent first) or "asc"
const ui = { range: 30, group: "day", heat: "S", model: null, rolls: null, users: [], pages: [null], page: 0, next: null, sort: "desc", find: "", reads: 0, loading: false };
let src = null;

// frame-busting: GitHub Pages cannot send frame-ancestors, so refuse to draw inside someone else's frame
if (window.top !== window.self) { document.body.textContent = ""; throw new Error("framed"); }

/* ======================================================================================= sources */

/** Live: Firestore through the owner rule. */
function liveSource() {
  const h = VA.adminHandles(); const { fs, db } = h;
  const count = async (q) => { ui.reads += 1; return (await fs.getCount(q)).data().count; };
  const toRow = (d) => {
    const x = d.data();
    const last = x.lastLoginAt?.toMillis() || 0;
    return { uid: d.id, email: x.email, provider: x.provider, createdAt: x.createdAt?.toMillis() || 0, lastLoginAt: last, lastActiveAt: Math.max(last, x.flushAt?.toMillis() || 0), loginCount: x.loginCount || 0 };
  };
  return {
    countUsers: () => count(fs.collection(db, "users")),
    loginAtLeast: () => Promise.all(LOGIN_EDGES.map((n) => count(fs.query(fs.collection(db, "users"), fs.where("loginCount", ">=", n))))),
    loginSum: async () => { ui.reads += 1; return (await fs.getAggregate(fs.collection(db, "users"), { s: fs.sum("loginCount") })).data().s || 0; },
    // "Last active" is flushAt: every sign-in, and every batch of usage events, writes it
    async listUsers(after, n, dir = "desc") {
      const parts = [fs.collection(db, "users"), fs.orderBy("flushAt", dir), fs.limit(n)];
      if (after) parts.splice(2, 0, fs.startAfter(after));
      const snap = await fs.getDocs(fs.query(...parts)); ui.reads += Math.max(1, snap.size);
      return { rows: snap.docs.map(toRow), next: snap.size === n ? snap.docs[snap.size - 1] : null };
    },
    // Find by email: the people whose email starts with the text (emails are stored as Google or the link gave them)
    async findUsers(q, n) {
      const snap = await fs.getDocs(fs.query(fs.collection(db, "users"), fs.where("email", ">=", q), fs.where("email", "<=", q + "\uf8ff"), fs.orderBy("email"), fs.limit(n)));
      ui.reads += Math.max(1, snap.size);
      return snap.docs.map(toRow);
    },
    async allUsers() {
      const out = []; let after = null;
      for (;;) { const { rows, next } = await this.listUsers(after, 500); out.push(...rows); if (!next) return out; after = next; }
    },
    async getDaily(days) {
      const snap = await fs.getDocs(fs.query(fs.collection(db, "daily"), fs.where("day", ">=", days[0]), fs.where("day", "<=", days[days.length - 1])));
      ui.reads += Math.max(1, snap.size);
      const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); return m;
    },
    putDaily: (r) => fs.setDoc(fs.doc(db, "daily", r.day), { ...toStored(r), computedAt: fs.serverTimestamp() }),
    dropDaily: (day) => fs.deleteDoc(fs.doc(db, "daily", day)),
    // retention (privacy.html): events older than 12 months are deleted, 400 at a time, a few batches per visit
    async sweep(before) {
      let n = 0;
      for (let i = 0; i < 5; i++) {
        const snap = await fs.getDocs(fs.query(fs.collection(db, "events"), fs.where("at", "<", fs.Timestamp.fromMillis(before)), fs.limit(400)));
        ui.reads += Math.max(1, snap.size);
        if (snap.empty) break;
        const b = fs.writeBatch(db); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit(); n += snap.size;
        if (snap.size < 400) break;
      }
      return n;
    },
    async events(from, to) {
      const out = []; let after = null;
      for (;;) {
        const parts = [fs.collection(db, "events"), fs.where("at", ">=", fs.Timestamp.fromMillis(from)), fs.where("at", "<", fs.Timestamp.fromMillis(to)), fs.orderBy("at"), fs.limit(1000)];
        if (after) parts.splice(4, 0, fs.startAfter(after));
        const snap = await fs.getDocs(fs.query(...parts)); ui.reads += Math.max(1, snap.size);
        snap.docs.forEach((d) => { const x = d.data(); out.push({ uid: x.uid, name: x.name, atMs: x.at.toMillis(), lag: x.lag || 0, dev: x.dev, p: x.p || {} }); });
        if (snap.size < 1000) return out;
        after = snap.docs[snap.size - 1];
      }
    },
  };
}

/** Mock: the same interface over a seeded sample, in memory. */
function mockSource(state) {
  const now = Date.now(); const m0 = makeMock(now); const daily = {};
  // ?mock=1&state=empty|error|slow shows the dashboard's other states with the sample's shape (no Firebase)
  const users = state === "empty" ? [] : m0.users; const events = state === "empty" ? [] : m0.events;
  const hold = (v) => (state === "slow" ? new Promise((r) => setTimeout(() => r(v), 600000)) : state === "error" ? Promise.reject(new Error("sample error")) : Promise.resolve(v));
  const ge = (n) => users.filter((u) => u.loginCount >= n).length;
  const lastEv = {}; events.forEach((e) => { if (!lastEv[e.uid] || e.atMs > lastEv[e.uid]) lastEv[e.uid] = e.atMs; });
  users.forEach((u) => { u.lastActiveAt = Math.max(u.lastLoginAt, lastEv[u.uid] || 0); });
  const sorted = [...users].sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.email.localeCompare(b.email));
  return {
    countUsers: async () => users.length,
    loginAtLeast: async () => LOGIN_EDGES.map(ge),
    loginSum: async () => users.reduce((a, u) => a + u.loginCount, 0),
    async listUsers(after, n, dir = "desc") {
      const list = dir === "asc" ? [...sorted].reverse() : sorted; const i = after || 0;
      return { rows: list.slice(i, i + n), next: i + n < list.length ? i + n : null };
    },
    async findUsers(q, n) { return sorted.filter((u) => u.email.startsWith(q)).sort((a, b) => a.email.localeCompare(b.email)).slice(0, n); },
    allUsers: async () => sorted,
    async getDaily(days) { const m = {}; days.forEach((d) => { if (daily[d]) m[d] = daily[d]; }); return hold(m); },
    async putDaily(r) { daily[r.day] = toStored(r); },
    async dropDaily(d) { delete daily[d]; },
    async sweep() { return 0; },
    async events(from, to) { return events.filter((e) => e.atMs >= from && e.atMs < to); },
  };
}

/* ======================================================================================= load */

function status(msg) { const s = $("#status"); s.textContent = msg || ""; s.hidden = !msg; }

function srOnly(msg) { $("#loadSr").textContent = msg || ""; }
function showState(st) {
  // one of: loading (region skeletons), error (red notice), empty (one block), full
  $("#board").hidden = false;
  $("#skel").hidden = st !== "loading";
  $("#loadErr").hidden = st !== "error";
  $("#dash").hidden = !(st === "full" || st === "empty");
  for (const b of document.querySelectorAll("#dash > [data-full]")) b.hidden = st === "empty";
  $("#emptyBlock").hidden = st !== "empty";
}

async function load() {
  if (ui.loading) return;
  ui.loading = true; ui.reads = 0;
  const btn = $("#refresh"); btn.setAttribute("aria-busy", "true"); btn.disabled = true;
  if (!ui.model) showState("loading");
  status("");
  try {
    const now = Date.now();
    const days = pastDays(Math.max(30, ui.range), now);
    const recent = days.slice(-30); const today = istDay(now);
    srOnly("Loading the numbers.");
    const stored = await src.getDaily(days);
    // A-02: the old roll-ups (v1) kept a row per person; delete them once and build the totals again
    for (const [d, r] of Object.entries(stored)) {
      if (r.v !== 2 || r.users) { delete stored[d]; await src.dropDaily(d).catch((e) => console.warn("could not drop", d, e && e.code)); }
    }
    // the last 30 days and today are read live and kept in memory only: they give the distinct counts
    const live = await src.events(dayStart(recent[0]), now + 60000);
    const byDay = {}; live.forEach((e) => { (byDay[istDay(e.atMs)] || (byDay[istDay(e.atMs)] = [])).push(e); });
    const mem = {};
    for (const d of recent.concat([today])) mem[d] = rollupDay(d, byDay[d] || []);
    for (const d of recent) if (!stored[d]) { stored[d] = toStored(mem[d]); await src.putDaily(mem[d]).catch((e) => console.warn("could not store", d, e && e.code)); }
    // older days (90-day view) not stored yet: built once from their events, stored as totals
    const older = days.filter((d) => !recent.includes(d) && !stored[d]);
    for (let i = 0; i < older.length; i++) {
      const d = older[i];
      srOnly(`Building daily totals: ${i + 1} of ${older.length} days.`);
      const r = rollupDay(d, await src.events(dayStart(d), dayStart(d) + 86400000));
      stored[d] = toStored(r);
      await src.putDaily(r).catch((e) => console.warn("could not store", d, e && e.code));
    }
    ui.rolls = days.map((d) => mem[d] || stored[d]).concat([mem[today]]);
    ui.model = combine(ui.rolls, ui.range);
    ui.pages = [null]; ui.page = 0; ui.find = ""; $("#find").value = "";
    const [total, atLeast, sum, page] = await Promise.all([src.countUsers(), src.loginAtLeast(), src.loginSum(), src.listUsers(null, PAGE, ui.sort)]);
    ui.model.total = total; ui.model.loginBuckets = loginBuckets(atLeast); ui.model.loginSum = sum;
    ui.users = page.rows; ui.next = page.next;
    ui.loadedAt = now;
    render();
    srOnly("");
    showState(ui.model.total === 0 && !ui.model.meetings ? "empty" : "full");
    // retention: sweep events over 12 months old (a day of margin), after the numbers are on screen
    src.sweep(now - 366 * 86400000).then((n) => { if (n) { ui.swept = n; renderMeta(); } }).catch((e) => console.warn("sweep", e && e.code));
  } catch (e) {
    console.error(e);
    if (ui.model) { showState("full"); status("Couldn’t refresh the numbers. These are from before."); }
    else showState("error");
  } finally {
    ui.loading = false; btn.removeAttribute("aria-busy"); btn.disabled = false;
  }
}

/* ======================================================================================= render */

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else n.setAttribute(k, v); }
  if (text != null) n.textContent = text;
  return n;
}
function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
}
const resizeWatch = new ResizeObserver((entries) => {
  for (const e of entries) {
    const box = e.target; const w = Math.round(e.contentRect.width);
    if (box._chart && w && w !== box._w) { box._w = w; const [d, o] = box._chart; chart(box, d, o); }
  }
});
// four gridline steps of 1, 2, 2.5 or 5 times a power of ten, so every tick is a whole number
function niceMax(v) {
  const raw = Math.max(1, v / 4); const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw && Number.isInteger(x)) || 10 * p;
  return step * 4;
}

/**
 * Vertical bars (or a line) with 4 gridlines, a zero baseline and a screen-reader table of the same numbers.
 * @param {HTMLElement} box @param {{label: string, value: number, title?: string}[]} data
 * @param {{kind?: "bar"|"line", name: string, unit?: string}} o
 */
function chart(box, data, o) {
  const wasOpen = !!box.querySelector("details[open]");
  box.textContent = "";
  box._chart = [data, o]; resizeWatch.observe(box);
  // drawn at the box's real width so 12px labels stay 12px on a phone and on a wide screen
  const W = Math.max(260, Math.round(box.clientWidth || 600)), H = 200, L = 40, B = 26, T = 10, R = 10;
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const total = data.reduce((a, d) => a + d.value, 0);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${o.name}: ${NF.format(total)} in total over ${data.length} ${o.unit || "points"}. The table below lists each value.` });
  for (let i = 0; i <= 4; i++) {
    const y = T + (H - T - B) * (1 - i / 4);
    s.append(svg("line", { class: "grid", x1: L, x2: W - R, y1: y, y2: y }));
    s.append(svg("text", { class: "axis", x: L - 6, y: y + 4, "text-anchor": "end" }, NF.format(Math.round((max * i) / 4))));
  }
  const n = data.length; const slot = (W - L - R) / Math.max(1, n);
  const yOf = (v) => T + (H - T - B) * (1 - v / max);
  if (o.kind === "line") {
    let dpath = "";
    data.forEach((d, i) => { const x = L + slot * (i + 0.5); dpath += `${i ? "L" : "M"}${x.toFixed(1)} ${yOf(d.value).toFixed(1)}`; });
    s.append(svg("path", { class: "line", d: dpath }));
    const last = data[n - 1]; if (last) s.append(svg("circle", { class: "dot", cx: L + slot * (n - 0.5), cy: yOf(last.value), r: 3.5 }));
  } else {
    const bw = Math.min(24, Math.max(2, slot - Math.max(2, Math.min(4, slot * 0.25))));
    data.forEach((d, i) => {
      const h = (H - T - B) * (d.value / max); if (h <= 0) return;
      const x = L + slot * i + (slot - bw) / 2, y = H - B - h, r = Math.min(2, h, bw / 2);
      // rounded only at the data end
      s.append(svg("path", { class: "bar", d: `M${x} ${H - B}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bw - r}Q${x + bw} ${y} ${x + bw} ${y + r}V${H - B}Z` },
      ));
    });
  }
  // dates: anchored on the newest day, spaced so labels never touch; categories: every label
  const every = o.allLabels ? 1 : Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 64)));
  data.forEach((d, i) => { if ((n - 1 - i) % every === 0) s.append(svg("text", { class: "axis", x: L + slot * (i + 0.5), y: H - 8, "text-anchor": "middle" }, d.label)); });
  if (!total) s.append(svg("text", { class: "empty", x: (L + W) / 2, y: H / 2, "text-anchor": "middle" }, "Nothing yet in this period"));
  box.append(s);
  // the same numbers as a real table, one click away, for screen readers and for anyone who wants exact values
  const det = el("details", { class: "as-table" }); det.append(el("summary", {}, "Show the numbers"));
  const wrap = el("div", { class: "table-scroll" }); det.append(wrap);
  // built only while open: a closed disclosure holds no rows
  const fill = () => {
    wrap.textContent = "";
    if (!det.open) return;
    const t = el("table", { class: "data" }); const tb = el("tbody");
    t.append(el("caption", { class: "sr" }, o.name));
    data.forEach((d) => { const tr = el("tr"); tr.append(el("th", { scope: "row" }, d.title || d.label), el("td", { class: "n num" }, NF.format(d.value))); tb.append(tr); });
    t.append(tb); wrap.append(t);
  };
  det.addEventListener("toggle", fill);
  if (wasOpen) { det.open = true; fill(); }
  box.append(det);
}

/** Horizontal bars as a list: label, value in type, and a bar that is decoration only. */
function hbars(list, rows, o = {}) {
  list.textContent = "";
  const max = Math.max(1, ...rows.map((r) => r.n)); const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) { list.append(el("li", { class: "none" }, "Nothing yet in this period")); return; }
  rows.forEach((r) => {
    const li = el("li"); const v = el("span", { class: "v num" }, NF.format(r.n));
    if (o.share) v.append(el("small", {}, PCT.format(r.n / total)));
    const track = el("span", { class: "track", "aria-hidden": "true" }); const bar = el("i"); bar.style.setProperty("--w", ((r.n / max) * 100).toFixed(1));
    track.append(bar); li.append(el("span", {}, r.label), v, track); list.append(li);
  });
}

function sortedEntries(obj, labels) {
  return Object.entries(obj).map(([k, n]) => ({ k, n, label: labels[k] || k })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

function renderHeat() {
  const m = ui.model; const data = ui.heat === "S" ? m.heatS : m.heatL;
  const tbl = $("#heat"); tbl.textContent = "";
  const max = Math.max(0, ...Object.values(data));
  const cg = el("colgroup"); cg.append(el("col", { class: "wd" })); for (let h = 0; h < 24; h++) cg.append(el("col")); tbl.append(cg);
  const head = el("thead"); const hr = el("tr"); hr.append(el("td"));
  for (let h = 0; h < 24; h += 3) hr.append(el("th", { scope: "colgroup", colspan: "3" }, String(h)));
  head.append(hr); tbl.append(head);
  const body = el("tbody"); let peak = null;
  for (let wd = 0; wd < 7; wd++) {
    const tr = el("tr"); tr.append(el("th", { scope: "row" }, WD[wd]));
    for (let h = 0; h < 24; h++) {
      const n = data[`${wd}-${h}`] || 0; const lvl = !n ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999));
      const td = el("td", { class: lvl ? `l${lvl}` : "", title: `${WD[wd]} ${h}:00 to ${h + 1}:00, ${NF.format(n)}` });
      td.append(el("span", { class: "sr" }, `${WD[wd]} ${h}:00, ${NF.format(n)}`));
      tr.append(td);
      if (n && (!peak || n > peak.n)) peak = { n, wd, h };
    }
    body.append(tr);
  }
  tbl.append(body);
  $("#heatCap").textContent = ui.heat === "S" ? "When people open Vaani" : "When people sign in";
  const pk = $("#heatPeak"); pk.textContent = "";
  if (peak) pk.append("Busiest: ", el("b", {}, `${WD[peak.wd]}, ${peak.h}:00 to ${peak.h + 1}:00`), ` (${NF.format(peak.n)})`);
  else pk.textContent = "Nothing yet in this period";
}

function renderUsers() {
  const tb = $("#userTable tbody"); tb.textContent = "";
  const per = ui.model.perUser;
  ui.users.forEach((u) => {
    const tr = el("tr");
    tr.append(
      el("td", { class: "email", "data-label": "Email" }, u.email || "(no email)"),
      el("td", { "data-label": "Signed up" }, u.createdAt ? DAYY.format(u.createdAt) : ""),
      el("td", { "data-label": "Last active" }, u.lastActiveAt ? TIMEF.format(u.lastActiveAt) : ""),
      el("td", { class: "n num", "data-label": "Sign-ins" }, NF.format(u.loginCount || 0)),
      el("td", { class: "n num", "data-label": $("#thMeet").textContent }, NF.format((per[u.uid] && per[u.uid].m) || 0)),
      el("td", { "data-label": "Signed in with" }, u.provider === "google" ? "Google" : "Email link"),
    );
    tb.append(tr);
  });
  if (!ui.users.length) {
    const tr = el("tr"); tr.append(el("td", { colspan: "6" }, ui.find ? "No one found." : "Nobody has signed up yet.")); tb.append(tr);
  }
  const total = ui.model.total; const from = ui.page * PAGE;
  $("#pages").hidden = !!ui.find || !total;
  $("#pageInfo").textContent = ui.users.length ? `${NF.format(from + 1)} to ${NF.format(from + ui.users.length)} of ${NF.format(total)}` : "";
  $("#prevPage").disabled = ui.page === 0; $("#nextPage").disabled = !ui.next;
  const th = $("#thActive"); th.setAttribute("aria-sort", ui.find ? "none" : ui.sort === "asc" ? "ascending" : "descending");
  th.classList.toggle("asc", ui.sort === "asc");
  $("#sortActive").setAttribute("aria-label", `Last active, ${ui.sort === "asc" ? "oldest" : "most recent"} first. Change the order`);
  $("#userCap").textContent = ui.find ? `Users whose email starts with ${ui.find}` : `Users, ${ui.sort === "asc" ? "least" : "most"} recently active first`;
}
async function showPage(i) {
  const page = await src.listUsers(ui.pages[i], PAGE, ui.sort);
  if (i > 0 && !page.rows.length) return;
  ui.page = i; ui.users = page.rows; ui.next = page.next; ui.pages[i + 1] = page.next;
  renderUsers();
}
async function findUsers(q) {
  q = q.trim().toLowerCase().slice(0, 254); ui.find = q;
  const note = $("#findNote");
  if (!q) { note.hidden = true; ui.pages = [null]; await showPage(0); return; }
  const rows = await src.findUsers(q, 50); ui.users = rows; ui.next = null;
  renderUsers();
  note.hidden = false;
  note.textContent = rows.length ? `${rows.length === 50 ? "The first 50" : NF.format(rows.length)} ${rows.length === 1 ? "person" : "people"} whose email starts with “${q}”. Clear the box to see everyone.` : `No one’s email starts with “${q}”.`;
}

function render() {
  const m = ui.model; const r = ui.range;
  $("#pgSub").textContent = `${MOCK ? "Sample data. " : ""}Last ${r} days, in India time (IST).`;
  // the stat row (admin-mock.html): five numbers, each with one plain line under it
  $("#kSign").textContent = NF.format(m.signups.reduce((a, x) => a + x, 0));
  $("#kSignSub").textContent = `${NF.format(m.total)} ${m.total === 1 ? "person" : "people"} in all`;
  $("#dau").textContent = NF.format(m.today.dau);
  $("#kDauSub").textContent = m.mau ? `${PCT.format(m.today.dau / m.mau)} of this month’s people` : "Today, India time";
  $("#wau").textContent = NF.format(m.wau);
  $("#mau").textContent = NF.format(m.mau);
  $("#kRec").textContent = NF.format(m.meetings + m.notes);
  $("#kRecSub").textContent = m.meetings ? `Typical meeting ${Math.round(m.meetingSec / m.meetings / 60)} min` : "Meetings and quick notes";
  renderSignups();

  chart($("#dauChart"), m.days.map((d, i) => ({ label: DAYF.format(dayStart(d) + 3600000), title: DAYY.format(dayStart(d) + 3600000), value: m.dau[i] })), { kind: "line", name: "People active each day", unit: "days" });
  const hi = m.dau.reduce((b, v, i) => (v > (b ? b.v : 0) ? { v, i } : b), null);
  const pk = $("#dauPeak"); pk.textContent = "";
  if (hi) pk.append("Highest: ", el("b", {}, NF.format(hi.v)), `, on ${DAYF.format(dayStart(m.days[hi.i]) + 3600000)}`);

  hbars($("#loginBars"), m.loginBuckets.map((b) => ({ label: b.label, n: b.n })), { share: true });
  $("#loginAvg").textContent = m.total ? `On average ${(m.loginSum / m.total).toFixed(1)} sign-ins per person since they joined. A sign-in is a fresh login; opening the app while still signed in counts as an app open.` : "";
  renderHeat();

  const hours = m.meetingSec / 3600;
  $("#typeTotal").textContent = m.meetings ? `${NF.format(m.meetings)} meetings, ${NF.format(Math.round(hours))} hours` : "";
  $("#lenTypical").textContent = "";
  if (m.meetings) $("#lenTypical").append("Typical ", el("b", {}, `${Math.round(m.meetingSec / m.meetings / 60)} min`));
  hbars($("#typeBars"), sortedEntries(m.types, TYPE_LABELS), { share: true });
  chart($("#durChart"), DUR_BUCKETS.map((b) => ({ label: b.short, title: b.label, value: m.dur[b.k] || 0 })), { name: "Meetings by length", unit: "length groups", allLabels: true });
  const langs = sortedEntries(m.lang, LANG_LABELS);
  const top = langs.slice(0, 7); const rest = langs.slice(7).reduce((a, x) => a + x.n, 0);
  if (rest) top.push({ label: `${langs.length - 7} more languages`, n: rest });
  hbars($("#langBars"), top, { share: true });
  $("#langUsed").textContent = langs.length ? `${NF.format(langs.length)} used` : "";

  renderDevices();
  renderFeatures();
  $("#thMeet").textContent = `Meetings, ${Math.min(r, 30)} days`;
  $("#userCount").textContent = `${NF.format(m.total)} in all`;
  renderUsers();
  renderMeta();
}
function renderMeta() {
  const m = ui.model; if (!m) return;
  const distinct = ui.range > 30 ? " People counts (this week, this month, devices, features and meetings per person) cover the last 30 days; older days keep totals only." : "";
  const swept = ui.swept ? ` Removed ${NF.format(ui.swept)} events older than 12 months.` : "";
  $("#metaLine").textContent = `Updated ${TIMEF.format(ui.loadedAt)} India time. This view read about ${NF.format(ui.reads)} documents${MOCK ? " (sample, nothing was read)" : ""}. Today’s numbers are still counting.${distinct}${swept}`;
}

function renderSignups() {
  const m = ui.model;
  const data = ui.group === "day"
    ? m.days.map((d, i) => ({ label: DAYF.format(dayStart(d) + 3600000), title: DAYY.format(dayStart(d) + 3600000), value: m.signups[i] }))
    : m.weeks.map((w) => ({ label: DAYF.format(dayStart(w.day) + 3600000), title: `Week from ${DAYY.format(dayStart(w.day) + 3600000)}`, value: w.n }));
  $("#signCap").textContent = ui.group === "day" ? "New sign-ups each day" : "New sign-ups each week";
  chart($("#signChart"), data, { name: $("#signCap").textContent, unit: ui.group === "day" ? "days" : "weeks" });
}

function renderDevices() {
  const m = ui.model; const order = ["laptop", "extension", "phone", "tablet"];
  $("#devPeople").textContent = m.active ? `${NF.format(m.active)} active ${m.active === 1 ? "person" : "people"}` : "";
  const rows = order.map((k) => ({ k, n: m.devUsers[k] || 0 }));
  const sum = rows.reduce((a, r) => a + r.n, 0);
  const st = $("#devStack"); st.textContent = "";
  const lg = $("#devLegend"); lg.textContent = "";
  rows.forEach((r, i) => {
    if (sum && r.n) { const seg = el("i", { class: `r${i + 1}` }); seg.style.setProperty("--w", ((r.n / sum) * 100).toFixed(2)); st.append(seg); }
    const li = el("li"); li.append(el("i", { class: `r${i + 1}`, "aria-hidden": "true" }), el("span", {}, DEV_LABELS[r.k]));
    const b = el("b", { class: "num" }, `${NF.format(r.n)} ${r.n === 1 ? "person" : "people"}`); li.append(b); lg.append(li);
  });
}

function renderFeatures() {
  const m = ui.model; const tb = $("#featTable tbody"); tb.textContent = "";
  const rows = Object.keys(FEATURE_LABELS).map((k) => ({ k, people: m.featUsers[k] || 0, uses: m.feat[k] || 0 }))
    .filter((r) => r.uses).sort((a, b) => b.people - a.people || b.uses - a.uses);
  if (!rows.length) { const tr = el("tr"); tr.append(el("td", { colspan: "4" }, "No feature use yet in this period.")); tb.append(tr); return; }
  rows.forEach((r) => {
    const tr = el("tr");
    tr.append(el("td", {}, FEATURE_LABELS[r.k]), el("td", { class: "n num" }, NF.format(r.people)),
      el("td", { class: "n num" }, m.active ? PCT.format(r.people / m.active) : "0%"), el("td", { class: "n num" }, NF.format(r.uses)));
    tb.append(tr);
  });
}

/* ======================================================================================= CSV */

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const iso = (ms) => (ms ? new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace("T", " ") : "");

async function csvUsers() {
  const b = $("#csvUsers"); b.setAttribute("aria-busy", "true");
  try {
    const all = await src.allUsers(); const per = ui.model.perUser;
    const rows = all.map((u) => [u.email, iso(u.createdAt), iso(u.lastLoginAt), u.loginCount, (per[u.uid] && per[u.uid].m) || 0, u.provider]);
    download(`vaani-people-${istDay(Date.now())}.csv`, toCsv(["email", "signed_up_ist", "last_sign_in_ist", "sign_ins", `meetings_last_${Math.min(ui.range, 30)}_days`, "signed_in_with"], rows));
    status(`Downloaded ${NF.format(all.length)} people.`);
  } catch (e) { status("The download did not work. Try again."); console.error(e); } finally { b.removeAttribute("aria-busy"); }
}
function csvDaily() {
  const rows = ui.rolls.slice(-ui.range).map((r) => [r.day, r.n.signups, dauOf(r), r.n.sessions, r.n.logins, r.n.meetings, Math.round(r.n.meetingSec / 60), r.n.notes]);
  download(`vaani-daily-${istDay(Date.now())}.csv`, toCsv(["day_ist", "sign_ups", "active_people", "app_opens", "sign_ins", "meetings", "meeting_minutes", "quick_notes"], rows));
}

/* ======================================================================================= wiring */

function radio(group, attr, onPick) {
  const btns = [...document.querySelectorAll(`[${attr}]`)];
  btns.forEach((b) => {
    b.tabIndex = b.getAttribute("aria-checked") === "true" ? 0 : -1;
    b.addEventListener("click", () => pick(b));
    b.addEventListener("keydown", (e) => {
      const i = btns.indexOf(b); let j = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % btns.length;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + btns.length) % btns.length;
      if (j != null) { e.preventDefault(); pick(btns[j]); btns[j].focus(); }
    });
  });
  function pick(b) {
    btns.forEach((x) => { const on = x === b; x.setAttribute("aria-checked", String(on)); x.tabIndex = on ? 0 : -1; });
    onPick(b.getAttribute(attr));
  }
}

function wire() {
  radio("range", "data-range", (v) => {
    ui.range = Number(v);
    // the roll-ups already loaded cover the new period: redraw without reading anything
    if (ui.rolls && ui.rolls.length >= Math.max(30, ui.range) + 1) {
      const keep = { total: ui.model.total, loginBuckets: ui.model.loginBuckets, loginSum: ui.model.loginSum };
      ui.model = Object.assign(combine(ui.rolls, ui.range), keep); render();
    } else load();
  });
  radio("group", "data-group", (v) => { ui.group = v; if (ui.model) renderSignups(); });
  radio("heat", "data-heat", (v) => { ui.heat = v; if (ui.model) renderHeat(); });
  $("#refresh").addEventListener("click", load);
  $("#csvUsers").addEventListener("click", csvUsers);
  $("#csvDaily").addEventListener("click", csvDaily);
  $("#prevPage").addEventListener("click", () => { if (ui.page > 0) showPage(ui.page - 1).catch(pageErr); });
  $("#nextPage").addEventListener("click", () => { if (ui.next) showPage(ui.page + 1).catch(pageErr); });
  $("#sortActive").addEventListener("click", () => {
    ui.sort = ui.sort === "desc" ? "asc" : "desc"; ui.pages = [null]; ui.find = ""; $("#find").value = ""; $("#findNote").hidden = true;
    showPage(0).catch(pageErr);
  });
  $("#findForm").addEventListener("submit", (e) => { e.preventDefault(); findUsers($("#find").value).catch(pageErr); });
  $("#find").addEventListener("search", () => { if (!$("#find").value && ui.find) findUsers("").catch(pageErr); });
  $("#signout").addEventListener("click", () => VA.signOut());
  $("#retry").addEventListener("click", () => { ui.model = null; load(); });
  $("#copyLink").addEventListener("click", async () => {
    const link = location.origin + location.pathname.replace(/admin\.html$/, "");
    try { await navigator.clipboard.writeText(link); $("#copyDone").textContent = "Copied " + link; } catch { $("#copyDone").textContent = link; }
  });
}

function pageErr(e) { console.error(e); status("Couldn’t load that page of people. Try again."); }

function gate(text, showButton) {
  $("#board").hidden = true; $("#gate").hidden = false;
  $("#gateText").textContent = text; $("#gbtn").hidden = !showButton;
}
function owner(email) { const w = $("#who"); w.textContent = email || ""; w.hidden = !email; $("#signout").hidden = !email || MOCK; }
/* Google's button is 40px tall; drawn at the box width ÷ 1.1 and scaled 1.1, it is 44px on a phone (n-c) */
function googleButton() {
  const box = $("#gbtn"); if (box.childElementCount) return;
  const w = Math.max(200, Math.min(300, Math.floor((box.clientWidth || 300) / 1.1)));
  VA.renderGoogleButton(box, { width: w }).then(() => box.classList.add("is-ready"))
    .catch(() => { $("#gateErr").textContent = "Google sign-in did not load. Check the connection and reload."; });
}

async function start() {
  wire();
  if (MOCK) {
    owner(SAMPLE_OWNER); $("#pgSub").textContent = "Sample data. Last 30 days, in India time (IST).";
    src = mockSource(new URLSearchParams(location.search).get("state")); await load(); return;
  }
  // onlyEmail (A-05): any other Google account is refused before Firebase sees it, so no Auth record is made
  const st = await VA.init(VAANI_FIREBASE_CONFIG, { analytics: false, googleClientId: VAANI_GOOGLE_SIGNIN_CLIENT_ID, onlyEmail: VAANI_ADMIN_EMAIL });
  if (st.status === "unconfigured") {
    gate("Sign-in is not set up yet. Paste the Firebase project’s settings into firebase-config.js and reload, or open this page with ?mock=1 to see the layout.", false);
    return;
  }
  VA.onState(async (s) => {
    if (s.status === "signed-out" && s.error === "not-owner") {
      const who = VA.refusedEmail();
      owner("");
      gate(`This page opens only for the owner’s Google account${who ? `, not ${who}` : ""}. Nothing was saved about that account.`, true);
      googleButton();
    } else if (s.status === "signed-out") {
      owner("");
      gate("Sign in with the owner’s Google account. This page shows counts and times, never notes.", true);
      googleButton();
    } else if (s.status === "ready") {
      if (!s.user || s.user.email !== VAANI_ADMIN_EMAIL || s.user.provider !== "google") {
        gate(`This page opens only for the owner’s Google account. You are signed in as ${s.user ? s.user.email : "someone else"}.`, false);
        owner(s.user ? s.user.email : ""); return;
      }
      $("#gate").hidden = true; owner(s.user.email);
      src = liveSource(); load();
    } else if (s.status === "error") {
      gate("Sign-in could not start. Check the connection and reload.", false);
    }
  });
}

start();
