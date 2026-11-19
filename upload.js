/* Vaani upload.js (v2.6): make notes from an audio or video file.
   Stages, all in this browser: check the file, read the sound (decoded to 16 kHz mono with the browser's own decoder, no ffmpeg),
   cut it in pauses into pieces of under 25 seconds, turn each piece into text, then Vaani writes the notes as for a recording.
   - With a Sarvam AI key (and a language Sarvam AI covers) each piece goes through VaaniSTT.sendFile (stt.js): same endpoint,
     key header, retries and key terms as a live recording, two pieces at a time. Nothing goes to Vaani.
   - Without one, a browser that can feed a file to its own speech engine (SpeechRecognition.start with an audio track) is used,
     at the speed of the recording. Other browsers are told to add a Sarvam AI key. This path could not be tested here.
   - The file is never saved or uploaded to Vaani; the decoded sound is dropped as soon as the pieces are cut. Cancel (or closing
     the window) stops every request. A screen wake lock is held while it works, where the browser allows.
   - v2.8: before the file is read into memory, Vaani works out how much room the decoded sound needs (length x channels,
     the channel count read from the file's header) and refuses a recording this device cannot hold, with a plain message,
     instead of letting the tab be killed. A quiet recording (peak under 0.1) is made louder as its pieces are written,
     by one gain for the whole file, never past half scale (after silverstein/minutes whisper-guard normalize_audio, MIT).
   Ideas adapted from Meetily's audio import (Zackriya-Solutions/meeting-minutes, MIT: stages with progress, one run at a time, cancel
   between steps, split long speech at the quietest moment before the limit) and from transformers.js-examples
   (huggingface/transformers.js-examples, Apache-2.0, whisper-word-timestamps MediaInput: decodeAudioData, mix to mono). See NOTICE. */
