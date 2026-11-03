/* Vaani accounts (v2.2): the sign-in gate, the consent step, the account rows in Settings, per-account notes on a
   shared browser, and the usage hooks. Loaded before the main script so the notes namespace is known before
   anything is read.

   THE SWITCH. While VAANI_ACCOUNTS_ENABLED is false this file stops at the first lines below: no Firebase, no
   Google script, no stylesheet, no network, no change to the page. Vaani is then exactly v2.1.
   A tester can turn it on for one browser tab with ?accounts=1 (kept in sessionStorage only; ?accounts=0 clears it),
   but only on localhost or 127.0.0.1 (A-03, SECURITY-AUDIT-v23.md): a shared link to the live site cannot switch it on.
   Turn it on for everyone only after the Chrome Web Store listing and Privacy tab update is approved
   (team/accounts/DECISIONS.md 8 and privacy/STORE-UPDATE.md). */
(function () {
  "use strict";
  var VAANI_ACCOUNTS_ENABLED = false;

  if (window.top !== window.self) return;
  var on = VAANI_ACCOUNTS_ENABLED, override = false;
  var LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (LOCAL) try {
    var qa = new URLSearchParams(location.search).get("accounts");
    if (qa === "1") sessionStorage.setItem("vaani.acct.flag", "1");
    else if (qa === "0") sessionStorage.removeItem("vaani.acct.flag");
    override = sessionStorage.getItem("vaani.acct.flag") === "1";
  } catch (e) { /* storage blocked: the tester switch is simply unavailable */ }
  else try { sessionStorage.removeItem("vaani.acct.flag"); } catch (e) { /* blocked */ }
  if (!(on || override)) return;

  /* ================= constants ================= */
  /* {{PRIVACY_EMAIL}}: the owner's fallback until the Vaani-only privacy address exists (DECISIONS.md 3) */
  var PRIVACY_EMAIL = "pradeepzille111@gmail.com";
  var APP_VERSION = "2.2.0";
  var LSK = { uid: "vaani.acct.uid", age: "vaani.acct.age", first: "vaani.acct.first", seen: "vaani.acct.noticeSeen", anonDay: "vaani.acct.anonDay" };
  var UID_RE = /^[A-Za-z0-9]{1,128}$/;
  var DEVICE_KEYS = { "vaani.theme": 1 };
  var d = document, root = d.documentElement;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* blocked */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* blocked */ } }

  /* ================= notes namespace (read synchronously by index.html's storage) ================= */
  /* Signed-out use and under-18 use keep the default keys ("vaani.history"). A signed-in account's keys are
     "vaani.u.<uid>.history" and so on. The theme stays per device. */
  var u18 = lsGet(LSK.age) === "u18";
  var nsUid = !u18 && UID_RE.test(lsGet(LSK.uid) || "") ? lsGet(LSK.uid) : "";
  function personal(k) { return typeof k === "string" && k.indexOf("vaani.") === 0 && !DEVICE_KEYS[k] && !/^vaani\.(u|a|acct)\./.test(k); }
  function nsKey(uid, k) { return "vaani.u." + uid + "." + k.slice(6); }
  var A = window.VaaniAccounts = {
    enabled: true, ns: nsUid, u18: u18,
    key: function (k) { return nsUid && personal(k) ? nsKey(nsUid, k) : k; },
  };

  /* ================= small helpers ================= */
  function $(s, r) { return (r || d).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || d).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function notesIn(key) { try { var a = JSON.parse(lsGet(key) || "[]"); return Array.isArray(a) ? a.filter(function (n) { return n && !n.sample; }) : []; } catch (e) { return []; } }
  function defaultNotes() { return notesIn("vaani.history"); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  var VA = null, CFG = null, ST = null;
  function loadModules() {
    return Promise.all([import("./analytics-client.js"), import("./firebase-config.js")]).then(function (m) { VA = m[0]; CFG = m[1]; });
  }
  function sha256(text) {
    var b = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", b).then(function (h) { return [].map.call(new Uint8Array(h), function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); });
  }
  function textOf(el) { return String(el ? el.textContent : "").replace(/\s+/g, " ").trim(); }
  function policyUrl() { return location.origin + location.pathname.replace(/[^/]*$/, "") + "privacy.html"; }
  function errCode(e) { return (e && (e.code || e.name)) || "unknown"; }
  function saveFile(name, text) {
    var b = new Blob([text], { type: "application/json" }), u = URL.createObjectURL(b), a = d.createElement("a");
    a.href = u; a.download = name; d.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 200);
  }

  /* icons, as in the design prototypes */
  var IC = {
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.5"/></svg>',
    errS: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.5"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8.8a15 15 0 0 1 4-2.5M10 5.1a15 15 0 0 1 11.5 3.7M5.5 12.5a10 10 0 0 1 3.2-2M15.3 10.6a10 10 0 0 1 3.2 1.9M9 16a4.5 4.5 0 0 1 6 0M12 19.5v.5M3 3l18 18"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 20V10M10 20V4M15 20v-7M20 20v-4"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9V5a3 3 0 0 1 5.8-1M15 10v2a3 3 0 0 1-4.6 2.5M19 10v2a7 7 0 0 1-11.2 5.6M5 10v2a7 7 0 0 0 .6 2.8M12 19v3M3 3l18 18"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>',
    ppl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 11a3 3 0 1 0 0-6M21.5 20a5.5 5.5 0 0 0-4.5-5.4"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/></svg>',
    bin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/></svg>',
  };
  var SPIN = '<span class="spin" aria-hidden="true"></span>';

  /* ================= the gate: everything before the app ================= */
  var needGate = !nsUid && !u18;
  var app = d.getElementById("app");
  var gate = null, gateState = "", alertKind = "", lastErr = null, linkBusy = false, sentTo = "", resendT = null;
  function hideApp(h) {
    if (!app) return;
    app.style.visibility = h ? "hidden" : "";
    try { app.inert = !!h; } catch (e) { /* older browsers */ }
    if (h) app.setAttribute("aria-hidden", "true"); else app.removeAttribute("aria-hidden");
  }
  if (needGate) { hideApp(true); root.classList.add("acct-gated"); }

  var css = d.createElement("link"); css.rel = "stylesheet"; css.href = "accounts.css";
  css.addEventListener("load", function () { if (gate) gate.classList.add("ready"); });
  d.head.appendChild(css);

  function card(states, label, body, cls) {
    return '<section class="au-card' + (cls ? " " + cls : "") + '" data-st="' + states + '"' + label + " hidden>" + body + "</section>";
  }
  function note(t) { return '<p class="au-note">' + t + "</p>"; }
  var PRIV = '<a class="lnk-in" href="privacy.html#account" target="_blank" rel="noopener">Privacy</a>';
  function buildGate() {
    gate = d.createElement("div");
    gate.className = "au acct-gate" + (css.sheet ? " ready" : "");
    gate.id = "acctGate";
    var h = '<header class="au-bar"><span class="brand">Vaani</span></header><main class="au-main"><div class="col">' +
      '<div class="hero"><h1>Just talk.<br>Vaani takes the notes.</h1><p>Meetings, calls and classes, in 22 languages.</p></div>' +
      '<div id="acAlertHome" hidden><div class="au-alert" id="acAlert"></div></div>' +
      /* boot: Firebase is reading the saved session */
      '<section class="au-card" data-st="boot" aria-label="Checking whether you are signed in" aria-busy="true" hidden><div class="au-head"><span class="sk sk-t"></span><span class="sk sk-p"></span></div><div class="au-act"><span class="sk sk-b"></span><span class="sk sk-b"></span></div></section>' +
      /* one-time notice for people with v2.1 notes */
      card("notice", ' aria-labelledby="acHNotice"', '<div class="au-head"><h2 id="acHNotice" tabindex="-1">Vaani now has free accounts</h2><p>From version 2.2, people 18 or older sign in to use Vaani. Your notes still stay in this browser, and we can’t see them. Want a copy first?</p></div>' +
        '<div class="au-act"><button type="button" class="btn-2" id="acExport">' + IC.doc + "Export my notes</button>" +
        '<button type="button" class="done-btn" id="acNoticeGo">Continue</button></div>' + note("The copy is a file on this device. Nothing is sent anywhere. " + PRIV)) +
      /* the age question */
      card("age", ' aria-labelledby="acHAge"', '<div class="au-head"><h2 id="acHAge" tabindex="-1">Are you 18 or older?</h2><p>Adults sign in with a free account. Under 18? Use Vaani without one. Vaani keeps nothing about you, only a daily count with no name or device attached.</p></div>' +
        '<div class="au-act"><button type="button" class="btn-2" id="acAdult">Yes, I’m 18 or older</button><button type="button" class="btn-2" id="acMinor">No, I’m under 18</button></div>' +
        note("Your notes stay on this device either way. " + PRIV)) +
      /* the two ways in */
      card("welcome", ' aria-labelledby="acHIn"', '<div class="au-head"><h2 id="acHIn" tabindex="-1">Sign in to start</h2><p>It’s free. Your notes stay on this device.</p></div>' +
        '<div class="au-act"><div class="gbtn" id="acGoogle" aria-label="Continue with Google"><span class="sk sk-b"></span></div>' +
        '<button type="button" class="btn-2" id="acToEmail">' + IC.mail + "Continue with email</button>" +
        '<button type="button" class="cancel" id="acBackAge">Back</button></div>' +
        note("Your account keeps your email and when you sign in. Never what you say or your notes. " + PRIV)) +
      /* email */
      card("email", ' aria-labelledby="acHEmail"', '<div class="au-head"><h2 id="acHEmail" tabindex="-1">Sign in with email</h2><p id="acEmailLine">We’ll email you a link. No password to remember.</p></div>' +
        '<form class="au-act" id="acEmailForm" novalidate><div><label class="au-l" for="acEmail">Email</label>' +
        '<input class="field" id="acEmail" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="name@gmail.com" aria-describedby="acEmailHelp" maxlength="254">' +
        '<p class="au-help" id="acEmailHelp"></p></div>' +
        '<button type="submit" class="done-btn" id="acSend">' + SPIN + '<span class="lbl">Email me a link</span></button>' +
        '<button type="button" class="cancel" id="acEmailBack">Back</button></form>' +
        note("Your account keeps your email and when you sign in. Never what you say or your notes. " + PRIV)) +
      /* inbox */
      card("inbox", ' aria-labelledby="acHInbox"', '<div class="au-head"><h2 id="acHInbox" tabindex="-1">Check your inbox</h2><p>We emailed a sign-in link to <b id="acSentTo"></b>. Open it on this device to finish.</p></div>' +
        '<div class="au-act"><a class="btn-2" id="acGmail" href="https://mail.google.com/" target="_blank" rel="noopener" hidden>' + IC.mail + "Open Gmail</a>" +
        '<div class="au-links"><button type="button" class="lnk" id="acResend" aria-disabled="true">Resend in 0:30</button><button type="button" class="lnk" id="acOther">Use a different email</button></div></div>' +
        '<p class="au-note" id="acInboxNote">Not there? Look in spam or promotions. Each link works once.</p><p class="sr" role="status" id="acInboxSr"></p>') +
      /* the link was opened */
      card("link-opening", ' aria-live="polite"', '<div class="au-head au-wait">' + SPIN + "<p><b>Signing you in…</b>This takes a moment.</p></div>", "solo") +
      card("link-confirm", ' aria-labelledby="acHConfirm"', '<div class="au-head"><h2 id="acHConfirm" tabindex="-1">Confirm your email</h2><p>You opened the link in a different browser. Type the email you used, so we know it’s you.</p></div>' +
        '<form class="au-act" id="acConfirmForm" novalidate><div><label class="au-l" for="acEmail2">Email</label>' +
        '<input class="field" id="acEmail2" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="name@gmail.com" aria-describedby="acEmail2Help" maxlength="254">' +
        '<p class="au-help" id="acEmail2Help"></p></div><button type="submit" class="done-btn">Sign in</button></form>') +
      card("link-expired", ' aria-labelledby="acHExpired"', '<div class="au-head"><h2 id="acHExpired" tabindex="-1">This link has expired</h2><p>Sign-in links work once, and only for a short time. <span id="acExpiredLine"></span></p></div>' +
        '<div class="au-act"><button type="button" class="done-btn" id="acNewLink">Email me a new link</button><div class="au-links"><button type="button" class="lnk" id="acExpiredOther">Use a different email</button></div></div>') +
      /* consent */
      '<section class="cs" data-st="consent" aria-labelledby="acHConsent" hidden><div id="acNotice">' +
        '<div class="cs-head"><div><h1 class="pg-h1" id="acHConsent" tabindex="-1">Before you start</h1>' +
        '<p class="pg-sub" id="acConsentSub">You’re signed in as <b id="acConsentWho"></b>. Your notes never leave this browser.</p></div></div>' +
        '<div class="cs-ledger"><section class="cs-keep" aria-labelledby="acHKeep"><h2 id="acHKeep">Your account keeps</h2><ul>' +
        "<li>" + IC.mail + "<span>Your email and name</span></li><li>" + IC.clock + "<span>When you signed up and each time you sign in</span></li></ul>" +
        '<h2 class="cs-h2b" id="acHOpt">Only if you say yes below</h2><ul aria-labelledby="acHOpt"><li>' + IC.bars + "<span>For each recording: its meeting type (like “sales”), length and language</span></li><li>" + IC.phone + "<span>Your type of device and browser, and which features you use</span></li></ul></section>" +
        '<section class="cs-never" aria-labelledby="acHNever"><h2 id="acHNever">Vaani never gets</h2><ul><li>' + IC.mic + "<span>Your audio, or what anyone says</span></li><li>" + IC.doc + "<span>Your transcripts, notes and titles</span></li><li>" + IC.ppl + "<span>Names of people in your meetings, or your calendar events</span></li><li>" + IC.key + "<span>Your AI keys</span></li></ul></section></div>" +
        '<div class="cs-secs"><section class="cs-sec" aria-labelledby="acHWhy"><h2 id="acHWhy">Why</h2><p>We use this to run your account, keep it secure, and count how many people use Vaani. It is never sold or used for ads.</p></section>' +
        '<section class="cs-sec" aria-labelledby="acHChoice"><h2 id="acHChoice">Your choices</h2><p>You can download your data, turn stats off or delete your account any time in Settings. Vaani is run by Pradeep Zille, Bengaluru.</p><p>Questions or complaints: <a class="lnk-in" href="mailto:' + PRIVACY_EMAIL + '">' + PRIVACY_EMAIL + "</a>. If you’re not satisfied, you can complain to the Data Protection Board of India.</p></section></div>" +
        '<details class="cs-more"><summary>What exactly is kept</summary><div class="cs-tbl" role="region" aria-label="What exactly is kept" tabindex="0"><table><thead><tr><th scope="col">What</th><th scope="col">Kept where</th><th scope="col">For how long</th></tr></thead><tbody>' +
        "<tr><td>Email, name, sign-up date, last sign-in</td><td>Firebase Authentication (Google, United States)</td><td>While your account is open</td></tr>" +
        "<tr><td>Each sign-in (date and time)</td><td>Firestore, Mumbai</td><td>12 months</td></tr>" +
        "<tr><td>Usage stats, only if you said yes</td><td>Firestore, Mumbai</td><td>12 months, then deleted or kept only as anonymous totals</td></tr>" +
        "<tr><td>What you agreed to, and when</td><td>Firestore, Mumbai</td><td>While your account is open</td></tr></tbody></table></div>" +
        "<p>Google runs Firebase for Vaani and may only use this data to provide that service. Firebase sees the IP address you sign in from and keeps it for a few weeks to stop abuse. Vaani does not save it. We never sell your data, show ads or share it with any company.</p></details>" +
        '<fieldset class="cs-boxes"><legend class="sr">Your answers</legend>' +
        '<label class="cs-box" id="acBox1Row"><input type="checkbox" id="acBox1" aria-describedby="acBox1Err"><span><b>I am 18 or older, and I agree to Vaani keeping the account details above.</b> <i>Required</i></span></label>' +
        '<p class="au-help cs-err" id="acBox1Err"></p>' +
        '<label class="cs-box"><input type="checkbox" id="acBox2"><span><b>Also share usage stats.</b> <i>Optional</i> For each recording, its meeting type (like “sales”), length, language and device type, and which features I use. Never what was said.</span></label>' +
        "</fieldset></div>" +
        '</section>' +
      /* notes from before, on the first account that signs in here */
      card("migrate", ' aria-labelledby="acHMig"', '<div class="au-head"><h2 id="acHMig" tabindex="-1">Bring your notes into this account?</h2><p id="acMigLine"></p></div>' +
        '<div class="au-act"><button type="button" class="done-btn" id="acMigMove">Move my notes</button><button type="button" class="btn-2" id="acMigKeep">Keep them apart</button></div>' +
        note("We ask only once. Notes stay on this device either way, and are never uploaded.")) +
      "</div>" +
      /* n1: the consent footer sits outside the column, so its hairline runs the full width */
      '<div class="cs-foot" data-st="consent" hidden><div class="cs-foot-in"><div class="au-alert err" role="alert" id="acConsentErr" hidden>' + IC.err + "<p>Couldn’t save your answer. Check your connection and try again.</p></div>" +
      '<button type="button" class="done-btn" id="acAgree">' + SPIN + '<span class="lbl">Agree and continue</span></button>' +
      '<a class="lnk" href="privacy.html" target="_blank" rel="noopener">Read privacy policy</a>' +
      '<button type="button" class="btn-t" id="acConsentOut">Sign out</button></div></div>' +
      "</main>";
    gate.innerHTML = h;
    d.body.appendChild(gate);
    wireGate();
  }

  var FOCUS = { notice: "#acHNotice", age: "#acHAge", welcome: "#acHIn", email: "#acEmail", inbox: "#acHInbox", "link-confirm": "#acEmail2", "link-expired": "#acHExpired", consent: "#acHConsent", migrate: "#acHMig" };
  function gateShow(st, keepAlert) {
    if (!gate) buildGate();
    gate.hidden = false; hideApp(true); root.classList.add("acct-gated");
    var was = gateState; gateState = st;
    if (!keepAlert && was !== st) setAlert("");
    $$("[data-st]", gate).forEach(function (el) { el.hidden = el.getAttribute("data-st") !== st; });
    gate.setAttribute("data-state", st);
    placeAlert();
    if (st === "welcome") renderGoogle();
    if (st === "consent") gate.scrollTop = 0;
    var f = FOCUS[st] && $(FOCUS[st], gate);
    if (f && was !== st && was !== "") setTimeout(function () { try { f.focus({ preventScroll: st === "consent" }); } catch (e) { /* gone */ } }, 30);
  }
  function release() {
    if (gate) gate.hidden = true;
    gateState = "";
    hideApp(false); root.classList.remove("acct-gated");
  }
  /* one notice at a time, at the top of the visible card */
  var ALERTS = {
    offline: { err: false, ic: "off", t: "You’re offline. Signing in needs the internet, just this once." },
    error: { err: true, ic: "err", t: "Couldn’t sign you in. Check your connection and try again." },
    gisload: { err: true, ic: "err", t: "Couldn’t reach Google. Check your connection, or continue with email." },
    deleted: { err: false, ic: "lock", t: "Your account is deleted. Notes on this device are still here." },
    deletedLogin: { err: false, ic: "lock", t: "Your data is deleted. Sign in once more to remove your login." },
    deletedAll: { err: false, ic: "lock", t: "Your account and the notes in this browser are deleted." },
    deletedLoginAll: { err: false, ic: "lock", t: "Your data and the notes in this browser are deleted. Sign in once more to remove your login." },
    deleteLater: { err: false, ic: "lock", t: "Your account isn’t fully deleted yet. Sign in again to finish deleting it." },
    deleteFailed: { err: true, ic: "err", t: "Vaani couldn’t finish deleting your account. Part of it may already be deleted. Sign in again to finish, or write to " + PRIVACY_EMAIL + " and it will be removed." },
    limit: { err: true, ic: "err", t: "Too many links asked for. Wait a few minutes, then try again." },
    otherWay: { err: true, ic: "err", t: "This email already signs in another way. Use the button you used before." },
    disabled: { err: true, ic: "err", t: "This account is turned off. Write to " + PRIVACY_EMAIL + " for help." },
    storage: { err: true, ic: "err", t: "This browser is blocking what sign-in needs. Turn off private browsing, or try another browser." },
    expiredNoEmail: { err: false, ic: "err", t: "That link has expired. Enter your email for a new one." },
  };
  function setAlert(kind) {
    alertKind = kind;
    var a = gate && $("#acAlert", gate); if (!a) return;
    var al = ALERTS[kind];
    if (!al) { a.hidden = true; a.innerHTML = ""; a.removeAttribute("role"); placeAlert(); return; }
    a.className = "au-alert" + (al.err ? " err" : "");
    a.setAttribute("role", al.err ? "alert" : "status");
    a.innerHTML = IC[al.ic] + "<p>" + esc(al.t) + "</p>";
    a.hidden = false; placeAlert();
  }
  function placeAlert() {
    var a = gate && $("#acAlert", gate); if (!a) return;
    var c = $$(".au-card", gate).filter(function (x) { return !x.hidden; })[0];
    if (c && alertKind && !a.hidden) c.insertBefore(a, c.firstChild); else $("#acAlertHome", gate).appendChild(a);
  }
  function busy(btn, on, label) {
    if (!btn) return;
    btn.classList.toggle("is-busy", !!on);
    if (on) { btn.setAttribute("aria-busy", "true"); btn.setAttribute("aria-disabled", "true"); } else { btn.removeAttribute("aria-busy"); btn.removeAttribute("aria-disabled"); }
    var l = $(".lbl", btn); if (l && label) l.textContent = label;
  }
  function off(btn) { return btn && btn.getAttribute("aria-disabled") === "true"; }
  function fieldErr(inp, help, msg) {
    inp.setAttribute("aria-invalid", msg ? "true" : "false");
    help.innerHTML = msg ? '<span class="au-err">' + IC.errS + esc(msg) + "</span>" : "";
  }
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

  function firstCard() {
    var del = ssGet("vaani.acct.deleted"); ssSet("vaani.acct.deleted", null);
    if (!lsGet(LSK.first) && !lsGet(LSK.seen) && defaultNotes().length) { gateShow("notice"); return; }
    gateShow("age");
    if (del) setAlert(del === "loginrm" ? "deletedLoginAll" : del.indexOf("login") === 0 ? "deletedLogin" : del === "1rm" ? "deletedAll" : del === "failed" ? "deleteFailed" : del === "later" ? "deleteLater" : "deleted");
    else if (navigator.onLine === false) setAlert("offline");
  }

  var gRendered = false;
  function renderGoogle() {
    if (gRendered || !VA || !ST || ST.status === "error") return;
    var el = $("#acGoogle", gate); gRendered = true;
    var w = Math.round(el.getBoundingClientRect().width) || 320;
    googleInto(el, w, "signin", root.getAttribute("data-theme") === "dark" || (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches) ? "filled_black" : "outline")
      .catch(function (e) { gRendered = false; el.innerHTML = ""; el.hidden = true; console.info("[vaani-accounts] Google sign-in unavailable:", errCode(e)); setAlert("gisload"); });
  }
  /* S5: Google's own button ("large" is 40 px) drawn rectangular and scaled to 52 px inside a wrapper with the email
     button's 14 px corners. Nothing of Google's button is restyled: only its size, by the transform. */
  var G_SCALE = 1.3;
  function googleInto(el, w, mode, theme) {
    return VA.renderGoogleButton(el, { width: Math.max(200, Math.min(400, Math.floor(w / G_SCALE))), mode: mode, theme: theme })
      .then(function () { var sk = $(".sk", el); if (sk) sk.remove(); el.classList.add("is-ready"); });
  }

  function mapSignInError(c) {
    if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request") return "";
    if (c === "auth/network-request-failed" && navigator.onLine === false) return "offline";
    if (c === "auth/account-exists-with-different-credential") return "otherWay";
    if (c === "auth/user-disabled") return "disabled";
    if (c === "auth/web-storage-unsupported") return "storage";
    if (c === "auth/too-many-requests" || c === "auth/quota-exceeded") return "limit";
    if (c && c !== "unknown") console.info("[vaani-accounts] sign-in error:", c);
    return "error";
  }

  function startResend() {
    var b = $("#acResend", gate), left = 30; clearInterval(resendT);
    b.setAttribute("aria-disabled", "true"); b.textContent = "Resend in 0:30";
    resendT = setInterval(function () {
      left--; if (left > 0) { b.textContent = "Resend in 0:" + ("0" + left).slice(-2); return; }
      clearInterval(resendT); b.removeAttribute("aria-disabled"); b.textContent = "Resend link";
      $("#acInboxSr", gate).textContent = "You can ask for another link now.";
    }, 1000);
  }
  function linkUrl() { return location.origin + location.pathname + "?auth=link" + (override ? "&accounts=1" : ""); }
  function sendLink(email, btn, then) {
    if (btn) busy(btn, true, "Sending link…");
    return startFirebase().then(function () { return VA.sendEmailLink(email, { continueUrl: linkUrl() }); }).then(function () {
      sentTo = email; if (btn) busy(btn, false, "Email me a link");
      $("#acSentTo", gate).textContent = email;
      $("#acGmail", gate).hidden = !/@(gmail|googlemail)\.com$/i.test(email);
      gateShow("inbox"); startResend(); if (then) then();
    }, function (e) {
      if (btn) busy(btn, false, "Email me a link");
      var c = errCode(e);
      if (c === "bad-email" || c === "auth/invalid-email") { gateShow("email"); fieldErr($("#acEmail", gate), $("#acEmailHelp", gate), "Enter your full email, like name@gmail.com."); $("#acEmail", gate).focus(); return; }
      setAlert(mapSignInError(c));
    });
  }

  function wireGate() {
    $("#acExport", gate).addEventListener("click", function () { var b = d.getElementById("bkDl"); if (b) b.click(); });
    $("#acNoticeGo", gate).addEventListener("click", function () { lsSet(LSK.seen, "1"); gateShow("age"); });
    /* A-13: Firebase (and its Auth SDK) loads only now, never for someone who says they are under 18 */
    $("#acAdult", gate).addEventListener("click", function () { gateShow("welcome"); if (navigator.onLine === false) setAlert("offline"); startFirebase(); });
    $("#acMinor", gate).addEventListener("click", goMinor);
    $("#acBackAge", gate).addEventListener("click", function () { gateShow("age"); });
    $("#acToEmail", gate).addEventListener("click", function (e) { if (off(e.currentTarget)) return; gateShow("email"); });
    $("#acEmailBack", gate).addEventListener("click", function () { gateShow("welcome"); });
    $("#acEmailForm", gate).addEventListener("submit", function (e) {
      e.preventDefault(); var inp = $("#acEmail", gate), btn = $("#acSend", gate); if (off(btn)) return;
      var v = inp.value.trim();
      if (!EMAIL_RE.test(v) || v.length > 254) { fieldErr(inp, $("#acEmailHelp", gate), "Enter your full email, like name@gmail.com."); inp.focus(); return; }
      fieldErr(inp, $("#acEmailHelp", gate), ""); setAlert(""); sendLink(v, btn);
    });
    $("#acEmail", gate).addEventListener("input", function () { if (this.getAttribute("aria-invalid") === "true" && EMAIL_RE.test(this.value.trim())) fieldErr(this, $("#acEmailHelp", gate), ""); });
    $("#acResend", gate).addEventListener("click", function () {
      if (off(this)) return;
      sendLink(sentTo, null, function () { var n = $("#acInboxNote", gate), s = $("#acInboxSr", gate); s.textContent = "We emailed another link. Use the newest one."; n.textContent = "We emailed another link. Use the newest one."; setTimeout(function () { n.textContent = "Not there? Look in spam or promotions. Each link works once."; }, 5000); });
    });
    $("#acOther", gate).addEventListener("click", function () { clearInterval(resendT); if (VA) VA.forgetLinkEmail(); gateShow("email"); });
    $("#acExpiredOther", gate).addEventListener("click", function () { if (VA) VA.forgetLinkEmail(); gateShow("email"); });
    $("#acNewLink", gate).addEventListener("click", function () { if (sentTo) sendLink(sentTo, null); else gateShow("email"); });
    $("#acConfirmForm", gate).addEventListener("submit", function (e) {
      e.preventDefault(); var inp = $("#acEmail2", gate), v = inp.value.trim();
      if (!EMAIL_RE.test(v)) { fieldErr(inp, $("#acEmail2Help", gate), "Enter your full email, like name@gmail.com."); inp.focus(); return; }
      finishLink(v);
    });
    $("#acBox1", gate).addEventListener("change", function () { if (this.checked) { $("#acBox1Err", gate).innerHTML = ""; $("#acBox1Row", gate).classList.remove("bad"); } });
    $("#acAgree", gate).addEventListener("click", agree);
    /* A-05: saying no removes the Firebase Auth record sign-in just made (someone new); then the gate starts over */
    $("#acConsentOut", gate).addEventListener("click", function () { if (off(this)) return; this.setAttribute("aria-disabled", "true"); var b = this; VA.declineConsent().catch(function () {}).then(function () { b.removeAttribute("aria-disabled"); }); });
    window.addEventListener("online", function () { if (alertKind === "offline") setAlert(""); });
    window.addEventListener("offline", function () { if (gateState && gateState !== "consent") setAlert("offline"); });
    /* the app's keyboard shortcuts (Ctrl J records) must not reach the app behind the gate */
    window.addEventListener("keydown", function (e) { if (gateState) e.stopPropagation(); }, true);
  }

  function goMinor() {
    lsSet(LSK.age, "u18"); u18 = true; A.u18 = true;
    if (VA && ST && ST.user) VA.signOut().catch(function () {});
    release(); setupHooks(); paintSettings(); paintPrivacy(); anonOpen();
  }

  function finishLink(email) {
    linkBusy = true; gateShow("link-opening");
    VA.completeEmailLink(email).then(function () { linkBusy = false; handle(VA.getState()); }, function (e) {
      linkBusy = false; var c = errCode(e);
      if (c === "need-email") { gateShow("link-confirm"); return; }
      if (c === "auth/invalid-email") { gateShow("link-confirm"); fieldErr($("#acEmail2", gate), $("#acEmail2Help", gate), "That email doesn’t match the link. Check it, or start again."); return; }
      if (c === "auth/expired-action-code" || c === "auth/invalid-action-code") {
        var known = sentTo || email || VA.savedLinkEmail() || ""; /* S1: the address this browser sent the link to (kept 1 hour, A-16) */
        if (known) { sentTo = known; $("#acExpiredLine", gate).innerHTML = "We can email a new one to <b>" + esc(known) + "</b>."; gateShow("link-expired"); }
        else { gateShow("email"); setAlert("expiredNoEmail"); }
        return;
      }
      gateShow("welcome"); setAlert(mapSignInError(c));
    });
  }

  function agree() {
    var btn = $("#acAgree", gate); if (off(btn)) return;
    var b1 = $("#acBox1", gate), b2 = $("#acBox2", gate);
    if (!b1.checked) {
      $("#acBox1Row", gate).classList.add("bad");
      $("#acBox1Err", gate).innerHTML = '<span class="au-err">' + IC.errS + "Tick the first box to continue. An account needs it.</span>";
      b1.focus(); return;
    }
    $("#acConsentErr", gate).hidden = true;
    busy(btn, true, "Saving…"); $("#acConsentOut", gate).setAttribute("aria-disabled", "true");
    var p = ST && ST.user && ST.user.provider === "google" ? "checkbox+google_button" : "checkbox+email_link";
    sha256(textOf($("#acNotice", gate))).then(function (hash) {
      return VA.giveConsent({ stats: b2.checked, record: { notice_version: VA.NOTICE_VERSION, notice_hash: hash, notice_lang: "en", policy_url: policyUrl(), method: p } });
    }).then(function () { busy(btn, false, "Agree and continue"); $("#acConsentOut", gate).removeAttribute("aria-disabled"); }, function (e) {
      console.info("[vaani-accounts] consent not saved:", errCode(e));
      busy(btn, false, "Agree and continue"); $("#acConsentOut", gate).removeAttribute("aria-disabled");
      $("#acConsentErr", gate).hidden = false;
    });
  }

  /* ================= state ================= */
  function handle(st) {
    ST = st;
    if (st.status === "loading") return;
    if (st.status === "unconfigured") { console.info("[vaani-accounts] Firebase is not set up (placeholder config): Vaani runs as v2.1."); release(); return; }
    if (finishing) return;
    if (st.deleted) {
      VA.ackDeleted();
      if (delCtx) { finishDelete(st.deleted === "done" ? "1" : "failed"); return; }
      if (nsUid) { ssSet("vaani.acct.deleted", st.deleted === "done" ? "1" : "failed"); finishing = true; lsSet(LSK.uid, null); location.reload(); return; }
      gateShow("age"); setAlert(st.deleted === "done" ? "deleted" : "deleteFailed"); return;
    }
    if (delCtx && delCtx.reauth && st.error && st.error !== delCtx.lastErr) { delCtx.lastErr = st.error; reauthErr(st.error); return; }
    if (delCtx && st.reauth) { showReauth(st.reauth.provider); return; }
    /* the login going away mid-deletion is part of the deletion: finishDelete reloads with the right notice, not switchTo */
    if (delCtx && st.status === "signed-out") return;
    if (linkBusy) return;
    if (st.status === "delete-pending") {
      /* R-2: a deletion that stopped part way is never finished silently: say so, and let the person finish it */
      if (delCtx || !st.user) return;
      if (nsUid === st.user.uid) { release(); paintSettings(); paintPrivacy(); openDel(true); return; }
      switchTo(st.user.uid); return;
    }
    if (st.status === "ready") { onReady(st); return; }
    if (nsUid) {
      /* the app is showing a stored account: offline start keeps it; a sign-out anywhere returns to the gate */
      if (st.status === "error") { setupHooks(); paintSettings(); return; }
      switchTo(""); return;
    }
    if (st.status === "needs-consent") {
      var who = st.user ? st.user.email : "";
      if (gateState !== "consent") {
        $("#acConsentWho", gate).textContent = who;
        $("#acHConsent", gate).textContent = st.isNew ? "Before you start" : "What Vaani keeps has changed";
        $("#acBox1", gate).checked = false; $("#acBox2", gate).checked = false;
        gateShow("consent");
      }
      return;
    }
    if (st.status === "unverified") { VA.signOut().catch(function () {}); gateShow("welcome"); setAlert("error"); return; }
    if (st.status === "error") {
      if (!gateState || gateState === "boot") firstCard();
      setAlert(navigator.onLine === false ? "offline" : "error");
      return;
    }
    /* signed out */
    if (!gateState || gateState === "boot" || gateState === "consent" || gateState === "link-opening" || gateState === "migrate") firstCard();
    if (st.error && st.error !== lastErr) { lastErr = st.error; var k = mapSignInError(st.error); if (k) { if (gateState !== "welcome") gateShow("welcome"); setAlert(k); } }
  }

  function onReady(st) {
    var uid = st.user.uid;
    if (nsUid === uid) { release(); setupHooks(); paintSettings(); paintPrivacy(); return; }
    if (nsUid) { switchTo(uid); return; }
    var first = lsGet(LSK.first), n = defaultNotes().length;
    if (first || !n) { if (!first) lsSet(LSK.first, uid); switchTo(uid); return; }
    $("#acMigLine", gate).textContent = "This browser has " + plural(n, "note", "notes") + " from before you signed in. Move them into the notes for " + st.user.email + ", or keep them apart.";
    gateShow("migrate");
    $("#acMigMove", gate).onclick = function () { lsSet(LSK.first, uid); migrate(uid); switchTo(uid); };
    $("#acMigKeep", gate).onclick = function () { lsSet(LSK.first, uid); switchTo(uid); };
  }

  /* change the notes namespace, then reload so the whole app reads the right notes */
  var switching = false;
  function switchTo(uid) {
    if (switching) return; switching = true;
    lsSet(LSK.uid, uid || null);
    var wait = VA ? Promise.race([VA.whenSettled().then(function () { return VA.flush(); }), new Promise(function (r) { setTimeout(r, 4000); })]) : Promise.resolve();
    wait.catch(function () {}).then(function () { location.reload(); });
  }

  /* move the default (signed-out) keys into an account's namespace */
  function migrate(uid) {
    var ks = []; try { for (var i = 0; i < localStorage.length; i++) ks.push(localStorage.key(i)); } catch (e) { return; }
    ks.filter(personal).forEach(function (k) {
      var v = lsGet(k), t = nsKey(uid, k), cur = lsGet(t);
      if (cur != null && k === "vaani.history") {
        try { var a = JSON.parse(cur), b = JSON.parse(v), seen = {}; a.forEach(function (n) { seen[n.id] = 1; }); v = JSON.stringify(a.concat(b.filter(function (n) { return !seen[n.id]; }))); } catch (e) { /* keep the moved copy */ }
      } else if (cur != null) { lsSet(k, null); return; }
      lsSet(t, v); lsSet(k, null);
    });
  }
  /* remove an account's notes from this browser (sign out or delete, only when asked) */
  function removeLocal(uid) {
    var pre = "vaani.u." + uid + ".", ks = [];
    try { for (var i = 0; i < localStorage.length; i++) ks.push(localStorage.key(i)); } catch (e) { return Promise.resolve(); }
    ks.forEach(function (k) { if (k.indexOf(pre) === 0) lsSet(k, null); });
    return new Promise(function (res) {
      try {
        var r = indexedDB.open("vaani", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () {
          try {
            var tx = r.result.transaction("kv", "readwrite"), c = tx.objectStore("kv").openCursor();
            c.onsuccess = function () { var cur = c.result; if (!cur) return; if (String(cur.key).indexOf(pre) === 0) cur.delete(); cur.continue(); };
            tx.oncomplete = tx.onerror = tx.onabort = function () { res(); };
          } catch (e) { res(); }
        };
        r.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }

  /* ================= under 18: anonymous counters only ================= */
  function istDay() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
  function anon(bucket) {
    var go = function () { return VA.countAnon(CFG.VAANI_FIREBASE_CONFIG, bucket); };
    return (VA ? Promise.resolve() : loadModules()).then(go).catch(function () { return false; });
  }
  function anonOpen() { var t = istDay(); if (lsGet(LSK.anonDay) === t) return; lsSet(LSK.anonDay, t); anon("open"); }

  /* ================= usage hooks ================= */
  var hooked = false, made = {};
  function T(name, props) { if (u18 || !VA) return false; return VA.track(name, props); }
  window.VaaniTrack = function (name, props) { return T(name, props); };
  function setupHooks() {
    if (hooked) return; hooked = true;
    var V = window.Vaani, H = window.VaaniHome;
    if (!V || !H) return;
    H.ext.hooks.push(function (ev, x) {
      if (ev === "start") T("record_start", { mode: V.getMode() === "note" ? "note" : "meeting", call: !!(V.hasCallTrack && V.hasCallTrack()) });
      else if (ev === "made" && x && !made[x.id] && Date.now() - (+x.id || 0) < 15 * 60000) {
        made[x.id] = 1;
        if (u18) { anon(x.kind === "meeting" ? "meeting" : "note"); return; }
        var eng = VA ? VA.engineFromLabel(x.engine) : "basic";
        if (x.kind === "meeting") T("meeting_done", { type: !x.tmpl || x.tmpl === "auto" ? "other" : x.tmpl, durS: +x.dur || 0, lang: x.lang || "other", engine: eng, call: !!x.call, words: +x.words || 0 });
        else T("note_done", { durS: +x.dur || 0, lang: x.lang || "other", engine: eng, words: +x.words || 0 });
      } else if (ev === "translated" && x) T("translate", { to: x.to, engine: VA ? VA.engineFromLabel(x.engine) : "basic" });
      else if (ev === "asked" && x) T("ask", { engine: x.engine === "chrome" ? "chrome" : VA ? VA.engineFromLabel(x.engine) : "basic" });
      else if (ev === "sheet" && x === "#fuSheet") T("feature_used", { f: "followup" });
    });
    var ins = H.ext.pages && H.ext.pages.insights;
    if (ins && ins.render) { var r0 = ins.render, lastIns = 0; ins.render = function () { if (Date.now() - lastIns > 2000) T("insights_open"); lastIns = Date.now(); return r0.apply(this, arguments); }; }
    /* clicks, read in the capture phase before the app acts on them; nothing from the page is sent, only which control */
    var SHARE = { shWa: "whatsapp", shMail: "email", shNative: "native", shCopy: "copy", shDl: "download", tbCopy: "copy" };
    d.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target : null; if (!t) return;
      var b = t.closest("button,a"); if (!b) return;
      if (SHARE[b.id]) { T("share", { via: SHARE[b.id] }); return; }
      if (b.id === "bkDl" || b.getAttribute("data-act") === "backup") { T("feature_used", { f: "backup" }); return; }
      if (b.getAttribute("data-act") === "recap") { T("feature_used", { f: "recap" }); return; }
      if (b.getAttribute("data-act") === "insCopy") { T("feature_used", { f: "copy_stats" }); return; }
      if (b.hasAttribute("data-theme-set")) { T("feature_used", { f: "theme" }); return; }
      if ((b.hasAttribute("data-tk") || b.hasAttribute("data-ck")) && b.getAttribute("aria-pressed") === "false") { T("feature_used", { f: "todo_done" }); return; }
      if (b.id === "setDone") {
        var p = V.provider && d.getElementById("provSel") ? d.getElementById("provSel").value : "auto", ki = d.getElementById("keyInp");
        if (p !== "auto" && ki && ki.value.trim() && ki.value.trim() !== String(V.load("vaani.key." + p, "") || "")) T("feature_used", { f: "key_added" });
      }
    }, true);
    /* capture phase on the document: home.js clears the file input in its own change handler */
    d.addEventListener("change", function (e) { var t = e.target; if (t && t.id === "bkFile" && t.files && t.files.length) T("feature_used", { f: "restore" }); }, true);
    var srch = d.getElementById("search"), searched = false;
    if (srch) srch.addEventListener("input", function () { if (!searched && this.value.trim()) { searched = true; T("feature_used", { f: "search" }); } });
    window.addEventListener("appinstalled", function () { T("feature_used", { f: "install" }); });
    /* Calendar (calendar.js is not edited): connect and disconnect are read from its own settings writes.
       calendar_join is not sent: its "via" would come from the event's link, and Calendar data is never used
       for usage stats (privacy.html, Google Limited Use). */
    /* a folder counts when one is created (the folder list grows), not when the sheet opens */
    var saveJSON0 = V.saveJSON;
    V.saveJSON = function (k, v) { var before = k === "vaani.folders" ? (V.loadJSON(k, []) || []).length : 0; var r = saveJSON0.apply(this, arguments); if (k === "vaani.folders" && Array.isArray(v) && v.length > before) T("feature_used", { f: "folder" }); return r; };
    var save0 = V.save, remove0 = V.remove;
    V.save = function (k, v) { var was = V.load(k, ""); var r = save0.apply(this, arguments); if (k === "vaani.calOn" && String(v) === "1" && was !== "1") T("calendar_connect", { result: "ok" }); return r; };
    V.remove = function (k) { var was = k === "vaani.calOn" ? V.load(k, "") : ""; var r = remove0.apply(this, arguments); if (k === "vaani.calOn" && was === "1") T("calendar_disconnect"); return r; };
    var toast0 = V.toast;
    V.toast = function (m) {
      var s = String(m || "");
      if (/^Vaani needs permission to see your events|^Google Calendar wasn’t connected/.test(s)) T("calendar_connect", { result: "denied" });
      else if (/^The browser blocked Google’s sign-in window|^Couldn’t reach Google\. Check your connection/.test(s)) T("calendar_connect", { result: "error" });
      return toast0.apply(this, arguments);
    };
  }

  /* ================= Settings and the privacy sheet ================= */
  function avatarHue(uid) { var h = 0; for (var i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0; return 1 + (h % 8); }
  var setBuilt = false;
  function paintSettings() {
    var done = d.getElementById("setDone"), head = d.getElementById("setH");
    if (!done || !head) return;
    if (!setBuilt) {
      setBuilt = true;
      var acct = d.createElement("div"); acct.className = "opts acct-box"; acct.id = "acctRow";
      head.parentNode.insertBefore(acct, head.nextSibling);
      var box = d.createElement("div"); box.id = "acctSet";
      done.parentNode.insertBefore(box, done);
      acct.addEventListener("click", onSettingsClick); box.addEventListener("click", onSettingsClick);
      /* n2: Settings opens on its first setting, not on the account row's Sign out (openSheet focuses at 60 ms) */
      var H = window.VaaniHome; if (H && H.onSheet) { var prev = H.onSheet["#setSheet"]; H.onSheet["#setSheet"] = function () { if (prev) prev(); paintSettings(); setTimeout(function () { var ps = d.getElementById("provSel"); if (ps && d.activeElement && d.activeElement.closest && d.activeElement.closest("#acctRow")) ps.focus(); }, 90); }; }
    }
    var row = d.getElementById("acctRow"), box2 = d.getElementById("acctSet");
    if (u18) {
      row.hidden = true;
      box2.innerHTML = '<span class="form-l">Your account</span><div class="opts set-more"><div class="set-row"><span id="acNoAcct">No account<small>You use Vaani without one. Vaani keeps nothing about you, only a daily count with no name or device attached.</small></span><button type="button" data-acct="adult" aria-describedby="acNoAcct">I’m 18 or older</button></div></div>';
      return;
    }
    var u = ST && ST.user, ready = ST && ST.status === "ready";
    var name = u ? (u.provider === "google" && u.name ? u.name : u.email) : "Signed in";
    var sub = u ? (u.provider === "google" && u.name ? u.email : "Signed in with an email link") : "Account details load when you’re online";
    var init = String((u && (u.name || u.email)) || "V").trim().charAt(0).toUpperCase();
    var hue = avatarHue(nsUid || "v");
    row.hidden = false;
    row.innerHTML = '<div class="acct"><span class="acct-av c' + hue + '" aria-hidden="true">' + esc(init) + '</span><div class="acct-who" title="' + esc(u ? u.email : "") + '"><b>' + esc(name) + "</b><span>" + esc(sub) + '</span></div><button type="button" data-acct="out">Sign out</button></div>';
    var stats = !!(ST && ST.stats);
    var keepDl = d.getElementById("acDlState"), dlState = keepDl ? keepDl.getAttribute("data-s") : "";
    box2.innerHTML = '<span class="form-l">Your account</span><div class="opts set-more">' +
      '<div class="set-row"><span id="acStatsLbl">Share usage stats<small id="acStatsHelp">Meeting type, length, language, device type and features used. Never what was said. Turning this off deletes the stats already saved.</small><small id="acStatsMsg" role="status"></small></span>' +
      '<button type="button" class="switch" id="acStats" role="switch" aria-checked="' + stats + '" aria-labelledby="acStatsLbl"' + (ready ? "" : ' aria-disabled="true"') + ' data-acct="stats"><i aria-hidden="true"></i><span class="sr">' + (stats ? "On" : "Off") + "</span></button></div>" +
      '<div class="set-row" id="acDlRow"><span id="acDlLbl">Download my data<small id="acDlState" data-s="">Your account details, consent records and usage records, as a file</small></span><button type="button" data-acct="dl" id="acDl" aria-describedby="acDlLbl"' + (ready ? "" : ' aria-disabled="true"') + ">Download</button></div>" +
      '<div class="set-row"><span>Delete my account</span><button type="button" class="rm" data-acct="del"' + (ready ? "" : ' aria-disabled="true"') + ">Delete</button></div></div>" +
      '<p class="hint">Your notes are not part of your account. They stay in this browser, so keep a backup.' + (ready ? "" : " Account actions need the internet.") + "</p>";
    if (dlState) dlState = "";
  }
  function onSettingsClick(e) {
    var b = e.target.closest("[data-acct]"); if (!b || off(b)) return;
    var w = b.getAttribute("data-acct");
    if (w === "out") openOut();
    else if (w === "del") openDel();
    else if (w === "dl") download(b);
    else if (w === "stats") toggleStats(b);
    else if (w === "adult") { lsSet(LSK.age, null); location.reload(); }
  }
  function toggleStats(b) {
    var want = b.getAttribute("aria-checked") !== "true", msg = d.getElementById("acStatsMsg");
    b.setAttribute("aria-disabled", "true"); msg.textContent = want ? "Turning on…" : "Turning off and deleting saved stats…";
    sha256(textOf(d.getElementById("acStatsLbl")).replace(/(Turning on…|Turning off and deleting saved stats…)$/, "").trim()).then(function (hash) {
      return VA.setStats(want, { notice_version: VA.NOTICE_VERSION, notice_hash: hash, notice_lang: "en", policy_url: policyUrl() });
    }).then(function (r) {
      paintSettings(); var m = d.getElementById("acStatsMsg");
      if (r.stats) m.textContent = "Usage stats are on.";
      else m.textContent = r.purged >= 0 ? "Usage stats are off. The ones saved before are deleted." : "Usage stats are off. Deleting the saved ones didn’t finish; Vaani tries again next time.";
    }, function (err) {
      console.info("[vaani-accounts] stats not changed:", errCode(err));
      b.removeAttribute("aria-disabled"); msg.textContent = "Couldn’t change this. Check your connection and try again.";
    });
  }
  function download(b) {
    var st = d.getElementById("acDlState");
    b.hidden = true; st.className = ""; st.innerHTML = '<span class="busy" role="status">' + SPIN + "Preparing…</span>";
    VA.exportMyData().then(function (data) {
      saveFile("vaani-my-data.json", JSON.stringify(data, null, 1));
      st.setAttribute("role", "status"); st.textContent = "Saved to your downloads as vaani-my-data.json"; b.hidden = false;
    }, function (e) {
      console.info("[vaani-accounts] export failed:", errCode(e));
      st.className = "err"; st.setAttribute("role", "alert"); st.textContent = "Couldn’t make the file. Check your connection and try again."; b.hidden = false; b.textContent = "Try again";
    });
  }

  /* sheets: the app's own .scrim/.panel recipe, opened with Vaani.openSheet */
  var deleting = false;
  /* F1: while a step that has its own way out is showing ("Not now"), Escape and a tap on the scrim take that way out,
     so the person's choices (notes to remove) are carried out and they are told what happened */
  var sheetExit = null;
  function sheet(id, html) {
    var s = d.getElementById(id); if (s) return s;
    s = d.createElement("div"); s.className = "scrim acct-sheet"; s.id = id; s.hidden = true; s.innerHTML = html;
    s.addEventListener("click", function (e) {
      if (deleting) return;
      if (e.target === s || e.target.closest("[data-close]")) {
        if (sheetExit && s.contains(sheetExit)) { e.preventDefault(); sheetExit.click(); return; }
        window.Vaani.closeSheets();
      }
    });
    /* M4: a sheet keeps keyboard focus inside it */
    s.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var f = $$("button,input,a[href],iframe,[tabindex='0']", s).filter(function (x) { return !x.hidden && !x.closest("[hidden]") && x.offsetParent !== null; });
      if (!f.length) return;
      var a = f[0], z = f[f.length - 1];
      if (e.shiftKey && d.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && d.activeElement === z) { e.preventDefault(); a.focus(); }
    });
    d.body.appendChild(s); return s;
  }
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (deleting) { e.stopPropagation(); e.preventDefault(); return; }
    var s = d.getElementById("acctDel");
    if (sheetExit && s && !s.hidden && s.contains(sheetExit)) { e.stopPropagation(); e.preventDefault(); sheetExit.click(); }
  }, true);
  function localCount() { return nsUid ? notesIn(nsKey(nsUid, "vaani.history")).length : 0; }
  function openOut() {
    var who = ST && ST.user ? ST.user.email : "";
    var s = sheet("acctOut", '<div class="panel" role="dialog" aria-modal="true" aria-labelledby="acOutH"><h2 id="acOutH">Sign out of Vaani?</h2><p class="sub" id="acOutWho"></p>' +
      '<label class="cs-box set-box"><input type="checkbox" id="acOutRm"><span><b>Also remove this account’s notes from this browser</b> <i id="acOutN"></i></span></label>' +
      '<p class="hint">Leave this off to keep them here for the next time you sign in. Removed notes can only come back from a backup.</p>' +
      '<button type="button" class="done-btn" id="acOutGo">' + SPIN + '<span class="lbl">Sign out</span></button><button type="button" class="cancel" data-close>Cancel</button></div>');
    $("#acOutWho", s).textContent = who;
    var n = localCount(); $("#acOutN", s).textContent = n ? plural(n, "note", "notes") + " saved here." : "";
    $("#acOutRm", s).checked = false;
    /* S6: the choice shows on the button; with no notes here there is nothing to offer */
    $(".lbl", $("#acOutGo", s)).textContent = "Sign out"; $("#acOutGo", s).className = "done-btn";
    /* removing notes can't be undone without a backup: the button turns into the danger style (n-b) */
    $("#acOutRm", s).onchange = function () { var g = $("#acOutGo", s); $(".lbl", g).textContent = this.checked ? "Sign out and remove notes" : "Sign out"; g.className = this.checked ? "btn-danger" : "done-btn"; };
    $(".set-box", s).hidden = !n; $(".hint", s).hidden = !n;
    $("#acOutGo", s).onclick = function () {
      var b = this; if (off(b)) return; busy(b, true, $("#acOutRm", s).checked ? "Signing out and removing…" : "Signing out…");
      var rm = $("#acOutRm", s).checked, uid = nsUid;
      VA.signOut().catch(function () {}).then(function () { return rm ? removeLocal(uid) : null; }).then(function () { lsSet(LSK.uid, null); location.reload(); });
    };
    window.Vaani.openSheet("#acctOut");
    /* F3: with no notes the box is hidden, so focus goes to the button and stays inside the dialog */
    if (!n) setTimeout(function () { var g = $("#acOutGo", s); if (g) g.focus(); }, 80);
  }
  function openDel(pending) {
    var who = ST && ST.user ? ST.user.email : "";
    var s = sheet("acctDel", '<div class="panel del-view" role="dialog" aria-modal="true" aria-labelledby="acDelH"><div>' +
      '<h2 id="acDelH">Delete your account?</h2><p class="sub" id="acDelWho"></p><div class="facts">' +
      '<div class="fact">' + IC.bin + "<span><b>Your account, sign-in history and usage records go.</b> This can’t be undone.</span></div>" +
      '<div class="fact">' + IC.lock + "<span><b>Your notes stay on this device</b> unless you tick the box below. They were never part of your account.</span></div></div>" +
      '<div class="au-alert err" role="alert" id="acDelErr" hidden>' + IC.err + "<p>Couldn’t finish deleting your account. Part of it may already be deleted. Try again. If you leave, Vaani asks you to finish the next time you open it.</p></div>" +
      '<form id="acDelForm" novalidate><label class="cs-box set-box"><input type="checkbox" id="acDelRm"><span><b>Also delete the notes saved in this browser</b> <i id="acDelN"></i></span></label>' +
      '<label class="form-l" for="acDelWord">To confirm, type delete</label><input class="field" id="acDelWord" name="confirm" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="acDelHelp" maxlength="40">' +
      '<p class="au-help" id="acDelHelp"></p><button type="submit" class="btn-danger" id="acDelGo">' + SPIN + '<span class="lbl">Delete my account</span></button>' +
      '<button type="button" class="cancel" id="acDelCancel" data-close>Cancel</button></form></div>' +
      /* A-01: Firebase wants a fresh sign-in before it removes a login; the data is already deleted by then */
      '<div id="acRe" hidden><h2 id="acReH" tabindex="-1">Sign in again to delete</h2><p class="sub" id="acReLine">For your safety, confirm it’s you. Then your account is deleted.</p>' +
      '<div class="au-alert err" role="alert" id="acReErr" hidden>' + IC.err + '<p id="acReErrT"></p></div>' +
      '<div class="gbtn" id="acReG" aria-label="Continue with Google" hidden><span class="sk sk-b"></span></div>' +
      '<button type="button" class="done-btn" id="acReMail" hidden>' + SPIN + '<span class="lbl">Email me a link</span></button>' +
      '<p class="hint" id="acReSent" role="status" hidden></p>' +
      '<button type="button" class="cancel" id="acReCancel">Not now</button></div>' +
      /* R-2: a deletion that stopped part way, found at the next start */
      '<div id="acPend" hidden><h2 id="acPendH" tabindex="-1">Finish deleting your account</h2><p class="sub" id="acPendLine">Deleting your account didn’t finish last time. Part of it may already be deleted. Finish now to delete the rest, including your sign-in.</p>' +
      '<label class="cs-box set-box"><input type="checkbox" id="acPendRm"><span><b>Also delete the notes saved in this browser</b> <i id="acPendN"></i></span></label>' +
      '<button type="button" class="btn-danger" id="acPendGo">' + SPIN + '<span class="lbl">Finish deleting</span></button>' +
      '<button type="button" class="cancel" id="acPendCancel">Not now</button></div></div>');
    $("#acDelWho", s).textContent = who; $("#acDelWord", s).value = ""; $("#acDelRm", s).checked = false; $("#acDelErr", s).hidden = true;
    fieldErr($("#acDelWord", s), $("#acDelHelp", s), "");
    var n = localCount(); $("#acDelN", s).textContent = n ? plural(n, "note", "notes") + " saved here." : "";
    /* n-a: with no notes here there is nothing to offer */
    $("#acDelRm", s).closest(".set-box").hidden = !n; sheetExit = null;
    $("#acDelForm", s).onsubmit = function (e) {
      e.preventDefault(); var b = $("#acDelGo", s); if (off(b)) return;
      var w = $("#acDelWord", s);
      if (w.value.trim().toLowerCase() !== "delete") { fieldErr(w, $("#acDelHelp", s), "That doesn’t match. Type delete."); w.focus(); return; }
      fieldErr(w, $("#acDelHelp", s), ""); $("#acDelErr", s).hidden = true;
      deleting = true; busy(b, true, "Deleting…"); w.readOnly = true; $("#acDelCancel", s).setAttribute("aria-disabled", "true");
      var rm = $("#acDelRm", s).checked, uid = nsUid;
      delCtx = { rm: rm, uid: uid };
      VA.deleteAccount().then(function (r) {
        if (r && r.done) return finishDelete("1");
        if (r && r.needsSignIn) return showReauth(r.provider);
      }, function (err) {
        delCtx = null;
        console.info("[vaani-accounts] delete failed:", errCode(err));
        deleting = false; busy(b, false, "Delete my account"); w.readOnly = false; $("#acDelCancel", s).removeAttribute("aria-disabled"); $("#acDelErr", s).hidden = false;
      });
    };
    $("#acDelForm", s).parentNode.hidden = !!pending; $("#acRe", s).hidden = true; $("#acPend", s).hidden = !pending;
    s.querySelector(".panel").setAttribute("aria-labelledby", pending ? "acPendH" : "acDelH");
    if (pending) {
      $("#acPendRm", s).checked = false; $("#acPendRm", s).closest(".set-box").hidden = !n;
      $("#acPendN", s).textContent = n ? plural(n, "note", "notes") + " saved here." : "";
      $("#acPendGo", s).onclick = function () {
        var b = this; if (off(b)) return; deleting = true; busy(b, true, "Deleting…"); $("#acPendCancel", s).setAttribute("aria-disabled", "true");
        delCtx = { rm: $("#acPendRm", s).checked, uid: nsUid };
        /* the outcome comes back as state: deleted, a re-sign-in, or failed (handle) */
        VA.resumePendingDelete().catch(function () { finishDelete("failed"); });
      };
      $("#acPendCancel", s).onclick = function () {
        if (off(this)) return;
        finishing = true; VA.cancelDelete().then(function () { ssSet("vaani.acct.deleted", "later"); lsSet(LSK.uid, null); location.reload(); });
      };
      sheetExit = $("#acPendCancel", s);
    }
    window.Vaani.openSheet("#acctDel");
    setTimeout(function () { var w = pending ? $("#acPendH", s) : $("#acDelWord", s); if (w) w.focus(); }, 80);
    /* opened at page start (R-2), the app may still move focus while it loads: bring it back into the sheet once */
    if (pending) setTimeout(function () { var w = $("#acPendH", s); if (w && !s.hidden && !s.contains(d.activeElement)) w.focus(); }, 400);
  }
  var delCtx = null, finishing = false;
  /* the deletion is complete (or could not finish): notes too if asked, then back to the gate with the right notice (M5) */
  function finishDelete(kind) {
    if (finishing) return; finishing = true;
    var c = delCtx || { rm: false, uid: nsUid };
    var rm = c.rm && kind === "1"; /* notes go only with a deletion that finished */
    (rm ? removeLocal(c.uid) : Promise.resolve()).then(function () {
      ssSet("vaani.acct.deleted", kind + (rm ? "rm" : "")); lsSet(LSK.uid, null); location.reload();
    });
  }
  function showReauth(provider) {
    var s = d.getElementById("acctDel"); if (!s || !delCtx) return;
    if (delCtx.reauth) return; delCtx.reauth = provider;
    $("#acDelForm", s).parentNode.hidden = true; $("#acPend", s).hidden = true; $("#acRe", s).hidden = false;
    s.querySelector(".panel").setAttribute("aria-labelledby", "acReH");
    if (provider === "google") {
      var g = $("#acReG", s); g.hidden = false;
      googleInto(g, Math.round(g.getBoundingClientRect().width) || 320, "reauth").catch(function () { reauthErr("gisload"); });
    } else {
      $("#acReLine", s).textContent = "For your safety, confirm it’s you with a link sent to " + (ST && ST.user ? ST.user.email : "your email") + ". Opening it on this device deletes your account.";
      $("#acReMail", s).hidden = false;
      $("#acReMail", s).onclick = function () {
        var b = this; if (off(b)) return; busy(b, true, "Sending link…");
        VA.sendDeleteLink(linkUrl() + "&del=1").then(function () {
          busy(b, false, "Email me a link"); b.hidden = true;
          var t = $("#acReSent", s); t.hidden = false; t.textContent = "We emailed a link to " + (ST && ST.user ? ST.user.email : "you") + ". Open it on this device to finish. You can close this sheet.";
        }, function (e) { busy(b, false, "Email me a link"); reauthErr(errCode(e)); });
      };
    }
    $("#acReCancel", s).onclick = function () {
      /* leave now: the data is gone already; the next sign-in here removes the login */
      if (finishing) return;
      finishing = true; var rm = !!(delCtx && delCtx.rm);
      VA.cancelDelete().then(function () { (rm ? removeLocal(delCtx.uid) : Promise.resolve()).then(function () { ssSet("vaani.acct.deleted", rm ? "loginrm" : "login"); lsSet(LSK.uid, null); location.reload(); }); });
    };
    sheetExit = $("#acReCancel", s);
    deleting = false; /* the sheet may be left with Not now, Escape or the scrim (all the same path, F1) */
    setTimeout(function () { var h = $("#acReH", s); if (h) h.focus(); }, 60);
  }
  function reauthErr(c) {
    var s = d.getElementById("acctDel"); if (!s) return;
    var t = c === "auth/user-mismatch" ? "That’s a different Google account. Use " + (ST && ST.user ? ST.user.email : "the one you signed in with") + "."
      : c === "gisload" ? "Couldn’t reach Google. Check your connection and try again."
      : c === "auth/popup-closed-by-user" ? "" : "Couldn’t confirm it’s you. Try again.";
    if (!t) return;
    $("#acReErrT", s).textContent = t; $("#acReErr", s).hidden = false;
  }

  var privBuilt = false;
  function paintPrivacy() {
    var facts = d.querySelector("#privSheet .facts"); if (!facts) return;
    var f = d.getElementById("privAcct");
    if (!f) {
      f = d.createElement("div"); f.className = "fact"; f.id = "privAcct";
      var after = facts.children[2] || null; facts.insertBefore(f, after);
    }
    f.innerHTML = IC.user + (u18
      ? "<span><b>No account.</b> You use Vaani without one, so Vaani keeps nothing about you. It only adds one to an anonymous daily count when Vaani is opened or a note is made, with no name, device or time attached.</span>"
      : "<span><b>Your account keeps the basics.</b> Your email, name, sign-up date and sign-in times, held by Google Firebase. If you said yes to usage stats: meeting type, length, language, device type and features used, never what was said. Download your data, turn stats off or delete your account in Settings.</span>");
    if (!privBuilt) { privBuilt = true; var H = window.VaaniHome; if (H && H.onSheet) { var prev = H.onSheet["#privSheet"]; H.onSheet["#privSheet"] = function () { if (prev) prev(); paintPrivacy(); }; } }
  }

  /* ================= start ================= */
  var fbP = null;
  function startFirebase() {
    if (fbP) return fbP;
    fbP = loadModules().then(function () {
      return VA.init(CFG.VAANI_FIREBASE_CONFIG, { appVersion: APP_VERSION, googleClientId: CFG.VAANI_GOOGLE_SIGNIN_CLIENT_ID });
    }).then(function () {
      if (VA.isEmailLinkReturn()) {
        /* a link that confirms a deletion is used even while signed in here; any other is not needed then */
        var pend = lsGet("vaani.a.del");
        if (nsUid && pend !== nsUid) { try { var u = new URL(location.href); ["apiKey", "oobCode", "mode", "lang", "continueUrl", "tenantId", "auth"].forEach(function (k) { u.searchParams.delete(k); }); history.replaceState(history.state, "", u.pathname + u.search + u.hash); } catch (e) { /* keep */ } }
        else finishLink();
      }
      VA.onState(handle);
      if (gateState === "welcome") renderGoogle();
    }).catch(function (e) {
      console.info("[vaani-accounts] could not start:", errCode(e));
      if (needGate) { if (!gateState || gateState === "boot") firstCard(); setAlert(navigator.onLine === false ? "offline" : "error"); }
    });
    return fbP;
  }
  function start() {
    if (u18) { setupHooks(); paintSettings(); paintPrivacy(); anonOpen(); return; }
    var q = new URLSearchParams(location.search), linkReturn = q.get("mode") === "signIn" && !!q.get("oobCode");
    if (nsUid) { setupHooks(); paintSettings(); paintPrivacy(); startFirebase(); return; }
    if (!needGate) return;
    buildGate();
    if (linkReturn) {
      gateShow("boot"); gate.querySelector('[data-st="boot"]').hidden = true;
      setTimeout(function () { if (gateState === "boot") $$('[data-st="boot"]', gate)[0].hidden = false; }, 300);
      startFirebase(); return;
    }
    /* A-13: the first question needs nothing from Firebase */
    firstCard();
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", start); else start();
})();
