/* Build a fresh DOM from an explicit HTML allowlist; never insert remote nodes. */
(function () {
'use strict';
var B = browser;
var container = document.getElementById('announcement');
var allowed = new Set(['H1', 'H2', 'H3', 'P', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I',
  'BR', 'HR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'A']);
var drop = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'TEMPLATE', 'NOSCRIPT']);

function clean(node, parent, depth) {
  if (depth > 64) return;
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(node.textContent));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || drop.has(node.tagName)) return;
  var target = parent;
  if (allowed.has(node.tagName) && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
    target = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === 'A') {
      try {
        var url = new URL(node.getAttribute('href'));
        if (url.protocol === 'https:' && !url.username && !url.password) {
          target.href = url.href;
          target.target = '_blank';
          target.rel = 'noopener noreferrer';
        }
      } catch (e) { /* Keep link text without an unsafe/missing URL. */ }
    }
    parent.appendChild(target);
  }
  Array.from(node.childNodes).forEach(function (child) { clean(child, target, depth + 1); });
}

if (window.FxMcp) window.FxMcp.localize();
document.getElementById('close').addEventListener('click', function () { window.close(); });
document.getElementById('done').addEventListener('click', function () { window.close(); });
document.addEventListener('keydown', function (event) { if (event.key === 'Escape') window.close(); });
B.runtime.sendMessage({ type: 'announcement-get' }).then(async function (item) {
  if (!item) { window.close(); return; }
  var parsed = new DOMParser().parseFromString(item.html, 'text/html');
  var fragment = document.createDocumentFragment();
  Array.from(parsed.body.childNodes).forEach(function (node) { clean(node, fragment, 0); });
  if (!fragment.textContent.trim()) { window.close(); return; }
  container.replaceChildren(fragment);
  container.hidden = false;
  document.getElementById('annFoot').hidden = false;
  document.getElementById('close').focus();
  // Wait for an actual paint before consuming the announcement ID.
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  await B.runtime.sendMessage({ type: 'announcement-shown', id: item.id });
}).catch(function () { window.close(); });
})();
