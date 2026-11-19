/* Vaani 1.3.0: spots a live call in this tab (Google Meet, Microsoft Teams or Zoom in the browser) and offers to take notes.
   How it knows, and nothing more is read:
   - the meeting's own address (a Meet code such as /abc-defg-hij, Zoom's /wc/<number>, or a Teams page),
   - the call's hang-up button, found by the app's own ids and icon name (any language) or by a "Leave call" style label,
   - and, as a second signal, whether the page plays a live call stream: an <audio> element fed by a live MediaStream.
     Only that yes or no is read: never the sound, names, chat, captions or anything on screen.
   - 1.3.0, Google Meet: while you wait to be let in ("Asking to be let in"), Meet already shows its Leave call button.
     That is not a call yet, so Vaani also needs a sign that you are in: a participant tile exists on the page (only
     whether one exists is read, never what it says), or the call's sound is playing. (Idea: Vexa's admission signals,
     Apache-2.0; see NOTICE.) Zoom and Teams show no hang-up button in their lobby, so nothing changes there.
   The signal must hold on two checks in a row before Vaani asks (idea: anarlog's "mic active for a while" threshold, MIT;
   see NOTICE), and the call counts as ended only after 5 s without it (call pages redraw their buttons now and then).
   It asks once per call: Chrome shows a notification, and this page shows a small prompt with Start notes and Not now.
   While Vaani takes notes, a bar says what Vaani hears and has a one-tap Stop. It sends nothing anywhere: only yes/no
   messages go to Vaani's own service worker. */
