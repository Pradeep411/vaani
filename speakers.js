/* Vaani speakers.js (v2.6): speaker names in the transcript.
   - Tap a speaker label to rename that speaker everywhere in the meeting; tap "Add speaker" on a line to say who spoke.
   - Names are kept in the note (n.spk) apart from the lines (s.s), so a rename never rewrites a line and is remembered
     with the meeting. Exports and prompts read them as "[Name] text" (stamped() in index.html).
   - Where speaker keys come from today: the person, here. Sarvam AI's speaker separation (diarization) exists only in
     its Batch API, whose uploads go to a storage host this page's security policy doesn't allow and which could not be
     tested without a key, so it is NOT offered (see CHANGES.md). Nothing is guessed from anyone's voice.
   Approach adapted as an idea from Vibe (thewh1teagle/vibe, MIT), Hyprnote (fastrepl/hyprnote, MIT) and Scriberr
   (rishikanthc/Scriberr, MIT): names kept apart from segments; "You" for the person's own voice; "Speaker N" defaults. */
(function () {
  "use strict";
  var V = window.Vaani;
  if (!V) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var MAXN = 20, ctx = null;

  function used(n) { var o = Object.create(null); n.segs.forEach(function (s) { var k = V.spKey(s.s); if (k) o[k] = 1; }); return o; }
  function nextKey(n) { var u = used(n), m = 0; Object.keys(u).forEach(function (k) { var d = +String(k).replace(/^\D+/, ""); if (d > m) m = d; }); Object.keys(n.spk || {}).forEach(function (k) { var d = +String(k).replace(/^\D+/, ""); if (d > m) m = d; }); return m < 99 ? "s" + (m + 1) : ""; }
  function prune(n) { var u = used(n); if (n.spk) { Object.keys(n.spk).forEach(function (k) { if (!u[k]) delete n.spk[k]; }); if (!Object.keys(n.spk).length) delete n.spk; } }
  function keyByName(n, name) {
    var low = name.toLowerCase(), u = used(n), hit = "";
    if (low === "you") return "you";
    Object.keys(u).forEach(function (k) { if (!hit && V.spLabel(n, k).toLowerCase() === low) hit = k; });
    return hit;
  }
  function suggestions(n, skip) {
    var out = [], seen = Object.create(null);
    function add(x) { x = V.spClean(x); var l = x.toLowerCase(); if (!x || seen[l] || l === skip) return; seen[l] = 1; out.push(x); }
    add("You");
    Object.keys(used(n)).forEach(function (k) { add(V.spLabel(n, k)); });
    ((n.cal && n.cal.people) || []).slice(0, 12).forEach(add);
    return out.slice(0, 10);
  }

  function open(i) {
    var n = V.cur(); if (!n || !n.segs[i]) return;
    var seg = n.segs[i], k = V.spKey(seg.s), rename = !!k;
    ctx = { id: n.id, i: i, k: k, mode: rename ? "rename" : "assign" };
    paint(n);
    V.openSheet("#spSheet");
    setTimeout(function () { var f = $("#spName"), a = document.activeElement; if (a && a !== f && a.matches && a.matches("input, select") && f && f.closest(".panel").contains(a)) return; if (f) { f.focus(); f.select(); } }, 80);
  }
  function paint(n) {
    var seg = n.segs[ctx.i], rename = ctx.mode === "rename";
    $("#spH").textContent = rename ? "Rename speaker" : "Who said this?";
    $("#spSub").textContent = rename ? "Every line by this speaker changes. The name stays with this meeting." : (seg.t ? seg.t + ", " : "") + "“" + String(seg.x).slice(0, 90) + (seg.x.length > 90 ? "…" : "") + "”";
    $("#spName").value = rename ? V.spLabel(n, ctx.k) : "";
    var sc = $("#spScope"); sc.textContent = "";
    [["this", "Just this line"], ["after", "This line and the next lines with no speaker"]].forEach(function (o) { var e = document.createElement("option"); e.value = o[0]; e.textContent = o[1]; sc.appendChild(e); });
    $("#spScopeWrap").hidden = rename;
    $("#spLine").hidden = !rename; $("#spClear").hidden = !rename;
    var box = $("#spSugs"); box.textContent = "";
    suggestions(n, rename ? V.spLabel(n, ctx.k).toLowerCase() : "").forEach(function (nm) {
      var b = document.createElement("button"); b.type = "button"; b.className = "sp-sug"; b.textContent = nm; b.setAttribute("data-sug", nm); box.appendChild(b);
    });
    box.hidden = !box.children.length;
  }

  function save() {
    if (!ctx) return;
    var name = V.spClean($("#spName").value);
    if (!name) { V.toast("Type a name first."); $("#spName").focus(); return; }
    var n = V.getNote(ctx.id); if (!n || !n.segs[ctx.i]) { V.closeSheets(); return; }
    n.spk = n.spk || {};
    var i = ctx.i, k, other;
    if (ctx.mode === "rename") {
      k = ctx.k; other = keyByName(n, name);
      if (other && other !== k) { n.segs.forEach(function (s) { if (s.s === k) s.s = other; }); k = other; }
      if (k !== "you" || name.toLowerCase() !== "you") n.spk[k] = name; else delete n.spk[k];
    } else {
      k = keyByName(n, name);
      if (!k) {
        if (Object.keys(used(n)).length >= MAXN) { V.toast("A meeting can have up to " + MAXN + " speakers."); return; }
        k = nextKey(n); if (!k) { V.toast("A meeting can have up to " + MAXN + " speakers."); return; }
      }
      if (k === "you") delete n.spk.you; else n.spk[k] = name;
      n.segs[i].s = k;
      if ($("#spScope").value === "after") for (var j = i + 1; j < n.segs.length && !V.spKey(n.segs[j].s); j++) n.segs[j].s = k;
    }
    prune(n); V.upsert(n); done(n);
  }
  function lineOnly() { if (!ctx || ctx.mode !== "rename") return; ctx.mode = "assign"; ctx.k = ""; var n = V.getNote(ctx.id); if (n) { paint(n); $("#spScope").value = "this"; $("#spScopeWrap").hidden = true; $("#spLine").hidden = true; $("#spClear").hidden = true; $("#spH").textContent = "Who said this line?"; $("#spName").focus(); } ctx.lineOnly = true; }
  function clearSpeaker() {
    if (!ctx || !ctx.k) return;
    var n = V.getNote(ctx.id); if (!n) return;
    n.segs.forEach(function (s) { if (s.s === ctx.k) delete s.s; });
    prune(n); V.upsert(n); done(n);
  }
  function done(n) {
    var i = ctx.i; ctx = null;
    V.closeSheets(); V.redrawTranscript(n); paintMarks(n);
    var c = $('#trBody [data-spi="' + i + '"]'); if (c) try { c.focus({ preventScroll: true }); } catch (e) {}
  }
  function paintMarks(n) {
    var mi = (n.marks || []).map(function (m) { return m.i; });
    [].forEach.call(document.querySelectorAll("#trBody .tr-row"), function (r, i) { var on = mi.indexOf(i) >= 0; r.classList.toggle("mk", on); var dt = r.querySelector(".ln-dot"); if (dt) dt.classList.toggle("mk", on); });
  }

  $("#trBody").addEventListener("click", function (e) { var b = e.target.closest("[data-spi]"); if (b) open(+b.getAttribute("data-spi")); });
  $("#spSave").addEventListener("click", save);
  $("#spLine").addEventListener("click", lineOnly);
  $("#spClear").addEventListener("click", clearSpeaker);
  $("#spName").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); save(); } });
  $("#spSugs").addEventListener("click", function (e) { var b = e.target.closest("[data-sug]"); if (b) { $("#spName").value = b.getAttribute("data-sug"); $("#spName").focus(); } });
  /* a new transcript drawn by the note view keeps working: marks are painted by home.js, speakers need nothing more */
})();
