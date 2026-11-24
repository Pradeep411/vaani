/* Vaani x CGotchi: a CGotchi desk device becomes Vaani's hardware remote, over USB (Web Serial, Chrome or Edge on a computer).
   CGotchi runs the "Vaani" app (app id local.vaani.remote). It starts and stops the recording, marks moments and picks the note type;
   Vaani records on this computer, as always, and tells CGotchi what is happening so its screen shows the live state.
   Wire contract VAANI1 (see the CGotchi app's vaani_model.hpp):
     CGotchi -> Vaani : app log lines "VAANI1 HELLO 1 | START <type> | STOP | MARK <ms> | TYPE <type>", read with MPX1 LOG_READ
     Vaani -> CGotchi : key presses the device has no button for, sent with MPX1 INPUT_SEQUENCE, only while the Vaani app is in front:
                        south = linked (every 2 s), north = recording, east = saving and writing notes, down = notes ready,
                        up = stopped or failed, back = Vaani is idle (sent on link)
   Nothing leaves this computer: Web Serial is local USB only. Only the Vaani app on CGotchi is listened to, only known commands are
   acted on, only a port the person picked in Chrome's own chooser is ever opened, the app on CGotchi is only switched or installed
   after a click, and nothing records behind Vaani's sign-in and consent screen. */
