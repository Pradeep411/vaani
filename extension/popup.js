/* The popup opens when the Vaani icon is clicked on a tab that isn't a detected call, or on a call tab while Chrome's OK
   to hear calls (the optional "tabCapture" permission) is still missing. Opening it was a click on the icon, which is
   what Chrome needs before Vaani may hear this tab, so "Take notes on this tab" can hand the tab's sound over at once.
   chrome.permissions.request is called only here, as the first thing inside a click. */
var $ = function (id) { return document.getElementById(id); };
var TAB = null, S = { perm: false };
var PERM = { permissions: ["tabCapture"] };
function send(m, cb) { try { chrome.runtime.sendMessage(m, function (r) { void chrome.runtime.lastError; if (cb) cb(r); }); } catch (e) { if (cb) cb(null); } }
function view(id) {
  ["vMain", "vAsk", "vDone", "vRec"].forEach(function (v) { $(v).hidden = v !== id; });
  $("setCard").hidden = id === "vAsk" || id === "vDone";
  var h = { vMain: "mainH", vAsk: "askH", vDone: "doneH", vRec: "recH" }[id]; if (h) $(h).focus();
}
function hearRow() {
  $("hearSub").textContent = S.perm ? "On. Only a call tab you start notes on, only while taking notes." : "Off. Vaani hears only your mic.";
  $("hearBtn").textContent = S.perm ? "Turn off" : "Turn on";
}
function startTab() { if (TAB) send({ type: "start", tabId: TAB.id }); }

chrome.storage.sync.get({ ask: true }, function (o) { $("ask").checked = o.ask !== false; });
$("ask").addEventListener("change", function () { chrome.storage.sync.set({ ask: $("ask").checked }); });

var shown = false, fallback = setTimeout(function () { if (!shown) { shown = true; view("vMain"); } }, 700);
chrome.tabs.query({ active: true, currentWindow: true }, function (t) {
  TAB = t && t[0] ? t[0] : null;
  send({ type: "popupState", tabId: TAB ? TAB.id : -1 }, function (r) {
    clearTimeout(fallback); shown = true;
    if (!r) { view("vMain"); return; }
    S = r; hearRow();
    if (r.rec && !(r.recHere && !r.recCall && !r.perm)) {
      $("recP").textContent = r.recHere ? (r.recCall ? "Vaani hears this call and your mic." : "Vaani hears only your mic.") : r.recOwned ? "Vaani is taking notes in its window." : "Vaani is taking notes in another tab.";
      return view("vRec");
    }
    if ((r.call || r.recHere) && !r.perm) return view("vAsk");
    $("startTab").textContent = r.call ? "Take notes on this call" : "Take notes on this tab";
    view("vMain");
  });
});

$("startTab").addEventListener("click", function () { startTab(); window.close(); });
$("open").addEventListener("click", function () { chrome.windows.getCurrent(function (w) { send({ type: "open", near: w && w.id }); window.close(); }); });
$("goto").addEventListener("click", function () { send({ type: "focus" }); window.close(); });
$("stop").addEventListener("click", function () { send({ type: "stop" }); window.close(); });
$("allow").addEventListener("click", function () {
  chrome.permissions.request(PERM, function (ok) {
    void chrome.runtime.lastError;
    S.perm = !!ok; hearRow();
    if (!ok) { $("allow").textContent = "Chrome didn’t allow it. Try again"; return; }
    startTab(); view("vDone"); setTimeout(function () { window.close(); }, 2500);
  });
});
$("micOnly").addEventListener("click", function () { startTab(); window.close(); });
$("hearBtn").addEventListener("click", function () {
  if (S.perm) { chrome.permissions.remove(PERM, function () { void chrome.runtime.lastError; S.perm = false; hearRow(); }); return; }
  chrome.permissions.request(PERM, function (ok) { void chrome.runtime.lastError; S.perm = !!ok; hearRow(); });
});
