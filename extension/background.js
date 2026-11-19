/* Vaani: AI Note Taker Agent, Chrome extension 1.3.0 (service worker).

   What it does
   - content.js tells this worker when a call is live in a Google Meet, Teams or Zoom tab (it looks only at the call's own
     controls and whether the page plays a live call stream; it reads no names, chat, captions or anything else).
   - The worker then asks once per call: a Chrome notification ("Meeting detected on Google Meet. Take notes?" with
     Start notes / Not now) and the small prompt in the page; "Not now" in either puts both away for that call. "Ask me
     when a call starts" in the popup turns both off.
   - Start (the notification, the prompt, the toolbar icon or Alt+Shift+V) opens the Vaani window beside the call, or
     brings it forward, and hands it the call tab's sound with chrome.tabCapture.getMediaStreamId: no screen-share picker.
   - Chrome's rule (checked in Chromium and in tests/ext-e2e.cjs): a tab's sound can be handed over only after the person
     invokes the extension on that tab, which means a click on its toolbar icon (or its puzzle-menu entry) or its keyboard
     shortcut. A click on a notification or on a button inside the call page does not count. So Start from the
     notification or the prompt starts the notes with the microphone and says, in the page and in the Vaani window, that
     one click on the Vaani icon adds everyone's voices. That click joins the same recording: one meeting, one note.
   - tabCapture is an OPTIONAL permission (its install warning would otherwise read "all your data on all websites"). The
     popup asks for it, inside a click, the first time it is needed, and says why.

   The one protocol with the Vaani page (index.html), through externally_connectable. Nothing else is sent or accepted.
     page -> worker, one message:  {type:"hello", callAudio}               reply {perm}
                                   {type:"ready", callAudio}               reply {type:"tab", id, src}
                                                                                 | {type:"nocap", src, why: mic|perm|grant|fail}
                                                                                 | nothing (no hand-over for this tab)
     page -> worker, port "vaani": {type:"state", rec, call, busy[, gone]} and {type:"ping"} (keeps this worker awake)
     worker -> page, port:         {type:"stop"} | {type:"calloff"} | {type:"permoff"} | {type:"join", src}
   The call's sound goes only to the Vaani window this extension opened itself: other pages on the same github.io address
   can script a Vaani tab they opened, but not a window made by chrome.windows.create.

   What it keeps: in chrome.storage.session (memory, gone when Chrome closes) the call tabs, the Vaani window and which
   Vaani tab is recording, so a worker that Chrome put to sleep picks up where it was; in chrome.storage.sync one choice,
   "ask" (Ask me when a call starts). It sends nothing anywhere. */