(function () {
  if (window.__vaaniLoaded) return;
  window.__vaaniLoaded = true;
  /* this page's own id: an in-page move (Teams and Meet change their address during a call) keeps it, a reload doesn't */
  var INST = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  var host = location.hostname;
  var SRC = host === "meet.google.com" ? "meet" : /(^|\.)zoom(gov)?\.(us|com)$/.test(host) ? "zoom" : "teams";
  var NAME = { meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom" }[SRC];
  var MEET_CODE = /(?:^|\/)([a-z]{3,4}-[a-z]{4}-[a-z]{3})(?=\/|$)/i;
  var ZOOM_ID = /\/wc\/(?:join\/)?(\d{6,14})(?=\/|$)/;
  /* the hang-up button, by the call page's own ids and classes (any language) */
  var HANGUP = '[jsname="CQylAd"],[data-tid="hangup-main-btn"],#hangup-button,[data-tid="call-hangup"],[data-tid="hangup-button"],[data-tid="hangup-leave-button"],.footer__leave-btn,.footer__leave-btn-container button,[aria-label="Leave"][data-tid]';
  /* the fallback: what the button says, in a few languages (lower case). Idea: anarlog's meeting-control labels, MIT. */
  var LABELS = ["leave call", "leave meeting", "end meeting", "hang up", "end call", "कॉल छोड़ें", "मीटिंग छोड़ें", "ಕರೆ ತೊರೆ", "அழைப்பிலிருந்து வெளியேறு", "salir de la llamada", "quitter l'appel", "anruf verlassen", "sair da chamada"];
  var STABLE_MS = 1200, LEAVE_MS = 5000, FOLD_MS = 20000;
  var cur = null, seenCall = {}, declined = {}, folded = {}, goneAt = 0, pendAt = 0, pendKey = null, askOn = true, told = null;
  var pill = null, root = null, state = "", rec = false, heard = false, ended = false, starting = 0, info = { pinned: true, key: "", perm: false };

  function visible(b) { if (b.disabled || b.getAttribute("aria-disabled") === "true") return false; var r = b.getClientRects(); return r.length > 0 && r[0].width > 0 && r[0].height > 0; }
  function hasHangup() {
    var hs = document.querySelectorAll(HANGUP);
    for (var k = 0; k < hs.length; k++) if (visible(hs[k])) return true;
    var bs = document.getElementsByTagName("button");
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (SRC === "meet" && b.textContent.indexOf("call_end") >= 0 && visible(b)) return true; /* Meet's hang-up icon, the same in every language */
      var l = ((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")).toLowerCase();
      if (l.length > 1) for (var j = 0; j < LABELS.length; j++) if (l.indexOf(LABELS[j]) >= 0 && visible(b)) return true;
    }
    return false;
  }
  /* a live call's sound playing in the page: an <audio> element fed by a live MediaStream (a yes or no, nothing else) */
  function liveAudio() {
    var els = document.getElementsByTagName("audio");
    for (var i = 0; i < els.length; i++) {
      var so = els[i].srcObject;
      if (so && typeof so.getAudioTracks === "function") { var ts = so.getAudioTracks(); for (var j = 0; j < ts.length; j++) if (ts[j].readyState === "live") return true; }
    }
    return false;
  }
  /* Google Meet: are you in the call, not in its lobby? A participant tile exists (a yes or no; its contents are not read) */
  var MEET_IN = "[data-participant-id],[data-self-name]";
  function meetIn() { try { return !!document.querySelector(MEET_IN); } catch (e) { return false; } }
  /* which meeting is open here and whether you are in it; null when this is not a meeting page */
  function where() {
    var p = location.pathname;
    /* Meet: the call's sound playing is enough on its own; the hang-up button counts only once you have been let in */
    if (SRC === "meet") { var m = p.match(MEET_CODE); if (!m) return null; return { key: m[1].toLowerCase(), call: liveAudio() || (meetIn() && hasHangup()) }; }
    if (SRC === "zoom") { var z = p.match(ZOOM_ID), zc = hasHangup(); return z || zc ? { key: z ? z[1] : "web", call: zc || (!!z && liveAudio()) } : null; }
    /* Teams changes its address during a call; one Teams meeting per tab, so the key is the tab's own */
    var tc = hasHangup() || liveAudio(); return tc ? { key: "teams", call: true } : null;
  }
  function alive() { return !!(chrome.runtime && chrome.runtime.id); } /* false once the extension was updated or removed */
  function send(m, cb) { if (!alive()) return; try { chrome.runtime.sendMessage(m, function (r) { void chrome.runtime.lastError; if (cb) cb(r); }); } catch (e) {} }

  var CSS = ':host{all:initial;--p-bg:rgba(28,28,30,.94);--p-ink:#F5F5F7;--p-ink2:rgba(245,245,247,.74);--p-edge:rgba(245,245,247,.14);--p-shadow:rgba(0,0,0,.35);' +
    '--p-rec:#FF453A;--p-btn:#F5F5F7;--p-btn-ink:#1C1C1E;--p-btn-hover:#E5E5EA;--p-btn-off:rgba(245,245,247,.35);--p-sp1:4px;--p-sp2:8px;--p-sp3:12px;--p-sp4:16px}' +
    '.p{position:fixed;top:var(--p-sp3);right:var(--p-sp4);max-width:380px;z-index:2147483647;display:flex;align-items:center;gap:var(--p-sp3);' +
    'padding:var(--p-sp3) var(--p-sp3) var(--p-sp3) var(--p-sp4);border-radius:16px;background:var(--p-bg);' +
    '-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);color:var(--p-ink);' +
    'font:400 14px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;box-shadow:0 12px 40px var(--p-shadow),0 0 0 .5px var(--p-edge);transition:transform .5s cubic-bezier(.32,.72,0,1),opacity .35s}' +
    '@starting-style{.p{opacity:0;transform:translateY(-8px)}}' +
    '.ic{width:20px;height:20px;flex:none;border-radius:5px}.dot{width:12px;height:12px;border-radius:50%;background:var(--p-rec);flex:none}' +
    '.rec .dot{animation:pu 1.4s ease-in-out infinite}@keyframes pu{50%{opacity:.35}}' +
    '.t{min-width:0;flex:1}.t b{display:block;font-weight:600;font-size:15px}.t span{display:block;color:var(--p-ink2);font-size:13px;margin-top:2px}' +
    '.acts{display:flex;flex-direction:column;align-items:stretch;gap:var(--p-sp1);flex:none;min-width:116px}' +
    'button{font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border:0;border-radius:999px;cursor:pointer;flex:none}' +
    'button:focus-visible{outline:2px solid var(--p-ink);outline-offset:2px}' +
    '.go{background:var(--p-btn);color:var(--p-btn-ink);min-height:36px;padding:0 var(--p-sp4)}.go:hover{background:var(--p-btn-hover)}.go:active{transform:scale(.97)}' +
    '.go:disabled{background:var(--p-btn-off);color:var(--p-ink2);cursor:not-allowed}' +
    '.x,.lk{background:transparent;color:var(--p-ink2);min-height:32px;padding:0 var(--p-sp2);font-size:13px;font-weight:400}.x:hover,.lk:hover{color:var(--p-ink)}' +
    '.chip{padding:var(--p-sp1) var(--p-sp1) var(--p-sp1) var(--p-sp3);gap:var(--p-sp2);border-radius:999px}.chip .t b{font-size:13px}' +
    '@media (prefers-reduced-motion:reduce){.p{transition:none}.rec .dot{animation:none}}';
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var foldT = 0;
  function hide() { clearTimeout(foldT); if (pill) { pill.remove(); pill = null; root = null; state = ""; } }
  function frame() { if (pill) return; pill = document.createElement("div"); pill.setAttribute("data-vaani", "1"); root = pill.attachShadow({ mode: "closed" }); document.documentElement.appendChild(pill); }
  function iconWord() { return info.pinned ? "the Vaani icon at the top right of Chrome" : "the puzzle piece at the top right of Chrome, then Vaani"; }
  function addLine() { return "Only your mic for now. To add everyone on the call, click " + iconWord() + (info.key ? ", or press " + info.key : "") + "."; }
  function paint(kind) {
    if (state === kind) return;
    frame(); state = kind;
    var icon = ""; try { icon = chrome.runtime.getURL("icons/32.png"); } catch (e) {}
    var img = '<img class="ic" src="' + esc(icon) + '" alt="" width="20" height="20">', h;
    if (kind === "rec") h = '<div class="p rec" role="status" aria-label="Vaani"><span class="dot" aria-hidden="true"></span><span class="t"><b>Vaani is taking notes</b><span>' + esc(heard ? "Vaani hears this call and your mic." : addLine()) + '</span></span><span class="acts"><button class="go" type="button" data-a="stop">Stop</button><button class="lk" type="button" data-a="tell">Copy chat note</button></span></div>';
    else if (kind === "ended") h = '<div class="p rec" role="alertdialog" aria-label="Vaani"><span class="dot" aria-hidden="true"></span><span class="t"><b>Your call ended</b><span>Stop taking notes? Vaani then writes them up.</span></span><span class="acts"><button class="go" type="button" data-a="stop">Stop notes</button><button class="x" type="button" data-a="keep">Keep going</button></span></div>';
    else if (kind === "chip") h = '<div class="p chip" role="region" aria-label="Vaani">' + img + '<span class="t"><b>Meeting detected</b></span><button class="go" type="button" data-a="start">Start notes</button><button class="x" type="button" data-a="no">Not now</button></div>';
    else h = '<div class="p ask" role="region" aria-label="Vaani">' + img + '<span class="t"><b>Meeting detected on ' + esc(NAME) + '. Take notes?</b><span>' + esc(info.perm ? "Vaani writes the summary, tasks and follow-up email. Tip: " + (info.key ? info.key + " or " : "") + "the Vaani icon starts notes that hear everyone." : "Vaani writes the summary, tasks and follow-up email. No bot joins.") + '</span></span><span class="acts"><button class="go" type="button" data-a="start">Start notes</button><button class="x" type="button" data-a="no">Not now</button></span></div>';
    root.innerHTML = "<style>" + CSS + "</style>" + h;
    root.querySelector(".p").addEventListener("click", function (e) {
      if (!e.isTrusted) return; /* only a real click, never one the call page made up */
      var b = e.target.closest && e.target.closest("[data-a]"); if (!b) return;
      var a = b.getAttribute("data-a");
      if (a === "start") { send({ type: "start" }); b.disabled = true; b.textContent = "Starting…"; starting = Date.now(); setTimeout(function () { if (starting && Date.now() - starting >= 9000 && !rec) { starting = 0; state = ""; render(); } }, 9500); }
      else if (a === "no") { if (cur) declined[cur] = 1; send({ type: "notnow" }); hide(); }
      else if (a === "stop") { send({ type: "stop" }); b.disabled = true; b.textContent = "Stopping…"; }
      else if (a === "keep") { ended = false; hide(); }
      else if (a === "tell") {
        /* a line to paste in the meeting chat, so people know notes are being taken (idea: anarlog's meeting disclosure, MIT) */
        var t = "Heads-up: I’m using Vaani, an AI note taker, to take notes on this call.";
        try { navigator.clipboard.writeText(t).then(function () { b.textContent = "Copied"; }, function () { b.textContent = "Couldn’t copy"; }); } catch (x) { b.textContent = "Couldn’t copy"; }
      }
    });
    clearTimeout(foldT);
    if (kind === "ask") { var k = cur; foldT = setTimeout(function () { if (cur === k && state === "ask") { folded[k] = 1; render(); } }, FOLD_MS); }
  }
  function render() {
    if (rec) return paint(ended ? "ended" : "rec");
    if (starting) return;
    if (cur && askOn && !declined[cur]) return paint(folded[cur] ? "chip" : "ask");
    hide();
  }
  /* the worker tells this tab when Vaani starts or stops taking notes for it; the bar goes only when it says so */
  chrome.runtime.onMessage.addListener(function (m, sender, reply) {
    if (sender.id !== chrome.runtime.id || !m) return;
    if (m.type === "alive") { reply({ inst: INST }); return; }
    if (m.type === "declined") { if (cur) declined[cur] = 1; if (!rec) hide(); return; }
    if (m.type !== "rec") return;
    var was = rec;
    rec = m.on === true; heard = rec && m.call === true; starting = 0;
    if (rec !== was || rec) state = "";
    if (!rec) { ended = false; if (was && cur) declined[cur] = 1; } /* asked once: after the notes, it doesn't ask again in this meeting */
    render();
  });
  /* a page that loads while Vaani takes notes for this tab shows the bar at once */
  send({ type: "recq" }, function (r) { if (r && r.rec === true) { rec = true; heard = r.call === true; render(); } });
  try { chrome.storage.sync.get({ ask: true }, function (o) { if (!chrome.runtime.lastError) { askOn = o.ask !== false; render(); } }); chrome.storage.onChanged.addListener(function (c, area) { if (area === "sync" && c.ask) { askOn = c.ask.newValue !== false; render(); } }); } catch (e) {}
  window.addEventListener("pagehide", function () { if (cur || rec) send({ type: "gone", inst: INST }); });
  function tell(on, key) {
    told = on ? key : null;
    send({ type: "call", on: on, src: SRC, key: key || "", inst: INST }, function (r) {
      if (!r || !on) return;
      info = { pinned: r.pinned !== false, key: typeof r.key === "string" ? r.key.slice(0, 40) : "", perm: r.perm === true };
      if (r.rec === true) { rec = true; heard = r.call === true; }
      state = ""; render();
    });
  }
  function check() {
    if (!alive()) { hide(); return; }
    if (pill && !pill.isConnected) { pill = null; root = null; state = ""; render(); } /* the page removed the bar: draw it again */
    var w = where(), now = Date.now();
    if (w && w.call) {
      goneAt = 0;
      if (cur === w.key) return;
      /* the call must hold for a moment (two checks) before Vaani asks */
      if (pendKey !== w.key) { pendKey = w.key; pendAt = now; setTimeout(check, STABLE_MS + 50); return; }
      if (now - pendAt < STABLE_MS) return;
      if (cur) tell(false);
      cur = w.key; seenCall[cur] = 1; ended = false; tell(true, cur); render();
      return;
    }
    pendKey = null;
    if (!cur) return;
    if (!goneAt) { goneAt = now; setTimeout(check, LEAVE_MS + 100); return; }
    if (now - goneAt < LEAVE_MS) return;
    /* the call is over here: forget its "Not now", so rejoining asks again */
    var old = cur; cur = null; goneAt = 0; delete declined[old]; delete folded[old];
    if (rec) { ended = true; state = ""; render(); } else hide();
    tell(false);
  }
  /* cheap: page changes and in-page navigation run one check at most every 300 ms, plus a slow tick */
  var due = 0;
  function soon() { if (due) return; due = setTimeout(function () { due = 0; check(); }, 300); }
  try { new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-label"] }); } catch (e) {}
  window.addEventListener("popstate", soon);
  setInterval(check, 2000);
  check();
})();
