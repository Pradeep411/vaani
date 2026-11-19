/* Vaani agent.js (v2.4): Vaani, the AI note taker agent, lines up its next steps after a meeting and does what a web page
   honestly can on its own.
   - The notes already hold the Summary, Notes, Tasks (owner and due date when said), Next action plan, Meeting conclusion,
     Follow-up meeting and a drafted Follow-up email (index.html FMT). This file shows them as one-tap actions under the notes.
   - Email: a Gmail compose link, or a mailto: link for any other mail app. Exact URLs, no redirects. "To" is filled only
     with the other attendees of the linked Google Calendar event (or addresses the person types in). Vaani never sends email.
   - Google Calendar: a prefilled "create event" link that opens in a new tab. calendar.js has a read-only scope; adding the
     event is the person's own click in Google Calendar. Guests are the same invite attendees, never anyone else.
   - WhatsApp, the system share sheet and Copy: as before, each needs a tap.
   - Slack: only if the person pastes an incoming-webhook URL (strictly https://hooks.slack.com/services/...). Stored only in
     this browser. With "On their own", Vaani posts each new meeting's notes there once; otherwise only on a tap.
     Other pages on the same github.io address share this browser storage (SECURITY-AUDIT-v25 I2), so a stored link and
     "On their own" are not enough on their own: Vaani posts automatically only after the person chose them in Settings
     in this same page session, or confirmed the channel on the note (it shows which workspace and link) since it opened.
   A web page with no server can't send email or WhatsApp messages on its own, and Vaani doesn't pretend it can. */
