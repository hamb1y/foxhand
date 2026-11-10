/* Remote announcement data only. Rendering and all executable code ship locally. */
(function () {
'use strict';
var B = browser;
var ENDPOINT = 'https://foxhand-popup-endpoint.pages.dev/popup.json';
var PAGE = B.runtime.getURL('announcement.html');
var SEEN = 'shownPopupIds';
var pending = null;
var checking = false;

async function check() {
  if (checking || pending) return;
  checking = true;
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 10000);
  try {
    var response = await fetch(ENDPOINT, {
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: controller.signal
    });
    if (!response.ok) return;
    // Bound downloads as well as the accepted HTML size.
    var reader = response.body.getReader(), chunks = [], size = 0;
    try {
      while (true) {
        var part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) { await reader.cancel(); return; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    var bytes = new Uint8Array(size), offset = 0;
    chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
    var item = JSON.parse(new TextDecoder().decode(bytes));
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 128 ||
        typeof item.html !== 'string' || !item.html.trim() || new TextEncoder().encode(item.html).length > 32768) return;
    var stored = await B.storage.local.get(SEEN);
    var seen = Array.isArray(stored[SEEN]) ? stored[SEEN] : [];
    if (seen.indexOf(item.id) !== -1) return;
    pending = { id: item.id, html: item.html, opening: null, windowId: null };
    var current = pending;
    current.opening = B.windows.create({
      url: PAGE, type: 'popup', width: 460, height: 520
    });
    var win = await current.opening;
    current.windowId = win.id;
  } catch (e) {
    // A failed request/window must never disrupt the native bridge or consume an ID.
    pending = null;
  } finally {
    clearTimeout(timer);
    checking = false;
  }
}

B.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || (msg.type !== 'announcement-get' && msg.type !== 'announcement-shown')) return undefined;
  if (!sender || sender.id !== B.runtime.id || sender.url !== PAGE) return undefined;
  return (async function () {
    var current = pending;
    if (!current) return null;
    var win = await current.opening;
    if (pending !== current || !sender.tab || sender.tab.windowId !== win.id) return null;
    if (msg.type === 'announcement-get') return { id: current.id, html: current.html };
    if (msg.id !== current.id) return null;
    var stored = await B.storage.local.get(SEEN);
    var seen = Array.isArray(stored[SEEN]) ? stored[SEEN] : [];
    if (seen.indexOf(current.id) === -1) {
      seen.push(current.id);
      var data = {}; data[SEEN] = seen;
      await B.storage.local.set(data);
    }
    return { ok: true };
  })();
});
B.windows.onRemoved.addListener(function (id) {
  if (pending && pending.windowId === id) pending = null;
});
setTimeout(check, 15000);
setInterval(check, 4 * 60 * 60 * 1000);
})();
