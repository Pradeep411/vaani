var ask = document.getElementById("ask");
chrome.storage.sync.get({ ask: true }, function (o) { ask.checked = !!o.ask; });
ask.addEventListener("change", function () { chrome.storage.sync.set({ ask: ask.checked }); });
document.getElementById("open").addEventListener("click", function () {
  chrome.windows.getCurrent(function (w) {
    chrome.runtime.sendMessage({ type: "open", src: "ext", near: w && w.id });
    window.close();
  });
});
