/* Vaani: offers to take notes when a call starts in this tab.
   It only checks whether a "Leave call" style button is on the page. It reads nothing else and sends nothing anywhere. */
(function () {
  if (window.__vaaniLoaded) return;
  window.__vaaniLoaded = true;

  var host = location.hostname;
  var APP = host.indexOf("meet.google") >= 0 ? "Google Meet" : host.indexOf("zoom") >= 0 ? "Zoom" : "Microsoft Teams";
  var SRC = APP === "Google Meet" ? "meet" : APP === "Zoom" ? "zoom" : "teams";
  var LEAVE = [
    'button[aria-label*="eave call" i]', '[data-tid="hangup-main-btn"]', '#hangup-button',
    'button[aria-label*="hang up" i]', '.footer__leave-btn', 'button[aria-label*="Leave" i]'
  ].join(",");
  var shownFor = null, pill = null;

  function callKey() { return location.pathname.split("/").slice(0, 3).join("/"); }
  function inCall() {
    if (SRC === "meet" && !/^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3}/.test(location.pathname)) return false;
    return !!document.querySelector(LEAVE);
  }

  function hide() { if (pill) { pill.remove(); pill = null; } }

  function show() {
    if (pill) return;
    pill = document.createElement("div");
    var root = pill.attachShadow({ mode: "closed" });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.p{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-12px);opacity:0;z-index:2147483647;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 14px;border-radius:999px;' +
      'background:rgba(28,28,30,.86);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);color:#fff;' +
      'font:500 14px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35),0 0 0 .5px rgba(255,255,255,.12);' +
      'transition:transform .5s cubic-bezier(.32,.72,0,1),opacity .35s}' +
      '.p.in{transform:translateX(-50%) translateY(0);opacity:1}' +
      '.dot{width:22px;height:22px;border-radius:50%;background:#FF3B30;box-shadow:0 0 0 3px rgba(255,59,48,.28);flex:none}' +
      '.t b{display:block;font-weight:600}.t span{display:block;color:rgba(255,255,255,.62);font-size:12px;margin-top:2px}' +
      'button{font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border:0;border-radius:999px;cursor:pointer}' +
      '.go{background:#fff;color:#000;padding:9px 14px}.go:hover{background:#e9e9ee}' +
      '.x{background:transparent;color:rgba(255,255,255,.62);width:30px;height:30px;font-size:18px;line-height:30px;padding:0}.x:hover{color:#fff}' +
      '</style>' +
      '<div class="p" role="dialog" aria-label="Vaani meeting notes">' +
      '<span class="dot" aria-hidden="true"></span>' +
      '<span class="t"><b>Take notes on this call?</b><span>Vaani writes the notes and action items for you</span></span>' +
      '<button class="go">Start notes</button><button class="x" aria-label="Not now">×</button></div>';
    var p = root.querySelector(".p");
    root.querySelector(".go").addEventListener("click", function () {
      chrome.runtime.sendMessage({ type: "open", src: SRC });
      hide();
    });
    root.querySelector(".x").addEventListener("click", hide);
    document.documentElement.appendChild(pill);
    requestAnimationFrame(function () { requestAnimationFrame(function () { p.classList.add("in"); }); });
    setTimeout(hide, 45000);
  }

  function check() {
    if (!chrome.runtime || !chrome.runtime.id) return; /* extension was updated or removed */
    try { chrome.storage.sync.get({ ask: true }, function (o) {
      if (chrome.runtime.lastError || !o.ask) return;
      var k = callKey();
      if (inCall()) { if (shownFor !== k) { shownFor = k; show(); } }
      else if (shownFor === k) { hide(); }
    }); } catch (e) {}
  }
  setInterval(check, 2000);
})();
