/* Vaani stt.js (v2.3): speech to text by Sarvam AI, used when the person has saved a Sarvam AI key in Settings and has
   not switched speech to text back to "This browser". The browser's own speech recognition (index.html) stays the free
   fallback, and is used for languages Sarvam AI doesn't cover.
   - Audio is recorded with MediaRecorder from the microphone, or from the call mix (call tab plus microphone, made in
     index.html) when "Hear everyone on a call" is on.
   - Two MediaRecorders take turns, so every piece is a complete audio file. A piece is 18 to 27 seconds long and is cut
     in a pause when there is one; the next piece starts a moment before the last one stops, so no word falls into a
     gap, and the few words heard twice are removed where the pieces meet.
   - Pieces go to https://api.sarvam.ai/speech-to-text (the REST limit is 30 seconds a request), at most two at a time.
     429, 5xx, timeouts and network errors are retried with backoff. Results are shown strictly in recording order.
     Recording never waits for a request.
   - Audio is held only in memory (never in browser storage) and each piece is dropped as soon as it is
     transcribed. It goes nowhere but api.sarvam.ai. The key is sent only in the api-subscription-key header.
   - Speaker labels are not offered: Sarvam's diarization exists only in its Batch API, whose uploads go to presigned
     cloud-storage URLs on another host (see CHANGES.md, v2.3). */
