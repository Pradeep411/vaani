/* Vaani insights.js (v2.1): the Insights page. Everything is worked out here, in this browser, from the notes saved
   in localStorage. No network, no other users' data, no percentiles. Plugs into home.js through window.VaaniHome.
   Every name, title and label that comes from a note goes through esc(). */
(function () {
  "use strict";
  var V = window.Vaani, H = window.VaaniHome;
  if (!V || !H) return;
  var esc = V.esc, DAY = H.DAY, TYPING_WPM = 40, WEEKS = 20;
  var FMT_MON = new Intl.DateTimeFormat(undefined, { month: "short" });
  var FMT_DAYMON = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  var FMT_WD = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  var FMT_WDS = new Intl.DateTimeFormat(undefined, { weekday: "short" });

  function num(n) { return Math.round(n).toLocaleString(); }
  function pl(n, one, many) { return num(n) + " " + (Math.round(n) === 1 ? one : many); }
  function hours(secs) { var h = secs / 3600, t = h < 10 ? (Math.round(h * 10) / 10).toString() : num(h); return t + (t === "1" ? " hour" : " hours"); }
  /* the same maths as the sidebar's "Saved about": words / 40, rounded to the minute */
  function savedParts(min) { min = Math.round(min); return min < 60 ? [[min, "min"]] : [[Math.floor(min / 60), "h"]].concat(min % 60 ? [[min % 60, "min"]] : []); }
  function savedText(min) { return savedParts(min).map(function (p) { return p[0] + " " + p[1]; }).join(" "); }
  function dayKey(d) { return H.startOfDay(d).getTime(); }
  function startOf(n) { var d = new Date(n.date); return new Date(d.getTime() - Math.max(0, +n.dur || 0) * 1000); }
  /* Monday-first weekday index, 0 to 6 */
  function wd(d) { return (d.getDay() + 6) % 7; }
  function frac(v, max) { return max > 0 ? Math.max(0, Math.min(1, v / max)) : 0; }
  function w4(f) { return (Math.round(f * 1000) / 1000).toString(); }

  /* owner, language and source names come from notes: every lookup table has no prototype */
  function own(o, k) { return typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : ""; }
  var LANG_NAME = Object.create(null); (V.LANGS || []).forEach(function (l) { LANG_NAME[l[0]] = l[1]; });
  var SRC_NAME = { meet: "Google Meet", teams: "Teams", zoom: "Zoom" };
  function typeName(n) { var t = H.typeOf(n.tmpl); return t ? t[0] : "General"; }
  function srcName(n) { var x = own(SRC_NAME, n.src); if (x) return x; return n.call ? "Whole call" : "Mic only"; }
  function engineName(e) {
    e = typeof e === "string" ? e.slice(0, 60) : "";
    if (!e) return "";
    if (/basic engine/i.test(e)) return "Vaani’s basic engine";
    if (/on-device/i.test(e)) return "On-device AI";
    if (/translator/i.test(e)) return "";
    return e;
  }

  /* ================= the numbers ================= */
  function compute() {
    var now = new Date(), today = dayKey(now);
    var ns = H.realNotes().filter(function (n) { return !n.of; });
    var meetings = ns.filter(function (n) { return n.kind === "meeting"; }), quick = ns.length - meetings.length;
    var words = V.savedWords(), savedMin = Math.round(words / TYPING_WPM);
    var meetSecs = 0; meetings.forEach(function (n) { meetSecs += Math.max(0, +n.dur || 0); });
    /* pace: only recordings of 20 seconds or more that captured words */
    var paceSecs = 0, paceWords = 0;
    ns.forEach(function (n) { var d = +n.dur || 0, w = +n.words || 0; if (d >= 20 && w > 0) { paceSecs += d; paceWords += w; } });
    var wpm = paceSecs ? paceWords / (paceSecs / 60) : 0;
    /* to-dos */
    var all = []; ns.forEach(function (n) { H.todosOf(n).forEach(function (t) { all.push(t); }); });
    var done = all.filter(function (t) { return t.done; }).length, open = all.filter(function (t) { return !t.done; });
    var youOwe = open.filter(function (t) { return H.isMine(t.owner); }).length;
    var othersOwe = open.filter(function (t) { return !H.isMine(t.owner) && !H.isTeamOwner(t.owner); }).length;
    var overdue = open.filter(function (t) { return t.due && dayKey(t.due) < today; }).length;
    /* people: owners who are not you and not the team, ranked by open then by all */
    var ppl = Object.create(null), order = [];
    all.forEach(function (t) {
      var o = String(t.owner || "").trim(); if (!o || H.isMine(o) || H.isTeamOwner(o)) return;
      var k = o.toLowerCase(); if (!ppl[k]) { ppl[k] = { name: o, open: 0, all: 0 }; order.push(k); }
      ppl[k].all++; if (!t.done) ppl[k].open++;
    });
    var people = order.map(function (k) { return ppl[k]; }).sort(function (a, b) { return b.open - a.open || b.all - a.all || a.name.localeCompare(b.name); }).slice(0, 5);
    /* days with a recording */
    var days = Object.create(null); ns.forEach(function (n) { var k = dayKey(startOf(n)); days[k] = (days[k] || 0) + 1; });
    var keys = Object.keys(days).map(Number).sort(function (a, b) { return a - b; });
    var longest = 0, run = 0, prev = null;
    keys.forEach(function (k) { run = prev !== null && H.daysBetween(new Date(prev), new Date(k)) === 1 ? run + 1 : 1; longest = Math.max(longest, run); prev = k; });
    /* the current run counts back from today; with nothing yet today it is still alive from yesterday */
    var cur = 0, d = new Date(today); if (!days[dayKey(d)]) d.setDate(d.getDate() - 1);
    while (days[dayKey(d)]) { cur++; d.setDate(d.getDate() - 1); }
    /* rhythm */
    var byWd = [0, 0, 0, 0, 0, 0, 0], byTod = [0, 0, 0, 0];
    ns.forEach(function (n) { var s = startOf(n), h = s.getHours(); byWd[wd(s)]++; byTod[h >= 5 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 21 ? 2 : 3]++; });
    /* breakdowns */
    function tally(list, fn) { var c = Object.create(null), ord = []; list.forEach(function (n) { var k = fn(n); if (!k) return; if (!c[k]) { c[k] = 0; ord.push(k); } c[k]++; }); return ord.map(function (k) { return { label: k, n: c[k] }; }).sort(function (a, b) { return b.n - a.n || a.label.localeCompare(b.label); }); }
    var first = ns.length ? new Date(Math.min.apply(null, ns.map(function (n) { return new Date(n.date).getTime(); }))) : null;
    return {
      notes: ns.length, meetings: meetings.length, quick: quick, words: words, savedMin: savedMin, meetSecs: meetSecs,
      wpm: wpm, paceSecs: paceSecs, todos: all.length, done: done, open: open.length, youOwe: youOwe, othersOwe: othersOwe, overdue: overdue,
      people: people, days: days, cur: cur, longest: longest, byWd: byWd, byTod: byTod, first: first,
      types: tally(meetings, typeName), langs: tally(ns, function (n) { return (typeof n.lang === "string" && LANG_NAME[n.lang]) || (typeof n.lang === "string" ? n.lang.slice(0, 20) : ""); }),
      srcs: tally(meetings, srcName), engines: tally(ns, function (n) { return engineName(n.engine); })
    };
  }

  /* ================= pieces ================= */
  /* horizontal bars, drawn to scale against the largest value; the width comes from --w (0 to 1) */
  function bars(list, label) {
    var max = 0; list.forEach(function (x) { max = Math.max(max, x.n); });
    var total = list.reduce(function (t, x) { return t + x.n; }, 0);
    return '<ul class="ins-bars" aria-label="' + esc(label) + '">' + list.map(function (x) {
      var pct = total ? Math.round(x.n / total * 100) : 0;
      return '<li><span class="ib-l">' + esc(x.label) + (x.hint ? '<span class="ib-h">, ' + esc(x.hint) + "</span>" : "") + '</span><span class="ib-t" aria-hidden="true"><i data-w="' + w4(frac(x.n, max)) + '"></i></span><span class="ib-n">' + esc(num(x.n)) + '<span class="sr"> (' + pct + '%)</span></span></li>';
    }).join("") + "</ul>";
  }
  function group(id, title, list, label) {
    if (!list.length) return "";
    return '<section class="ins-grp" aria-labelledby="' + id + '"><h3 id="' + id + '">' + esc(title) + "</h3>" + bars(list.slice(0, 6), label) + "</section>";
  }
  function heatmap(st) {
    var now = new Date(), today = H.startOfDay(now);
    var start = new Date(today); start.setDate(today.getDate() - wd(today) - (WEEKS - 1) * 7);
    /* a month is named above the week that holds its 1st; the first column is named only when its month runs on for 3 weeks */
    var h = '<div class="hm-wrap"><div class="hm-months" aria-hidden="true"><span></span>', marks = [];
    for (var w = 0; w < WEEKS; w++) {
      var wk = new Date(start); wk.setDate(start.getDate() + w * 7);
      var end = new Date(wk); end.setDate(wk.getDate() + 6);
      if (w === 0 && wk.getDate() !== 1) marks.push({ w: 0, d: wk }); else if (end.getDate() <= 7) marks.push({ w: w, d: end });
    }
    if (marks.length > 1 && marks[0].w === 0 && marks[1].w < 3) marks.shift();
    marks.forEach(function (mk) { h += '<span class="hm-mon" data-col="' + (mk.w + 2) + '">' + esc(FMT_MON.format(mk.d)) + "</span>"; });
    h += '</div><div class="hm-grid" role="grid" tabindex="0" aria-label="Days with a recording, the last ' + WEEKS + ' weeks. Use the arrow keys to move." aria-readonly="true" id="insHeat">';
    for (var r = 0; r < 7; r++) {
      var rowDay = new Date(start); rowDay.setDate(start.getDate() + r);
      h += '<div class="hm-row" role="row"><span class="hm-dl" aria-hidden="true">' + (r % 2 === 0 && r < 6 ? esc(FMT_WDS.format(rowDay)) : "") + "</span>";
      for (var c = 0; c < WEEKS; c++) {
        var d = new Date(start); d.setDate(start.getDate() + c * 7 + r);
        if (d > today) { h += '<span class="hm-c hm-f" aria-hidden="true"></span>'; continue; }
        var k = st.days[dayKey(d)] || 0, lv = k >= 4 ? 4 : k;
        var lab = (k ? pl(k, "note", "notes") : "No notes") + " on " + FMT_DAYMON.format(d);
        h += '<span class="hm-c l' + lv + (d.getTime() === today.getTime() ? " today" : "") + '" role="gridcell" id="hc' + r + "_" + c + '" data-r="' + r + '" data-c="' + c + '" aria-label="' + esc(lab) + '" title="' + esc(lab) + '"></span>';
      }
      h += "</div>";
    }
    h += '</div><p class="hm-key" aria-hidden="true">Less<i class="hm-c l0"></i><i class="hm-c l1"></i><i class="hm-c l2"></i><i class="hm-c l3"></i><i class="hm-c l4"></i>More</p></div>';
    return h;
  }
  function columns(vals, labels, label) {
    var max = Math.max.apply(null, vals);
    return '<ul class="ins-cols" aria-label="' + esc(label) + '">' + vals.map(function (v, i) {
      return '<li' + (v === max && v > 0 ? ' class="top"' : "") + '><span class="ic-t" aria-hidden="true"><i data-h="' + w4(frac(v, max)) + '"></i></span><span class="ic-n">' + num(v) + '</span><span class="ic-l">' + esc(labels[i]) + "</span><span class=\"sr\">: " + pl(v, "recording", "recordings") + "</span></li>";
    }).join("") + "</ul>";
  }
  var TOD = ["Morning", "Afternoon", "Evening", "Night"], TOD_HINT = ["before noon", "noon to 5", "5 to 9", "after 9"];
  function wdNames(fmt) { var mon = new Date(2024, 0, 1), out = []; for (var i = 0; i < 7; i++) { var d = new Date(mon); d.setDate(mon.getDate() + i); out.push(fmt.format(d)); } return out; }

  /* ================= the page ================= */
  function emptyPage() {
    return '<div class="pg-head"><div><h1 class="pg-h1">Insights</h1><p class="pg-sub">Your patterns, worked out on this device from the notes you save.</p></div></div>' +
      '<section class="ins-empty" aria-label="What will appear here"><p class="ins-line">Your time saved, speaking pace, streak and to-dos show here after your first recording. <button class="lnk-in" type="button" data-act="insRec">Start recording</button></p>' +
      '<p class="ins-note">Nothing here leaves this browser. The sample meeting doesn’t count.</p></section>';
  }
  function render() {
    var st = compute();
    if (!st.notes) return emptyPage();
    var since = st.first ? FMT_DAYMON.format(st.first) : "";
    var h = '<div class="pg-head"><div><h1 class="pg-h1">Insights</h1><p class="pg-sub">From ' + pl(st.notes, "note", "notes") + (since ? " since " + esc(since) : "") + ". Worked out on this device.</p></div>" +
      '<button class="btn-f ins-copy" type="button" data-act="insCopy">Copy my stats</button></div>';
    /* lead: one number, then a ledger */
    var big = "<small>about </small>" + savedParts(st.savedMin).map(function (p) { return num(p[0]) + "<small> " + p[1] + "</small>"; }).join(" ");
    h += '<section class="ins-lead" aria-labelledby="insLeadH"><div class="ins-hero"><h2 id="insLeadH" class="sr">Time saved</h2><p class="ins-big">' + big + "</p>" +
      '<p class="ins-cap">of typing saved, at ' + TYPING_WPM + " words a minute.</p></div>" +
      '<dl class="ins-ledger"><div><dt>Words captured</dt><dd>' + esc(num(st.words)) + "</dd></div>" +
      "<div><dt>Meetings recorded</dt><dd>" + esc(num(st.meetings)) + (st.meetings ? "<small>" + esc(hours(st.meetSecs)) + "</small>" : "") + "</dd></div>" +
      "<div><dt>Quick notes</dt><dd>" + esc(num(st.quick)) + "</dd></div></dl></section>";
    /* to-dos and pace, side by side on a laptop: the to-dos block is wider */
    h += '<div class="ins-pair">';
    var rate = st.todos ? Math.round(st.done / st.todos * 100) : 0;
    h += '<section class="ins-sec ins-todo" aria-labelledby="insTodoH"><div class="ins-h"><h2 id="insTodoH">To-dos</h2>' + (st.todos ? '<button class="lnk" type="button" data-go2="todos">Open To-dos</button>' : "") + "</div>";
    if (st.todos) {
      h += '<p class="ins-line"><b>' + esc(num(st.done)) + " of " + esc(pl(st.todos, "to-do", "to-dos")) + " done</b>, a " + rate + "% completion rate.</p>" +
        '<div class="ins-meter" role="img" aria-label="' + rate + '% of to-dos done"><i data-w="' + w4(st.done / st.todos) + '"></i></div>' +
        '<dl class="ins-ledger sm"><div><dt>You owe</dt><dd>' + esc(num(st.youOwe)) + "</dd></div><div><dt>Others owe you</dt><dd>" + esc(num(st.othersOwe)) + "</dd></div>" +
        "<div><dt>Overdue</dt><dd" + (st.overdue ? ' class="late"' : "") + ">" + esc(num(st.overdue)) + "</dd></div></dl>";
    } else h += '<p class="ins-note">Action items from your meetings are counted here.</p>';
    h += "</section>";
    if (st.wpm > 0) {
      var x = st.wpm / TYPING_WPM, mx = Math.max(st.wpm, TYPING_WPM);
      var cmp = x >= 1.15 ? "about " + (Math.round(x * 10) / 10) + " times as fast as typing" : x > 0.87 ? "about the same as typing" : "slower than typing";
      h += '<section class="ins-sec ins-pace" aria-labelledby="insPaceH"><div class="ins-h"><h2 id="insPaceH">Speaking pace</h2></div>' +
        '<p class="ins-line"><b>' + esc(num(st.wpm)) + " words a minute</b> when you record, " + esc(cmp) + ".</p>" +
        '<ul class="ins-bars two" aria-label="Words a minute"><li><span class="ib-l">You, speaking</span><span class="ib-t" aria-hidden="true"><i data-w="' + w4(st.wpm / mx) + '"></i></span><span class="ib-n">' + esc(num(st.wpm)) + "</span></li>" +
        '<li class="ref"><span class="ib-l">Typing</span><span class="ib-t" aria-hidden="true"><i data-w="' + w4(TYPING_WPM / mx) + '"></i></span><span class="ib-n">' + TYPING_WPM + "</span></li></ul>" +
        '<p class="ins-note">From ' + esc(hours(st.paceSecs)) + " of your recordings. Typing is a typical 40 words a minute.</p></section>";
    }
    h += "</div>";
    /* streak */
    var line = st.cur ? "<b>" + esc(pl(st.cur, "day", "days")) + "</b> in a row with a recording." : "No recording yesterday or today yet.";
    h += '<section class="ins-sec" aria-labelledby="insStreakH"><div class="ins-h"><h2 id="insStreakH">Streak</h2></div><p class="ins-line">' + line + " Your longest run is " + esc(pl(st.longest, "day", "days")) + ".</p>" + heatmap(st) + "</section>";
    /* rhythm */
    var wdl = wdNames(FMT_WDS), wdL = wdNames(FMT_WD), bd = st.byWd.indexOf(Math.max.apply(null, st.byWd)), bt = st.byTod.indexOf(Math.max.apply(null, st.byTod));
    h += '<section class="ins-sec" aria-labelledby="insRhythmH"><div class="ins-h"><h2 id="insRhythmH">When you record</h2></div><p class="ins-line">Your busiest day is <b>' + esc(wdL[bd]) + "</b>, and most recordings start in the <b>" + esc(TOD[bt].toLowerCase()) + "</b>.</p>" +
      '<div class="ins-two"><div><h3 class="ins-sub">Day of the week</h3>' + columns(st.byWd, wdl, "Recordings by day of the week") + "</div>" +
      '<div><h3 class="ins-sub">Time of day</h3>' + bars(st.byTod.map(function (v, i) { return { label: TOD[i], hint: TOD_HINT[i], n: v }; }), "Recordings by time of day") + "</div></div></section>";
    /* what you record */
    var g = group("insTypeH", "Meeting types", st.types, "Meetings by type") + group("insLangH", "Languages", st.langs, "Notes by language") + group("insSrcH", "Source", st.srcs, "Meetings by source") + group("insEngH", "Notes engine", st.engines, "Notes by engine");
    if (g) h += '<section class="ins-sec" aria-labelledby="insWhatH"><div class="ins-h"><h2 id="insWhatH">What you record</h2></div><div class="ins-grid">' + g + "</div></section>";
    /* people */
    if (st.people.length) {
      h += '<section class="ins-sec" aria-labelledby="insPplH"><div class="ins-h"><h2 id="insPplH">People with to-dos</h2></div><div class="ins-ppl">';
      var pmax = Math.max.apply(null, st.people.map(function (p) { return p.all; }));
      st.people.forEach(function (p) {
        h += '<button type="button" class="ins-person" data-owner="' + esc(p.name) + '" aria-label="Show to-dos for ' + esc(p.name) + ", " + p.open + " open of " + p.all + '"><span class="av c' + H.hueOf(p.name) + '" aria-hidden="true">' + esc(p.name.charAt(0).toUpperCase()) + '</span><span class="ip-n">' + esc(p.name) + '</span><span class="ib-t" aria-hidden="true"><i data-w="' + w4(frac(p.all, pmax)) + '"></i><b data-w="' + w4(frac(p.open, pmax)) + '"></b></span><span class="ip-c">' + esc(num(p.open)) + " open of " + esc(num(p.all)) + "</span></button>";
      });
      h += '</div><p class="ins-note"><span class="ip-key">The blue part of each bar is still open. The grey part is done. </span>Tap a name to see their open to-dos.</p></section>';
    }
    h += '<p class="ins-foot">Worked out in this browser from your saved notes. Nothing is sent anywhere to make them.</p>';
    return h;
  }

  function statsText() {
    var st = compute(), L = ["My Vaani stats"];
    if (!st.notes) L.push("No recordings yet.");
    else {
      L.push("Typing saved: about " + savedText(st.savedMin));
      L.push("Words captured: " + num(st.words));
      L.push("Meetings recorded: " + num(st.meetings) + (st.meetings ? ", " + hours(st.meetSecs) : ""));
      L.push("Quick notes: " + num(st.quick));
      if (st.todos) L.push("To-dos: " + num(st.done) + " of " + num(st.todos) + " done (" + Math.round(st.done / st.todos * 100) + "%), " + num(st.overdue) + " overdue");
      if (st.wpm > 0) L.push("Speaking pace: " + num(st.wpm) + " words a minute (typing is about 40)");
      L.push("Streak: " + pl(st.cur, "day", "days") + ", longest " + pl(st.longest, "day", "days"));
    }
    if (V.load("vaani.noBrand", "0") !== "1") L.push("", "Made with Vaani: " + V.APP_URL);
    return L.join("\n");
  }

  /* bar sizes and month columns go in through CSSOM: the page's CSP allows no style attributes */
  function sizeBars(root) {
    [].forEach.call(root.querySelectorAll("[data-w]"), function (e) { e.style.setProperty("--w", String(Math.max(0, Math.min(1, +e.getAttribute("data-w") || 0)))); });
    [].forEach.call(root.querySelectorAll("[data-h]"), function (e) { e.style.setProperty("--h", String(Math.max(0, Math.min(1, +e.getAttribute("data-h") || 0)))); });
    [].forEach.call(root.querySelectorAll(".hm-mon[data-col]"), function (e) { e.style.gridColumn = (+e.getAttribute("data-col") || 1) + " / span 3"; });
  }
  function after(root) { sizeBars(root); bindHeat(root); }
  /* heatmap keyboard: the grid holds focus, the active cell is aria-activedescendant */
  function bindHeat(root) {
    var g = root.querySelector("#insHeat"); if (!g) return;
    var cells = [].slice.call(g.querySelectorAll('[role="gridcell"]'));
    if (!cells.length) return;
    var at = cells[cells.length - 1];
    function set(c) { if (!c) return; if (at) at.classList.remove("act"); at = c; c.classList.add("act"); g.setAttribute("aria-activedescendant", c.id); }
    g.setAttribute("aria-activedescendant", at.id);
    g.addEventListener("focus", function () { set(at); });
    g.addEventListener("blur", function () { if (at) at.classList.remove("act"); });
    g.addEventListener("keydown", function (e) {
      var r = +at.getAttribute("data-r"), c = +at.getAttribute("data-c"), k = e.key, nx = null;
      function cell(rr, cc) { return g.querySelector("#hc" + rr + "_" + cc); }
      if (k === "ArrowRight") nx = cell(r, c + 1); else if (k === "ArrowLeft") nx = cell(r, c - 1);
      else if (k === "ArrowDown") nx = cell(r + 1, c); else if (k === "ArrowUp") nx = cell(r - 1, c);
      else if (k === "Home") nx = cell(r, 0); else if (k === "End") { for (var i = WEEKS - 1; i >= 0 && !nx; i--) nx = cell(r, i); }
      else return;
      e.preventDefault(); e.stopPropagation(); if (nx) set(nx);
    });
  }

  H.ext.pages.insights = { render: render, after: after };
  H.ext.acts.insCopy = function () { V.copyText(statsText(), "Copied your stats"); };
  H.ext.acts.insRec = function () { if (!V.isListening()) V.startRec(); };
  window.VaaniInsights = { compute: compute, statsText: statsText };
})();