(function () {
  "use strict";
  var V = window.Vaani, H = window.VaaniHome;
  if (!V || !H) return;
  var esc = V.esc, $ = function (s, r) { return (r || document).querySelector(s); };

  /* ================= rules ================= */
  var MAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  function okMail(m) { return typeof m === "string" && m.length <= 254 && MAIL_RE.test(m); }
  /* the only Slack address Vaani will ever post to (the page's CSP allows only this prefix too) */
  var SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]+$/;
  function okSlack(u) { return typeof u === "string" && u.length <= 300 && SLACK_RE.test(u); }
  function mode() { return V.load("vaani.agent", "ask") === "auto" ? "auto" : "ask"; }
  function slackUrl() { var u = V.load("vaani.slack", ""); return okSlack(u) ? u : ""; }
  function enc(s) { return encodeURIComponent(String(s == null ? "" : s)); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1).trim() + "…" : s; }
  function names(list) { list = (list || []).filter(Boolean); if (list.length <= 2) return list.join(" and "); return list.slice(0, 2).join(", ") + " and " + (list.length - 2) + " more"; }

  /* ================= reading the notes ================= */
  /* the raw lines of the first section whose heading passes test, up to the next ## heading */
  function rawSection(md, test) {
    var lines = String(md || "").split(/\r?\n/), out = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^#{2,6}\s+(.*)$/);
      if (m) { if (out) break; if (test(m[1].replace(/\*\*/g, "").trim())) out = []; continue; }
      if (out) out.push(lines[i]);
    }
    return out;
  }
  function plainLine(l) { return String(l).replace(/\*\*/g, "").replace(/__/g, "").trim(); }
  /* v2.7 (audit L2): Vaani no longer reads attendee email addresses, so nothing is pre-addressed: the person types who it goes to */
  function mailsOf(n) { return []; }
  function peopleOf(n) { return n && n.cal && Array.isArray(n.cal.people) ? n.cal.people.filter(function (x) { return typeof x === "string" && x.trim(); }).slice(0, 40) : []; }
  function noEmailType(n) { return n.tmpl === "lecture" || n.tmpl === "interview"; }
  /* the drafted email: the model's "## Follow-up email" (Subject line, then the body), else one built from the notes */
  var WHY_SWAP = "Written from your checked to-dos, because the AI’s notes named details that are not in the transcript.";
  function mailDraft(n) {
    if (n.agentMail && typeof n.agentMail.body === "string") return { subject: String(n.agentMail.subject || ""), body: n.agentMail.body, edited: true };
    var raw = rawSection(n.md, V.isMailHead), subject = "", body = [];
    if (raw) {
      raw.forEach(function (l) { var m = plainLine(l).match(/^subject\s*:\s*(.+)$/i); if (!subject && m) subject = m[1].trim(); else if (subject || l.trim()) body.push(l.replace(/\*\*/g, "")); });
      while (body.length && !body[0].trim()) body.shift(); while (body.length && !body[body.length - 1].trim()) body.pop();
      if (body.length && /^body\s*:\s*$/i.test(body[0].trim())) body.shift();
      if (body.join("").trim()) {
        /* fix r4 (audit R4-1): the AI's email is used only when it names no owner or date that Vaani left out of the
           to-dos (home.js grounding). If it does, the draft is the one Vaani builds from the checked to-dos, so the
           amber mark's words "left out of your to-dos and follow-up email" hold for Open in Gmail and the editor too. */
        /* fix r5 (audit R5-2): simpler and stricter: if the transcript check left out ANY owner or date of this note's
           to-dos, the AI's email is not used at all (it may name the detail in other words). An error in the check counts
           as "something was left out". */
        var txt = body.join("\n").trim(), anyCut = cutAny(n), subj = subject || "Follow-up: " + (n.title || "our meeting");
        if (anyCut && !noEmailType(n)) return { subject: "Follow-up: " + (n.title || "our meeting"), body: basicMail(n), edited: false, swapped: true };
        if (!anyCut) return { subject: subj, body: txt, edited: false };
      }
    }
    if (noEmailType(n)) return null;
    return { subject: "Follow-up: " + (n.title || "our meeting"), body: basicMail(n), edited: false };
  }
  /* the free draft: thanks, where it landed, then each open task as "Owner: task" */
  /* did the transcript check leave out an owner or a date of any to-do of this note? (an error counts as yes) */
  function cutAny(n) {
    try { if (!H.todosOf) return true; if (H.todosOf(n).some(function (t) { return !!(t.cut && t.cut.length); })) return true; var fm = followMeeting(n); return !!(fm && fm.dropped); } catch (e) { return true; }
  }
  function basicMail(n) {
    var secs = V.parseMd(n.md), land = [];
    secs.forEach(function (s) { if (!land.length && /conclusion|decided|decision/i.test(s.h)) land = s.paras.concat(s.items).map(plainLine); });
    if (!land.length) secs.forEach(function (s) { if (!land.length && /summary|highlight|discussed|snapshot/i.test(s.h)) land = s.paras.concat(s.items).map(plainLine).slice(0, 2); });
    /* v2.8: what is still to do, as the to-do list reads it (a name or date the transcript never had is already gone);
       a task nobody took on is listed without the "Owner not said" label, which reads badly in an email to clients */
    var tasks = H.todosOf(n).filter(function (t) { return !t.done; }).map(function (t) { return H.noOwner(t.owner) ? t.task : t.owner + ": " + t.task; });
    var b = "Hi all,\n\nThanks for your time today." + (land.length ? " Where we landed:\n" + land.map(function (x) { return "- " + x; }).join("\n") : "");
    if (tasks.length) b += "\n\nNext steps:\n" + tasks.map(function (x) { return "- " + x; }).join("\n");
    return b + "\n\nLet me know if I missed anything.";
  }
  /* "## Follow-up meeting": When, Who and About, as written; "Not said" counts as nothing */
  function followMeeting(n) {
    var raw = rawSection(n.md, function (h) { return /follow.?up meeting|next meeting/i.test(h) && !V.isMailHead(h); });
    if (!raw) return null;
    /* fix r5 (audit R5-5): runs of spaces made one and each line capped, so a very long line costs nothing */
    raw = raw.slice(0, 40).map(function (l) { return String(l).replace(/\s+/g, " ").slice(0, 300); });
    var f = { when: "", who: "", about: "" }, free = [];
    raw.forEach(function (l) {
      var t = plainLine(l).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""); if (!t) return;
      var m = t.match(/^(when|date|time|who|with|attendees|about|topic|agenda)\s*:\s*(.*)$/i);
      if (!m) { free.push(t); return; }
      var k = m[1].toLowerCase(), v = /^not said\.?$/i.test(m[2].trim()) ? "" : m[2].trim();
      if (/when|date|time/.test(k)) f.when = f.when ? f.when + " " + v : v; else if (/who|with|attendees/.test(k)) f.who = v; else f.about = v;
    });
    if (!f.when && !f.who && !f.about) { if (!free.length) return null; f.about = free.join(" "); f.when = free.join(" "); }
    f.at = whenOf(f.when, new Date(n.date));
    /* v2.8: a day the transcript never had (AI notes only, home.js grounding) does not go into the calendar link.
       whenOf moves "Thursday" said on a Thursday a week on, so the week before counts as said too. */
    if (f.at && H.groundDay && !H.groundDay(n, f.at.d, f.when) && !H.groundDay(n, new Date(f.at.d.getTime() - 7 * 86400000), "")) { f.at = null; f.cut = true; /* fix r4 (testing R4-S1): the unsaid day's words go too, wherever this is read */ if (f.about === f.when) f.about = ""; f.when = ""; f.dropped = true; }
    /* fix r3 (testing R3-G3): the same for "Who": a name the transcript never had is not shown and not put in the calendar link */
    if (f.who && H.groundOwner) { var w0 = f.who.split(/\s*(?:,|;|&|\band\b)\s*/).filter(Boolean), w1 = w0.filter(function (w) { return H.groundOwner(n, w); }); if (w1.length !== w0.length) f.dropped = true; f.who = w1.join(", "); }
    /* fix r5 (testing R5-S3): a clock time the transcript never had goes too, even when the day was said: "Thursday at 5 PM"
       is "Thursday" when only "3 PM" was said. AI notes only (the same notes the day check covers). */
    if (f.at && f.at.time && n.engine && !/basic engine|Sample/i.test(n.engine) && Array.isArray(n.segs) && !timeSaid(n, f.at.d)) {
      var TM = /[,\s]*\b(?:at\s+|around\s+|by\s+)?(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|(?:[01]?\d|2[0-3]):[0-5]\d|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:am|pm|a\.m\.|p\.m\.|o['’]clock)|noon|midnight)(?![\p{L}\p{N}])/giu;
      f.when = f.when.replace(TM, "").replace(/\s{2,}/g, " ").replace(/^[,\s]+|[,\s]+$/g, ""); if (f.about) f.about = f.about.replace(TM, "").trim();
      f.at = { d: new Date(f.at.d.getFullYear(), f.at.d.getMonth(), f.at.d.getDate()), time: false, amb: f.at.amb }; f.dropped = true;
    }
    return f;
  }
  /* was this clock time said? "3 pm", "3:00 PM", "three pm", "15:00", "3.30 pm" in the transcript */
  function timeSaid(n, d) {
    try {
      var h = d.getHours(), m = d.getMinutes(), h12 = h % 12 || 12, ap = h < 12 ? "a" : "p", W = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
      var mm = (m < 10 ? "0" : "") + m, hh = "(?:0?" + h12 + "|" + W[h12] + ")", re = m ? new RegExp("(?:^|[^\\d:.])(?:" + hh + "[:. ]" + mm + "\\s*" + ap + "\\.?\\s?m|0?" + h + ":" + mm + "(?!\\d))", "i") : new RegExp("(?:^|[^\\d:.])(?:" + hh + "(?:[:.]00)?\\s*" + ap + "\\.?\\s?m\\b|0?" + h + ":00(?!\\d)" + (h === 12 ? "|noon" : h === 0 ? "|midnight" : "") + ")", "i");
      return n.segs.some(function (s) { return re.test(String(s && s.x || "").toLowerCase()); });
    } catch (e) { return false; }
  }
  /* a day (with the strict deadline reader from home.js) and a clock time, from words like "Thursday 3 pm" */
  function whenOf(t, base) {
    if (!t) return null;
    /* read as a date that was said ("on 12 November", "on Thursday"), so the strict reader accepts a bare date */
    var day = H.parseDue(/^\s*(by|before|on|due|until|till)\b/i.test(t) ? t : "on " + t, base), tm = null, m;
    /* v2.7 (testing T02q): a time said in words ("eleven AM") counts like "11 am" */
    var NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    t = String(t).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?=\s*(?:am|pm|a\.m\.|p\.m\.|o['’]clock)\b)/gi, function (w) { return NUM[w.toLowerCase()]; }).replace(/\ba\.m\./gi, "am").replace(/\bp\.m\./gi, "pm");
    if ((m = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i))) { var h = +m[1] % 12 + (/pm/i.test(m[3]) ? 12 : 0); if (+m[1] <= 12) tm = [h, +(m[2] || 0)]; }
    else if ((m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/))) tm = [+m[1], +m[2]];
    if (!day) return null;
    var d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    /* "Thursday" said on a Thursday means next week's */
    if (H.daysBetween(base, d) <= 0 && /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(t)) d.setDate(d.getDate() + 7);
    if (tm) d.setHours(tm[0], tm[1], 0, 0);
    /* "next Thursday" said on a Wednesday: many people mean the week after, so the row says to check */
    var amb = /\bnext\s+(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(t) && H.daysBetween(base, d) <= 7;
    return { d: d, time: !!tm, amb: amb };
  }

  /* ================= links: exact URLs, nothing in between ================= */
  function gmailUrl(to, subject, body) {
    return "https://mail.google.com/mail/?view=cm&fs=1" + (to.length ? "&to=" + enc(to.join(",")) : "") + "&su=" + enc(subject) + "&body=" + enc(body);
  }
  function mailtoUrl(to, subject, body) {
    return "mailto:" + to.map(function (m) { return m.replace(/%/g, "%25"); }).join(",") + "?subject=" + enc(subject) + "&body=" + enc(body);
  }
  function two(x) { return (x < 10 ? "0" : "") + x; }
  function stamp(d, time) { return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + (time ? "T" + two(d.getHours()) + two(d.getMinutes()) + "00" : ""); }
  function tz() { try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; return /^[A-Za-z0-9_\/+-]{1,64}$/.test(z || "") ? z : ""; } catch (e) { return ""; } }
  function calUrl(n, f) {
    var u = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + enc("Follow-up: " + (n.title || "meeting"));
    if (f.at) {
      var a = f.at.d, b = new Date(a);
      if (f.at.time) { var mins = Math.min(120, Math.max(30, Math.round((+n.dur || 1800) / 60 / 15) * 15)); b.setMinutes(b.getMinutes() + mins); }
      else b.setDate(b.getDate() + 1);
      u += "&dates=" + stamp(a, f.at.time) + "/" + stamp(b, f.at.time);
      var z = tz(); if (z && f.at.time) u += "&ctz=" + enc(z);
    }
    var det = (f.about ? "About: " + f.about + "\n" : "") + (f.who ? "Who: " + f.who + "\n" : "") + "From the notes of “" + (n.title || "the meeting") + "”, " + new Date(n.date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) + ".";
    u += "&details=" + enc(det);
    var to = mailsOf(n); if (to.length) u += "&add=" + enc(to.join(","));
    return u;
  }
  function whenLabel(f) {
    if (f.cut) return "but not its day in the transcript. Pick the day in Google Calendar";
    if (!f.at) return f.when ? f.when : "no date yet";
    var d = f.at.d; return H.longDay(d) + (f.at.time ? ", " + V.timeLabel(d) : "") + (f.at.amb ? " (or the week after? Check in Google Calendar)" : "");
  }

  /* ================= Slack ================= */
  /* Slack reads <, > and & as markup (<!channel> pings everyone), so they are escaped; the draft email is not sent */
  function slackText(n) {
    var t = V.shareText(n).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return clip(t, 3500);
  }
  /* a simple request (no custom headers), so the browser sends it without a preflight; Slack answers "ok" */
  function postSlack(n) {
    var url = slackUrl(); if (!url) return Promise.reject(new Error("no-slack"));
    return fetch(url, { method: "POST", body: JSON.stringify({ text: slackText(n), unfurl_links: false, unfurl_media: false }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" })
      .then(function (r) { return r.text().then(function (t) { if (!r.ok || String(t).trim() !== "ok") throw new Error("slack " + r.status); return true; }); });
  }
  function setAgent(id, patch) { var n = V.getNote(id); if (!n) return null; n.agent = Object.assign({}, n.agent && typeof n.agent === "object" ? n.agent : {}, patch); V.upsert(n); return n; }
  function sendSlack(id, auto) {
    var n = V.getNote(id); if (!n) return;
    setAgent(id, { slackTry: new Date().toISOString(), slackErr: "" }); paint(V.getNote(id));
    postSlack(n).then(function () { setAgent(id, { slack: new Date().toISOString(), slackErr: "" }); },
      function () { setAgent(id, { slackErr: new Date().toISOString() }); V.toast("Couldn’t post to Slack. Check the Slack channel link in Settings."); })
      .then(function () { var x = V.getNote(id); if (x && V.getCurrentId() === id) paint(x); });
  }

  /* I2: where Slack posts go, in words the person can check (workspace and link start, and the link's last 4 characters) */
  function slackWhere(u) {
    var m = String(u || "").match(/\/services\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_\/-]+)$/);
    if (!m) return "the link ending “" + String(u).slice(-4) + "”";
    return "workspace " + m[1].slice(0, 4) + "…, channel link " + m[2].slice(0, 4) + "…, ending “" + m[3].slice(-4) + "”";
  }
  /* automatic posts need the person's own say-so in this page session: choosing it in Settings here, or confirming on a note.
     Another tab changing the link or the choice takes it back. */
  var armed = null, ASKED = {};
  function arm() { armed = slackUrl() && mode() === "auto" ? slackUrl() : null; }
  function isArmed() { return !!armed && armed === slackUrl() && mode() === "auto"; }
  window.addEventListener("storage", function (e) { if (e.key === null || /vaani\.(slack|agent)$/.test(String(e.key))) { armed = null; var n = V.cur(); if (n && H.appView() === "note") paint(V.getNote(n.id)); } });

  /* ================= the "Next steps" block, right under the Summary ================= */
  function tasksLine(n) {
    var t = H.todosOf(n); if (!t.length) return "";
    var none = t.filter(function (x) { return H.noOwner(x.owner); }).length;
    return "Vaani found " + H.plural(t.length, "task", "tasks") + (none ? ", " + none + " with no owner yet" : t.length > 1 ? ", each with an owner" : ", with an owner");
  }
  function row(k, l1, l2, x) {
    return '<div class="row-r ag-row"><span class="ln-g">' + esc(k) + '</span><span class="ln-n"><span class="ln-dot" aria-hidden="true"></span></span><div class="ln-c"><span class="l1">' + l1 + "</span>" + (l2 ? '<span class="l2">' + l2 + "</span>" : "") + '</div><div class="ln-x">' + x + "</div></div>";
  }
  function paint(n) {
    var box = $("#agBox"); if (box) box.remove();
    /* v2.7 (audit L4): a recording with no words gets no drafts */
    if (!n || n.kind !== "meeting" || n.thin || !n.md || !(+n.words > 0) || V.getCurrentId() !== n.id) return;
    var body = $("#noteBody"); if (!body) return;
    var h = "", mail = mailDraft(n), f = followMeeting(n), tl = tasksLine(n), to = mailsOf(n), ppl = peopleOf(n), slack = slackUrl(), ag = n.agent || {};
    /* only a Share row would be left: the toolbar's Share already does that */
    if (!mail && !f && !tl && !slack) return;
    if (ASKED[n.id] && slack && mode() === "auto" && !ag.slack && !isArmed())
      h += row("Slack", esc("Post these notes to Slack?"), esc("To " + slackWhere(slack) + ". Vaani checks with you once each time it opens, so no one else can change where your notes go."),
        '<button type="button" class="btn-f" data-ag="slackok">Post to Slack</button><button type="button" class="btn-t" data-ag="slackno">Not now</button>');
    if (mail) h += row("Email", esc("Vaani drafted the follow-up email" + (ppl.length ? " for " + names(ppl) : "")), esc((to.length ? "To the " + H.plural(to.length, "person", "people") + " in the invite. " : "You choose who it goes to. ") + (mail.swapped ? WHY_SWAP + " " : "") + "Subject: " + clip(mail.subject, 80)),
      '<button type="button" class="btn-f" data-ag="gmail">Open in Gmail</button><button type="button" class="btn-t" data-ag="mail">Edit</button>');
    /* the second line says only what the button does: who gets invited */
    var guests = to.length ? "Invites " + (ppl.length === to.length ? names(ppl) : H.plural(to.length, "person", "people")) + ", from the meeting invite." : "No guests added. You can add them in Google Calendar.";
    if (f) h += row("Meeting", esc("Vaani found a follow-up meeting, " + whenLabel(f)), esc(guests), '<button type="button" class="btn-f" data-ag="cal">Add to Google Calendar</button>');
    if (tl) h += row("Tasks", esc(tl), "", '<button type="button" class="btn-t" data-ag="tasks">Copy tasks</button>');
    var st = "";
    if (slack) st = ag.slack ? "Posted to Slack, " + V.timeLabel(new Date(ag.slack)) + "." : ag.slackErr ? "Couldn’t post to Slack." : ag.slackTry && !ag.slackErr ? "Posting to Slack…" : "";
    /* I-3: a tap on Post to Slack says where it goes, as the automatic post's question does */
    if (slack) st = (st ? st + " " : "") + "Slack posts go to " + slackWhere(slack) + ".";
    h += row("Share", "Send the notes", st ? esc(st) : "", '<button type="button" class="btn-t" data-ag="wa">WhatsApp</button>' + (slack ? '<button type="button" class="btn-t" data-ag="slack">' + (ag.slack ? "Post to Slack again" : "Post to Slack") + "</button>" : ""));
    var line = mode() === "auto" && slack && ag.slack ? "Vaani posted the notes to Slack. Email, WhatsApp and the invite need your tap." : "Nothing goes out until you tap.";
    box = H.el("section", "agent"); box.id = "agBox"; box.setAttribute("aria-labelledby", "agH");
    box.innerHTML = '<h3 class="sec-h" id="agH">Vaani drafted your follow-up</h3><p class="ag-mode">' + esc(line) + '</p><div class="nb-sec ag-list">' + h + "</div>";
    var sumH = [].filter.call(body.querySelectorAll("h3.sec-h"), function (x) { return /^summary$/i.test(x.textContent.trim()); })[0];
    var after = sumH && sumH.nextElementSibling && sumH.nextElementSibling.classList.contains("nb-sec") ? sumH.nextElementSibling : null;
    if (after) after.after(box); else body.insertBefore(box, $(".peak", body) || $(".thin-fix", body) || null);
  }
  /* automatic: only Slack can truly go out on its own, once per new meeting note, never for samples, thin notes or copies */
  function auto(n, fresh) {
    if (!fresh || mode() !== "auto" || !slackUrl() || !n || n.kind !== "meeting" || n.thin || n.sample || n.of || !n.md) return;
    if (n.agent && (n.agent.slack || n.agent.slackTry)) return;
    if (!isArmed()) { ASKED[n.id] = 1; paint(V.getNote(n.id)); return; } /* ask first, showing where it would go */
    sendSlack(n.id, true);
  }
  H.ext.hooks.push(function (ev, d) {
    if (ev === "decorated" && d && d.n) paint(V.getNote(d.n.id) || d.n);
    else if (ev === "note" && d && d.n) auto(V.getNote(d.n.id) || d.n, d.fresh);
  });

  /* ================= actions ================= */
  function open(u) { window.open(u, "_blank", "noopener,noreferrer"); }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ag]"); if (!b) return;
    var n = V.cur(); if (!n) return;
    var a = b.getAttribute("data-ag");
    if (a === "gmail") { var m = mailDraft(n); if (m) open(gmailUrl(mailsOf(n), m.subject, m.body)); }
    else if (a === "mail") mailSheet(n);
    else if (a === "cal") { var f = followMeeting(n); if (f) open(calUrl(n, f)); }
    else if (a === "tasks") V.copyText((n.title || "Tasks") + "\n" + H.todosOf(n).map(function (t) { return "- " + H.ownerLabel(t.owner) + ": " + t.task; }).join("\n"), "Tasks copied. Paste them anywhere.");
    else if (a === "wa") open("https://wa.me/?text=" + enc(V.shareText(n)));
    else if (a === "slack") sendSlack(n.id, false);
    else if (a === "slackok") { arm(); delete ASKED[n.id]; if (isArmed()) sendSlack(n.id, true); else paint(V.getNote(n.id)); }
    else if (a === "slackno") { delete ASKED[n.id]; paint(V.getNote(n.id)); }
  });

  /* the email, to check and change before it opens in Gmail or another mail app */
  H.sheet("agMail", '<h2 id="agMailH">Follow-up email</h2><p class="sub">Check it, then send it from your email. Vaani never sends it for you.</p>' +
    '<label class="form-l" for="agTo">To</label><input class="field" id="agTo" type="text" inputmode="email" autocomplete="off" spellcheck="false" aria-describedby="agToHint">' +
    '<p class="hint" id="agToHint"></p>' +
    '<p class="hint" id="agWhy" hidden></p><label class="form-l" for="agSubj">Subject</label><input class="field" id="agSubj" autocomplete="off">' +
    '<label class="form-l" for="agBody">Message</label><textarea class="field" id="agBody" rows="10"></textarea>' +
    '<div class="sh-actions"><button type="button" id="agGmail">Open in Gmail</button><button type="button" id="agMailto">Other mail app</button><button type="button" id="agCopy">Copy</button></div>' +
    '<button type="button" class="cancel" data-close>Cancel</button>');
  var MS = { id: 0 };
  function mailSheet(n) {
    var m = mailDraft(n) || { subject: "Follow-up: " + (n.title || "our meeting"), body: basicMail(n) };
    MS.id = n.id;
    $("#agTo").value = (n.agentMail && Array.isArray(n.agentMail.to) ? n.agentMail.to.filter(okMail) : mailsOf(n)).join(", ");
    $("#agTo").removeAttribute("aria-invalid");
    /* v2.7: the placeholder names the people of the meeting, so the empty To line says whose addresses to add */
    var pp = peopleOf(n).map(function (x) { return x.split(/\s+/)[0]; }).slice(0, 3);
    $("#agTo").placeholder = pp.length ? "Add " + (pp.length === 1 ? pp[0] + "’s" : pp.slice(0, -1).join("’s, ") + "’s and " + pp[pp.length - 1] + "’s") + " email" : "Add email addresses";
    $("#agToHint").textContent = mailsOf(n).length ? "From the meeting invite. Separate addresses with commas." : "Add email addresses, separated by commas, or leave it empty and choose in your email.";
    $("#agSubj").value = m.subject; $("#agBody").value = m.body;
    /* fix r5 (creative r5 P2-1): the editor says it too */
    var why = $("#agWhy"); if (why) { why.textContent = m.swapped ? WHY_SWAP : ""; why.hidden = !m.swapped; }
    V.openSheet("#agMail");
  }
  /* only well-formed addresses the person can see in the field; anything else stops and says so */
  function sheetTo() {
    var raw = $("#agTo").value.split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean), bad = raw.filter(function (x) { return !okMail(x); });
    if (bad.length) { $("#agTo").setAttribute("aria-invalid", "true"); $("#agToHint").textContent = "“" + clip(bad[0], 60) + "” isn’t an email address. Fix it or remove it."; $("#agTo").focus(); return null; }
    $("#agTo").removeAttribute("aria-invalid"); return raw.slice(0, 40);
  }
  function keep(to) { var n = V.getNote(MS.id); if (!n) return; n.agentMail = { to: to, subject: $("#agSubj").value.slice(0, 300), body: $("#agBody").value.slice(0, 20000) }; V.upsert(n); }
  $("#agGmail").addEventListener("click", function () { var to = sheetTo(); if (!to) return; keep(to); open(gmailUrl(to, $("#agSubj").value, $("#agBody").value)); V.closeSheets(); });
  $("#agMailto").addEventListener("click", function () { var to = sheetTo(); if (!to) return; keep(to); location.href = mailtoUrl(to, $("#agSubj").value, $("#agBody").value); V.closeSheets(); });
  $("#agCopy").addEventListener("click", function () { var to = sheetTo(); if (!to) return; keep(to); V.copyText("Subject: " + $("#agSubj").value + "\n\n" + $("#agBody").value, "Copied. Paste it in your email."); });

  /* ================= Settings: Post notes to Slack ================= */
  (function () {
    var anchor = $("#calSet") || ($("#bkDl") && $("#bkDl").closest(".opts") && $("#bkDl").closest(".opts").parentNode);
    if (!anchor) return;
    var box = H.el("div"); box.id = "agSet";
    /* the link is a secret (anyone who has it can post there): the field is never filled back in, the hint shows only its ends */
    box.innerHTML = '<label class="form-l" for="slackInp">Slack channel link (optional)</label>' +
      '<input class="field" id="slackInp" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://hooks.slack.com/services/…" aria-describedby="slackHint">' +
      '<div class="adv-act"><button type="button" class="adv-save" id="slackSave">Save</button><button type="button" class="btn-t" id="slackRm" hidden>Remove</button></div>' +
      '<p class="hint" id="slackHint"></p>' +
      '<div id="agWrap" hidden><span class="form-l" id="agL">What Vaani does after a meeting</span>' +
      '<div class="seg" id="agSeg" role="group" aria-labelledby="agL" data-on="0"><span class="thumb" aria-hidden="true"></span><button type="button" data-agm="ask" aria-pressed="true">Ask me first</button><button type="button" data-agm="auto" aria-pressed="false">Do it automatically</button></div>' +
      '<p class="hint" id="agHint"></p></div>';
    anchor.parentNode.insertBefore(box, anchor);
    var SLACK_HINT = "Paste a Slack incoming webhook link and Vaani can post your notes to one channel. In Slack, add the Incoming Webhooks app to a channel and copy its link. Only this browser keeps it, and anyone with the link can post there.";
    function sync() {
      var m = mode(), seg = $("#agSeg"), has = !!slackUrl();
      $("#agWrap").hidden = !has;
      seg.setAttribute("data-on", m === "auto" ? 1 : 0);
      [].forEach.call(seg.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-agm") === m)); });
      $("#agHint").textContent = m === "auto" ? "After each meeting, Vaani posts the notes to your Slack channel on its own. Email, WhatsApp and calendar invites still need your tap, because a web app can’t send them for you."
        : "Vaani drafts the follow-up email, finds the tasks and the follow-up meeting, and asks you first. Nothing goes out until you tap.";
      $("#slackRm").hidden = !has;
      var inp = $("#slackInp");
      if (document.activeElement !== inp) { inp.value = ""; inp.removeAttribute("aria-invalid"); $("#slackHint").textContent = has ? "Saved. Vaani posts to this channel: " + slackWhere(slackUrl()) + "." : SLACK_HINT; }
    }
    function saveSlack(quiet) {
      var inp = $("#slackInp"), v = inp.value.trim();
      if (!v) { sync(); return true; } /* an empty field keeps the saved link; Remove removes it */
      if (!okSlack(v)) { inp.setAttribute("aria-invalid", "true"); $("#slackHint").textContent = "That isn’t a Slack incoming webhook. It starts with https://hooks.slack.com/services/ and has nothing after the address."; if (!quiet) inp.focus(); return false; }
      inp.removeAttribute("aria-invalid"); V.save("vaani.slack", v); inp.value = ""; inp.blur(); arm(); sync(); return true;
    }
    $("#agSeg").addEventListener("click", function (e) { var b = e.target.closest("[data-agm]"); if (!b) return; V.save("vaani.agent", b.getAttribute("data-agm")); arm(); sync(); });
    $("#slackSave").addEventListener("click", function () { saveSlack(false); });
    $("#slackInp").addEventListener("keydown", function (e) { if (e.key === "Enter") saveSlack(false); });
    $("#slackRm").addEventListener("click", function () { V.remove("vaani.slack"); armed = null; $("#slackInp").value = ""; sync(); $("#slackInp").focus(); });
    /* Done keeps a valid link that was typed but not saved; a wrong one is not saved, and the toast says so */
    $("#setDone").addEventListener("click", function () { var v = $("#slackInp").value.trim(); if (v && !okSlack(v)) { setTimeout(function () { V.toast("The Slack link wasn’t saved: it isn’t a Slack incoming webhook."); }, 0); $("#slackInp").value = ""; } else if (v) saveSlack(true); var n = V.cur(); if (n && H.appView() === "note") paint(V.getNote(n.id)); }, true);
    var prev = H.onSheet["#setSheet"]; H.onSheet["#setSheet"] = function () { if (prev) prev(); $("#slackInp").blur(); sync(); };
    sync();
  })();

  /* for tests and the console: pure helpers and the one email editor, never the webhook */
  window.VaaniAgent = { okMail: okMail, okSlack: okSlack, gmailUrl: gmailUrl, mailtoUrl: mailtoUrl, calUrl: calUrl, mailDraft: mailDraft, followMeeting: followMeeting, slackText: slackText, mode: mode, mailSheet: mailSheet, slackWhere: slackWhere, armed: isArmed };
})();