(function () {
  "use strict";
  var V = window.Vaani;
  if (!V) return;
  var API = "https://api.sarvam.ai/speech-to-text";
  /* timings in ms. minMs..maxMs is when a piece may end (in a pause) and when it must; overlapMs is how long the next
     piece runs before the last one stops. A piece is at most maxMs + overlapMs, well under the 30 s limit. */
  /* holdMs: at most this much unsent audio is held in memory (a refused key or a long outage); older pieces are dropped */
  var CFG = { minMs: 18000, maxMs: 27000, overlapMs: 900, quietMs: 400, quiet: 0.01, tries: 5, backoffMs: 1000, timeoutMs: 45000, parallel: 2, holdMs: 900000 };
  /* tests shorten the timings: only on localhost, numbers only, clamped so a piece stays under 30 s and retries stay bounded */
  (function () {
    try {
      if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
      var t = window.__vaaniSttTest; if (!t || typeof t !== "object") return;
      Object.keys(CFG).forEach(function (k) { var v = +t[k]; if (Object.prototype.hasOwnProperty.call(t, k) && isFinite(v) && v >= 0) CFG[k] = v; });
      CFG.maxMs = Math.min(CFG.maxMs, 27000); CFG.overlapMs = Math.min(CFG.overlapMs, 1500); CFG.minMs = Math.min(CFG.minMs, CFG.maxMs); CFG.parallel = Math.max(1, Math.min(4, Math.round(CFG.parallel)));
      CFG.tries = Math.max(1, Math.min(5, Math.round(CFG.tries))); CFG.backoffMs = Math.max(50, CFG.backoffMs); CFG.timeoutMs = Math.max(1000, Math.min(45000, CFG.timeoutMs)); CFG.holdMs = Math.max(1000, Math.min(900000, CFG.holdMs));
    } catch (e) {}
  })();

  /* ---------- when it is used ---------- */
  var INDIC = { "hi-IN": 1, "kn-IN": 1, "ta-IN": 1, "te-IN": 1, "mr-IN": 1, "bn-IN": 1, "gu-IN": 1, "ml-IN": 1, "pa-IN": 1 };
  /* the language_code Sarvam gets for Vaani's spoken-language choice. English (any) means auto-detect: meetings set to
     English in India are often Kannada, Hindi or Tamil mixed with English. null: not a Sarvam language. */
  function codeFor(lang) { lang = String(lang || ""); if (/^en-/.test(lang)) return "unknown"; if (lang === "ur-PK") return "ur-IN"; return INDIC[lang] ? lang : null; }
  function key() { return String(V.load("vaani.key.sarvam", "") || "").trim(); }
  function enabled() { return V.load("vaani.stt", "sarvam") !== "browser"; }
  function supported() { return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.FormData && window.fetch && window.Blob); }
  function usable(lang) { return supported() && !!key() && enabled() && codeFor(lang == null ? V.langSel.value : lang) !== null; }
  function pickMime() {
    var c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (var i = 0; i < c.length; i++) { try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {} }
    return "";
  }
  function extOf(m) { return /mp4/.test(m) ? ".m4a" : /ogg/.test(m) ? ".ogg" : ".webm"; }
  /* "Names and words": up to 50 plain terms of at most 64 characters each, sent as one JSON array (Sarvam's keyterms) */
  function keyterms() {
    var d = V.loadJSON("vaani.dict", []), out = [], seen = Object.create(null);
    (Array.isArray(d) ? d : []).forEach(function (x) {
      if (!x || typeof x.word !== "string" || out.length >= 50) return;
      var w = x.word.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64).trim();
      var k = w.toLowerCase(); if (!w || seen[k]) return; seen[k] = 1; out.push(w);
    });
    return out;
  }

  /* ---------- words heard twice where two pieces overlap ---------- */
  var NORM = /[^\p{L}\p{N}\p{M}]+/gu;
  function norm(w) { return String(w).toLowerCase().replace(NORM, ""); }
  function toks(segs) { var a = []; segs.forEach(function (s, si) { s.x.split(/\s+/).forEach(function (w, ti) { var n = norm(w); if (w && n) a.push({ si: si, ti: ti, n: n }); }); }); return a; }
  function dedupe(segs, tail) {
    if (!tail.length || !segs.length) return segs.slice();
    var ws = toks(segs), max = Math.min(6, tail.length, ws.length), k = 0;
    for (var kk = max; kk >= 1 && !k; kk--) {
      var ok = true;
      for (var j = 0; j < kk; j++) if (tail[tail.length - kk + j] !== ws[j].n) { ok = false; break; }
      if (ok && (kk >= 2 || ws[0].n.length >= 4)) k = kk;
    }
    if (!k) return segs.slice();
    var last = ws[k - 1], out = [];
    segs.forEach(function (s, si) {
      var parts = s.x.split(/\s+/);
      if (si < last.si) return;
      if (si === last.si) parts = parts.slice(last.ti + 1);
      var x = parts.join(" ").trim(); if (x) out.push({ s: s.s, x: x });
    });
    return out;
  }
  function tailOf(tail, segs) { var a = tail.slice(); toks(segs).forEach(function (w) { a.push(w.n); }); return a.slice(-8); }
  function toSeg(s) { return { t: V.fmt(Math.max(0, Math.floor(s.s))), x: s.x }; }

  /* ---------- one recording ---------- */
  var R = null;
  function start(o) {
    if (R) return Promise.reject(new Error("busy"));
    var S = { lang: codeFor(o.lang), t0: o.t0 || Date.now(), chunks: [], recs: [], cur: null, pend: null, out: 0, inflight: 0, tail: [], langs: {}, auth: false, noMode: false, noKt: false, stopped: false, qs: 0, waiters: [], onSegs: o.onSegs || function () {}, onState: o.onState || function () {}, kt: keyterms(), mime: pickMime() };
    S.ext = extOf(S.mime);
    if (S.lang === null) return Promise.reject(new Error("language"));
    R = S;
    var track = o.track && o.track.readyState === "live" ? o.track : null;
    var got = track ? Promise.resolve(new MediaStream([track])) : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (st) { S.own = st; return st; });
    return got.then(function (stream) {
      if (R !== S) { if (S.own) S.own.getTracks().forEach(function (t) { t.stop(); }); throw new Error("stopped"); }
      S.stream = stream;
      /* the pause finder: a level meter read on every tick. Ticks come from a 250 ms timer and from the recorder's
         own once-a-second data events, which keep coming when the tab is in the background and timers slow down. */
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        S.ac = new AC(); S.src = S.ac.createMediaStreamSource(stream); S.an = S.ac.createAnalyser(); S.an.fftSize = 2048; S.buf = new Float32Array(S.an.fftSize);
        S.src.connect(S.an);
        if (S.ac.state === "suspended" && S.ac.resume) S.ac.resume().catch(function () {});
      } catch (e) { S.ac = null; S.an = null; }
      S.iv = setInterval(function () { tick(S); }, 250);
      S.cur = newRec(S);
      state(S);
    }, function (err) { if (R === S) R = null; throw err; });
  }
  function newRec(S) {
    var r = { i: S.chunks.length, at: Date.now(), parts: [], closed: false, done: null };
    r.s = Math.max(0, (r.at - S.t0) / 1000);
    S.chunks.push({ i: r.i, s: r.s, e: r.s, st: "recording", tries: 0 });
    var mr;
    try { mr = S.mime ? new MediaRecorder(S.stream, { mimeType: S.mime, audioBitsPerSecond: 48000 }) : new MediaRecorder(S.stream); }
    catch (e) { mr = new MediaRecorder(S.stream); S.mime = ""; }
    r.mr = mr;
    mr.ondataavailable = function (e) { if (e.data && e.data.size) r.parts.push(e.data); tick(S); };
    mr.onstop = function () { closeRec(S, r); };
    mr.onerror = function () { closeRec(S, r); };
    S.recs.push(r);
    /* a microphone that was unplugged or blocked mid-recording: keep what was recorded and say so */
    try { mr.start(1000); } catch (e) { S.micLost = true; closeRec(S, r); }
    return r;
  }
  function stopOne(S, r) { try { if (r.mr.state !== "inactive") r.mr.stop(); else closeRec(S, r); } catch (e) { closeRec(S, r); } }
  function closeRec(S, r) {
    if (r.closed) return; r.closed = true;
    var c = S.chunks[r.i];
    c.e = Math.max(c.s, (Date.now() - S.t0) / 1000);
    var type = S.mime || (r.parts[0] && r.parts[0].type) || "audio/webm";
    c.blob = new Blob(r.parts, { type: type }); r.parts = [];
    if (c.blob.size < 800 || c.e - c.s < 0.4) { c.st = "done"; c.res = { segs: [] }; c.blob = null; }
    else { c.st = "queued"; c.tries = 0; c.wait = 0; }
    S.recs = S.recs.filter(function (x) { return x !== r; });
    if (r.done) r.done();
    if (R !== S) return;
    capHeld(S); deliver(S); pump(S); state(S);
  }
  /* I3: while Sarvam AI can't be reached (or refuses the key), keep at most holdMs of unsent audio; drop the oldest */
  function capHeld(S) {
    var held = S.chunks.filter(function (c) { return c.blob && (c.st === "queued" || c.st === "failed"); }), sum = 0;
    held.forEach(function (c) { sum += Math.max(0, c.e - c.s); });
    /* a dropped piece counts up to where the next piece starts, so the overlap isn't counted twice */
    for (var i = 0; i < held.length && sum * 1000 > CFG.holdMs; i++) { var c = held[i], nx = S.chunks[c.i + 1], d = Math.max(0, (nx ? Math.min(c.e, nx.s) : c.e) - c.s); c.blob = null; c.st = "lost"; S.lost = (S.lost || 0) + d; sum -= Math.max(0, c.e - c.s); }
  }
  /* cut a piece in a pause after minMs, or at maxMs whatever is being said */
  function level(S, now) {
    if (!S.an) return;
    S.an.getFloatTimeDomainData(S.buf);
    var sum = 0; for (var i = 0; i < S.buf.length; i += 2) sum += S.buf[i] * S.buf[i];
    if (Math.sqrt(sum / (S.buf.length / 2)) < CFG.quiet) { if (!S.qs) S.qs = now; } else S.qs = 0;
  }
  function tick(S) {
    if (R !== S || S.stopped || !S.cur || S.micLost) return;
    if (S.stream && !S.stream.getAudioTracks().some(function (t) { return t.readyState === "live"; })) { S.micLost = true; state(S); return; }
    var now = Date.now(); level(S, now);
    if (S.pend) { if (now >= S.pend.at) { var o = S.pend.r; S.pend = null; stopOne(S, o); } return; }
    var age = now - S.cur.at, quiet = !!S.qs && now - S.qs >= CFG.quietMs;
    if (age >= CFG.maxMs || (age >= CFG.minMs && quiet)) {
      var old = S.cur; S.cur = newRec(S);
      S.pend = { r: old, at: now + (quiet ? Math.min(CFG.overlapMs, 400) : CFG.overlapMs) };
    }
  }

  /* ---------- sending ---------- */
  function pump(S) {
    if (R !== S || S.auth) return;
    while (S.inflight < CFG.parallel) {
      var now = Date.now(), c = null;
      for (var i = 0; i < S.chunks.length; i++) { var x = S.chunks[i]; if (x.st === "queued" && (!x.wait || x.wait <= now)) { c = x; break; } }
      if (!c) break;
      send(S, c);
    }
  }
  function send(S, c) {
    c.st = "sending"; S.inflight++;
    var fd = new FormData();
    fd.append("file", c.blob, "vaani-" + c.i + S.ext);
    fd.append("model", "saaras:v4");
    if (!S.noMode) fd.append("mode", "codemix");
    fd.append("language_code", S.lang);
    fd.append("with_timestamps", "true");
    if (!S.noKt && S.kt.length) fd.append("keyterms", JSON.stringify(S.kt));
    var ctl = window.AbortController ? new AbortController() : null, done = false;
    var to = setTimeout(function () { if (ctl) ctl.abort(); fail(); }, CFG.timeoutMs);
    function fin() { if (done) return false; done = true; clearTimeout(to); S.inflight = Math.max(0, S.inflight - 1); return true; }
    function fail() { if (!fin()) return; retry(S, c); }
    fetch(API, { method: "POST", headers: { "api-subscription-key": key() }, body: fd, signal: ctl ? ctl.signal : undefined, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" })
      .then(function (r) { return r.text().then(function (t) { var d = null; try { d = JSON.parse(t); } catch (e) {} return { st: r.status, d: d }; }); })
      .then(function (x) { if (!fin()) return; handle(S, c, x.st, x.d); }, fail);
  }
  function msgOf(d) { var e = d && d.error; var m = e && (e.message || e.code) || (d && d.detail) || ""; return typeof m === "string" ? m : JSON.stringify(m); }
  function handle(S, c, status, d) {
    if (status >= 200 && status < 300 && d && typeof d === "object") {
      c.res = parse(S, c, d); c.st = "done"; c.blob = null;
    } else if (status === 401 || status === 403) {
      /* a wrong or expired key: stop sending, keep every piece, and say so */
      c.st = "queued"; c.wait = 0; S.auth = true;
    } else if (status === 400 || status === 422) {
      var m = msgOf(d);
      if (!S.noMode && /\bmode\b/i.test(m)) { S.noMode = true; c.st = "queued"; c.wait = 0; }
      else if (!S.noKt && /keyterm/i.test(m)) { S.noKt = true; c.st = "queued"; c.wait = 0; }
      else { c.st = "failed"; c.why = "bad"; }
    } else { retry(S, c); return; }
    after(S);
  }
  function retry(S, c) {
    c.tries++;
    if (c.tries >= CFG.tries) { c.st = "failed"; c.why = "net"; after(S); return; }
    var ms = CFG.backoffMs * Math.pow(2, c.tries - 1) * (0.8 + Math.random() * 0.4);
    c.st = "queued"; c.wait = Date.now() + ms;
    setTimeout(function () { pump(S); }, ms + 5);
    after(S);
  }
  function after(S) { if (R !== S) return; capHeld(S); deliver(S); pump(S); state(S); }
  function parse(S, c, d) {
    var segs = [], ts = d.timestamps, ph = ts && Array.isArray(ts.words) ? ts.words : null, st = ts && Array.isArray(ts.start_time_seconds) ? ts.start_time_seconds : [];
    if (ph && ph.length) ph.forEach(function (w, j) { var x = String(w == null ? "" : w).replace(/\s+/g, " ").trim(); if (x) segs.push({ s: c.s + Math.max(0, +st[j] || 0), x: x }); });
    else { var x = String(d.transcript || "").replace(/\s+/g, " ").trim(); if (x) segs.push({ s: c.s, x: x }); }
    if (typeof d.language_code === "string" && /^[a-z]{2,3}-[A-Z]{2}$/.test(d.language_code)) {
      var n = 0; segs.forEach(function (s) { n += s.x.split(/\s+/).length; });
      S.langs[d.language_code] = (S.langs[d.language_code] || 0) + n;
    }
    return { segs: segs };
  }
  /* pieces reach the page in recording order; a piece that failed is skipped for now and tried again at the end */
  function deliver(S) {
    while (S.out < S.chunks.length) {
      var c = S.chunks[S.out];
      if (c.st === "done") {
        var out = dedupe(c.res.segs, S.tail); S.tail = tailOf(S.tail, out);
        if (out.length) S.onSegs(out.map(toSeg));
      } else if (c.st === "failed" || c.st === "lost") S.tail = [];
      else break;
      S.out++;
    }
  }
  function info(S) {
    var q = 0, f = 0, got = 0, retrying = false;
    S.chunks.forEach(function (c) { if (c.st === "queued" || c.st === "sending") q++; if (c.st === "failed") f++; if (c.st === "done") got++; if (c.st === "queued" && c.tries > 0) retrying = true; });
    return { engine: "sarvam", waiting: q, failed: f, got: got, retrying: retrying, auth: S.auth, stopped: S.stopped, micLost: !!S.micLost, lost: Math.round(S.lost || 0) };
  }
  function state(S) {
    if (R !== S) return;
    try { S.onState(info(S)); } catch (e) {}
    if (settled(S)) { var w = S.waiters; S.waiters = []; w.forEach(function (f) { f(); }); }
  }
  function settled(S) { return S.stopped && !S.recs.length && S.inflight === 0 && S.chunks.every(function (c) { return c.st === "done" || c.st === "failed" || c.st === "lost" || (S.auth && c.st === "queued"); }); }

  /* ---------- the end of a recording ---------- */
  /* stop both recorders; resolves once every piece is recorded, so the microphone and call can be released */
  function stop() {
    var S = R; if (!S) return Promise.resolve();
    S.stopped = true; S.pend = null;
    var ps = S.recs.map(function (r) { return new Promise(function (res) { r.done = res; stopOne(S, r); }); });
    return Promise.all(ps).then(function () { quiet(S); state(S); });
  }
  function quiet(S) {
    clearInterval(S.iv);
    if (S.src) { try { S.src.disconnect(); } catch (e) {} S.src = null; S.an = null; }
    if (S.ac) { try { S.ac.close(); } catch (e) {} S.ac = null; }
    if (S.own) { S.own.getTracks().forEach(function (t) { t.stop(); }); S.own = null; }
  }
  function drain(S) { return new Promise(function (res) { if (settled(S)) res(); else S.waiters.push(res); }); }
  function collect(S) {
    var segs = [], tail = [], gap = 0, bad = 0;
    S.chunks.forEach(function (c) {
      if (c.st === "done") { var out = dedupe(c.res.segs, tail); tail = tailOf(tail, out); out.forEach(function (s) { segs.push(toSeg(s)); }); }
      else { gap += Math.max(0, c.e - c.s); if (c.st !== "lost") bad++; tail = []; }
    });
    var lang = null;
    if (S.lang === "unknown") {
      var best = "", n = 0; Object.keys(S.langs).forEach(function (k) { if (S.langs[k] > n) { n = S.langs[k]; best = k; } });
      if (best === "ur-IN") best = "ur-PK";
      if (best && V.LANGS.some(function (l) { return l[0] === best; })) lang = best;
    }
    return { segs: segs, gap: Math.round(gap), bad: bad, lost: Math.round(S.lost || 0), auth: S.auth, lang: lang };
  }
  /* waits for every piece; if some could not be transcribed, asks: try again, keep what is there, or discard.
     The audio stays in memory until then. Resolves { segs, lang, gap, drop }. */
  function finish() {
    var S = R; if (!S) return Promise.resolve({ segs: [], lang: null, gap: 0, drop: false });
    S.chunks.forEach(function (c) { if (c.st === "failed") { c.st = "queued"; c.tries = Math.max(0, CFG.tries - 2); c.wait = 0; } });
    pump(S); state(S);
    function loop() {
      return drain(S).then(function () {
        var r = collect(S);
        if (!r.bad || R !== S) return r;
        return ask(r).then(function (a) {
          if (a === "retry" && enabled() && key()) {
            S.auth = false;
            S.chunks.forEach(function (c) { if (c.st === "failed" || c.st === "queued") { c.st = "queued"; c.tries = 0; c.wait = 0; } });
            busyUi(true); pump(S); state(S); return loop();
          }
          if (a === "retry") return loop(); /* switched to This browser meanwhile: ask again, without Try again */
          r.drop = a === "drop"; if (a === "keep") r.gap = Math.max(1, r.gap); return r;
        });
      });
    }
    return loop();
  }
  function reset() { var S = R; R = null; if (S) { S.stopped = true; S.recs.forEach(function (r) { try { r.mr.ondataavailable = null; r.mr.onstop = null; if (r.mr.state !== "inactive") r.mr.stop(); } catch (e) {} }); quiet(S); S.chunks.forEach(function (c) { c.blob = null; }); } askBox(null); }
  function busy() { return !!R; }

  /* ---------- the question on the making screen ---------- */
  function secsLabel(s) { s = Math.max(1, Math.round(s)); return s < 60 ? s + (s === 1 ? " second" : " seconds") : Math.floor(s / 60) + " min" + (s % 60 ? " " + (s % 60) + " s" : ""); }
  function askBox(box) { var old = document.getElementById("sttAsk"); if (old) old.remove(); var th = document.querySelector("#vMaking .think"); if (th) th.hidden = !!box; if (box) document.getElementById("vMaking").appendChild(box); }
  function busyUi(on) { askBox(null); if (on) { $id("makingH").textContent = "Trying Sarvam AI again"; $id("makingSub").textContent = "Vaani still has the audio, in memory only."; } }
  function $id(i) { return document.getElementById(i); }
  function ask(r) {
    return new Promise(function (res) {
      var have = r.segs.length > 0, off = !enabled() || !key();
      /* design R4: one consistent account of what is still held and what was dropped */
      var nl = Math.max(1, Math.round(r.lost || 0)), lost = r.lost ? " The oldest " + secsLabel(nl) + (nl === 1 ? " was" : " were") + " dropped, because Vaani keeps at most 15 minutes of unsent audio." : "";
      var held = r.lost ? "the last 15 minutes of audio" : "the audio of this recording";
      if (off) { $id("makingH").textContent = have ? "Part of the recording isn’t transcribed" : "The recording isn’t transcribed"; $id("makingSub").textContent = "Speech to text is set to this browser now, so Vaani won’t send this audio to Sarvam AI." + lost; }
      else if (r.auth) { $id("makingH").textContent = "Sarvam AI didn’t accept your key"; $id("makingSub").textContent = "Vaani still has " + held + ", in memory only. Check your Sarvam AI key in Settings, then try again. If you close this page, it’s gone." + lost; }
      else { $id("makingH").textContent = have ? "Part of the recording isn’t transcribed" : "The recording isn’t transcribed"; $id("makingSub").textContent = "Sarvam AI couldn’t turn " + secsLabel(r.gap - (r.lost || 0)) + " of the recording into text. Vaani still has that audio, in memory only, so you can try again. If you close this page, it’s gone." + lost; }
      var box = document.createElement("div"); box.className = "stt-ask"; box.id = "sttAsk";
      box.setAttribute("role", "group"); box.setAttribute("aria-labelledby", "makingH"); box.setAttribute("aria-describedby", "makingSub");
      function b(cls, txt, a) { var x = document.createElement("button"); x.type = "button"; x.className = cls; x.textContent = txt; x.setAttribute("data-stt-ask", a); box.appendChild(x); return x; }
      var first = off ? null : b("btn-p", "Try again", "retry");
      if (r.auth && !off) b("btn-f", "Open Settings", "settings");
      if (have) { var k = b(off ? "btn-p" : "btn-t", "Make notes without it", "keep"); first = first || k; }
      var dr = b(have || !off ? "btn-t" : "btn-p", "Discard the recording", "drop"); first = first || dr;
      if (have && !off) dr.remove();
      box.addEventListener("click", function (e) {
        var x = e.target.closest("[data-stt-ask]"); if (!x) return;
        var a = x.getAttribute("data-stt-ask");
        if (a === "settings") { V.openSettings("sarvam"); return; }
        askBox(null); res(a);
      });
      askBox(box); setTimeout(function () { try { first.focus(); } catch (e) {} }, 60);
    });
  }
  /* the page warns before closing while audio is still waiting to be transcribed */
  window.addEventListener("beforeunload", function (e) { if (R && !V.isListening()) { e.preventDefault(); e.returnValue = ""; } });

  window.VaaniSTT = { usable: usable, hasKey: function () { return !!key(); }, enabled: enabled, supported: supported, codeFor: codeFor, start: start, stop: stop, finish: finish, reset: reset, busy: busy, keyterms: keyterms, _dedupe: dedupe };
  if (V.syncRecBtn) V.syncRecBtn();
})();