var APP = "https://pradeep411.github.io/vaani/";
var APP_URL = new URL(APP), APP_ORIGIN = APP_URL.origin;
var SRC_RE = /^(meet|teams|zoom)$/;
var NAME = { meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom" };
var TITLE = "Vaani: AI Note Taker Agent";
var GRACE = 3000; /* a page whose port went quiet this long without coming back is no longer recording */
var ports = {}; /* tab id -> the Vaani page's port (memory only: pages reconnect within a second of a worker restart) */

function lastErr() { void chrome.runtime.lastError; }
function st() { return chrome.storage.session.get({ calls: {}, win: null, pages: {}, pend: null, asked: {} }); }
function put(o) { return chrome.storage.session.set(o); }
function askOn() { return chrome.storage.sync.get({ ask: true }).then(function (o) { return o.ask !== false; }, function () { return true; }); }
function hasPerm() { return chrome.permissions.contains({ permissions: ["tabCapture"] }).catch(function () { return false; }); }
/* every change to the shared state runs in turn, so no update is lost to another */
var queue = Promise.resolve();
function serial(fn) { var p = queue.then(fn, fn); queue = p.catch(function () {}); return p; }
/* only the app page itself (/vaani/ or /vaani/index.html), its top frame, on the app's origin */
function appPage(url) { try { var u = new URL(url); return u.origin === APP_ORIGIN && (u.pathname === APP_URL.pathname || u.pathname === APP_URL.pathname + "index.html"); } catch (e) { return false; } }
function fromApp(sender) { return !!(sender && sender.tab && sender.frameId === 0 && sender.origin === APP_ORIGIN && typeof sender.url === "string" && appPage(sender.url)); }
function owned(s, tid) { return !!(s.win && s.win.tab === tid); }
/* the Vaani page that is recording now, if any: {tab, rec, call, busy, callTab, recAt} */
function recPage(s) { var best = null; Object.keys(s.pages).forEach(function (k) { var p = s.pages[k]; if (p && p.rec) best = Object.assign({ tab: +k }, p); }); return best; }
function toApp(tid, msg) { var pt = ports[tid]; if (!pt) return false; try { pt.postMessage(msg); return true; } catch (e) { return false; } }
function toCall(tid, msg) { if (tid == null) return; try { chrome.tabs.sendMessage(tid, msg, { frameId: 0 }, lastErr); } catch (e) {} }

/* ---------- notifications ---------- */
var ICON = "icons/128.png";
function note(id, o) { try { chrome.notifications.create(id, Object.assign({ type: "basic", iconUrl: ICON, priority: 2 }, o), lastErr); } catch (e) {} }
function unnote(id) { try { chrome.notifications.clear(id, lastErr); } catch (e) {} }
/* once per call (its key), and not again for 10 minutes after the person answered or let it go (idea: anarlog's
   mic-detect cooldown, MIT; see NOTICE) */
var ASK_COOLDOWN = 600000;
function offerCall(tid, c) {
  return askOn().then(function (on) {
    if (!on) return;
    return st().then(function (s) {
      var a = s.asked[c.key], rp = recPage(s);
      if (a && Date.now() - a < ASK_COOLDOWN) return;
      if (rp && rp.callTab === tid) return; /* already taking notes for this call */
      s.asked[c.key] = Date.now();
      Object.keys(s.asked).forEach(function (k) { if (Date.now() - s.asked[k] > 86400000) delete s.asked[k]; });
      return put({ asked: s.asked }).then(function () {
        /* short enough for one title line and two body lines on a Mac banner */
        note("vaani-call-" + tid, { title: "Meeting detected. Take notes?", message: "Vaani, your AI note taker agent, is ready for this " + NAME[c.src] + " call. No bot joins.", buttons: [{ title: "Start notes" }, { title: "Not now" }], requireInteraction: true });
      });
    });
  });
}
function offerStop(tid, src) {
  note("vaani-end-" + tid, { title: "Your call ended", message: "Stop taking notes? Vaani then writes them up.", buttons: [{ title: "Stop notes" }, { title: "Keep going" }], requireInteraction: true });
}
/* named, so a test can call it the way Chrome does (tests/ext-e2e.cjs) */
function onNoteButton(id, i) {
  unnote(id);
  var m = /^vaani-(call|end)-(\d+)$/.exec(id || ""); if (!m) return;
  var tid = +m[2];
  if (m[1] === "call") {
    /* "Not now" here also puts the prompt in the call page away, so Vaani never asks twice */
    if (i !== 0) { toCall(tid, { type: "declined" }); return; }
    chrome.tabs.get(tid, function (t) { if (chrome.runtime.lastError || !t) return; start(t, "notif"); });
  } else if (i === 0) stopFor(tid);
}
function onNoteClick(id) {
  unnote(id);
  var m = /^vaani-(call|end)-(\d+)$/.exec(id || ""); if (!m) return;
  /* the body of the notification brings the call tab forward (the prompt there has Start); it never starts on its own */
  chrome.tabs.update(+m[2], { active: true }, function (t) { if (chrome.runtime.lastError || !t) return; chrome.windows.update(t.windowId, { focused: true }, lastErr); });
}
chrome.notifications.onButtonClicked.addListener(onNoteButton);
chrome.notifications.onClicked.addListener(onNoteClick);

/* ---------- the Vaani window ---------- */
function openWin(url, nearWindowId, s) {
  return new Promise(function (done) {
    function make(b) {
      var w = 400, h = Math.max(420, Math.min(720, ((b && b.height) || 900) - 200)), o = { url: url, type: "popup", width: w, height: h, focused: true };
      if (b) { o.left = Math.max(0, b.left + b.width - w - 16); o.top = b.top + 120; }
      chrome.windows.create(o, function (win) {
        /* Chrome refuses bounds that are mostly off screen (a small or second screen): open it where Chrome likes instead */
        if (chrome.runtime.lastError || !win) { if (b) return make(null); return done(null); }
        var tid = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
        put({ win: { id: win.id, tab: tid } }).then(function () { done(tid); });
      });
    }
    function fresh() { if (nearWindowId != null) chrome.windows.get(nearWindowId, function (b) { make(chrome.runtime.lastError ? null : b); }); else make(null); }
    if (!s.win) return fresh();
    chrome.windows.get(s.win.id, { populate: true }, function (win) {
      if (chrome.runtime.lastError || !win || !win.tabs || !win.tabs[0]) return fresh();
      var tid = win.tabs[0].id, pg = s.pages[tid];
      chrome.windows.update(s.win.id, { focused: true }, lastErr);
      /* never navigate away from notes that are being taken or written up there */
      if (pg && (pg.rec || pg.busy)) return done(null);
      chrome.tabs.update(tid, { url: url }, function () { lastErr(); put({ win: { id: s.win.id, tab: tid } }).then(function () { done(tid); }); });
    });
  });
}
function focusTab(tid) {
  if (tid == null) return;
  chrome.tabs.update(tid, { active: true }, function (t) { if (chrome.runtime.lastError || !t) return; chrome.windows.update(t.windowId, { focused: true }, lastErr); });
}

/* ---------- Start: the notification, the prompt in the call page, the toolbar icon, Alt+Shift+V or the popup ---------- */
/* how: "icon" (Chrome counts it as invoking Vaani on this tab), "popup", "notif", "pill" */
function start(tab, how) {
  if (!tab || tab.id == null) return Promise.resolve();
  unnote("vaani-call-" + tab.id);
  return serial(function () {
    return st().then(function (s) {
      var c = s.calls[tab.id], src = c ? c.src : "ext", rp = recPage(s);
      if (rp) {
        /* one meeting, one recording: the call joins the notes Vaani is taking in its own window */
        if (owned(s, rp.tab) && ports[rp.tab] && !rp.call && tab.id !== rp.tab) {
          var pend = { callTab: tab.id, appTab: rp.tab, src: src, at: Date.now(), how: how };
          s.pages[rp.tab].callTab = tab.id;
          return put({ pend: pend, pages: s.pages }).then(function () { toApp(rp.tab, { type: "join", src: src }); focusTab(rp.tab); return remarkIn(); });
        }
        if (!owned(s, rp.tab)) note("vaani-busy", { title: "Vaani is already taking notes in another tab", message: "Stop those notes first, then start again from this call, so Vaani can hear everyone on it." });
        focusTab(rp.tab);
        return;
      }
      if (tab.id === (s.win && s.win.tab)) return; /* the Vaani window itself */
      return openWin(APP + "?src=" + encodeURIComponent(src) + "&start=1&ext=" + chrome.runtime.id, tab.windowId, s).then(function (appTab) {
        if (appTab == null) { if (s.win) focusTab(s.win.tab); return; }
        return put({ pend: { callTab: tab.id, appTab: appTab, src: src, at: Date.now(), how: how } });
      });
    });
  });
}
function stopFor(callTid) {
  return serial(function () {
    return st().then(function (s) {
      var rp = recPage(s);
      if (!rp || (callTid != null && rp.callTab !== callTid)) return;
      toApp(rp.tab, { type: "stop" });
    });
  });
}
/* the Vaani page asks for the call: a one-time stream id made for that tab only, or "nocap" with the reason */
function answer(sender) {
  var tid = sender.tab.id;
  return serial(function () {
    return st().then(function (s) {
      var p = s.pend;
      if (!p || p.appTab !== tid) return null; /* only the Vaani tab this worker is handing over to, after a Start */
      return put({ pend: null }).then(function () {
        if (Date.now() - p.at > 60000) return null;
        var no = function (why) { return { type: "nocap", src: p.src, why: why }; };
        if (!owned(s, tid)) return no("fail");
        return hasPerm().then(function (perm) {
          if (!perm) return no("perm");
          return new Promise(function (res) {
            try {
              chrome.tabCapture.getMediaStreamId({ targetTabId: p.callTab, consumerTabId: tid }, function (id) {
                var err = chrome.runtime.lastError, m = err && err.message || "";
                if (!err && typeof id === "string" && id) return res({ type: "tab", id: id, src: p.src });
                res(no(/invoked|activeTab/i.test(m) ? "grant" : "fail"));
              });
            } catch (e) { res(no("fail")); }
          });
        }).then(function (r) {
          return st().then(function (s2) { var pg = s2.pages[tid] || {}; pg.callTab = p.callTab; s2.pages[tid] = pg; return put({ pages: s2.pages }); }).then(function () { return r; });
        });
      });
    });
  });
}

/* ---------- the icon ---------- */
/* on a call tab the icon starts in one click (no popup) once Chrome's OK to hear calls is held; before that, the popup
   asks for it. Red REC only while Vaani records; a detected call gets a calm blue mark. */
function markCall(tid, s, perm) {
  if (tid == null) return;
  var c = s.calls[tid], rp = recPage(s), recHere = !!(rp && rp.callTab === tid);
  var popup = recHere ? (rp.call || perm ? "" : "popup.html") : c ? (perm ? "" : "popup.html") : "popup.html";
  chrome.action.setPopup({ tabId: tid, popup: popup }, lastErr);
  chrome.action.setTitle({ tabId: tid, title: recHere ? (rp.call ? "Vaani is taking notes on this call" : "Vaani hears only your mic. Click to add everyone on this call") : c ? "Take notes on this call with Vaani" : TITLE }, lastErr);
  chrome.action.setBadgeBackgroundColor({ tabId: tid, color: recHere ? "#D70015" : "#0A66D8" }, lastErr);
  chrome.action.setBadgeText({ tabId: tid, text: recHere ? (rp.call ? "REC" : "+") : c ? " " : "" }, lastErr);
}
function remarkIn() {
  return Promise.all([st(), hasPerm()]).then(function (r) {
    var s = r[0], done = {};
    Object.keys(s.calls).forEach(function (t) { done[t] = 1; markCall(+t, s, r[1]); });
    var rp = recPage(s); if (rp && rp.callTab != null && !done[rp.callTab]) markCall(rp.callTab, s, r[1]);
  });
}
function remarkAll() { return serial(remarkIn); }
chrome.action.onClicked.addListener(function (tab) { start(tab, "icon"); });

/* ---------- a call ends, or its tab goes ---------- */
function callOff(tid, why) {
  return serial(function () {
    return st().then(function (s) {
      var c = s.calls[tid], o = {};
      if (c) { delete s.calls[tid]; o.calls = s.calls; }
      if (s.pend && s.pend.callTab === tid) o.pend = null;
      unnote("vaani-call-" + tid);
      var rp = recPage(s);
      if (rp && rp.callTab === tid) {
        /* the call's sound has gone: the Vaani page stops hearing the tab (the microphone carries on) and offers to stop */
        toApp(rp.tab, { type: "calloff" });
        if (why !== "closed-app") offerStop(tid, c ? c.src : "");
        s.pages[rp.tab].call = false; o.pages = s.pages;
      }
      return (Object.keys(o).length ? put(o) : Promise.resolve()).then(remarkIn);
    });
  });
}
/* which page answers in this tab now (the content script's own id), or null */
function alive(tid) {
  return new Promise(function (res) {
    var t = setTimeout(function () { res(null); }, 1000);
    try { chrome.tabs.sendMessage(tid, { type: "alive" }, { frameId: 0 }, function (r) { void chrome.runtime.lastError; clearTimeout(t); res(r && typeof r.inst === "string" ? r.inst : null); }); } catch (e) { clearTimeout(t); res(null); }
  });
}
/* Chrome says "loading" both for a new page and for an in-page move (Teams and Meet change their address during a
   call): the call page's content script tells the two apart by its own id */
chrome.tabs.onUpdated.addListener(function (tid, ci) {
  if (ci.status !== "loading") return;
  st().then(function (s) {
    var c = s.calls[tid], rp = recPage(s);
    if (!c && !(rp && rp.callTab === tid)) return;
    setTimeout(function () { alive(tid).then(function (a) { if (!c || a !== c.inst) callOff(tid, "nav"); }); }, 1500);
  });
});
chrome.tabs.onRemoved.addListener(function (tid) {
  st().then(function (s) {
    var rp = recPage(s);
    if (s.calls[tid] || (rp && rp.callTab === tid)) callOff(tid, "closed");
    if (s.pages[tid] || (s.win && s.win.tab === tid)) serial(function () { return st().then(function (s2) { var pg = s2.pages[tid]; delete s2.pages[tid]; var o = { pages: s2.pages }; if (s2.win && s2.win.tab === tid) o.win = null; if (pg && pg.callTab != null) toCall(pg.callTab, { type: "rec", on: false, call: false }); return put(o); }).then(remarkIn); });
  });
});
chrome.windows.onRemoved.addListener(function (id) { serial(function () { return st().then(function (s) { if (s.win && s.win.id === id) return put({ win: null }); }); }); });
chrome.permissions.onRemoved.addListener(function (p) {
  if (!p.permissions || p.permissions.indexOf("tabCapture") < 0) return;
  serial(function () { return st().then(function (s) { var rp = recPage(s); if (rp && rp.call) { toApp(rp.tab, { type: "permoff" }); s.pages[rp.tab].call = false; return put({ pages: s.pages }); } }); }).then(remarkAll);
});
chrome.permissions.onAdded.addListener(function () { remarkAll(); });

/* ---------- the Vaani page: externally_connectable ---------- */
chrome.runtime.onMessageExternal.addListener(function (msg, sender, reply) {
  if (!fromApp(sender) || !msg || typeof msg !== "object") return;
  if (msg.type === "ready") { answer(sender).then(function (r) { reply(r || undefined); }, function () { reply(undefined); }); return true; }
  if (msg.type === "hello") { hasPerm().then(function (perm) { reply({ perm: perm }); }); return true; }
});
chrome.runtime.onConnectExternal.addListener(function (port) {
  var s0 = port.sender;
  if (!fromApp(s0) || port.name !== "vaani") { port.disconnect(); return; }
  var tid = s0.tab.id, old = ports[tid];
  ports[tid] = port;
  if (old && old !== port) try { old.disconnect(); } catch (e) {}
  port.onMessage.addListener(function (m) {
    if (!m || typeof m !== "object" || m.type !== "state") return; /* "ping" only keeps this worker awake while Vaani records */
    var rec = m.rec === true && m.gone !== true, call = rec && m.call === true, busy = m.busy === true && m.gone !== true;
    serial(function () {
      return st().then(function (s) {
        var pg = s.pages[tid] || {}, was = !!pg.rec;
        /* another Vaani tab is already recording: this one can't also be the recording (one meeting, one note) */
        var other = recPage(s); if (rec && other && other.tab !== tid) { rec = false; call = false; }
        pg.rec = rec; pg.call = call; pg.busy = busy;
        if (rec && !was) pg.recAt = Date.now();
        if (!rec) { pg.recAt = null; }
        s.pages[tid] = pg;
        return put({ pages: s.pages }).then(function () {
          if (pg.callTab != null) toCall(pg.callTab, { type: "rec", on: rec, call: call });
          if (!rec && was && pg.callTab != null) { unnote("vaani-end-" + pg.callTab); }
          if (!rec && !busy && was) { pg.callTab = null; s.pages[tid] = pg; return put({ pages: s.pages }); }
        }).then(remarkIn);
      });
    });
  });
  port.onDisconnect.addListener(function () {
    lastErr();
    if (ports[tid] !== port) return;
    delete ports[tid];
    /* the page went away (a reload, another site, a crash): after a moment without a new port from it, it no longer records */
    setTimeout(function () {
      if (ports[tid]) return;
      serial(function () { return st().then(function (s) { var pg = s.pages[tid]; if (!pg) return; delete s.pages[tid]; if (pg.callTab != null) toCall(pg.callTab, { type: "rec", on: false, call: false }); return put({ pages: s.pages }); }).then(remarkIn); });
    }, GRACE);
  });
});

/* ---------- this extension's own content script and popup ---------- */
chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return;
  var popup = sender.url === chrome.runtime.getURL("popup.html");
  var tab = !popup && sender.tab && sender.frameId === 0 ? sender.tab : null;
  if (tab && msg.type === "call") {
    var tid = tab.id, on = msg.on === true, src = SRC_RE.test(msg.src) ? msg.src : null;
    var key = typeof msg.key === "string" ? msg.key.slice(0, 80) : "", inst = typeof msg.inst === "string" ? msg.inst.slice(0, 40) : "";
    if (!src) return;
    if (!on) { callOff(tid, "ended"); reply({}); return; }
    serial(function () {
      return st().then(function (s) {
        var c = { src: src, key: src + ":" + key, inst: inst, at: Date.now() };
        s.calls[tid] = c;
        return put({ calls: s.calls }).then(function () { return Promise.all([remarkIn(), hasPerm()]); }).then(function (r) { return { s: s, c: c, perm: r[1] }; });
      });
    }).then(function (x) {
      offerCall(tid, x.c);
      chrome.action.getUserSettings(function (u) {
        chrome.commands.getAll(function (cs) {
          var k = (cs || []).filter(function (y) { return y.name === "_execute_action"; })[0], rp = recPage(x.s), here = !!(rp && rp.callTab === tid);
          reply({ pinned: !!(u && u.isOnToolbar), key: k && k.shortcut ? k.shortcut : "", perm: x.perm, rec: here, call: here && !!rp.call });
        });
      });
    });
    return true;
  }
  if (tab && msg.type === "gone") { st().then(function (s) { var c = s.calls[tab.id], rp = recPage(s); if ((c && c.inst === msg.inst) || (rp && rp.callTab === tab.id)) callOff(tab.id, "nav"); }); return; }
  if (tab && msg.type === "recq") { serial(st).then(function (s) { var rp = recPage(s), here = !!(rp && rp.callTab === tab.id); reply({ rec: here, call: here && !!rp.call }); }); return true; }
  if (tab && msg.type === "start") { start(tab, "pill"); return; }
  if (tab && msg.type === "stop") { stopFor(tab.id); return; }
  if (tab && msg.type === "notnow") { unnote("vaani-call-" + tab.id); return; }
  if (!popup) return;
  if (msg.type === "popupState" && typeof msg.tabId === "number") {
    Promise.all([st(), hasPerm(), askOn()]).then(function (r) {
      var s = r[0], rp = recPage(s);
      reply({ call: !!s.calls[msg.tabId], src: s.calls[msg.tabId] ? s.calls[msg.tabId].src : "", perm: r[1], ask: r[2], rec: !!rp, recHere: !!(rp && rp.callTab === msg.tabId), recCall: !!(rp && rp.call), recOwned: !!(rp && owned(s, rp.tab)) });
    });
    return true;
  }
  if (msg.type === "start" && typeof msg.tabId === "number") chrome.tabs.get(msg.tabId, function (t) { if (!chrome.runtime.lastError && t) start(t, "popup"); });
  else if (msg.type === "stop") stopFor(null);
  else if (msg.type === "open") st().then(function (s) { var rp = recPage(s); if (rp) return focusTab(rp.tab); openWin(APP + "?src=ext", typeof msg.near === "number" ? msg.near : null, s); });
  else if (msg.type === "focus") st().then(function (s) { var rp = recPage(s); focusTab(rp ? rp.tab : s.win && s.win.tab); });
});

/* when this worker wakes, a recording page it remembers but that never reconnected is no longer recording */
setTimeout(function () {
  serial(function () { return st().then(function (s) { var ch = false; Object.keys(s.pages).forEach(function (k) { if (!ports[k]) { var pg = s.pages[k]; if (pg && pg.callTab != null) toCall(pg.callTab, { type: "rec", on: false, call: false }); delete s.pages[k]; ch = true; } }); if (ch) return put({ pages: s.pages }); }); }).then(remarkAll);
}, 8000);

chrome.runtime.onInstalled.addListener(function (d) {
  if (d.reason === "install") chrome.tabs.create({ url: APP + "?src=installed" });
});