(function () {
  "use strict";
  var V = window.Vaani, H = window.VaaniHome;
  if (!V || !H || !H.ext || !navigator.serial || !window.isSecureContext) return;

  var APP_ID = "local.vaani.remote";
  var ESPRESSIF_VID = 0x303a;
  /* the CGotchi app Vaani ships (cgotchi-app.js, loaded only when needed); a CGotchi with any other build is offered an update */
  var APP_SHA = "50f41ad77c76080df08924b96db93f0029cfd8cfee925df717366b8b3b3f24d1", APP_KB = 256; /* set by vaani-cgotchi/tools/ship_to_vaani.py from the built bundle */
  var TYPES = { auto: 1, general: 1, management: 1, sales: 1, developer: 1, founder: 1 };
  var POLL_MS = 250, BEAT_MS = 2000, FRONT_MS = 6000, REQ_MS = 3000, QUEUE_MAX = 64;
  var KNOWN = "vaani.cgotchi.known", UNLINKED = "vaani.cgotchi.unlinked";

  var port = null, reader = null, writer = null, buf = "", reqId = 1 + Math.floor(Math.random() * 0x3fffffff), queued = 0;
  var pending = {}, queue = Promise.resolve(), live = false, front = false, cursor = null, opening = false;
  var chunk = 3072, lastCmd = { START: 0, STOP: 0 }, stateKey = "", wantNotes = false, home = null, row = null;
  var nextPoll = 0, nextBeat = 0, nextFront = 0, tickBusy = false;

  function known() { return V.load(KNOWN, "") === "1"; }
  function gated() { return document.documentElement.classList.contains("acct-gated"); }

  /* ---------------- MPX1 line protocol ---------------- */
  function send(op, args, timeoutMs, fixedId) {
    /* one request at a time, like the CGotchi command-line tool: answers are matched by request id */
    if (queued >= QUEUE_MAX) return Promise.reject(new Error("CGotchi is not answering"));
    queued++;
    var run = function () {
      if (!writer) return Promise.reject(new Error("CGotchi is not connected"));
      var id = fixedId || (reqId = reqId >= 0x7fffffff ? 1 : reqId + 1);
      var line = "MPX1 " + id + " " + op + (args ? " " + args : "") + "\n";
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { delete pending[id]; reject(new Error("CGotchi did not answer")); }, timeoutMs || REQ_MS);
        pending[id] = function (status, detail) { clearTimeout(t); delete pending[id]; status === "OK" ? resolve(detail) : reject(new Error("device:" + (detail || "error"))); };
        writer.write(new TextEncoder().encode(line)).catch(function (e) { clearTimeout(t); delete pending[id]; reject(e); });
      });
    };
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p.then(function (v) { queued--; return v; }, function (e) { queued--; throw e; });
  }
  function onLine(line) {
    var m = /^MPX1 (\d+) (OK|ERROR)(?: (.*))?$/.exec(line.replace(/\r$/, ""));
    if (m && Object.prototype.hasOwnProperty.call(pending, m[1])) pending[m[1]](m[2], m[3] || "");
    /* every other line is the device's own log output: ignored */
  }
  function readLoop() {
    var dec = new TextDecoder();
    (function pump() {
      if (!reader) return;
      reader.read().then(function (r) {
        if (r.done) { drop("CGotchi was unplugged"); return; }
        buf += dec.decode(r.value, { stream: true });
        if (buf.length > 131072) buf = buf.slice(-65536);
        var i;
        while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
        pump();
      }).catch(function () { drop("CGotchi was unplugged"); });
    })();
  }

  /* ---------------- device helpers ---------------- */
  function b64(s) { return btoa(String.fromCharCode.apply(null, new TextEncoder().encode(s))); }
  function unb64(s) { try { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return new TextDecoder().decode(a); } catch (e) { return ""; } }
  function key(code) {
    /* keys only ever go to the Vaani app; in any other CGotchi app they would be game buttons */
    if (!live || !front) return Promise.resolve();
    var ops = [{ type: "key", code: code, phase: "down" }, { type: "key", code: code, phase: "up", delayMs: 0 }];
    return send("INPUT_SEQUENCE", b64(JSON.stringify(ops))).catch(function () {});
  }
  function listApps() {
    var out = [], off = 0, pages = 0;
    function page() {
      return send("APP_LIST", String(off)).then(function (d) {
        var f = d.split(" ");
        if (f[0] !== "APP_LIST") throw new Error("device:bad_list");
        var next = +f[1], count = +f[2];
        f.slice(6).forEach(function (e) { var p = e.split(","); out.push({ id: p[0], active: p[3] === "1", sha: (p[5] || "").toLowerCase() }); });
        if (next > off && next < count && ++pages < 64) { off = next; return page(); }
        return out;
      });
    }
    return page();
  }
  /* LOG_READ: one entry per call. "LOG_PAGE <session> <next> <truncated> <hasMore> <count> [<seq> <us> <level> <source> <appId> <b64>]" */
  function readLog(cur) {
    var session = cur ? cur.s : "-", seq = cur ? cur.n : 0;
    return send("LOG_READ", session + " " + seq + " app").then(function (d) {
      var f = d.split(" ");
      if (f[0] !== "LOG_PAGE" || !/^[A-Za-z0-9_-]{1,64}$/.test(f[1] || "")) throw new Error("device:bad_log");
      var e = null;
      if (+f[5] === 1) e = f.length === 12 ? { app: f[10], msg: unb64(f[11]) } : { app: f[9], msg: unb64(f[10]) };
      return { cur: { s: f[1], n: +f[2] }, more: f[4] === "1", entry: e };
    });
  }
  /* skip what the app logged before Vaani connected: find the newest entry (gallop, then halve), like the CLI's log tail */
  function tail() {
    return readLog(null).then(function (r) {
      if (!r.entry) return r.cur;
      var s = r.cur.s, low = r.cur.n - 1, step = 1, high = low + 1, rounds = 0;
      function after(n) { return readLog({ s: s, n: n }).then(function (x) { return !!x.entry; }); }
      function gallop() { if (++rounds > 40) return { s: s, n: high }; return after(high).then(function (y) { if (y) { low = high; step *= 2; high = low + step; return gallop(); } return halve(); }); }
      function halve() { if (high - low <= 1 || ++rounds > 80) return { s: s, n: high }; var mid = Math.floor((low + high) / 2); return after(mid).then(function (y) { if (y) low = mid; else high = mid; return halve(); }); }
      return gallop();
    });
  }

  /* ---------------- install / update the CGotchi app ---------------- */
  function loadPackage() {
    if (window.VaaniCGotchiApp) return Promise.resolve(window.VaaniCGotchiApp);
    return new Promise(function (resolve, reject) {
      var sc = document.createElement("script"); sc.src = "cgotchi-app.js"; sc.async = true;
      sc.onload = function () { window.VaaniCGotchiApp ? resolve(window.VaaniCGotchiApp) : reject(new Error("The CGotchi app file is missing from Vaani.")); };
      sc.onerror = function () { reject(new Error("Couldn't load the CGotchi app. Check your internet and try again.")); };
      document.head.appendChild(sc);
    });
  }
  function bytesOf(pkg) {
    var b = atob(pkg.b64), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return crypto.subtle.digest("SHA-256", a).then(function (h) {
      var hex = Array.prototype.map.call(new Uint8Array(h), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      if (hex !== APP_SHA || pkg.sha256 !== APP_SHA || pkg.appId !== APP_ID || a.length !== pkg.size) throw new Error("The CGotchi app file didn't pass its check.");
      return a;
    });
  }
  function chunkB64(a, from, to) { var s = ""; for (var i = from; i < to; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function install(apps) {
    var other = apps.filter(function (a) { return a.active; })[0];
    paint("Getting the app ready");
    return loadPackage().then(bytesOf).then(function (data) {
      return (other ? send("APP_STOP", "", 8000) : Promise.resolve()).then(function () {
        var id = reqId = reqId >= 0x7fffffff ? 1 : reqId + 1;
        return send("APP_INSTALL_BEGIN", APP_ID + " " + data.length + " " + APP_SHA, 15000, id).then(function (r) {
          var f = r.split(" ");
          if (f[0] !== "INSTALL_READY") throw new Error("CGotchi didn't accept the app.");
          var size = Math.max(256, Math.min(chunk, +f[1] || 3072, 3072)), off = 0;
          function next() {
            if (off >= data.length) return send("APP_INSTALL_COMMIT", "", 60000, id);
            var end = Math.min(off + size, data.length);
            return send("APP_INSTALL_CHUNK", off + " " + chunkB64(data, off, end), 15000, id).then(function (ack) {
              if (ack !== "INSTALL_CHUNK " + end) throw new Error("CGotchi lost part of the app. Try again.");
              off = end; paint("Installing " + Math.floor(off * 100 / data.length) + "%");
              return next();
            });
          }
          return next().catch(function (e) { send("APP_INSTALL_ABORT", "", 3000, id).catch(function () {}); throw e; });
        });
      });
    }).then(function (r) { if (!/^RESULT /.test(r)) throw new Error("CGotchi couldn't finish installing."); });
  }

  /* ---------------- commands from CGotchi ---------------- */
  function onDevice(msg) {
    var m = /^VAANI1 (HELLO|START|STOP|MARK|TYPE|PAUSE|RESUME)(?: ([a-z0-9]{1,16}))?$/.exec(msg);
    if (!m) return;
    var verb = m[1], arg = m[2] || "", now = Date.now();
    if (verb === "HELLO") { key("south"); pushState(true); return; }
    if (verb === "TYPE" || verb === "START") setType(arg);
    if (verb === "START") {
      if (now - lastCmd.START < 1500) return; lastCmd.START = now;
      if (V.isListening()) { pushState(true); return; }
      if (gated()) { V.toast("Sign in to Vaani on this computer first, then press start on CGotchi."); return; }
      if (V.getMode() === "note") V.setMode("meeting");
      V.startRec();
      /* Vaani may need a choice first (speech engine, another tab already recording): CGotchi shows "didn't answer" and the reason is on screen here */
      /* if Vaani already said why (no speech engine, another tab recording), that reason stays on screen */
      setTimeout(function () { if (!V.isListening() && !document.querySelector("#toast.show") && !document.querySelector(".scrim:not([hidden])")) V.toast("CGotchi asked Vaani to start. Finish the step on screen, then try again."); }, 1500);
    } else if (verb === "STOP") {
      if (now - lastCmd.STOP < 1500) return; lastCmd.STOP = now;
      if (V.isListening()) { wantNotes = true; V.stopRec(); }
    } else if (verb === "MARK") {
      if (V.isListening() && H.mark) H.mark("tap");
    } else if (verb === "PAUSE" || verb === "RESUME") {
      V.toast("Pausing isn't in Vaani yet. Stop when you're done and Vaani writes the notes.");
    }
  }
  function setType(t) {
    var sel = V.tmplSel;
    /* a template the person made here (u:...) is theirs: CGotchi's built-in types never replace it */
    if (!Object.prototype.hasOwnProperty.call(TYPES, t) || V.isListening() || !sel || /^u:/.test(sel.value)) return;
    if (sel.value !== t && Array.prototype.some.call(sel.options, function (o) { return o.value === t; })) {
      sel.value = t; sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /* ---------------- Vaani state -> CGotchi ---------------- */
  function stateNow() {
    if (V.isListening()) return "north";
    var a = document.getElementById("app");
    if (a && a.getAttribute("data-view") === "making") return "east";
    return "back";
  }
  function pushState(force) {
    var k = stateNow();
    if (force || k !== stateKey) key(k);
    stateKey = k;
  }
  H.ext.hooks.push(function (ev, d) {
    if (!live) return;
    if (ev === "start") { stateKey = ""; pushState(true); }
    else if (ev === "view") {
      if (d === "making") { stateKey = "east"; key("east"); }
      else if (d === "idle" && (stateKey === "east" || stateKey === "north")) { stateKey = "back"; key("up"); wantNotes = false; }
    /* a note that only keeps the audio or your typed notes opens with fresh=false; it is still this recording's result */
    } else if (ev === "note" && d && (stateKey === "east" || wantNotes)) { stateKey = "back"; wantNotes = false; key("down"); }
  });

  /* ---------------- the clock: a worker, so a background tab keeps CGotchi in step ----------------
     Chrome slows timers in a tab hidden for 5 minutes to once a minute; a dedicated worker's timers are not slowed. */
  var ticker = null, fbT = 0;
  function startTicker() {
    if (ticker || fbT) return;
    try { ticker = new Worker("cgotchi-tick.js"); ticker.onmessage = tick; ticker.onerror = function () { stopTicker(); fbT = setInterval(tick, POLL_MS); }; }
    catch (e) { ticker = null; fbT = setInterval(tick, POLL_MS); }
  }
  function stopTicker() { if (ticker) { try { ticker.terminate(); } catch (e) {} ticker = null; } clearInterval(fbT); fbT = 0; }
  function tick() {
    if (!live || tickBusy) return;
    var now = Date.now(), jobs = [];
    tickBusy = true;
    if (now >= nextFront) { nextFront = now + FRONT_MS; jobs.push(checkFront()); }
    if (now >= nextBeat) { nextBeat = now + BEAT_MS; jobs.push(key("south").then(function () { pushState(false); })); }
    if (now >= nextPoll) jobs.push(poll());
    Promise.all(jobs).then(done, done);
    function done() { tickBusy = false; }
  }
  function poll() {
    /* drain what is new, at most 20 entries per tick */
    var n = 0;
    function one() {
      return readLog(cursor).then(function (r) {
        if (!cursor || r.cur.s !== cursor.s) { cursor = r.cur; return; } /* device restarted: carry on from here, old lines are never replayed */
        cursor = r.cur;
        if (r.entry && r.entry.app === APP_ID) onDevice(r.entry.msg);
        if (r.more && ++n < 20) return one();
      });
    }
    return one().then(function () { nextPoll = Date.now() + POLL_MS; }, function () { nextPoll = Date.now() + POLL_MS * 4; });
  }
  /* is the Vaani app still the one in front on CGotchi? (someone may open another app on the device) */
  function checkFront() {
    return listApps().then(function (apps) {
      var me = apps.filter(function (a) { return a.id === APP_ID; })[0], was = front;
      front = !!(me && me.active);
      if (front && !was) { stateKey = ""; key("south"); pushState(true); }
      if (front !== was) paint();
    }).catch(function () {});
  }

  /* ---------------- connect ---------------- */
  /* manual: the person clicked Connect, so Vaani may open its app on CGotchi (and install it, once they say yes).
     auto: a CGotchi this site may already use was found; Vaani only links if its app is already open on the device. */
  function open(p, manual) {
    if (live || port || opening) return Promise.resolve();
    opening = true; port = p;
    return p.open({ baudRate: 115200 }).then(function () {
      /* release RTS, then DTR, like the CGotchi tool, so opening the port never resets the board */
      return Promise.resolve().then(function () { return p.setSignals({ requestToSend: false }); })
        .then(function () { return p.setSignals({ dataTerminalReady: false }); }).catch(function () {});
    }).then(function () {
      writer = p.writable.getWriter(); reader = p.readable.getReader(); buf = ""; readLoop();
      return hello(8);
    }).then(function (d) {
      var f = d.split(" ");
      if (f[0] !== "HELLO" || f[1] !== "1") throw new Error("This doesn't look like a CGotchi.");
      chunk = Math.min(3072, +f[2] || 3072);
      return listApps();
    }).then(function (apps) {
      var me = apps.filter(function (a) { return a.id === APP_ID; })[0];
      if (!manual) {
        if (!me || !me.active) throw new Error("quiet");
        return apps;
      }
      if (!me && !APP_SHA) throw new Error("Put the Vaani app on CGotchi first with the Vaani installer for CGotchi.");
      if (APP_SHA && (!me || me.sha !== APP_SHA)) return ask(me ? "update" : "install").then(function (yes) {
        if (!yes) { if (!me) throw new Error("cancelled"); return apps; }
        return install(apps).then(listApps);
      });
      return apps;
    }).then(function (apps) {
      var me = apps.filter(function (a) { return a.id === APP_ID; })[0];
      if (!me) throw new Error("The Vaani app isn't on CGotchi.");
      if (me.active) return;
      var other = apps.filter(function (a) { return a.active; })[0];
      return (other ? send("APP_STOP", "", 8000).catch(function () {}) : Promise.resolve())
        .then(function () { return send("APP_START", APP_ID, 8000); });
    }).then(function () { return tail(); }).then(function (c) {
      cursor = c; live = true; front = true; opening = false; stateKey = "";
      V.save(KNOWN, "1"); V.save(UNLINKED, "");
      nextPoll = nextBeat = 0; nextFront = Date.now() + FRONT_MS;
      key("south"); pushState(true); startTicker(); mountHome(); paint();
      if (manual) V.toast("CGotchi is linked. Press its red button to take notes.");
    }).catch(function (e) {
      var msg = e && e.message ? e.message : "";
      opening = false; close();
      if (msg === "quiet" || msg === "cancelled" || !manual) return;
      V.toast(friendly(msg));
    });
  }
  function friendly(msg) {
    if (/^device:.*busy/i.test(msg)) return "CGotchi is busy for a moment. Try again in a few seconds.";
    if (/busy|in use|Failed to open|already open/i.test(msg)) return "CGotchi is open in another app or tab. Close it there and try again.";
    if (/did not answer|not answering/i.test(msg)) return "CGotchi didn't answer. Unplug it, plug it back in and try again.";
    if (/device_not_linked|not_linked|setup/i.test(msg)) return "Finish setting up CGotchi first. Follow the steps on its screen, then try again.";
    if (/^device:/.test(msg)) return "CGotchi said no to that. Unplug it, plug it back in and try again.";
    return msg || "Couldn't link CGotchi.";
  }
  /* the device can be mid-boot: HELLO is retried for a few seconds */
  function hello(n) { return send("HELLO", "", 1500).catch(function (e) { if (n > 1) return new Promise(function (r) { setTimeout(r, 400); }).then(function () { return hello(n - 1); }); throw e; }); }
  function close() {
    live = false; front = false; stopTicker();
    Object.keys(pending).forEach(function (id) { pending[id]("ERROR", "closed"); });
    var r = reader, w = writer, p = port; reader = null; writer = null; port = null; cursor = null; stateKey = "";
    Promise.resolve().then(function () { return r && r.cancel().catch(function () {}); })
      .then(function () { try { r && r.releaseLock(); } catch (e) {} try { w && w.releaseLock(); } catch (e) {} return p && p.close().catch(function () {}); });
    paint();
  }
  function drop(why) { if (!port) return; var was = live; close(); if (was) V.toast(why); }
  function unlink() { V.save(UNLINKED, "1"); (live && front ? key("back") : Promise.resolve()).then(close); V.toast("CGotchi is unlinked."); }

  function connect() {
    if (live) { sheetUnlink(); return; }
    if (opening) return;
    navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] })
      .then(function (p) { return open(p, true); })
      .catch(function (e) { if (e && e.name !== "NotFoundError") V.toast(friendly(e.message || "")); });
  }

  /* ---------------- sheets (Vaani's own, not the browser's confirm box) ---------------- */
  var sheetEl = null, sheetDone = null;
  function buildSheet() {
    if (sheetEl) return sheetEl;
    var s = document.createElement("div"); s.className = "scrim"; s.id = "cgSheet"; s.hidden = true;
    var pn = document.createElement("div"); pn.className = "panel"; pn.setAttribute("role", "dialog"); pn.setAttribute("aria-modal", "true");
    pn.setAttribute("aria-labelledby", "cgSheetH"); pn.setAttribute("aria-describedby", "cgSheetP");
    var h = document.createElement("h2"); h.id = "cgSheetH"; h.tabIndex = -1;
    var p = document.createElement("p"); p.className = "sub"; p.id = "cgSheetP";
    var ok = document.createElement("button"); ok.type = "button"; ok.className = "done-btn"; ok.id = "cgSheetOk";
    var no = document.createElement("button"); no.type = "button"; no.className = "cancel"; no.id = "cgSheetNo";
    pn.appendChild(h); pn.appendChild(p); pn.appendChild(ok); pn.appendChild(no); s.appendChild(pn); document.body.appendChild(s);
    /* the big button is the safe choice when the action is destructive: then the small red one is the action */
    ok.addEventListener("click", function () { var f = sheetDone, yes = !sheetEl.danger; sheetDone = null; V.closeSheets(); if (f) f(yes); });
    no.addEventListener("click", function () { var f = sheetDone, yes = !!sheetEl.danger; sheetDone = null; V.closeSheets(); if (f) f(yes); });
    s.addEventListener("click", function (e) { if (e.target === s) V.closeSheets(); });
    /* closed any other way (Escape, another sheet) counts as "no" */
    try { new MutationObserver(function () { if (s.hidden && sheetDone) { var f = sheetDone; sheetDone = null; f(false); } }).observe(s, { attributes: true, attributeFilter: ["hidden"] }); } catch (e) {}
    sheetEl = s; return s;
  }
  function sheet(title, body, okText, noText, danger) {
    buildSheet();
    sheetEl.danger = !!danger;
    document.getElementById("cgSheetNo").classList.toggle("cg-danger", !!danger);
    document.getElementById("cgSheetH").textContent = title;
    document.getElementById("cgSheetP").textContent = body;
    document.getElementById("cgSheetOk").textContent = okText;
    document.getElementById("cgSheetNo").textContent = noText;
    return new Promise(function (resolve) { sheetDone = resolve; V.openSheet("#cgSheet"); });
  }
  function ask(kind) {
    return kind === "update"
      ? sheet("Update the Vaani app on your CGotchi?", "Your CGotchi has a different version from the one this Vaani works with. It takes about 20 seconds. Keep CGotchi plugged in.", "Update", "Not now")
      : sheet("Put the Vaani app on your CGotchi?", "About " + APP_KB + " KB. It takes about 20 seconds. Keep CGotchi plugged in.", "Install", "Not now");
  }
  function sheetUnlink() {
    sheet("CGotchi is linked", "Its buttons start, stop and mark Vaani notes on this computer. Unlink to use CGotchi for other apps.", "Done", "Unlink", true)
      .then(function (yes) { if (yes) unlink(); });
  }

  /* ---------------- controls: Settings always, Home once a CGotchi is known ---------------- */
  var NS = "http://www.w3.org/2000/svg";
  function icon() {
    var sv = document.createElementNS(NS, "svg");
    [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.8"], ["aria-hidden", "true"]].forEach(function (a) { sv.setAttribute(a[0], a[1]); });
    var r = document.createElementNS(NS, "rect"); [["x", "7"], ["y", "2.5"], ["width", "10"], ["height", "19"], ["rx", "3"]].forEach(function (a) { r.setAttribute(a[0], a[1]); });
    var c = document.createElementNS(NS, "circle"); [["cx", "12"], ["cy", "8"], ["r", "2"]].forEach(function (a) { c.setAttribute(a[0], a[1]); });
    sv.appendChild(r); sv.appendChild(c); return sv;
  }
  function paint(busy) {
    if (home) {
      home.btn.classList.toggle("on", live);
      if (live) home.ico.setAttribute("hidden", ""); else home.ico.removeAttribute("hidden");
      home.dot.hidden = !live;
      home.txt.textContent = busy || (live ? (front ? "CGotchi linked" : "CGotchi in another app") : "Connect CGotchi");
      home.btn.title = live ? "CGotchi linked. Click to unlink" : "Use your CGotchi as Vaani's start and stop button";
    }
    if (row) {
      row.btn.textContent = busy || (live ? "Unlink" : "Connect");
      row.state.textContent = live ? (front ? "Linked over USB." : "Linked. Open the Vaani app on CGotchi to use it.") : "Start, stop and mark Vaani notes from your CGotchi. Chrome or Edge, over USB.";
    }
  }
  function mountHome(tries) {
    if (home || !(known() || live)) return;
    var opts = document.querySelector(".hm-opts");
    if (!opts) { if ((tries || 0) < 40) setTimeout(function () { mountHome((tries || 0) + 1); }, 250); return; }
    var b = document.createElement("button"); b.type = "button"; b.id = "cgBtn"; b.className = "cg-link";
    var ico = icon(), d = document.createElement("span"), t = document.createElement("span");
    d.className = "cg-dot"; d.setAttribute("aria-hidden", "true");
    b.appendChild(ico); b.appendChild(d); b.appendChild(t);
    var up = document.getElementById("upBtn");
    if (up && up.parentNode === opts) up.after(b); else opts.appendChild(b);
    home = { btn: b, ico: ico, dot: d, txt: t }; paint();
    b.addEventListener("click", connect);
  }
  function mountSettings() {
    var done = document.getElementById("setDone");
    if (!done || row) return;
    var box = document.createElement("div");
    var lbl = document.createElement("span"); lbl.className = "form-l"; lbl.textContent = "Devices";
    var grp = document.createElement("div"); grp.className = "opts set-more";
    var r = document.createElement("div"); r.className = "set-row";
    var sp = document.createElement("span"); sp.textContent = "CGotchi desk remote";
    var sm = document.createElement("small"); sp.appendChild(sm);
    var btn = document.createElement("button"); btn.type = "button"; btn.id = "cgSetBtn";
    r.appendChild(sp); r.appendChild(btn); grp.appendChild(r); box.appendChild(lbl); box.appendChild(grp);
    done.parentNode.insertBefore(box, done);
    row = { btn: btn, state: sm }; paint();
    btn.addEventListener("click", function () { if (live) { V.closeSheets(); setTimeout(sheetUnlink, 0); } else connect(); });
  }
  mountSettings(); mountHome();

  /* a CGotchi this site may already use links on its own, but only if the Vaani app is already open on it and the person didn't unlink */
  function auto(p) {
    if (live || opening || V.load(UNLINKED, "") === "1" || gated()) return;
    if (!p.getInfo || p.getInfo().usbVendorId !== ESPRESSIF_VID) return;
    V.save(KNOWN, "1"); mountHome();
    open(p, false);
  }
  navigator.serial.addEventListener("connect", function (e) { if (e.target) auto(e.target); });
  navigator.serial.addEventListener("disconnect", function (e) { if (port && e.target === port) drop("CGotchi was unplugged"); });
  navigator.serial.getPorts().then(function (ps) { var p = ps.filter(function (x) { return x.getInfo().usbVendorId === ESPRESSIF_VID; })[0]; if (p) auto(p); }).catch(function () {});
  window.addEventListener("pagehide", function () { if (live && V.isListening()) key("up"); });

  window.VaaniCGotchi = { linked: function () { return live; }, connect: connect };
})();
