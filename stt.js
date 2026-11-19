/* Vaani stt.js (v2.3): speech to text by Sarvam AI, used when the person has saved a Sarvam AI key in Settings and has
   not switched speech to text back to "This browser". The browser's own speech recognition (index.html) stays the free
   fallback, and is used for languages Sarvam AI doesn't cover.
   - Audio is recorded with MediaRecorder from the microphone, or from the call mix: the call tab, handed over by the
     Vaani Chrome extension (1.2.0 or later) with no picker, plus the microphone, mixed in index.html. useTrack() moves a running
     recording over to that mix when the call joins later (one meeting, one note).
   - Or from the Vaani Mac app: 16 kHz mono PCM in 250 ms chunks through feed() (start with {pcm:true}). The pieces are
     cut by the same rules and sent as WAV files.
   - Two MediaRecorders take turns, so every piece is a complete audio file. A piece is 18 to 27 seconds long and is cut
     in a pause when there is one; the next piece starts a moment before the last one stops, so no word falls into a
     gap, and the few words heard twice are removed where the pieces meet.
   - v2.8: the pause finder listens to the whole piece (50 ms frames, not a snapshot every 250 ms) and sets its bar from
     the room's own noise floor; a piece with no sound in it is not sent at all (its time is kept, so later words keep
     their place); the seam rule needs two matching words, or one word plus the half word the cut left behind.
   - Pieces go to https://api.sarvam.ai/speech-to-text (the REST limit is 30 seconds a request), at most two at a time.
     429, 5xx, timeouts and network errors are retried with backoff. Results are shown strictly in recording order.
     Recording never waits for a request.
   - v2.8: when Sarvam AI says "too many requests" (429, or 503 with Retry-After) the whole queue waits, not just that
     piece: for as long as Retry-After says (when the browser may read it), otherwise 2 s, 4 s, 8 s... up to 30 s; then one
     piece goes first. The state (onState) says so: limited, waitS.
   - Audio is held only in memory (never in browser storage) and each piece is dropped as soon as it is
     transcribed. It goes nowhere but api.sarvam.ai. The key is sent only in the api-subscription-key header.
   - v2.6: sendFile() sends one piece of an uploaded audio or video file the same way (upload.js).
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
  var CFG = { minMs: 18000, maxMs: 27000, overlapMs: 900, quietMs: 400, quiet: 0.01, tries: 5, backoffMs: 1000, timeoutMs: 45000, parallel: 2, holdMs: 900000, rlMs: 2000, rlMaxMs: 30000, raMaxMs: 60000, rlStopMs: 75000 };
  /* tests shorten the timings: only on localhost, numbers only, clamped so a piece stays under 30 s and retries stay bounded */
  (function () {
    try {
      if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
      var t = window.__vaaniSttTest; if (!t || typeof t !== "object") return;
      Object.keys(CFG).forEach(function (k) { var v = +t[k]; if (Object.prototype.hasOwnProperty.call(t, k) && isFinite(v) && v >= 0) CFG[k] = v; });
      CFG.maxMs = Math.min(CFG.maxMs, 27000); CFG.overlapMs = Math.min(CFG.overlapMs, 1500); CFG.minMs = Math.min(CFG.minMs, CFG.maxMs); CFG.parallel = Math.max(1, Math.min(4, Math.round(CFG.parallel)));
      CFG.tries = Math.max(1, Math.min(5, Math.round(CFG.tries))); CFG.backoffMs = Math.max(50, CFG.backoffMs); CFG.timeoutMs = Math.max(1000, Math.min(45000, CFG.timeoutMs)); CFG.holdMs = Math.max(1000, Math.min(900000, CFG.holdMs));
      CFG.rlMs = Math.max(50, Math.min(2000, CFG.rlMs)); CFG.rlMaxMs = Math.max(CFG.rlMs, Math.min(30000, CFG.rlMaxMs)); CFG.raMaxMs = Math.max(1000, Math.min(60000, CFG.raMaxMs)); CFG.rlStopMs = Math.max(500, Math.min(90000, CFG.rlStopMs));
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

  /* ---------- v2.8: the level meter (the pause finder and the silent-piece check read it) ----------
     Frames of 50 ms: [time in ms, RMS 0..1], the last 60 seconds. The noise floor is the mean of the quietest fifth of
     the last 30 seconds, clamped (after silverstein/minutes whisper-guard strip_silence, MIT); the pause bar is three
     times the floor and grows more lenient as a piece nears its limit (after fastrepl/anarlog audio-chunking
     neg_threshold_for_speech_samples, MIT). See NOTICE. */
  var FR = 50;
  function mNew() { return { fr: [], lt: 0, fl: null, flAt: -1e9 }; }
  function mPush(M, t, r) { M.fr.push(t, r); if (M.fr.length > 2400) M.fr.splice(0, M.fr.length - 2400); }
  function mFloor(M, now) {
    if (now - M.flAt < 1000 && now >= M.flAt) return M.fl;
    var a = [], f = M.fr, i; for (i = f.length - 2; i >= 0 && f[i] > now - 30000; i -= 2) a.push(f[i + 1]);
    M.flAt = now;
    if (a.length < 20) return (M.fl = null);
    a.sort(function (x, y) { return x - y; });
    var n = Math.max(1, Math.floor(a.length / 5)), sum = 0; for (i = 0; i < n; i++) sum += a[i];
    return (M.fl = Math.max(0.0005, Math.min(0.02, sum / n)));
  }
  /* the bar a frame must stay under to count as a pause: the old fixed bar until a second of sound has been heard */
  function mBar(M, now) { var fl = mFloor(M, now); return fl === null ? CFG.quiet : Math.max(CFG.quiet * 0.4, fl * 3); }
  /* how long it has been quiet, up to now: frames back from the newest, stopping at a loud one or at a hole in the meter */
  function mQuiet(M, now, bar) {
    var f = M.fr, run = 0, prev = now;
    for (var i = f.length - 2; i >= 0; i -= 2) { if (prev - f[i] > FR * 2.5 || f[i + 1] >= bar) break; run += FR; prev = f[i]; }
    return run;
  }
  /* may this piece end here? age: its length so far. Resolves the pause rule: quietMs of quiet under the bar at minMs,
     sliding to under half of that, under twice the bar, at maxMs. */
  function mPause(M, now, age) {
    var f = Math.max(0, Math.min(1, (age - CFG.minMs) / Math.max(1, CFG.maxMs - CFG.minMs)));
    return mQuiet(M, now, mBar(M, now) * (1 + f)) >= Math.max(FR * 2, CFG.quietMs * (1 - 0.625 * f));
  }
  /* is there no sound in [from, to]? Only when the meter saw at least 80% of it and under 300 ms rose over the lower of
     two bars: 0.0025 (-52 dB, far under a quiet voice), or four times the floor. A steady quiet voice cannot be told
     from a steady noise by level alone, so the bar is this low on purpose: when in doubt the piece is sent. */
  function mSilent(M, from, to) {
    var f = M.fr, seen = 0, loud = 0, fl = mFloor(M, to), bar = Math.min(0.0025, (fl === null ? 0.0005 : fl) * 4);
    for (var i = f.length - 2; i >= 0 && f[i] > from; i -= 2) { if (f[i] > to + FR) continue; seen += FR; if (f[i + 1] > bar) loud += FR; }
    return to - from >= 400 && seen >= (to - from) * 0.8 && loud < 300;
  }
  /* at most three silent pieces in a row are held back; the fourth is sent, so a meter that is wrong cannot go unnoticed */
  function skipOk(S, silent) { if (silent && (S.skips || 0) < 3) { S.skips = (S.skips || 0) + 1; S.skipped = (S.skipped || 0) + 1; return true; } S.skips = 0; return false; }

  /* ---------- words heard twice where two pieces overlap ---------- */
  var NORM = /[^\p{L}\p{N}\p{M}]+/gu;
  function norm(w) { return String(w).toLowerCase().replace(NORM, ""); }
  function toks(segs) { var a = []; segs.forEach(function (s, si) { s.x.split(/\s+/).forEach(function (w, ti) { var n = norm(w); if (w && n) a.push({ si: si, ti: ti, n: n }); }); }); return a; }
  /* v2.8. What is removed from the start of a piece (after OpenWhisper's append_preview_text, MIT: a lone repeated word
     is ambiguous, so two matching words are needed; the match is bounded by how many words fit in the overlap):
     1. its first k words when they are the last k words already shown, k from 2 up to what fits in the overlap;
     2. a half word at the cut. "send the repo" + "the report by Friday": the last word shown is the beginning of a word of
        this piece and the words before it agree, so "the" is removed and r.drop says the half word "repo" can go too;
        or "the report by" + "port by Friday": this piece opens with the end of a word already shown;
     3. one repeated word of four or more letters, only when the piece was cut mid-speech (o.pause false) and more words
        follow. After a cut in a pause the overlap is nearly all silence, so a word said twice was said twice: it stays.
     Never reorders; never removes anything but a prefix of the piece. Returns { segs, drop }. */
  function seam(segs, tail, o) {
    var r = { segs: segs.slice(), drop: 0 };
    if (!tail.length || !segs.length) return r;
    var pause = !!(o && o.pause), ov = (pause ? Math.min(CFG.overlapMs, 400) : CFG.overlapMs) / 1000;
    var ws = toks(segs), T = tail.length, maxK = Math.max(2, Math.min(6, Math.ceil(ov * 8))), k = 0, kk, j, i, ok, t, w, minJ = pause ? 2 : 1;
    for (kk = Math.min(maxK, T, ws.length); kk >= 2 && !k; kk--) {
      ok = true; for (i = 0; i < kk; i++) if (tail[T - kk + i] !== ws[i].n) { ok = false; break; }
      if (ok) k = kk;
    }
    for (j = Math.min(maxK - 1, T - 1, ws.length - 1); j >= minJ && !k; j--) {
      t = tail[T - 1]; w = ws[j].n;
      if (t.length < 2 || w.length <= t.length || w.indexOf(t) !== 0) continue;
      ok = true; for (i = 0; i < j; i++) if (tail[T - 1 - j + i] !== ws[i].n) { ok = false; break; }
      if (ok) { k = j; r.drop = 1; }
    }
    for (j = Math.min(maxK - 1, T - 1, ws.length - 1); j >= minJ && !k; j--) {
      t = tail[T - 1 - j]; w = ws[0].n;
      if (w.length < 2 || t.length <= w.length || t.lastIndexOf(w) !== t.length - w.length) continue;
      ok = true; for (i = 1; i <= j; i++) if (tail[T - 1 - j + i] !== ws[i].n) { ok = false; break; }
      if (ok) k = j + 1;
    }
    if (!k && !pause && ws.length > 1 && ws[0].n.length >= 4 && tail[T - 1] === ws[0].n) k = 1;
    if (!k) return r;
    var last = ws[k - 1], out = [];
    segs.forEach(function (s, si) {
      var parts = s.x.split(/\s+/);
      if (si < last.si) return;
      if (si === last.si) parts = parts.slice(last.ti + 1);
      var x = parts.join(" ").trim(); if (x) out.push({ s: s.s, x: x });
    });
    r.segs = out; return r;
  }
  function dedupe(segs, tail, o) { return seam(segs, tail, o).segs; }
  /* the half word the cut left at the end of what was collected so far (collect() only: the live view cannot take a word back) */
  function dropLast(list, from) {
    for (var i = list.length - 1; i >= from; i--) {
      var parts = list[i].x.split(/\s+/), q = parts.length - 1;
      while (q >= 0 && !norm(parts[q])) q--;
      if (q < 0) continue;
      parts.splice(q, 1); var x = parts.join(" ").trim();
      if (x) list[i] = { s: list[i].s, x: x }; else list.splice(i, 1);
      return;
    }
  }
  function tailOf(tail, segs) { var a = tail.slice(); toks(segs).forEach(function (w) { a.push(w.n); }); return a.slice(-8); }
  function toSeg(s) { return { t: V.fmt(Math.max(0, Math.floor(s.s))), x: s.x }; }

  /* ---------- one recording ---------- */
  var R = null;
  function start(o) {
    if (R) return Promise.reject(new Error("busy"));
    var S = { lang: codeFor(o.lang), t0: o.t0 || Date.now(), chunks: [], recs: [], cur: null, pend: null, out: 0, inflight: 0, tail: [], langs: {}, auth: false, noMode: false, noKt: false, stopped: false, qs: 0, waiters: [], M: mNew(), onSegs: o.onSegs || function () {}, onState: o.onState || function () {}, kt: keyterms(), mime: pickMime() };
    S.ext = extOf(S.mime);
    if (S.lang === null) return Promise.reject(new Error("language"));
    if (o.pcm) { S.pcm = { rate: 16000, cur: [], n: 0, pos: 0, s: 0, pz: false }; S.mime = "audio/wav"; S.ext = ".wav"; R = S; state(S); return Promise.resolve(); }
    R = S;
    var track = o.track && o.track.readyState === "live" ? o.track : null;
    var got = track ? Promise.resolve(new MediaStream([track])) : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (st) { S.own = st; return st; });
    return got.then(function (stream) {
      if (R !== S) { if (S.own) S.own.getTracks().forEach(function (t) { t.stop(); }); throw new Error("stopped"); }
      S.stream = stream;
      /* the pause finder: a level meter read on every tick. Ticks come from a 250 ms timer and from the recorder's
         own once-a-second data events, which keep coming when the tab is in the background and timers slow down.
         v2.8: the analyser holds the last 0.68 s (at 48 kHz), so every tick reads all the sound since the tick before:
         the whole piece is heard while the page is in front, about two thirds of it when timers slow to one a second. */
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        S.ac = new AC(); S.src = S.ac.createMediaStreamSource(stream); S.an = S.ac.createAnalyser(); S.an.fftSize = 32768; S.an.smoothingTimeConstant = 0; S.buf = new Float32Array(S.an.fftSize);
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
    /* v2.8: a piece with no sound in it (a muted call, waiting for people) is not sent; its time stays where it is */
    else if (skipOk(S, !!S.an && mSilent(S.M, r.at, Date.now()))) { c.st = "done"; c.res = { segs: [] }; c.blob = null; c.skip = true; }
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
    if (!S.an || !S.ac || S.ac.state !== "running") return;
    var M = S.M, dt = M.lt ? now - M.lt : 250;
    if (dt < FR * 0.6) return;
    S.an.getFloatTimeDomainData(S.buf);
    var L = S.buf.length, fl = Math.max(1, Math.round(S.ac.sampleRate * FR / 1000)), k = Math.max(1, Math.min(Math.floor(L / fl), Math.round(dt / FR)));
    for (var j = k - 1; j >= 0; j--) {
      var a = L - (j + 1) * fl, sum = 0; for (var i = a; i < a + fl; i++) sum += S.buf[i] * S.buf[i];
      mPush(M, now - j * FR, Math.sqrt(sum / fl));
    }
    M.lt = now;
  }
  function tick(S) {
    if (R !== S || S.stopped || !S.cur || S.micLost) return;
    if (S.stream && !S.stream.getAudioTracks().some(function (t) { return t.readyState === "live"; })) { S.micLost = true; state(S); return; }
    var now = Date.now(); level(S, now);
    if (S.pend) { if (now >= S.pend.at) { var o = S.pend.r; S.pend = null; stopOne(S, o); } return; }
    var age = now - S.cur.at, quiet = age >= CFG.minMs && !!S.an && mPause(S.M, now, age);
    if (age >= CFG.maxMs || quiet) {
      var old = S.cur; S.cur = newRec(S);
      /* pz: this piece began at a cut in a pause, so the overlap behind it is short and nearly silent (the seam rule reads it) */
      S.chunks[S.cur.i].pz = quiet;
      S.pend = { r: old, at: now + (quiet ? Math.min(CFG.overlapMs, 400) : CFG.overlapMs) };
    }
  }

  /* B1: the call joins a recording that is already running (Vaani was taking notes from the mic, then the person chose
     a click on the Vaani icon on the call tab). From now on every piece records the call mixed with the mic: the piece being
     recorded is cut here, with the usual overlap, so nothing is lost and it all stays one note. */
  function useTrack(track) {
    var S = R;
    if (!S || S.pcm || S.stopped || !S.cur || !track || track.readyState !== "live") return false;
    S.stream = new MediaStream([track]); S.micLost = false;
    try { if (S.ac && S.an) { if (S.src) S.src.disconnect(); S.src = S.ac.createMediaStreamSource(S.stream); S.src.connect(S.an); } } catch (e) { /* the pause finder only */ }
    if (S.pend) { var p = S.pend.r; S.pend = null; stopOne(S, p); }
    var old = S.cur; S.cur = newRec(S);
    S.pend = { r: old, at: Date.now() + CFG.overlapMs };
    /* the microphone this recorder opened itself is in the mix now: let it go once the last mic-only piece has ended */
    var own = S.own; S.own = null;
    if (own) setTimeout(function () { own.getTracks().forEach(function (t) { t.stop(); }); }, CFG.overlapMs + 1500);
    return true;
  }

  /* ---------- U3: PCM from the Vaani Mac app ---------- */
  function wav(list, rate) {
    var n = 0; list.forEach(function (c) { n += c.length; });
    var b = new ArrayBuffer(44 + n * 2), v = new DataView(b), o = 44;
    function str(at, t) { for (var i = 0; i < t.length; i++) v.setUint8(at + i, t.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    list.forEach(function (c) { for (var i = 0; i < c.length; i++, o += 2) v.setInt16(o, c[i], true); });
    return b;
  }
  /* one chunk of samples (Int16Array) in recording order */
  function feed(pcm) {
    var S = R; if (!S || !S.pcm || S.stopped || !pcm || !pcm.length) return;
    var P = S.pcm, i, fl = Math.round(P.rate * FR / 1000);
    /* the same 50 ms meter as a live recording, on the clock of the samples */
    for (var a = 0; a < pcm.length; a += fl) {
      var b = Math.min(pcm.length, a + fl), sum = 0; if (b - a < fl / 2) break;
      for (i = a; i < b; i++) sum += pcm[i] * pcm[i];
      mPush(S.M, (P.pos + b) / P.rate * 1000, Math.sqrt(sum / (b - a)) / 32768);
    }
    P.cur.push(pcm); P.n += pcm.length; P.pos += pcm.length;
    var age = P.n / P.rate * 1000, quiet = age >= CFG.minMs && mPause(S.M, P.pos / P.rate * 1000, age);
    if (age >= CFG.maxMs || quiet) cut(S, false, quiet);
  }
  function cut(S, last, quiet) {
    var P = S.pcm; if (!P.n) return;
    var c = { i: S.chunks.length, s: P.s, e: P.s + P.n / P.rate, st: "queued", tries: 0, wait: 0, pz: P.pz }, endMs = P.pos / P.rate * 1000;
    P.pz = !!quiet;
    if (P.n / P.rate < 0.4) { c.st = "done"; c.res = { segs: [] }; }
    else if (skipOk(S, mSilent(S.M, endMs - P.n / P.rate * 1000, endMs))) { c.st = "done"; c.res = { segs: [] }; c.skip = true; }
    else c.blob = new Blob([wav(P.cur, P.rate)], { type: "audio/wav" });
    S.chunks.push(c);
    if (last) { P.cur = []; P.n = 0; }
    else {
      /* the next piece starts a moment before this one ends, as with the recorder */
      var keep = Math.round(Math.min(P.n, (quiet ? Math.min(CFG.overlapMs, 400) : CFG.overlapMs) / 1000 * P.rate)), tail = new Int16Array(keep), k = keep;
      for (var j = P.cur.length - 1; j >= 0 && k > 0; j--) { var a = P.cur[j], m = Math.min(k, a.length); tail.set(a.subarray(a.length - m), k - m); k -= m; }
      P.cur = [tail]; P.n = keep; P.s = c.e - keep / P.rate;
    }
    capHeld(S); deliver(S); pump(S); state(S);
  }

  /* ---------- sending ---------- */
  /* v2.8: Retry-After, in seconds or as a date; null when absent, unreadable (a cross-origin response shows it only if the
     server exposes it) or nonsense. Capped at raMaxMs so a wild value cannot park a recording. */
  function retryAfter(h) {
    if (h == null || h === "") return null;
    var t = String(h).trim(), ms = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) * 1000 : Date.parse(t) - Date.now();
    return isFinite(ms) && ms >= 0 ? Math.min(CFG.raMaxMs, ms) : null;
  }
  /* how long to wait after the n-th "too many requests" in a row: Retry-After when given, else 2 s doubling to 30 s */
  function rlWait(n, ra) { var b = Math.min(CFG.rlMaxMs, CFG.rlMs * Math.pow(2, Math.max(0, n - 1))) * (0.9 + Math.random() * 0.2); return ra == null ? b : Math.max(ra, CFG.rlMs / 2); }
  function isLimit(status, ra) { return status === 429 || (status === 503 && ra != null); }
  function pump(S) {
    if (R !== S || S.auth) return;
    /* the whole queue waits while Sarvam AI asks for it; after that one piece goes first */
    if (S.pauseUntil && Date.now() < S.pauseUntil) return;
    if (S.pauseUntil) { S.pauseUntil = 0; state(S); }
    while (S.inflight < (S.rl ? 1 : CFG.parallel)) {
      var now = Date.now(), c = null;
      for (var i = 0; i < S.chunks.length; i++) { var x = S.chunks[i]; if (x.st === "queued" && (!x.wait || x.wait <= now)) { c = x; break; } }
      if (!c) break;
      send(S, c);
    }
  }
  function send(S, c) {
    c.st = "sending"; c.sent = Date.now(); S.inflight++;
    var fd = new FormData();
    fd.append("file", c.blob, "vaani-" + c.i + S.ext);
    fd.append("model", "saaras:v4");
    /* audit #16: "mode" applies only to saaras:v3, so it is not sent with saaras:v4 */
    fd.append("language_code", S.lang);
    fd.append("with_timestamps", "true");
    if (!S.noKt && S.kt.length) fd.append("keyterms", JSON.stringify(S.kt));
    var ctl = window.AbortController ? new AbortController() : null, done = false;
    var to = setTimeout(function () { if (ctl) ctl.abort(); fail(); }, CFG.timeoutMs);
    function fin() { if (done) return false; done = true; clearTimeout(to); S.inflight = Math.max(0, S.inflight - 1); return true; }
    function fail() { if (!fin()) return; retry(S, c); }
    fetch(API, { method: "POST", headers: { "api-subscription-key": key() }, body: fd, signal: ctl ? ctl.signal : undefined, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" })
      .then(function (r) { var ra = null; try { ra = retryAfter(r.headers.get("retry-after")); } catch (e) {} return r.text().then(function (t) { var d = null; try { d = JSON.parse(t); } catch (e) {} return { st: r.status, d: d, ra: ra }; }); })
      .then(function (x) { if (!fin()) return; handle(S, c, x.st, x.d, x.ra); }, fail);
  }
  function msgOf(d) { var e = d && d.error; var m = e && (e.message || e.code) || (d && d.detail) || ""; return typeof m === "string" ? m : JSON.stringify(m); }
  function handle(S, c, status, d, ra) {
    if (status >= 200 && status < 300 && d && typeof d === "object") {
      c.res = parse(S, c, d); c.st = "done"; c.blob = null; if (!S.pauseAt || c.sent > S.pauseAt) S.rl = 0;
    } else if (isLimit(status, ra)) { limited(S, c, ra); return;
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
  /* too many requests: nothing is sent until the wait is over. A piece that was already on its way when the wait began
     is put back without a penalty; the piece that met the limit uses one of its tries, so this ends (bounded). */
  /* fix r1 (audit H1). After Stop the person is looking at "finishing" with no button, so the waiting has an end:
     at most rlStopMs (75 s) of slow-down waits in all, and as soon as one piece has run out of tries on "too many
     requests" every piece still waiting fails with it at once (giveUp). finish() then shows Try again / Make notes
     without it / Discard; the audio of the failed pieces stays in memory for Try again. */
  function giveUp(S) {
    S.rlDead = true; S.pauseUntil = 0; clearTimeout(S.rlTo);
    S.chunks.forEach(function (x) { if (x.st === "queued") { x.st = "failed"; x.why = "limit"; x.wait = 0; } });
  }
  function limited(S, c, ra) {
    var now = Date.now();
    if (S.rlDead) { c.st = "failed"; c.why = "limit"; after(S); return; }
    if (!(S.pauseUntil && now < S.pauseUntil && c.sent <= S.pauseAt)) {
      c.tries++;
      var w = rlWait((S.rl || 0) + 1, ra);
      if (c.tries >= CFG.tries || (S.fin && S.rlSpent + w > CFG.rlStopMs)) { c.st = "failed"; c.why = "limit"; if (S.fin) giveUp(S); after(S); return; }
      if (S.fin) S.rlSpent += w;
      S.rl = (S.rl || 0) + 1; S.pauseAt = now; S.pauseUntil = Math.max(S.pauseUntil || 0, now + w);
      clearTimeout(S.rlTo); S.rlTo = setTimeout(function () { pump(S); state(S); }, S.pauseUntil - now + 5);
    }
    /* fix r1 (testing N10c): a piece that waits because Sarvam AI asked for it is not "retrying": the record screen must
       not say "isn't answering" when the wait ends and the piece goes out again */
    c.st = "queued"; c.wait = S.pauseUntil; c.lim = true;
    after(S);
  }
  function retry(S, c) {
    c.tries++;
    if (c.tries >= CFG.tries) { c.st = "failed"; c.why = "net"; after(S); return; }
    var ms = CFG.backoffMs * Math.pow(2, c.tries - 1) * (0.8 + Math.random() * 0.4);
    c.st = "queued"; c.wait = Date.now() + ms; c.lim = false;
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
        /* nothing can be heard twice across a piece of silence, so a word said on both sides of it stays */
        if (c.skip) S.tail = [];
        var out = dedupe(c.res.segs, S.tail, { pause: c.pz }); S.tail = tailOf(S.tail, out);
        if (out.length) S.onSegs(out.map(toSeg));
      } else if (c.st === "failed" || c.st === "lost") S.tail = [];
      else break;
      S.out++;
    }
  }
  function info(S) {
    var q = 0, f = 0, fl = 0, got = 0, retrying = false;
    S.chunks.forEach(function (c) { if (c.st === "queued" || c.st === "sending") q++; if (c.st === "failed") { f++; if (c.why === "limit") fl++; } if (c.st === "done") got++; if (c.st === "queued" && c.tries > 0 && !c.lim) retrying = true; });
    var left = S.pauseUntil ? S.pauseUntil - Date.now() : 0;
    return { engine: "sarvam", waiting: q, failed: f, failedLimit: fl, got: got, retrying: retrying, limited: left > 0, waitS: left > 0 ? Math.ceil(left / 1000) : 0, auth: S.auth, stopped: S.stopped, micLost: !!S.micLost, lost: Math.round(S.lost || 0), skipped: S.skipped || 0 };
  }
  function state(S) {
    if (R !== S) return;
    try { S.onState(info(S)); } catch (e) {}
    finUi(S);
    if (settled(S)) { var w = S.waiters; S.waiters = []; w.forEach(function (f) { f(); }); }
  }
  /* fix r1 (audit H1): the finishing screen says why it is waiting, in the words the record screen uses */
  function finUi(S) {
    if (!S.fin || document.getElementById("sttAsk")) return;
    var sub = document.getElementById("makingSub"), mk = document.getElementById("vMaking"); if (!sub || !mk || mk.hidden) return;
    var left = S.pauseUntil ? Math.ceil((S.pauseUntil - Date.now()) / 1000) : 0;
    if (left > 0) { S.finSaid = true; sub.textContent = "Sarvam AI asked Vaani to slow down. Vaani keeps the audio in this tab and sends it again in about " + left + (left === 1 ? " second" : " seconds") + ". Nothing is lost.";
      /* the seconds count down */
      clearTimeout(S.finTick); S.finTick = setTimeout(function () { if (R === S) finUi(S); }, 1000); }
    else if (S.finSaid) { S.finSaid = false; sub.textContent = S.finSub || "Sarvam AI is turning the last few seconds into text."; }
  }
  function settled(S) { return S.stopped && !S.recs.length && S.inflight === 0 && S.chunks.every(function (c) { return c.st === "done" || c.st === "failed" || c.st === "lost" || (S.auth && c.st === "queued"); }); }

  /* ---------- v2.6: a piece of an uploaded file ---------- */
  /* The same endpoint, key header, model, timeouts, retries and 400 fallbacks as a recorded piece (send, handle, retry above),
     for one WAV piece of a file the person chose (upload.js cuts the file in pauses, each piece under 25 seconds). Resolves
     { segs: [{ s, x }], lang } with s in seconds from the start of the file. Rejects with an Error whose code is "key" (no key or
     language not covered), "auth" (key refused), "bad" (Sarvam AI refused the piece), "net" (still failing after the retries) or
     "aborted" (o.signal). The audio is not kept: nothing holds the Blob once this returns. */
  function coded(code) { var e = new Error(code); e.code = code; return e; }
  var FP = 0;
  function sendFile(blob, o) {
    o = o || {};
    var lang = codeFor(o.lang == null ? V.langSel.value : o.lang), startS = Math.max(0, +o.start || 0);
    if (lang === null || !key() || !window.fetch || !window.FormData) return Promise.reject(coded("key"));
    var sig = o.signal || null, kt = keyterms(), noMode = false, noKt = false, tries = 0, rl = 0;
    function sleep(ms) { return new Promise(function (res, rej) { var t = setTimeout(res, ms); if (sig) sig.addEventListener("abort", function () { clearTimeout(t); rej(coded("aborted")); }, { once: true }); }); }
    function again() {
      tries++;
      if (tries >= CFG.tries) return Promise.reject(coded("net"));
      return sleep(CFG.backoffMs * Math.pow(2, tries - 1) * (0.8 + Math.random() * 0.4)).then(once);
    }
    /* v2.8: too many requests: every piece of the file waits (FP is shared by all sendFile calls), then tries again */
    function slow(ra) {
      tries++; rl++;
      if (tries >= CFG.tries) return Promise.reject(coded("net"));
      FP = Math.max(FP, Date.now() + rlWait(rl, ra)); if (typeof o.onWait === "function") { try { o.onWait(Math.ceil((FP - Date.now()) / 1000)); } catch (e) {} }
      return once();
    }
    function once() {
      if (sig && sig.aborted) return Promise.reject(coded("aborted"));
      if (Date.now() < FP) return sleep(FP - Date.now() + 5).then(once);
      var fd = new FormData();
      fd.append("file", blob, "vaani-upload.wav"); fd.append("model", "saaras:v4");
      fd.append("language_code", lang); fd.append("with_timestamps", "true");
      if (!noKt && kt.length) fd.append("keyterms", JSON.stringify(kt));
      var ctl = new AbortController(), timedOut = false, to = setTimeout(function () { timedOut = true; ctl.abort(); }, CFG.timeoutMs);
      function onAbort() { ctl.abort(); }
      if (sig) sig.addEventListener("abort", onAbort, { once: true });
      function end() { clearTimeout(to); if (sig) sig.removeEventListener("abort", onAbort); }
      return fetch(API, { method: "POST", headers: { "api-subscription-key": key() }, body: fd, signal: ctl.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" })
        .then(function (r) { var ra = null; try { ra = retryAfter(r.headers.get("retry-after")); } catch (e) {} return r.text().then(function (t) { var d = null; try { d = JSON.parse(t); } catch (e) {} return { st: r.status, d: d, ra: ra }; }); })
        .then(function (x) { end(); return x; }, function () { end(); if (sig && sig.aborted && !timedOut) throw coded("aborted"); return { st: 0, d: null }; })
        .then(function (x) {
          var st = x.st, d = x.d;
          if (st >= 200 && st < 300 && d && typeof d === "object") return fileParse(d, startS);
          if (st === 401 || st === 403) throw coded("auth");
          if (isLimit(st, x.ra)) return slow(x.ra);
          if (st === 400 || st === 422) {
            var m = msgOf(d);
            if (!noMode && /\bmode\b/i.test(m)) { noMode = true; return once(); }
            if (!noKt && /keyterm/i.test(m)) { noKt = true; return once(); }
            throw coded("bad");
          }
          return again();
        });
    }
    return once();
  }
  function fileParse(d, startS) {
    var segs = [], ts = d.timestamps, ph = ts && Array.isArray(ts.words) ? ts.words : null, st = ts && Array.isArray(ts.start_time_seconds) ? ts.start_time_seconds : [];
    if (ph && ph.length) ph.forEach(function (w, j) { var x = String(w == null ? "" : w).replace(/\s+/g, " ").trim(); if (x) segs.push({ s: startS + Math.max(0, +st[j] || 0), x: x }); });
    else { var x = String(d.transcript || "").replace(/\s+/g, " ").trim(); if (x) segs.push({ s: startS, x: x }); }
    var lang = typeof d.language_code === "string" && /^[a-z]{2,3}-[A-Z]{2}$/.test(d.language_code) ? d.language_code : null;
    return { segs: segs, lang: lang };
  }

  /* ---------- the end of a recording ---------- */
  /* stop both recorders; resolves once every piece is recorded, so the microphone and call can be released */
  function stop() {
    var S = R; if (!S) return Promise.resolve();
    if (S.pcm) { if (!S.stopped) { cut(S, true, false); S.stopped = true; } quiet(S); state(S); return Promise.resolve(); }
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
    var raw = [], tail = [], gap = 0, bad = 0, from = 0, quietS = 0;
    S.chunks.forEach(function (c) {
      if (c.st === "done") {
        /* fix r1 (audit L5): how much of the recording was judged silent and not sent, so the note can say it */
        if (c.skip) { tail = []; quietS += Math.max(0, c.e - c.s); }
        var r = seam(c.res.segs, tail, { pause: c.pz });
        /* the half word a cut left behind is taken out here, in the text the note is made from */
        if (r.drop && raw.length > from) { dropLast(raw, from); tail = tail.slice(0, -1); }
        if (r.segs.length) from = raw.length;
        tail = tailOf(tail, r.segs); r.segs.forEach(function (s) { raw.push(s); });
      }
      else { gap += Math.max(0, c.e - c.s); if (c.st !== "lost") bad++; tail = []; from = raw.length; }
    });
    var segs = raw.map(toSeg);
    var lang = null;
    if (S.lang === "unknown") {
      var best = "", n = 0; Object.keys(S.langs).forEach(function (k) { if (S.langs[k] > n) { n = S.langs[k]; best = k; } });
      if (best === "ur-IN") best = "ur-PK";
      if (best && V.LANGS.some(function (l) { return l[0] === best; })) lang = best;
    }
    return { segs: segs, gap: Math.round(gap), bad: bad, lost: Math.round(S.lost || 0), auth: S.auth, lang: lang, quiet: Math.round(quietS), limit: S.chunks.some(function (c) { return c.st === "failed" && c.why === "limit"; }) };
  }
  /* waits for every piece; if some could not be transcribed, asks: try again, keep what is there, or discard.
     The audio stays in memory until then. Resolves { segs, lang, gap, drop }. */
  function finish() {
    var S = R; if (!S) return Promise.resolve({ segs: [], lang: null, gap: 0, drop: false });
    S.chunks.forEach(function (c) { if (c.st === "failed") { c.st = "queued"; c.tries = Math.max(0, CFG.tries - 2); c.wait = 0; } });
    /* from here the slow-down waits are counted (limited); a wait already running at Stop counts too, and is cut to the cap */
    function began() { var now = Date.now(); S.fin = now; S.rlDead = false; S.rlSpent = 0; if (S.pauseUntil > now) { S.pauseUntil = Math.min(S.pauseUntil, now + CFG.rlStopMs); S.rlSpent = S.pauseUntil - now; clearTimeout(S.rlTo); S.rlTo = setTimeout(function () { pump(S); state(S); }, S.pauseUntil - now + 5); S.chunks.forEach(function (c) { if (c.st === "queued" && c.wait > S.pauseUntil) c.wait = S.pauseUntil; }); } }
    began();
    pump(S); state(S);
    function loop() {
      return drain(S).then(function () {
        var r = collect(S);
        if (!r.bad || R !== S) return r;
        return ask(r).then(function (a) {
          if (a === "retry" && enabled() && key()) {
            S.auth = false;
            S.chunks.forEach(function (c) { if (c.st === "failed" || c.st === "queued") { c.st = "queued"; c.tries = 0; c.wait = 0; } });
            S.rl = 0; S.pauseUntil = 0; began();
            busyUi(true); S.finSub = "Vaani still has the audio, in memory only."; pump(S); state(S); return loop();
          }
          if (a === "retry") return loop(); /* switched to This browser meanwhile: ask again, without Try again */
          r.drop = a === "drop"; if (a === "keep") r.gap = Math.max(1, r.gap); return r;
        });
      });
    }
    return loop();
  }
  function reset() { var S = R; R = null; if (S) { S.stopped = true; clearTimeout(S.rlTo); S.recs.forEach(function (r) { try { r.mr.ondataavailable = null; r.mr.onstop = null; if (r.mr.state !== "inactive") r.mr.stop(); } catch (e) {} }); quiet(S); S.chunks.forEach(function (c) { c.blob = null; }); } askBox(null); }
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
      else if (r.limit) { $id("makingH").textContent = have ? "Part of the recording isn’t transcribed" : "The recording isn’t transcribed"; $id("makingSub").textContent = "Sarvam AI asked Vaani to slow down (too many requests), so " + secsLabel(r.gap - (r.lost || 0)) + " of the recording isn’t text yet. Vaani still has that audio, in memory only. Wait a minute, then try again. If you close this page, it’s gone." + lost; }
      else { $id("makingH").textContent = have ? "Part of the recording isn’t transcribed" : "The recording isn’t transcribed"; $id("makingSub").textContent = "Sarvam AI couldn’t turn " + secsLabel(r.gap - (r.lost || 0)) + " of the recording into text. Vaani still has that audio, in memory only, so you can try again. If you close this page, it’s gone." + lost; }
      /* fix r2: lines typed under My notes are never dropped with the recording; the choice says so */
      var box = document.createElement("div"); box.className = "stt-ask"; box.id = "sttAsk";
      box.setAttribute("role", "group"); box.setAttribute("aria-labelledby", "makingH"); box.setAttribute("aria-describedby", "makingSub");
      /* fix r3 (creative): ...on its own line above the buttons, in the ink colour */
      if (V.padKeep) { var pk = document.createElement("p"); pk.className = "stt-keep"; pk.id = "sttKeep"; pk.textContent = V.padKeep; box.appendChild(pk); box.setAttribute("aria-describedby", "makingSub sttKeep"); }
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

  window.VaaniSTT = { sendFile: sendFile, usable: usable, hasKey: function () { return !!key(); }, enabled: enabled, supported: supported, codeFor: codeFor, start: start, useTrack: useTrack, feed: feed, stop: stop, finish: finish, reset: reset, busy: busy, keyterms: keyterms, _dedupe: dedupe, _seam: seam };
  if (V.syncRecBtn) V.syncRecBtn();
})();
