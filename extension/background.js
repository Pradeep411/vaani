/* Vaani extension: opens the live Vaani app in a slim window beside your call.
   The app itself is https://pradeep411.github.io/vaani/, so every app update reaches the extension instantly. */
var APP = "https://pradeep411.github.io/vaani/";
var vaaniWin = null;

function openVaani(src, nearWindowId) {
  var url = APP + "?src=" + encodeURIComponent(src || "ext");
  var make = function (bounds) {
    var w = 440, h = Math.min(820, (bounds && bounds.height) || 820);
    var opts = { url: url, type: "popup", width: w, height: h, focused: true };
    if (bounds) { opts.left = Math.max(0, bounds.left + bounds.width - w - 16); opts.top = bounds.top + 40; }
    chrome.windows.create(opts, function (win) { vaaniWin = win && win.id; });
  };
  if (vaaniWin !== null) {
    chrome.windows.get(vaaniWin, { populate: true }, function (win) {
      if (chrome.runtime.lastError || !win) { vaaniWin = null; return openVaani(src, nearWindowId); }
      chrome.windows.update(vaaniWin, { focused: true });
      if (win.tabs && win.tabs[0]) chrome.tabs.update(win.tabs[0].id, { url: url });
    });
    return;
  }
  if (nearWindowId) {
    chrome.windows.get(nearWindowId, function (b) { make(chrome.runtime.lastError ? null : b); });
  } else { make(null); }
}

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (msg && msg.type === "open") openVaani(msg.src, (sender.tab && sender.tab.windowId) || msg.near);
});

chrome.windows.onRemoved.addListener(function (id) { if (id === vaaniWin) vaaniWin = null; });

chrome.runtime.onInstalled.addListener(function (d) {
  if (d.reason === "install") chrome.tabs.create({ url: APP + "?src=installed" });
});
