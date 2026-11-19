/* Build a fresh DOM from an explicit HTML allowlist; never insert remote nodes. */
(function () {
'use strict';
interface AnnouncementItem { id: string; html: string; }
var B = browser;
var container = document.getElementById('announcement') as HTMLElement;
var allowed = new Set<string>(['H1', 'H2', 'H3', 'P', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I',
  'BR', 'HR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'A']);
var drop = new Set<string>(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'TEMPLATE', 'NOSCRIPT']);

function clean(node: Node, parent: Node, depth: number): void {
  if (depth > 64) return;
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(node.textContent!));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || drop.has((node as Element).tagName)) return;
  var target: Node = parent;
  if (allowed.has((node as Element).tagName) && (node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml') {
    target = document.createElement((node as Element).tagName.toLowerCase());
    if ((node as Element).tagName === 'A') {
      try {
        var url = new URL((node as Element).getAttribute('href')!);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          (target as HTMLAnchorElement).href = url.href;
          (target as HTMLAnchorElement).target = '_blank';
          (target as HTMLAnchorElement).rel = 'noopener noreferrer';
        }
      } catch (e) { /* Keep link text without an unsafe/missing URL. */ }
    }
    parent.appendChild(target);
  }
  Array.from(node.childNodes).forEach(function (child) { clean(child, target, depth + 1); });
}

if (window.FxMcp) window.FxMcp.localize();
(document.getElementById('close') as HTMLElement).addEventListener('click', function () { window.close(); });
(document.getElementById('done') as HTMLElement).addEventListener('click', function () { window.close(); });
document.addEventListener('keydown', function (event) { if (event.key === 'Escape') window.close(); });
B.runtime.sendMessage({ type: 'announcement-get' }).then(async function (item: AnnouncementItem | null) {
  if (!item) { window.close(); return; }
  var parsed = new DOMParser().parseFromString(item.html, 'text/html');
  var fragment = document.createDocumentFragment();
  Array.from(parsed.body.childNodes).forEach(function (node) { clean(node, fragment, 0); });
  if (!fragment.textContent!.trim()) {
    // A fully discarded message must not reopen a blank window every four hours.
    await B.runtime.sendMessage({ type: 'announcement-shown', id: item.id });
    window.close(); return;
  }
  container.replaceChildren(fragment);
  container.hidden = false;
  (document.getElementById('annFoot') as HTMLElement).hidden = false;
  (document.getElementById('close') as HTMLElement).focus();
  // Wait for an actual paint before consuming the announcement ID.
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  await B.runtime.sendMessage({ type: 'announcement-shown', id: item.id });
}).catch(function () { window.close(); });
})();
