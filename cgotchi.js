/* Vaani x CGotchi: a CGotchi desk device becomes Vaani's hardware remote, over USB (Web Serial, Chrome or Edge on a computer).
   CGotchi runs the "Vaani" app (app id local.vaani.remote). It starts and stops the recording, marks moments and picks the note type;
   Vaani records on this computer, as always, and tells CGotchi what is happening so its screen shows the live state.
   Wire contract VAANI1 (see the CGotchi app's vaani_model.hpp):
     CGotchi -> Vaani : app log lines "VAANI1 HELLO 1 | START <type> | STOP | MARK <ms> | TYPE <type>", read with MPX1 LOG_READ
     Vaani -> CGotchi : key presses the device has no button for, sent with MPX1 INPUT_SEQUENCE
                        south = linked (every 2 s), north = recording, east = saving and writing notes, down = notes ready, up = stopped/failed
   Nothing leaves this computer: Web Serial is local USB only. Only the Vaani app on CGotchi is listened to, only known commands are acted on,
   and only a port the person picked in Chrome's own chooser is ever opened. */
(function () {
  "use strict";
  var V = window.Vaani, H = window.VaaniHome;
  if (!V || !H || !H.ext || !navigator.serial || !window.isSecureContext) return;

  var APP_ID = "local.vaani.remote";
  /* the CGotchi app Vaani ships (cgotchi-app.js, loaded only when needed); a CGotchi with any other build is updated on Connect */
  var APP_SHA = "", APP_KB = 0; /* set by vaani-cgotchi/tools/ship_to_vaani.py from the built bundle */
  var ESPRESSIF_VID = 0x303a;
  var TYPES = { auto: 1, general: 1, management: 1, sales: 1, developer: 1, founder: 1 };
  var POLL_MS = 250, BEAT_MS = 2000, REQ_MS = 3000;

  var port = null, reader = null, writer = null, buf = "", reqId = 1 + Math.floor(Math.random() * 0x3fffffff);
  var pending = {}, queue = Promise.resolve(), live = false, cursor = null, pollT = 0, beatT = 0;
  var chunk = 3072, lastCmd = { START: 0, STOP: 0 }, stateKey = "", wantNotes = false, ui = null;

  /* ---------------- MPX1 line protocol ---------------- */
  function send(op, args, timeoutMs, fixedId) {
    /* one request at a time, like the CGotchi command-line tool: answers are matched by request id */
    var run = function () {
      if (!writer) return Promise.reject(new Error("CGotchi is not connected"));
      var id = fixedId || (reqId = reqId >= 0x7fffffff ? 1 : reqId + 1);
      var line = "MPX1 " + id + " " + op + (args ? " " + args : "") + "\n";
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { delete pending[id]; reject(new Error("CGotchi did not answer")); }, timeoutMs || REQ_MS);
        pending[id] = function (status, detail) { clearTimeout(t); delete pending[id]; status === "OK" ? resolve(detail) : reject(new Error(detail || "error")); };
        writer.write(new TextEncoder().encode(line)).catch(function (e) { clearTimeout(t); delete pending[id]; reject(e); });
      });
    };
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p;
  }
  function onLine(line) {
    var m = /^MPX1 (\d+) (OK|ERROR)(?: (.*))?$/.exec(line.replace(/\r$/, ""));
    if (m && pending[m[1]]) pending[m[1]](m[2], m[3] || "");
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
    var ops = [{ type: "key", code: code, phase: "down" }, { type: "key", code: code, phase: "up", delayMs: 0 }];
    return send("INPUT_SEQUENCE", b64(JSON.stringify(ops))).catch(function () {});
  }
  function listApps() {
    var out = [], off = 0;
    function page() {
      return send("APP_LIST", String(off)).then(function (d) {
        var f = d.split(" ");
        if (f[0] !== "APP_LIST") throw new Error("bad list");
        var next = +f[1], count = +f[2];
        f.slice(6).forEach(function (e) { var p = e.split(","); out.push({ id: p[0], active: p[3] === "1", sha: (p[5] || "").toLowerCase() }); });
        if (next > off && next < count) { off = next; return page(); }
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
      if (f[0] !== "LOG_PAGE") throw new Error("bad log page");
      var e = null;
      if (+f[5] === 1) e = f.length === 12 ? { app: f[10], msg: unb64(f[11]) } : { app: f[9], msg: unb64(f[10]) };
      return { cur: { s: f[1], n: +f[2] }, more: f[4] === "1", entry: e };
    });
  }
  /* skip what the app logged before Vaani connected: find the newest entry (gallop, then halve), like the CLI's log tail */
  function tail() {
    return readLog(null).then(function (r) {
      if (!r.entry) return null;
      var s = r.cur.s, low = r.cur.n - 1, step = 1, high = low + 1;
      function after(n) { return readLog({ s: s, n: n }).then(function (x) { return !!x.entry; }); }
      function gallop() { return after(high).then(function (y) { if (y) { low = high; step *= 2; high = low + step; return gallop(); } return halve(); }); }
      function halve() { if (high - low <= 1) return { s: s, n: high }; var mid = (low + high) >> 1; return after(mid).then(function (y) { if (y) low = mid; else high = mid; return halve(); }); }
      return gallop();
    });
  }

  /* ---------------- install / update the CGotchi app ---------------- */
  function loadPackage() {
    if (window.VaaniCGotchiApp) return Promise.resolve(window.VaaniCGotchiApp);
    return new Promise(function (resolve, reject) {
      var sc = document.createElement("script"); sc.src = "cgotchi-app.js"; sc.async = true;
      sc.onload = function () { window.VaaniCGotchiApp ? resolve(window.VaaniCGotchiApp) : reject(new Error("The CGotchi app file is missing")); };
      sc.onerror = function () { reject(new Error("Couldn't load the CGotchi app. Check your internet and try again.")); };
      document.head.appendChild(sc);
    });
  }
  function bytesOf(pkg) {
    var b = atob(pkg.b64), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return crypto.subtle.digest("SHA-256", a).then(function (h) {
      var hex = Array.prototype.map.call(new Uint8Array(h), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      if (hex !== APP_SHA || pkg.sha256 !== APP_SHA || pkg.appId !== APP_ID || a.length !== pkg.size) throw new Error("The CGotchi app file didn't pass its check");
      return a;
    });
  }
  function chunkB64(a, from, to) { var s = ""; for (var i = from; i < to; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function install(apps, chunkMax) {
    var other = apps.filter(function (a) { return a.active; })[0];
    progress("Getting the app ready");
    return loadPackage().then(bytesOf).then(function (data) {
      return (other ? send("APP_STOP", "", 8000) : Promise.resolve()).then(function () {
        var id = reqId = reqId >= 0x7fffffff ? 1 : reqId + 1;
        return send("APP_INSTALL_BEGIN", APP_ID + " " + data.length + " " + APP_SHA, 15000, id).then(function (r) {
          var f = r.split(" ");
          if (f[0] !== "INSTALL_READY") throw new Error("CGotchi didn't accept the app");
          var size = Math.max(256, Math.min(chunkMax || 3072, +f[1] || 3072, 3072)), off = 0;
          function next() {
            if (off >= data.length) return send("APP_INSTALL_COMMIT", "", 60000, id);
            var end = Math.min(off + size, data.length);
            return send("APP_INSTALL_CHUNK", off + " " + chunkB64(data, off, end), 15000, id).then(function (ack) {
              if (ack !== "INSTALL_CHUNK " + end) throw new Error("CGotchi lost part of the app");
              off = end; progress("Installing on CGotchi " + Math.floor(off * 100 / data.length) + "%");
              return next();
            });
          }
          return next().catch(function (e) { send("APP_INSTALL_ABORT", "", 3000, id).catch(function () {}); throw e; });
        });
      });
    }).then(function (r) { if (!/^RESULT /.test(r)) throw new Error("CGotchi couldn't finish installing"); });
  }
  function progress(t) { if (ui) ui.txt.textContent = t; }

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
      if (V.getMode() === "note") V.setMode("meeting");
      V.startRec();
      /* Vaani may need a choice first (speech engine, another tab already recording): CGotchi shows "didn't answer" and the reason is on screen here */
      setTimeout(function () { if (!V.isListening()) V.toast("CGotchi asked Vaani to start. Finish the step on screen, then try again."); }, 1500);
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
    if (!TYPES[t] || V.isListening()) return;
    var sel = V.tmplSel;
    if (sel && sel.value !== t && Array.prototype.some.call(sel.options, function (o) { return o.value === t; })) {
      sel.value = t; sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /* ---------------- Vaani state -> CGotchi ---------------- */
  function stateNow() {
    if (V.isListening()) return "north";
    var v = document.getElementById("app") && document.getElementById("app").getAttribute("data-view");
    if (v === "making") return "east";
    return "";
  }
  function pushState(force) {
    var k = stateNow();
    if (k && (force || k !== stateKey)) key(k);
    stateKey = k;
  }
  H.ext.hooks.push(function (ev, d) {
    if (!live) return;
    if (ev === "start") { stateKey = ""; pushState(true); }
    else if (ev === "view") {
      if (d === "making") { stateKey = "east"; key("east"); }
      else if (d === "idle" && (stateKey === "east" || stateKey === "north")) { stateKey = ""; key("up"); wantNotes = false; }
    } else if (ev === "note" && d && d.fresh && (stateKey === "east" || wantNotes)) { stateKey = ""; wantNotes = false; key("down"); }
  });

  /* ---------------- connect / poll ---------------- */
  function poll() {
    if (!live) return;
    readLog(cursor).then(function (r) {
      cursor = r.cur;
      if (r.entry && r.entry.app === APP_ID) onDevice(r.entry.msg);
      pollT = setTimeout(poll, r.more ? 0 : POLL_MS);
    }).catch(function () { pollT = setTimeout(poll, POLL_MS * 4); });
  }
  function beat() { if (!live) return; key("south"); pushState(false); beatT = setTimeout(beat, BEAT_MS); }

  function open(p, quiet) {
    if (live || port) return Promise.resolve();
    port = p;
    return p.open({ baudRate: 115200 }).then(function () {
      try { p.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (e) {}
      writer = p.writable.getWriter(); reader = p.readable.getReader(); buf = ""; readLoop();
      return hello(8);
    }).then(function (d) {
      var f = d.split(" ");
      if (f[0] !== "HELLO" || f[1] !== "1") throw new Error("This doesn't look like a CGotchi");
      chunk = +f[2] || 3072;
      return listApps();
    }).then(function (apps) {
      var me = apps.filter(function (a) { return a.id === APP_ID; })[0];
      if (!me || me.sha !== APP_SHA) {
        /* installing software on the device is never silent: only after a click on Connect, and only once the person says yes */
        if (quiet) throw new Error(me ? "Tap Connect CGotchi to update its Vaani app" : "Tap Connect CGotchi to put the Vaani app on it");
        var ask = me ? "Update the Vaani app on your CGotchi? It takes about 20 seconds." : "Put the Vaani app on your CGotchi? It's about " + APP_KB + " KB and takes about 20 seconds.";
        if (!window.confirm(ask)) throw new Error("cancelled");
        return install(apps, chunk).then(listApps);
      }
      return apps;
    }).then(function (apps) {
      var me = apps.filter(function (a) { return a.id === APP_ID; })[0];
      if (!me) throw new Error("The Vaani app isn't on CGotchi");
      if (me.active) return;
      var other = apps.filter(function (a) { return a.active; })[0];
      return (other ? send("APP_STOP", "", 8000).catch(function () {}) : Promise.resolve())
        .then(function () { return send("APP_START", APP_ID, 8000); });
    }).then(function () { return tail(); }).then(function (c) {
      cursor = c; live = true; stateKey = ""; paint();
      key("south"); pushState(true); poll(); beatT = setTimeout(beat, BEAT_MS);
      if (!quiet) V.toast("CGotchi is linked. Tap its red button to start the notes.");
    }).catch(function (e) {
      var msg = e && e.message ? e.message : "Couldn't link CGotchi";
      close();
      if (msg === "cancelled") return;
      if (!quiet || /^Tap Connect/.test(msg)) V.toast(/busy|in use|open/i.test(msg) ? "CGotchi is open in another app or tab. Close it there and try again." : msg);
    });
  }
  /* the device can be mid-boot: HELLO is retried for a few seconds */
  function hello(n) { return send("HELLO", "", 1500).catch(function (e) { if (n > 1) return new Promise(function (r) { setTimeout(r, 400); }).then(function () { return hello(n - 1); }); throw e; }); }
  function close() {
    live = false; clearTimeout(pollT); clearTimeout(beatT);
    Object.keys(pending).forEach(function (id) { pending[id]("ERROR", "closed"); });
    var r = reader, w = writer, p = port; reader = null; writer = null; port = null; cursor = null; stateKey = "";
    Promise.resolve().then(function () { return r && r.cancel().catch(function () {}); })
      .then(function () { try { r && r.releaseLock(); } catch (e) {} try { w && w.releaseLock(); } catch (e) {} return p && p.close().catch(function () {}); });
    paint();
  }
  function drop(why) { if (!port) return; var was = live; close(); if (was) V.toast(why); }

  function connect() {
    if (live) { close(); V.toast("CGotchi is unlinked."); return; }
    navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] })
      .then(function (p) { return open(p, false); })
      .catch(function (e) { if (e && e.name !== "NotFoundError") V.toast("Couldn't open CGotchi: " + (e.message || e.name)); });
  }

  /* ---------------- one quiet control on Home ---------------- */
  function paint() {
    if (!ui) return;
    ui.btn.setAttribute("aria-pressed", live ? "true" : "false");
    ui.btn.classList.toggle("on", live);
    ui.txt.textContent = live ? "CGotchi linked" : "Connect CGotchi";
    ui.btn.title = live ? "Unlink your CGotchi" : "Use your CGotchi as Vaani's start and stop button";
  }
  /* home.js builds Home a moment after load and moves the Chrome-extension line into its call row: the control joins that row */
  function mount(tries) {
    if (document.getElementById("cgBtn")) return;
    var row = document.querySelector(".hm-call");
    if (!row) { if ((tries || 0) < 40) setTimeout(function () { mount((tries || 0) + 1); }, 250); return; }
    var b = document.createElement("button"); b.type = "button"; b.id = "cgBtn"; b.className = "cg-link";
    var d = document.createElement("span"); d.className = "cg-dot"; d.setAttribute("aria-hidden", "true");
    var t = document.createElement("span"); b.appendChild(d); b.appendChild(t);
    row.appendChild(b); ui = { btn: b, txt: t }; paint();
    b.addEventListener("click", connect);
  }
  mount();

  /* a CGotchi this site was already allowed to use links on its own when it is plugged in or the page opens */
  navigator.serial.addEventListener("connect", function (e) { if (!live && e.target && e.target.getInfo && e.target.getInfo().usbVendorId === ESPRESSIF_VID) open(e.target, true); });
  navigator.serial.addEventListener("disconnect", function (e) { if (port && e.target === port) drop("CGotchi was unplugged"); });
  navigator.serial.getPorts().then(function (ps) { var p = ps.filter(function (x) { return x.getInfo().usbVendorId === ESPRESSIF_VID; })[0]; if (p) open(p, true); }).catch(function () {});
  window.addEventListener("pagehide", function () { if (live) key("up"); });

  window.VaaniCGotchi = { linked: function () { return live; }, connect: connect };
})();