(function () {
  "use strict";
  var V = window.Vaani, S = window.VaaniSTT;
  if (!V) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var EXT = /\.(mp3|m4a|wav|ogg|oga|opus|webm|mp4|m4v|mov|flac|aac|mkv|3gp)$/i;
  var MAXB = 150 * 1024 * 1024, MAXSEC = 7200, MAXBROWSER = 1800;
  var SR = 16000, PIECE = { min: 18, max: 25 }, PAR = 2;
  var panel = $("#upPanel"), sheet = $("#upSheet"), fileIn = $("#upFile"), run = null;

  /* ---------- small helpers ---------- */
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, act) { var b = h("button", cls, text); b.type = "button"; if (act) b.setAttribute("data-u", act); return b; }
  function mins(sec) { sec = Math.max(1, Math.round(sec)); return sec < 60 ? sec + " s" : Math.floor(sec / 60) + " min" + (sec % 60 >= 30 ? " 30 s" : ""); }
  function size(b) { return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB"; }
  function engine() {
    var lang = V.langSel.value, sarvam = !!(S && S.hasKey() && S.enabled() && S.codeFor(lang) !== null);
    if (sarvam) return "sarvam";
    var C = window.SpeechRecognition;
    /* SpeechRecognition.available() ships together with start(audioTrack); an older Chrome would ignore the track and listen to the microphone */
    if (C && typeof C.available === "function" && window.MediaStreamTrack) return "browser";
    return "none";
  }
  function langLabel() { var l = V.langSel; return l.options[l.selectedIndex].text; }
  function styleLabel() { var t = V.tmplSel; return t.options[t.selectedIndex].text; }

  /* ---------- the window ---------- */
  function open() {
    if (run) { V.openSheet("#upSheet"); return; }
    META = null; /* audit L5: an ordinary upload never inherits a kept recording's meeting */
    if (V.isListening() || (S && S.busy())) { V.toast("Finish the recording that is running first."); return; }
    chooser(); V.openSheet("#upSheet");
  }
  function chooser(msg) {
    panel.textContent = "";
    var hh = h("h2", null, "Make notes from a recording"); hh.id = "upH"; panel.appendChild(hh);
    panel.appendChild(h("p", "sub", "Choose an audio or video file of a meeting or call. Vaani listens to it and writes the notes, like it does for a live recording."));
    var e = engine(), box = h("div", "up-facts");
    function row(k, v) { var r = h("div", "up-row"); r.appendChild(h("span", "up-k", k)); r.appendChild(h("span", "up-v", v)); box.appendChild(r); }
    row("Speech to text", e === "sarvam" ? "Sarvam AI, with your key" : e === "browser" ? "This browser, at the speed of the recording" : "Needs a Sarvam AI key");
    row("Spoken language", langLabel() + (/^en-/.test(V.langSel.value) ? ", detected" : ""));
    row("Notes style", styleLabel());
    panel.appendChild(box);
    panel.appendChild(h("p", "hint", e === "sarvam" ? "The sound goes from this browser straight to Sarvam AI, in pieces of under 25 seconds. Nothing goes to Vaani and the file is not saved." : e === "browser" ? "Chrome plays the file to its own speech engine, which may send the sound to Google. Nothing goes to Vaani and the file is not saved." : "Your browser can’t read a file on its own. Add a Sarvam AI key in Settings, and Vaani can. MP3, M4A, WAV, OGG, WebM and MP4 files work, up to 150 MB and 2 hours."));
    if (msg) { var m = h("p", "hint up-err", msg); m.setAttribute("role", "alert"); panel.appendChild(m); }
    if (e === "none") { var st = btn("done-btn", "Open Settings", "settings"); panel.appendChild(st); }
    else { var ch = btn("done-btn", "Choose a file", "choose"); panel.appendChild(ch); }
    panel.appendChild(btn("cancel", "Cancel", "close"));
  }
  function progress(stage, pct, note, bar) {
    if (!run) return;
    var st = $("#upStage"), pb = $("#upBar"), nt = $("#upNote");
    if (st) st.textContent = stage; if (nt) nt.textContent = note || "";
    if (pb) { pb.value = Math.max(0, Math.min(100, Math.round(pct))); pb.setAttribute("aria-valuetext", stage + ", " + Math.round(pct) + " percent"); pb.hidden = bar === false; }
  }
  function working(name) {
    panel.textContent = "";
    var hh = h("h2", null, "Making notes"); hh.id = "upH"; panel.appendChild(hh);
    panel.appendChild(h("p", "sub up-file", name));
    var st = h("p", "up-stage"); st.id = "upStage"; st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite"); panel.appendChild(st);
    var pb = h("progress", "up-bar"); pb.id = "upBar"; pb.max = 100; pb.value = 0; pb.setAttribute("aria-label", "Progress"); panel.appendChild(pb);
    var nt = h("p", "hint up-note"); nt.id = "upNote"; panel.appendChild(nt);
    panel.appendChild(btn("cancel up-cancel", "Cancel", "cancel"));
  }
  function ask(title, sub, buttons) {
    panel.textContent = "";
    var hh = h("h2", null, title); hh.id = "upH"; panel.appendChild(hh);
    panel.appendChild(h("p", "sub", sub));
    buttons.forEach(function (b, i) { var x = btn(i === 0 ? "done-btn" : "btn-wide", b[1], b[0]); panel.appendChild(x); });
    setTimeout(function () { var f = panel.querySelector("button"); if (f) f.focus(); }, 40);
  }

  /* ---------- the file ---------- */
  function check(f) {
    if (!f) return "Choose a file first.";
    if (!EXT.test(f.name || "") && !/^(audio|video)\//.test(f.type || "")) return "That doesn’t look like an audio or video file. Try MP3, M4A, WAV, OGG, WebM or MP4.";
    if (!f.size) return "That file is empty.";
    if (f.size > MAXB) return "That file is " + size(f.size) + ". Vaani reads files up to 150 MB. Save it as MP3 or M4A and try again.";
    return "";
  }
  /* the length is read from the file header (an audio or video element) before the file is decoded, so a 20-hour file is
     refused without allocating anything. If the browser cannot tell, a size cap stands in for it. */
  var NOMETA = 64 * 1024 * 1024;
  function probe(f) {
    return new Promise(function (res) {
      var u, a = document.createElement(/^video\//.test(f.type || "") || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name || "") ? "video" : "audio"), done = false, t;
      function end(v) { if (done) return; done = true; clearTimeout(t); try { a.removeAttribute("src"); a.load(); } catch (e) {} if (u) try { URL.revokeObjectURL(u); } catch (e) {} res(v); }
      try { a.preload = "metadata"; a.muted = true; a.onloadedmetadata = function () { end(isFinite(a.duration) && a.duration > 0 ? a.duration : 0); }; a.onerror = function () { end(0); }; t = setTimeout(function () { end(0); }, 5000); u = URL.createObjectURL(f); a.src = u; } catch (e) { end(0); }
    });
  }
  /* ---------- v2.8: will the decoded sound fit in this device's memory? ----------
     The browser's decoder gives back every channel of the file at 16 kHz as 32-bit floats before Vaani can mix them down:
     2 hours of stereo is about 920 MB on top of the file itself, and a phone's tab is killed long before that (the page
     reloads, with no message). The channel count is read from the first bytes of the file (WAV, MP3, AAC, M4A/MP4/MOV,
     Ogg Opus/Vorbis, FLAC, WebM/MKV); when it cannot be read, two channels are assumed. */
  function tag(b, o, t) { for (var i = 0; i < t.length; i++) if (b[o + i] !== t.charCodeAt(i)) return false; return true; }
  function find(b, t, from) { for (var i = from || 0, n = b.length - t.length; i <= n; i++) if (b[i] === t.charCodeAt(0) && tag(b, i, t)) return i; return -1; }
  var MP3BR = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]], MP3SR = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];
  /* the length in bytes of the MPEG audio (layer III) or ADTS AAC frame at o, and its channels; null when there is none */
  function frame(b, o) {
    if (o + 7 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
    var ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3;
    if (layer === 0) { /* ADTS */
      if ((b[o + 1] & 0xf0) !== 0xf0) return null;
      var len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5), cc = ((b[o + 2] & 1) << 2) | (b[o + 3] >> 6);
      return len > 7 ? { len: len, ch: cc === 7 ? 8 : cc } : null;
    }
    var bi = b[o + 2] >> 4, si = (b[o + 2] >> 2) & 3;
    if (layer !== 1 || ver === 1 || bi === 0 || bi === 15 || si === 3) return null;
    var sr = MP3SR[ver][si], br = MP3BR[ver === 3 ? 0 : 1][bi] * 1000;
    return { len: Math.floor((ver === 3 ? 144 : 72) * br / sr) + ((b[o + 2] >> 1) & 1), ch: (b[o + 3] >> 6) === 3 ? 1 : 2 };
  }
  /* channels in a run of bytes from the start of a file (0: not known), and for WAV the length in seconds */
  function channelsOf(b, size) {
    var i, r = { ch: 0, sec: 0 };
    if (b.length < 12) return r;
    if (tag(b, 0, "RIFF") && tag(b, 8, "WAVE")) {
      var o = 12, rate = 0;
      while (o + 8 <= b.length) {
        var n = (b[o + 4] | b[o + 5] << 8 | b[o + 6] << 16 | b[o + 7] << 24) >>> 0;
        if (tag(b, o, "fmt ") && o + 20 <= b.length) { r.ch = b[o + 10] | b[o + 11] << 8; rate = (b[o + 16] | b[o + 17] << 8 | b[o + 18] << 16 | b[o + 19] << 24) >>> 0; }
        else if (tag(b, o, "data")) { if (rate) r.sec = Math.min(n, Math.max(0, (size || 0) - o - 8) || n) / rate; break; }
        o += 8 + n + (n & 1);
      }
    } else if (tag(b, 0, "OggS")) {
      if ((i = find(b, "OpusHead")) >= 0 && i + 9 < b.length) r.ch = b[i + 9];
      else if ((i = find(b, "\u0001vorbis")) >= 0 && i + 11 < b.length) r.ch = b[i + 11];
    } else if (tag(b, 0, "fLaC") && b.length > 21) r.ch = ((b[20] >> 1) & 7) + 1;
    else if (tag(b, 4, "ftyp")) {
      for (i = find(b, "stsd"); i >= 0 && !r.ch; i = find(b, "stsd", i + 4)) if (i + 38 <= b.length && /^(mp4a|Opus|alac|ac-3|ec-3|fLaC|sowt|twos|lpcm)$/.test(String.fromCharCode(b[i + 16], b[i + 17], b[i + 18], b[i + 19]))) r.ch = b[i + 36] << 8 | b[i + 37];
    } else if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      /* Matroska / WebM: the Channels element (9F, one byte) inside the Audio element (E1), after SamplingFrequency (B5) */
      for (i = 12; i + 2 < b.length && !r.ch; i++) if (b[i] === 0x9f && b[i + 1] === 0x81 && ((b[i - 6] === 0xb5 && b[i - 5] === 0x84) || (b[i - 10] === 0xb5 && b[i - 9] === 0x88) || b[i - 2] === 0xe1)) r.ch = b[i + 2];
    } else {
      /* MP3 or raw AAC: two frames in a row that agree */
      for (i = 0; i + 8 < b.length && !r.ch; i++) { var f1 = frame(b, i), f2 = f1 && frame(b, i + f1.len); if (f1 && f2 && f1.ch === f2.ch) r.ch = f1.ch; }
    }
    if (!(r.ch >= 1 && r.ch <= 8)) r.ch = 0;
    return r;
  }
  function bytes(f, a, n) { return f.slice(a, Math.min(f.size, a + n)).arrayBuffer().then(function (ab) { return new Uint8Array(ab); }, function () { return new Uint8Array(0); }); }
  function sniff(f) {
    var HEAD = 262144;
    return bytes(f, 0, HEAD).then(function (b) {
      /* an MP3 may open with a large ID3v2 tag (cover art): look after it */
      if (tag(b, 0, "ID3") && b.length > 10) { var skip = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127)); return bytes(f, skip, 16384).then(function (m) { return channelsOf(m, 0); }); }
      var r = channelsOf(b, f.size);
      /* an MP4 written for recording keeps its index at the end */
      if (!r.ch && tag(b, 4, "ftyp") && f.size > HEAD) return bytes(f, Math.max(0, f.size - HEAD * 2), HEAD * 2).then(function (t) { var o = find(t, "stsd"), x = { ch: 0, sec: 0 }; for (; o >= 0 && !x.ch; o = find(t, "stsd", o + 4)) if (o + 38 <= t.length && /^(mp4a|Opus|alac|ac-3|ec-3|fLaC|sowt|twos|lpcm)$/.test(String.fromCharCode(t[o + 16], t[o + 17], t[o + 18], t[o + 19]))) x.ch = t[o + 36] << 8 | t[o + 37]; if (!(x.ch >= 1 && x.ch <= 8)) x.ch = 0; return x; });
      return r;
    });
  }
  /* a quarter of the device's memory (Chrome reports it, at most 8 GB); where it is not reported, 4 GB for a phone or tablet, 8 GB otherwise */
  function memCap() { var dm = +navigator.deviceMemory; if (!(dm > 0)) dm = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ? 4 : 8; return dm * 1073741824 * 0.25; }
  function memErr(f, ch) { var e = coded("mem"); e.fit = Math.floor((memCap() - f.size) / (SR * 4 * ch) / 60); return e; }
  function decode(f) {
    var need = 0, chs = 2;
    return Promise.all([probe(f), sniff(f)]).then(function (a) {
      var len = a[0] || a[1].sec; chs = a[1].ch || 2;
      if (len > MAXSEC) throw coded("long");
      if (!len && f.size > NOMETA) throw coded("long");
      need = len * SR * 4 * chs + f.size;
      if (len && need > memCap()) throw memErr(f, chs);
      return f.arrayBuffer();
    }).then(function (ab) {
      var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!AC) throw new Error("decode");
      var ctx = new AC(1, 1, SR);
      return new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); ab = null; })
        /* a decoder that gives up on a long file ran out of room: say that, not "save it as MP3" */
        .then(null, function (e) { if (need > 268435456) throw memErr(f, chs); throw e; });
    }).then(function (buf) {
      var n = buf.length, ch = buf.numberOfChannels, rate = buf.sampleRate;
      if (n / rate > MAXSEC) throw coded("long");
      /* mixed down inside the first channel's own memory: no second full-size copy; the other channels can be freed */
      var out = buf.getChannelData(0);
      if (ch > 1) { var rest = []; for (var c = 1; c < ch; c++) rest.push(buf.getChannelData(c)); for (var i = 0; i < n; i++) { var x = out[i]; for (var k = 0; k < rest.length; k++) x += rest[k][i]; out[i] = x / ch; } rest = null; }
      buf = null;
      return { pcm: out, rate: rate };
    });
  }
  /* cut points: pieces of 18 to 25 seconds, each cut at the quietest tenth of a second before the 25 s limit, so a word is
     rarely split (Meetily searched both sides of the target, which let a piece run past its limit; this looks only before it) */
  function cuts(pcm, rate) {
    var n = pcm.length, min = Math.round(PIECE.min * rate), max = Math.round(PIECE.max * rate), blk = Math.round(rate / 100), win = 10, out = [], pos = 0;
    while (pos < n) {
      if (n - pos <= max) { out.push([pos, n]); break; }
      var from = pos + min, to = pos + max - win * blk, nb = Math.max(1, Math.floor((to - from) / blk) + win), e = new Float64Array(nb);
      for (var b = 0; b < nb; b++) { var s0 = from + b * blk, sum = 0, end = Math.min(n, s0 + blk); for (var i = s0; i < end; i++) sum += pcm[i] * pcm[i]; e[b] = sum; }
      var acc = 0, best = Infinity, at = 0;
      for (var k = 0; k < win && k < nb; k++) acc += e[k];
      for (var w = 0; w + win <= nb; w++) { if (acc < best) { best = acc; at = w; } acc += (e[w + win] || 0) - e[w]; }
      var cut = Math.min(n, from + at * blk + Math.floor(win * blk / 2));
      out.push([pos, cut]); pos = cut;
    }
    return out;
  }
  function rms(pcm, a, b) { var s = 0, c = 0; for (var i = a; i < b; i += 4) { s += pcm[i] * pcm[i]; c++; } return c ? Math.sqrt(s / c) : 0; }
  /* v2.8: one gentle gain for a quiet file. Peak under 0.1 (a phone on a table): raised to half scale, at most 20 times.
     A file with almost nothing in it (peak under 0.0005) is left alone, so noise is not turned into sound. */
  function gainOf(pcm) { var pk = 0; for (var i = 0, n = pcm.length; i < n; i++) { var x = pcm[i]; if (x < 0) x = -x; if (x > pk) pk = x; } return pk > 0.0005 && pk < 0.1 ? Math.min(0.5 / pk, 20) : 1; }
  /* 16-bit mono PCM WAV */
  function wav(pcm, a, b, rate, g) {
    g = g > 1 ? g : 1;
    var n = b - a, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, pcm[a + i] * g)); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }

  /* ---------- the run ---------- */
  function start(f) {
    var bad = check(f); if (bad) { META = null; chooser(bad); return; }
    var eng = engine(); if (eng === "none") { META = null; chooser(); return; }
    var R = run = { ctl: new AbortController(), eng: eng, lock: null, dead: false };
    working(f.name);
    progress("Checking the file", 3, size(f.size) + ". It stays on this device.");
    try { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request("screen").then(function (l) { if (run === R) R.lock = l; else l.release(); }, function () {}); } catch (e) {}
    function live() { if (R.dead || run !== R) throw new Error("aborted"); }
    progress("Reading the sound", 6, "Decoding happens in your browser. A long file takes a little while.");
    decode(f).then(function (d) {
      live();
      var sec = d.pcm.length / d.rate;
      if (sec < 1) throw coded("short");
      if (sec > MAXSEC) throw coded("long");
      if (eng === "browser" && sec > MAXBROWSER) throw coded("longb");
      return eng === "sarvam" ? viaSarvam(R, d, f, live) : viaBrowser(R, d, live);
    }).then(function (r) { live(); finish(R, f, r); }, function (e) { fail(R, e); });
  }
  function coded(c) { var e = new Error(c); e.code = c; return e; }
  function viaSarvam(R, d, f, live) {
    var parts = cuts(d.pcm, d.rate), total = d.pcm.length / d.rate, res = new Array(parts.length), next = 0, done = 0, failed = [], langs = {}, auth = false;
    var jobs = parts.map(function (p, i) { return { i: i, a: p[0], b: p[1], s: p[0] / d.rate }; });
    /* the silent-piece bar follows the gain, so a quiet recording's speech is not taken for silence */
    var gain = gainOf(d.pcm), bar = gain > 1 ? Math.max(0.0003, 0.0015 / gain) : 0.0015;
    function one(j) {
      if (rms(d.pcm, j.a, j.b) < bar || j.b - j.a < d.rate * 0.4) { res[j.i] = { segs: [] }; return Promise.resolve(); }
      /* v2.8: when Sarvam AI says "too many requests", every piece waits (stt.js) and the window says so */
      function onWait(sec) { R.slow = Date.now() + sec * 1000; R.slowNote = "Sarvam AI asked Vaani to slow down. Waiting " + sec + (sec === 1 ? " second" : " seconds") + ", then it carries on."; var nt = $("#upNote"); if (run === R && nt) nt.textContent = R.slowNote; }
      return S.sendFile(wav(d.pcm, j.a, j.b, d.rate, gain), { start: j.s, signal: R.ctl.signal, onWait: onWait }).then(function (r) { res[j.i] = r; if (r.lang) langs[r.lang] = (langs[r.lang] || 0) + r.segs.length; }, function (e) {
        if (e && e.code === "aborted") throw e;
        if (e && e.code === "auth") auth = true;
        failed.push(j); res[j.i] = { segs: [] };
      });
    }
    function worker() {
      if (next >= jobs.length || auth) return Promise.resolve();
      var j = jobs[next++];
      return one(j).then(function () { live(); done++; progress("Turning speech into text", 12 + done / jobs.length * 78, R.slow > Date.now() ? R.slowNote : "Part " + Math.min(done + 1, jobs.length) + " of " + jobs.length + ". " + mins(total) + " of sound in all."); return worker(); });
    }
    function pass() { next = 0; var ws = []; for (var k = 0; k < PAR; k++) ws.push(worker()); return Promise.all(ws); }
    progress("Turning speech into text", 12, "Part 1 of " + jobs.length + ". " + mins(total) + " of sound in all.");
    return pass().then(function () {
      if (failed.length && !auth) { jobs = failed.slice(); failed = []; done = parts.length - jobs.length; return pass(); }
    }).then(function () {
      live();
      var segs = []; res.forEach(function (r) { if (r) r.segs.forEach(function (s) { segs.push(s); }); });
      var best = "", n = 0; Object.keys(langs).forEach(function (k) { if (langs[k] > n) { n = langs[k]; best = k; } });
      var gap = 0; failed.forEach(function (j) { gap += (j.b - j.a) / d.rate; });
      var out = { segs: segs, dur: total, lang: best, gap: Math.round(gap), auth: auth, sarvam: true, failed: failed.length };
      d.pcm = null; return out;
    });
  }
  function viaBrowser(R, d, live) {
    return new Promise(function (resolve, reject) {
      var C = window.SpeechRecognition, total = d.pcm.length / d.rate, ac, rec, src, segs = [], t0 = 0, finished = false;
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        var buf = ac.createBuffer(1, d.pcm.length, d.rate); buf.copyToChannel(d.pcm, 0); d.pcm = null;
        var dest = ac.createMediaStreamDestination(); src = ac.createBufferSource(); src.buffer = buf; src.connect(dest);
        rec = new C(); rec.continuous = true; rec.interimResults = false; rec.lang = V.langSel.value;
        var track = dest.stream.getAudioTracks()[0];
        rec.onresult = function (ev) { for (var i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) { var x = String(ev.results[i][0].transcript || "").replace(/\s+/g, " ").trim(); if (x) segs.push({ s: Math.max(0, ac.currentTime - t0), x: x }); } };
        rec.onerror = function (ev) { if (ev && ev.error === "not-allowed") end(coded("browser")); };
        rec.onend = function () { end(); };
        R.stop = function () { try { rec.abort(); } catch (e) {} try { src.stop(); } catch (e) {} end(new Error("aborted")); };
        src.onended = function () { setTimeout(function () { try { rec.stop(); } catch (e) {} }, 1500); };
        t0 = ac.currentTime; rec.start(track); src.start();
        var iv = setInterval(function () { if (finished) return clearInterval(iv); progress("Listening to the recording", 10 + Math.min(1, (ac.currentTime - t0) / total) * 80, "In this browser the file plays at its own speed: " + mins(Math.max(0, total - (ac.currentTime - t0))) + " left."); }, 500);
      } catch (e) { end(coded("browser")); }
      function end(err) { if (finished) return; finished = true; try { if (ac) ac.close(); } catch (e) {} err ? reject(err) : resolve({ segs: segs, dur: total, lang: "", gap: 0, auth: false, sarvam: false, failed: 0 }); }
    });
  }
  function release(R) { if (R.lock) { try { R.lock.release(); } catch (e) {} R.lock = null; } }
  function fail(R, e) {
    release(R); if (run === R) run = null; META = null;
    var c = e && e.code;
    if (e && e.message === "aborted") return;
    var msg = c === "short" ? "That file has almost no sound in it." : c === "mem" ? "That recording is too long for this device to read in one go" + (e.fit >= 1 ? " (about " + mins(e.fit * 60) + " of it would fit)" : "") + ". Try it on a computer, or cut it into shorter parts." : c === "long" ? "That recording is longer than 2 hours, or too big for Vaani to check. Vaani reads up to 2 hours at a time. Cut it and try again." : c === "longb" ? "That recording is longer than 30 minutes. This browser can only play it at its own speed, so add a Sarvam AI key in Settings for longer files." : c === "browser" ? "This browser couldn’t listen to the file. Add a Sarvam AI key in Settings, and Vaani can read it." : c === "key" ? "Vaani needs a Sarvam AI key for this language. Add one in Settings." : "Vaani couldn’t read the sound in this file. Try saving it as MP3, M4A, WAV or MP4, or choose another file.";
    chooser(msg);
  }
  function finish(R, f, r) {
    release(R); if (run === R) run = null;
    var have = r.segs.length > 0;
    if (r.auth) { keep = have ? { r: r, f: f } : null; ask("Sarvam AI didn’t accept your key", "Nothing more was sent. Check your Sarvam AI key in Settings, then choose the file again.", (have ? [["notes", "Make notes with the part that was read"]] : []).concat([["settings", "Open Settings"], ["close", "Close"]])); return; }
    if (!have) { chooser(r.failed ? "Sarvam AI couldn’t turn this file into text. Check your connection and try again." : "Vaani didn’t hear any words in that file. Check that it has speech in the language set on the start screen."); return; }
    if (r.failed) { keep = { r: r, f: f }; ask("Part of the file isn’t transcribed", "Sarvam AI couldn’t read about " + mins(r.gap) + " of it, even after trying again. You can make notes with the rest, or discard.", [["notes", "Make notes without it"], ["close", "Discard"]]); return; }
    make(r, f);
  }
  var keep = null, META = null;
  function make(r, f) {
    var segs = r.segs.map(function (s) { return { t: V.fmt(Math.max(0, Math.floor(s.s))), x: s.x }; });
    var w = V.words(segs.map(function (s) { return s.x; }).join(" "));
    if (!w) { chooser("Vaani didn’t hear any words in that file."); return; }
    var lang = r.lang && V.langSel.querySelector('option[value="' + r.lang + '"]') ? r.lang : V.langSel.value;
    var n = { id: Date.now(), kind: "meeting", date: new Date().toISOString(), dur: Math.round(r.dur), lang: lang, tmpl: V.tmplKey(), tpl: V.tmplSnap() || undefined, segs: segs, title: V.titleOf(segs), md: "", done: {}, words: w };
    if (r.sarvam) n.stt = "sarvam"; if (r.gap) n.gap = r.gap;
    /* v2.7: a recording Vaani kept in this tab (index.html keep*) carries its meeting's title and calendar event over */
    var mt = META; META = null;
    if (mt) { if (mt.title) n.title = String(mt.title).slice(0, 200); if (mt.cal && typeof mt.cal === "object") n.cal = mt.cal; if (mt.call) n.call = true; if (/^(meet|teams|zoom)$/.test(mt.src || "")) n.src = mt.src; }
    if (window.VaaniHook) VaaniHook("beforeSave", n);
    keep = null; V.upsert(n); V.setCurrentId(n.id); V.closeSheets(); V.makeNotes(n);
  }
  function cancel() {
    var R = run; if (!R) return;
    R.dead = true; try { R.ctl.abort(); } catch (e) {} if (R.stop) R.stop(); release(R); run = null; META = null;
    V.toast("Cancelled. Nothing was saved.");
    if (!sheet.hidden) chooser();
  }

  panel.addEventListener("click", function (e) {
    var b = e.target.closest("[data-u]"); if (!b) return; var a = b.getAttribute("data-u");
    if (a === "choose") { fileIn.value = ""; fileIn.click(); }
    else if (a === "cancel") cancel();
    else if (a === "close") { keep = null; META = null; V.closeSheets(); }
    else if (a === "settings") { keep = null; V.closeSheets(); setTimeout(function () { var s = document.querySelector('[data-open="settings"]'); if (s) s.click(); }, 0); }
    else if (a === "notes" && keep) make(keep.r, keep.f);
  });
  fileIn.addEventListener("change", function () { var f = fileIn.files && fileIn.files[0]; if (f) start(f); });
  /* closing the window (Escape, the backdrop, another sheet) while it works is the same as Cancel */
  try { new MutationObserver(function () { if (sheet.hidden && run) cancel(); }).observe(sheet, { attributes: true, attributeFilter: ["hidden"] }); } catch (e) {}
  window.addEventListener("beforeunload", function (e) { if (run) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------- the button on the start screen ---------- */
  function addBtn() {
    var host = $(".hm-opts"); if (!host || $("#upBtn")) return !!$("#upBtn");
    /* v2.7: the same outlined pill as the pickers beside it, ink text and an upload glyph */
    var b = h("button", "up-pill"); b.type = "button"; b.id = "upBtn"; b.setAttribute("aria-haspopup", "dialog");
    /* v2.8 (security C11): the glyph and label are built as elements, never from a markup string */
    var NS = "http://www.w3.org/2000/svg", sv = document.createElementNS(NS, "svg"), pa = document.createElementNS(NS, "path");
    [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]].forEach(function (a) { sv.setAttribute(a[0], a[1]); });
    pa.setAttribute("d", "M12 16V4M7 9l5-5 5 5M5 20h14"); sv.appendChild(pa); b.appendChild(sv); b.appendChild(h("span", "", "Upload a recording"));
    host.appendChild(b); b.addEventListener("click", open); return true;
  }
  if (!addBtn()) { var t = 0, iv = setInterval(function () { if (addBtn() || ++t > 40) clearInterval(iv); }, 100); }
  /* v2.7: the audio Vaani kept in this tab during a recording (index.html keep*): the same stages as a chosen file */
  function fromBlob(blob, name, meta) {
    if (run) { V.openSheet("#upSheet"); return; }
    if (V.isListening() || (S && S.busy())) { V.toast("Finish the recording that is running first."); return; }
    var f; try { f = new File([blob], name, { type: (blob.type || "audio/webm").split(";")[0] }); } catch (e) { return; }
    META = meta || null; V.openSheet("#upSheet"); start(f);
  }
  window.VaaniUpload = { open: open, cuts: cuts, engine: engine, fromBlob: fromBlob, _channels: channelsOf, _sniff: sniff, _gain: gainOf };
})();
