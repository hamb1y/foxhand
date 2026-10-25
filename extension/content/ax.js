/* Foxhand — content script (isolated world).
 * Plain classic script (no modules). Idempotent: safe to re-inject.
 * Owns AX `ref` numbering. A ref names one element for the life of the
 * document and is never reused; each document starts numbering at a random
 * base so a ref from an earlier page can't silently hit a different element.
 */
(function () {
'use strict';

if (window.__fxmcp) return;
window.__fxmcp = true;

var B = (typeof browser !== 'undefined') ? browser : chrome;

var HAS_WEAKREF = typeof WeakRef === 'function';
var docId = Math.random().toString(36).slice(2, 8);
var generation = 0;
var generations = new Set(); // snapshot generation ids issued for this document
var nextRef = 1000 + Math.floor(Math.random() * 89000);
var refMap = new Map();      // ref number -> WeakRef<Element>
var elToRef = new WeakMap(); // Element -> ref number
var refInfo = new Map();     // ref number -> {role, name} as last shown, to find a re-rendered element again

/* The element's ref, assigning the next unused number the first time it's seen. */
function refFor(el) {
  var r = elToRef.get(el);
  if (r === undefined) {
    r = ++nextRef;
    elToRef.set(el, r);
    refMap.set(r, HAS_WEAKREF ? new WeakRef(el) : el);
  }
  return r;
}

function elForRef(r) {
  var h = refMap.get(r);
  if (!h) return null;
  return HAS_WEAKREF && h instanceof WeakRef ? h.deref() || null : h;
}

/* Forget refs whose elements were garbage-collected. */
function pruneRefs() {
  if (!HAS_WEAKREF || refMap.size < 5000) return;
  refMap.forEach(function (h, r) { if (!h.deref()) { refMap.delete(r); refInfo.delete(r); } });
}

/* ------------------------------------------------------------------ errors */

function be(code, message) {
  var e = new Error(String(message));
  e.code = code;
  return e;
}

function errToObj(e) {
  if (e && typeof e.code === 'string') return { code: e.code, message: String(e.message || e.code) };
  return { code: 'INTERNAL', message: String((e && e.message) || e) };
}

/* ------------------------------------------------------------------ helpers */

/* The parent in the flat tree: shadow roots hand over to their host. */
function flatParent(n) {
  if (n.parentNode && n.parentNode.nodeType === 11 && n.parentNode.host) return n.parentNode.host;
  var p = n.parentElement || (n.parentNode && n.parentNode.host) || null;
  if (!p && n.ownerDocument && n === n.ownerDocument.documentElement) {
    // The top of a same-origin frame's document: carry on from the <iframe> in the page around it.
    try { p = n.ownerDocument.defaultView.frameElement || null; } catch (e) { p = null; }
  }
  return p;
}

/* Hidden from assistive tech by an ancestor (aria-hidden, inert)? */
function axHidden(el) {
  for (var n = el; n; n = flatParent(n)) {
    if (n.getAttribute && (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert'))) return true;
  }
  return false;
}

function visible(el) {
  if (!el || el.nodeType !== 1) return false; // not instanceof: elements in iframes come from another realm
  if (el.hasAttribute('hidden')) return false;
  if (axHidden(el)) return false;
  return rendered(el, 0);
}

function rendered(el, depth) {
  var cs;
  try { cs = (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch (e) { return true; }
  if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  // display:contents has no box of its own; it shows if any child does.
  if (cs.display === 'contents') {
    if (depth > 8) return true;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (rendered(c, depth + 1)) return true;
    }
    for (var t = el.firstChild; t; t = t.nextSibling) {
      if (t.nodeType === 3 && t.nodeValue && t.nodeValue.trim()) return true;
    }
    return false;
  }
  try {
    var r = el.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) return true;
  } catch (e) { return true; }
  // Zero-rect but focusable/fixed elements (e.g. position:fixed) still count.
  try {
    if (cs.position === 'fixed') return true;
    if (el === el.ownerDocument.activeElement) return true;
  } catch (e) {}
  return false;
}

var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1 };

var HEADING_RE = /^H([1-6])$/;

function inputRole(type) {
  switch (type) {
    case 'checkbox': return 'checkbox';
    case 'radio': return 'radio';
    case 'button': case 'submit': case 'reset': case 'image': return 'button';
    case 'range': return 'slider';
    case 'number': return 'spinbutton';
    case 'search': return 'searchbox';
    case 'password': case 'email': case 'tel': case 'url': case 'text': default: return 'textbox';
  }
}

function tagRole(el, compact) {
  var explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0];
  var tag = el.tagName;
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'INPUT') return inputRole(String(el.type || 'text').toLowerCase());
  if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'IMG') return 'img';
  if (tag === 'FORM') return 'form';
  if (tag === 'TABLE') return 'table';
  if (tag === 'SUMMARY') return 'button';
  if (tag === 'LABEL') return 'label';
  if (tag === 'UL' || tag === 'OL') return 'list';
  if (tag === 'LI') return 'listitem';
  if (tag === 'DETAILS') return 'group';
  if (tag === 'FIELDSET') return 'group';
  if (tag === 'OPTION') return 'option';
  if (tag === 'IFRAME' || tag === 'FRAME') return 'iframe';
  var m = HEADING_RE.exec(tag);
  if (m) return 'heading';
  if (el.isContentEditable) return 'textbox';
  return compact ? '' : 'text';
}

function isInteresting(el) {
  var tag = el.tagName;
  if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
      tag === 'TEXTAREA' || tag === 'FORM' || tag === 'TABLE' || tag === 'IMG' ||
      tag === 'SUMMARY' || tag === 'LABEL' || tag === 'LI' || tag === 'DETAILS' || tag === 'IFRAME' || tag === 'FRAME') return true;
  if (HEADING_RE.test(tag)) return true;
  if (el.hasAttribute && (el.hasAttribute('role') || el.hasAttribute('tabindex') ||
      el.hasAttribute('onclick') || el.isContentEditable)) return true;
  return false;
}

/* Direct-text container for non-compact mode (leaf-ish text blocks). */
function hasDirectText(el) {
  var tag = el.tagName;
  if (/^(DIV|SPAN|P|TD|TH|LI|DT|DD|H[1-6]|BUTTON|A|LABEL|OPTION|LEGEND|CAPTION|FIGCAPTION|BLOCKQUOTE|PRE|CODE|EM|STRONG|SMALL|B|I|U)$/.test(tag)) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
  }
  return false;
}

function textOf(el) {
  try {
    var t = (el.innerText !== undefined) ? el.innerText : el.textContent;
    return String(t || '').trim().replace(/\s+/g, ' ');
  } catch (e) { return ''; }
}

/* A same-origin frame's document, or null (cross-origin, not loaded yet). */
function frameDoc(el) {
  try { var d = el.contentDocument; return d && d.documentElement ? d : null; } catch (e) { return null; }
}

function computeName(el, tag) {
  var labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledby) {
    var parts = [];
    labelledby.trim().split(/\s+/).forEach(function (id) {
      // ids resolve within the element's own (shadow) tree
      var scope = el.getRootNode ? el.getRootNode() : document;
      var lab = (scope && scope.getElementById ? scope : document).getElementById(id);
      if (lab) parts.push(textOf(lab));
    });
    if (parts.length) return parts.join(' ').slice(0, 100);
  }
  var aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim().slice(0, 100);
  if (tag === 'IFRAME' || tag === 'FRAME') {
    var ft = el.getAttribute('title') || el.getAttribute('name') || '';
    return ft.trim().slice(0, 100);
  }
  if (tag === 'IMG' || tag === 'INPUT') {
    var alt = el.getAttribute && el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, 100);
  }
  if (tag === 'INPUT' || tag === 'BUTTON') {
    var t = String(el.type || '').toLowerCase();
    if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) {
      return String(el.value).trim().slice(0, 100);
    }
  }
  if (el.labels && el.labels.length) {
    var lt = textOf(el.labels[0]);
    if (lt) return lt.slice(0, 100);
  }
  var ph = el.getAttribute && el.getAttribute('placeholder');
  var tx = textOf(el);
  if (!tx && ph && ph.trim()) return ph.trim().slice(0, 100);
  if (tx) return tx.slice(0, 100);
  var title = el.getAttribute && el.getAttribute('title');
  if (title && title.trim()) return title.trim().slice(0, 100);
  if (el.id) return '#' + el.id.slice(0, 60);
  return '';
}

/* Same-origin links shown as paths to save tokens; others absolute, capped. */
function shortHref(href) {
  var h = String(href);
  if (/^javascript:/i.test(h)) return '';
  try {
    var u = new URL(h, location.href);
    if (u.origin === location.origin) h = u.pathname + u.search + u.hash;
  } catch (e) {}
  return h.length > 120 ? h.slice(0, 117) + '...' : h;
}

/* --------------------------------------------------------------- snapshot */

/* The snapshot node and line for an element, or null when it has no role worth showing. */
function nodeFor(el, compact) {
  var tag = el.tagName;
  var role = tagRole(el, compact);
  if (!role) return null;
  var name = computeName(el, tag);
  var node = { ref: 0, role: role, name: name };
  var flags = [];
  if (isDisabled(el)) { node.disabled = true; flags.push('[disabled]'); }
  else if (ariaDisabled(el)) { node.disabled = true; flags.push('[disabled]'); }
  if (tag === 'INPUT') {
    var it = String(el.type || 'text').toLowerCase();
    if ((it === 'checkbox' || it === 'radio')) {
      node.checked = !!el.checked;
      flags.push(el.checked ? '[checked]' : '[unchecked]');
    }
    if (el.readOnly) { node.readonly = true; flags.push('[readonly]'); }
    if (typeof el.value === 'string' && el.value && it !== 'checkbox' && it !== 'radio' &&
        it !== 'submit' && it !== 'button' && it !== 'reset' && it !== 'password') {
      node.value = String(el.value).slice(0, 200);
    }
    if (it === 'file') {
      flags.push('[file' + (el.multiple ? 's' : '') + (el.accept ? ' ' + el.accept.slice(0, 40) : '') + ']');
      if (el.files && el.files.length) node.value = Array.prototype.map.call(el.files, function (f) { return f.name; }).join(', ').slice(0, 200);
    }
  }
  if (tag === 'TEXTAREA' && el.value) node.value = String(el.value).slice(0, 200);
  if (tag === 'TEXTAREA' && el.readOnly) { node.readonly = true; flags.push('[readonly]'); }
  if (tag === 'SELECT') {
    try {
      var sel = [];
      for (var oi = 0; oi < el.options.length; oi++) {
        if (el.options[oi].selected) sel.push(el.options[oi].text);
      }
      if (sel.length) node.value = sel.join(', ').slice(0, 200);
    } catch (e) {}
  }
  if (el.isContentEditable && el.textContent) {
    node.value = String(el.textContent).trim().slice(0, 200);
  }
  var ac = el.getAttribute && el.getAttribute('aria-checked');
  if (tag !== 'INPUT' && (ac === 'true' || ac === 'false' || ac === 'mixed')) {
    node.checked = ac === 'mixed' ? 'mixed' : ac === 'true';
    flags.push(ac === 'true' ? '[checked]' : ac === 'mixed' ? '[mixed]' : '[unchecked]');
  }
  var exp = el.getAttribute && el.getAttribute('aria-expanded');
  if (exp === 'true' || exp === 'false') {
    node.expanded = exp === 'true';
    flags.push(exp === 'true' ? '[expanded]' : '[collapsed]');
  }
  var sel2 = el.getAttribute && el.getAttribute('aria-selected');
  if (sel2 === 'true') { node.selected = true; flags.push('[selected]'); }
  var hm = HEADING_RE.exec(tag);
  if (hm) node.level = Number(hm[1]);
  else if (role === 'heading') {
    var al = Number(el.getAttribute('aria-level'));
    if (al >= 1 && al <= 9) node.level = al;
  }
  if (tag === 'A' && el.href) node.href = shortHref(el.href);
  if (role === 'iframe') {
    node.href = shortHref(el.src || '');
    if (!frameDoc(el)) node.crossOrigin = true;
  }
  var ref = refFor(el);
  node.ref = ref;
  refInfo.set(ref, { role: role, name: name });
  var line = '[ref=' + ref + '] ' + role + (name ? ' ' + JSON.stringify(name) : '');
  if (node.value !== undefined && role !== 'heading' && role !== 'link' && role !== 'button') {
    line += ' ' + JSON.stringify(String(node.value).slice(0, 80));
  }
  if (node.level) line += ' [h' + node.level + ']';
  if (node.href) line += ' -> ' + node.href;
  if (flags.length) line += ' ' + flags.join(' ');
  if (node.crossOrigin) line += ' [cross-origin: its content isn\'t in this snapshot; open its URL in a tab to read it]';
  else if (role === 'iframe') line += ' [its content follows]';
  return { node: node, line: line };
}

/* Does el's box overlap its window's viewport? */
function inViewport(el) {
  try {
    var r = el.getBoundingClientRect();
    var w = el.ownerDocument.defaultView || window;
    return r.bottom > 0 && r.right > 0 && r.top < w.innerHeight && r.left < w.innerWidth;
  } catch (e) { return true; }
}

function scrollInfo() {
  var r = scrollRoot();
  return { y: Math.round(window.scrollY), viewportHeight: window.innerHeight, pageHeight: r ? r.scrollHeight : 0 };
}

/* The outline: one line per interesting element. `root` limits it to one part of
   the page; `viewportOnly` keeps only what is on screen now. */
function buildSnapshot(compact, maxChars, root, viewportOnly) {
  generation += 1;
  pruneRefs();
  var genId = 'g' + generation + '-' + docId + '-' + Date.now().toString(36);
  generations.add(genId);

  var nodes = [];
  var lines = [];
  var len = 0;
  var truncated = false;

  root = root || document.body || document.documentElement;
  if (!root) {
    return { generation: genId, url: location.href, title: document.title || '', truncated: false, nodes: [], text: '' };
  }

  // Walk light DOM plus open shadow roots (web components hide most of
  // their UI there, e.g. YouTube, GitHub, Reddit) and same-origin frames.
  // Stops once the text budget is spent, so huge pages don't cost a full walk.
  var stack = [root];
  outer:
  while (stack.length) {
  var walker = document.createTreeWalker(stack.pop(), NodeFilter.SHOW_ELEMENT, null);
  var el = walker.currentNode;
  while (el) {
    var tag = el.tagName;
    if (el.shadowRoot) stack.push(el.shadowRoot);
    var fdoc = (tag === 'IFRAME' || tag === 'FRAME') ? frameDoc(el) : null;
    if (fdoc && fdoc.body && visible(el) && (!viewportOnly || inViewport(el))) stack.push(fdoc.body);
    if (tag && !SKIP_TAGS[tag]) {
      var interesting = isInteresting(el);
      var include = interesting || (!compact && hasDirectText(el));
      if (include && visible(el) && (!viewportOnly || inViewport(el))) {
        var nl = nodeFor(el, compact);
        if (nl) {
          var add = nl.line.length + (lines.length ? 1 : 0);
          if (len + add > maxChars) { truncated = true; break outer; }
          len += add;
          nodes.push(nl.node);
          lines.push(nl.line);
        }
      }
    }
    el = walker.nextNode();
  }
  }

  return {
    generation: genId,
    url: location.href,
    title: document.title || '',
    truncated: truncated,
    nodes: nodes,
    text: lines.join('\n'),
    scroll: scrollInfo()
  };
}

/* ------------------------------------------------------------------ targets */

/* Refs are stable for the life of the document, so any generation issued here
   is fine. An unknown one means the snapshot came from another page load. */
function checkGeneration(msg) {
  if (msg.generation !== undefined && msg.generation !== null && msg.generation !== '' &&
      !generations.has(String(msg.generation))) {
    throw be('REF_STALE', 'That snapshot is from a different page load (the page navigated or reloaded). Take a new page_snapshot.');
  }
}

function given(v) { return v !== undefined && v !== null && v !== ''; }

/* Does the message name a target (ref, selector, name/role or a point)? */
function hasTarget(msg) {
  return given(msg.ref) || given(msg.selector) || given(msg.name) || given(msg.role) || (given(msg.x) && given(msg.y));
}

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

/* All elements matching a CSS selector, in document order, looking into open
   shadow roots and same-origin frames too. */
function deepSelectAll(sel) {
  var out = [];
  (function walk(root) {
    var all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.matches(sel)) out.push(e);
      if (e.shadowRoot) walk(e.shadowRoot);
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') { var d = frameDoc(e); if (d) walk(d); }
    }
  })(document);
  return out;
}

function checkSelector(sel) {
  try { document.querySelector(sel); } catch (e) { throw be('INVALID_PARAMS', 'Bad CSS selector: ' + sel); }
}

/* The first visible match of a selector (else the first match), anywhere on the page. */
function deepSelect(sel) {
  checkSelector(sel);
  var fast = null;
  try { fast = document.querySelector(sel); } catch (e) {}
  if (fast && visible(fast)) return fast;
  var all = deepSelectAll(sel);
  for (var i = 0; i < all.length; i++) if (visible(all[i])) return all[i];
  return fast || all[0] || null;
}

/* The innermost element at a viewport point, inside open shadow roots and same-origin frames. */
function deepPoint(x, y) {
  var doc = document, el = null;
  for (var depth = 0; depth < 10; depth++) {
    var hit = doc.elementFromPoint(x, y);
    if (!hit) break;
    while (hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
      var inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    el = hit;
    if (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME') break;
    var fd = frameDoc(hit);
    if (!fd) break;
    var r = hit.getBoundingClientRect();
    x -= r.left + hit.clientLeft; y -= r.top + hit.clientTop;
    doc = fd;
  }
  return el;
}

var ACTION_ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|textbox|searchbox|slider|spinbutton|treeitem|gridcell|listbox)$/;
var CLICKABLE_SEL = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], ' +
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], ' +
  '[role="switch"], [role="treeitem"], [onclick], [tabindex]:not([tabindex="-1"])';

function actionable(el) {
  if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
      el.tagName === 'TEXTAREA' || el.tagName === 'SUMMARY' || el.isContentEditable) return true;
  return ACTION_ROLES.test(tagRole(el, false)) || (el.hasAttribute && el.hasAttribute('onclick'));
}

/* The nearest clickable element at or above el (text often sits in a span inside the button). */
function clickableAncestor(el) {
  for (var n = el, i = 0; n && n.nodeType === 1 && i < 6; n = flatParent(n), i++) {
    try { if (n.matches(CLICKABLE_SEL)) return n; } catch (e) {}
  }
  return null;
}

/* Cheap pre-check before computing an accessible name. */
function mayHaveName(el, needle) {
  if (el.hasAttribute('aria-labelledby') || (el.labels && el.labels.length)) return true;
  if (norm(el.textContent).indexOf(needle) >= 0) return true;
  var attrs = ['aria-label', 'placeholder', 'title', 'alt', 'value', 'name'];
  for (var i = 0; i < attrs.length; i++) if (norm(el.getAttribute(attrs[i])).indexOf(needle) >= 0) return true;
  return false;
}

function roleMatches(el, want) {
  var r = tagRole(el, false);
  if (r === want) return true;
  if (want === 'textbox') return r === 'searchbox' || (r === 'combobox' && el.tagName === 'INPUT');
  return false;
}

function prefers(kind, el) {
  if (kind === 'type' || kind === 'fill' || kind === 'upload') {
    return isEditableField(el) || inputType(el) === 'file' || (el.tagName === 'LABEL' && !!el.control);
  }
  return actionable(el);
}

/* Elements whose accessible name matches msg.name (exact beats contained), with
   msg.role as a filter. Falls back to visible text for elements with no role. */
function byName(msg, kind) {
  var needle = norm(msg.name);
  var wantRole = given(msg.role) ? String(msg.role).trim().toLowerCase() : '';
  var exact = [], partial = [];
  var stack = [document.body || document.documentElement];
  while (stack.length) {
    var root = stack.pop();
    if (!root) continue;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    for (var el = walker.currentNode; el; el = walker.nextNode()) {
      if (el.shadowRoot) stack.push(el.shadowRoot);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') { var fd = frameDoc(el); if (fd && fd.body) stack.push(fd.body); }
      if (el.nodeType !== 1 || SKIP_TAGS[el.tagName]) continue;
      if (wantRole ? !roleMatches(el, wantRole) : !isInteresting(el)) continue;
      if (needle && !mayHaveName(el, needle)) continue;
      if (!visible(el)) continue;
      var nm = needle ? norm(computeName(el, el.tagName)) : '';
      if (!needle || nm === needle) exact.push(el);
      else if (nm.indexOf(needle) >= 0) partial.push(el);
    }
  }
  var list = exact.length ? exact : partial;
  if (!list.length && needle && !wantRole) list = byText(needle);
  // A list item and the link inside it often share a name: keep the innermost.
  list = list.filter(function (a) { return !list.some(function (b) { return b !== a && flatContains(a, b); }); });
  var pref = list.filter(function (e) { return prefers(kind, e); });
  return pref.length ? pref : list;
}

/* Visible text containing needle, mapped to its clickable ancestor (or the text's own element). */
function byText(needle) {
  var out = [];
  (function walk(r) {
    var walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (n.shadowRoot) walk(n.shadowRoot);
        if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') { var fd = frameDoc(n); if (fd && fd.body) walk(fd.body); }
        continue;
      }
      var parent = n.parentElement;
      if (!parent || SKIP_TAGS[parent.tagName]) continue;
      if (norm(n.nodeValue).indexOf(needle) < 0 || !visible(parent)) continue;
      var el = clickableAncestor(parent) || parent;
      if (out.indexOf(el) < 0) out.push(el);
      if (out.length >= 50) return;
    }
  })(document.body || document.documentElement);
  return out;
}

/* A short line naming el for an error or a change list: its snapshot line when it has a role. */
function lineFor(el) {
  try { var nl = nodeFor(el, true); if (nl) return nl.line; } catch (e) {}
  return '[ref=' + refFor(el) + '] ' + describe(el) + quoted(textOf(el));
}

function describeTarget(msg) {
  if (given(msg.ref)) return 'ref ' + msg.ref;
  if (given(msg.selector)) return 'selector ' + JSON.stringify(String(msg.selector));
  if (given(msg.x) && given(msg.y)) return 'point (' + msg.x + ', ' + msg.y + ')';
  return (given(msg.role) ? String(msg.role) + ' ' : '') + (given(msg.name) ? JSON.stringify(String(msg.name)) : '');
}

/* One attempt at finding the target. Returns the element, or null when it isn't
 * on the page (yet); throws when the request itself is wrong or ambiguous. */
function findTarget(msg, kind) {
  checkGeneration(msg);
  if (given(msg.ref)) {
    var r = Number(msg.ref);
    var el = elForRef(r);
    if (el && el.isConnected) return el;
    var info = refInfo.get(r);
    if (!el && !info) {
      throw be('REF_NOT_FOUND', 'Unknown ref ' + msg.ref + ' on this page (refs come from page_snapshot on the current page). Take a new page_snapshot.');
    }
    // Re-rendered (React and friends replace nodes): the element with the same role and name, if exactly one.
    if (info && info.name) {
      var same = byName({ name: info.name, role: info.role }, kind).filter(function (e) {
        return norm(computeName(e, e.tagName)) === norm(info.name);
      });
      if (same.length === 1) {
        msg._notes = (msg._notes || []).concat('ref ' + r + ' was re-rendered by the page; used ' + describe(same[0]) + ', which has the same role and name.');
        return same[0];
      }
    }
    return null;
  }
  if (given(msg.selector)) return deepSelect(String(msg.selector));
  if (given(msg.x) && given(msg.y)) {
    var x = Number(msg.x), y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw be('INVALID_PARAMS', 'x and y must be numbers (CSS pixels from the viewport\'s top-left).');
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      throw be('INVALID_PARAMS', 'Point (' + x + ', ' + y + ') is outside the viewport (' + window.innerWidth + 'x' + window.innerHeight + ').');
    }
    return deepPoint(x, y);
  }
  if (given(msg.name) || given(msg.role)) {
    var found = byName(msg, kind);
    if (given(msg.nth)) {
      var k = Number(msg.nth);
      if (!(k >= 1)) throw be('INVALID_PARAMS', 'nth counts from 1.');
      if (k > found.length) {
        if (!found.length) return null;
        throw be('NO_MATCH', 'Only ' + found.length + ' element(s) match ' + describeTarget(msg) + ', so there is no nth=' + k + '.');
      }
      return found[k - 1];
    }
    if (found.length > 1) {
      var lines = found.slice(0, 8).map(lineFor);
      throw be('AMBIGUOUS', found.length + ' elements match ' + describeTarget(msg) + ':\n' + lines.join('\n') +
        (found.length > 8 ? '\n…' : '') + '\nPass one of these refs, add role, or pass nth (1 = first).');
    }
    return found[0] || null;
  }
  return null;
}

/* Find the target, waiting up to msg.waitMs (default 3s) for it to appear. */
async function locate(msg, kind) {
  if (!hasTarget(msg)) throw be('INVALID_PARAMS', 'Say which element: ref (from page_snapshot), name (its label or text, optionally with role), or selector.');
  var waitMs = given(msg.waitMs) ? Math.max(0, Math.min(Number(msg.waitMs) || 0, 30000)) : 3000;
  var start = Date.now();
  for (;;) {
    var el = findTarget(msg, kind);
    if (el) return el;
    if (Date.now() - start >= waitMs) break;
    checkCancel(msg);
    await sleep(150);
  }
  if (given(msg.ref)) {
    throw be('REF_STALE', 'ref ' + msg.ref + ' was removed from the page' + (refInfo.get(Number(msg.ref)) ? ' and nothing with the same role and name replaced it' : '') +
      '. Take a new page_snapshot.');
  }
  throw be('REF_NOT_FOUND', 'Nothing matches ' + describeTarget(msg) + (waitMs ? ' (waited ' + Math.round(waitMs / 100) / 10 + 's)' : '') +
    '. Check page_snapshot or page_find for the exact wording.');
}

/* Synchronous best effort for the cursor: the target if it's already there. */
function peekTarget(msg, kind) {
  try { return hasTarget(msg) ? findTarget(Object.assign({}, msg), kind) : null; } catch (e) { return null; }
}

function isDisabled(el) {
  try { if (el.matches(':disabled')) return true; } catch (e) {}
  return false;
}

function ariaDisabled(el) {
  for (var n = el; n && n.getAttribute; n = flatParent(n)) {
    if (n.getAttribute('aria-disabled') === 'true') return true;
  }
  return false;
}

function assertEnabled(el, what) {
  if (isDisabled(el)) throw be('ELEMENT_DISABLED', describe(el) + ' is disabled; ' + what + ' would do nothing.');
}

/* Is `anc` an ancestor of `el` in the flat tree (crossing shadow roots)? */
function flatContains(anc, el) {
  for (var n = el; n; n = flatParent(n)) if (n === anc) return true;
  return false;
}

/* In an inert subtree, or outside an open modal dialog: no user can reach it. */
function isInert(el) {
  for (var n = el; n; n = flatParent(n)) {
    if (n.hasAttribute && n.hasAttribute('inert')) return true;
  }
  var modal = null;
  try { modal = document.querySelector('dialog:modal'); } catch (e) {}
  return !!(modal && !flatContains(modal, el));
}

function assertActionable(el, what) {
  if (!el.isConnected) throw be('REF_STALE', describe(el) + ' was removed from the page. Take a new page_snapshot.');
  assertEnabled(el, what);
  if (isInert(el)) {
    throw be('NOT_INTERACTABLE', describe(el) + ' is inert (behind a modal dialog or in an inert region), so a user couldn\'t reach it; ' + what + ' was not done.');
  }
}

function mouseEvent(type, opts) {
  var init = { bubbles: true, cancelable: true, composed: true, view: window };
  if (opts) for (var k in opts) init[k] = opts[k];
  var ev;
  try { ev = new MouseEvent(type, init); }
  catch (e) {
    ev = document.createEvent('MouseEvents');
    ev.initMouseEvent(type, true, true, window, 1, 0, 0, 0, 0,
      !!(opts && opts.ctrlKey), !!(opts && opts.altKey), !!(opts && opts.shiftKey),
      !!(opts && opts.metaKey), (opts && opts.button) || 0, null);
  }
  return ev;
}

/* ------------------------------------------------------------------ actions */

function refOf(el) {
  return el && el.nodeType === 1 ? refFor(el) : undefined;
}

/* What a user's pointer would hit at el's centre, when that's something else
   (a cookie banner, an overlay, a spinner). */
function coveredBy(el) {
  if (el.ownerDocument !== document) return null;
  var r = el.getBoundingClientRect();
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;
  var hit = deepPoint(cx, cy);
  if (!hit || hit === el || flatContains(el, hit) || flatContains(hit, el)) return null;
  // A <label> for the element, or an element it controls, is fine.
  if (hit.tagName === 'LABEL' && hit.control === el) return null;
  return hit;
}

/* Press and release at a point on el, then the click itself (or dblclick/contextmenu). */
function pressOn(el, pos, btnCode) {
  var ptr = function (type) {
    try { el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true }, pos))); } catch (e) {}
  };
  ptr('pointerover');
  el.dispatchEvent(mouseEvent('mouseover', pos));
  ptr('pointermove');
  el.dispatchEvent(mouseEvent('mousemove', pos));
  ptr('pointerdown');
  el.dispatchEvent(mouseEvent('mousedown', Object.assign({ buttons: btnCode === 2 ? 2 : btnCode === 1 ? 4 : 1 }, pos)));
  var f = el.closest ? (el.closest('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]') || el) : el;
  try { f.focus({ preventScroll: true }); } catch (e) { try { f.focus(); } catch (e2) {} }
  ptr('pointerup');
  el.dispatchEvent(mouseEvent('mouseup', pos));
}

async function doClick(msg, target) {
  var el = target || await locate(msg, 'click');
  var atPoint = !target && !given(msg.ref) && !given(msg.selector) && !given(msg.name) && !given(msg.role);
  assertActionable(el, 'clicking it');
  var button = (msg.button || 'left').toLowerCase();
  var btnCode = button === 'middle' ? 1 : (button === 'right' ? 2 : 0);
  var mods = normalizeMods(msg.modifiers);
  var pos;
  if (atPoint) {
    pos = { clientX: Number(msg.x), clientY: Number(msg.y) };
  } else {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    var rect = el.getBoundingClientRect();
    pos = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  }
  pos = Object.assign({ button: btnCode, detail: 1 }, mods, pos);
  var cover = atPoint ? null : coveredBy(el);
  pressOn(el, pos, btnCode);
  // The page's pointer handlers ran: it may have removed or disabled the element.
  if (!el.isConnected || isDisabled(el)) {
    return { clicked: false, ref: refOf(el), note: 'The page ' + (el.isConnected ? 'disabled' : 'removed') + ' the element while it was being pressed, so the click didn\'t complete.' };
  }
  if (btnCode === 2) {
    el.dispatchEvent(mouseEvent('contextmenu', pos));
  } else if (btnCode === 1) {
    el.dispatchEvent(mouseEvent('auxclick', pos));
  } else if (typeof el.click === 'function' && !atPoint && !mods.ctrlKey && !mods.shiftKey && !mods.metaKey && !mods.altKey) {
    // Exactly one click: el.click() fires the click event AND runs default
    // actions (follow link, toggle checkbox, submit). Dispatching a synthetic
    // 'click' as well would double-toggle checkboxes and double-submit forms.
    el.click();
  } else {
    // At a point (canvas apps read clientX/Y) or with modifiers: a positioned click event.
    // Dispatching it still runs the default action of a link or input it lands in.
    el.dispatchEvent(mouseEvent('click', pos));
  }
  if (msg.double && btnCode === 0 && el.isConnected) {
    pressOn(el, Object.assign({}, pos, { detail: 2 }), 0);
    el.dispatchEvent(mouseEvent('click', Object.assign({}, pos, { detail: 2 })));
    el.dispatchEvent(mouseEvent('dblclick', Object.assign({}, pos, { detail: 2 })));
  }
  var out = { clicked: true, ref: refOf(el) };
  if (atPoint) out.hit = lineFor(el);
  if (ariaDisabled(el)) out.warning = 'The element is marked aria-disabled, so the page may have ignored the click.';
  else if (cover) {
    out.warning = 'Something else covers this element: ' + lineFor(cover) + '. The click went to the element anyway; ' +
      'if nothing happened, close that overlay (or click it) first.';
  }
  return out;
}

/* ------------------------------------------------------------ field values */

var NON_TEXT_INPUTS = { button: 1, submit: 1, reset: 1, image: 1, file: 1, hidden: 1 };

function inputType(el) {
  return el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
}

function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    var t = inputType(el);
    return !NON_TEXT_INPUTS[t] && t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'color';
  }
  return false;
}

/* The element that will actually take a value. A ref to a wrapper with exactly
   one field inside resolves to that field; anything else non-editable throws. */
function editableTarget(el) {
  if (el.tagName === 'LABEL' && el.control) el = el.control;
  var tag = el.tagName;
  var ok = el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT' ||
    (tag === 'INPUT' && !NON_TEXT_INPUTS[inputType(el)]);
  if (!ok) {
    var inner = el.querySelectorAll ? el.querySelectorAll(
      'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]),' +
      'textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') : [];
    if (inner.length === 1) el = inner[0];
    else {
      var what = tag === 'INPUT' ? 'a ' + inputType(el) + ' input' : describe(el);
      throw be('NOT_EDITABLE', describe(el) + ' is ' + (what === describe(el) ? 'not a text field' : what) +
        ', so it can\'t take a value' + (inputType(el) === 'file' ? ' (use page_upload)' : tag === 'BUTTON' || NON_TEXT_INPUTS[inputType(el)] ? ' (use page_click)' : '') + '.');
    }
  }
  if (isDisabled(el)) throw be('ELEMENT_DISABLED', describe(el) + ' is disabled.');
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.readOnly) {
    throw be('NOT_EDITABLE', describe(el) + ' is read-only.');
  }
  if (isInert(el)) throw be('NOT_INTERACTABLE', describe(el) + ' is inert (behind a modal dialog or in an inert region).');
  return el;
}

var TRUE_WORDS = { 'true': 1, on: 1, '1': 1, yes: 1, checked: 1, check: 1, y: 1 };
var FALSE_WORDS = { 'false': 1, off: 1, '0': 1, no: 1, unchecked: 1, uncheck: 1, n: 1, '': 1 };

function parseChecked(v) {
  var s = String(v).trim().toLowerCase();
  if (TRUE_WORDS[s]) return true;
  if (FALSE_WORDS[s]) return false;
  throw be('INVALID_PARAMS', 'A checkbox or radio takes true/false (or on/off, yes/no, checked/unchecked), not ' + JSON.stringify(String(v)) + '.');
}

/* Disabled itself or by its <optgroup>. */
function optionDisabled(o) {
  if (o.disabled) return true;
  var g = o.parentElement;
  return !!(g && g.tagName === 'OPTGROUP' && g.disabled);
}

/* Indices of the <option>s to select: exact value, then exact label, then the
   same ignoring case. Throws NO_MATCH listing what's available. */
function matchOptions(el, values) {
  if (!el.multiple && values.length > 1) {
    throw be('INVALID_PARAMS', describe(el) + ' allows only one option; got ' + values.length + '.');
  }
  var opts = el.options;
  var label = function (o) { return String(o.label || o.text || '').replace(/\s+/g, ' ').trim(); };
  var out = [];
  values.forEach(function (raw) {
    var v = String(raw);
    var tests = [
      function (o) { return o.value === v; },
      function (o) { return label(o) === v.trim(); },
      function (o) { return o.value.toLowerCase() === v.trim().toLowerCase(); },
      function (o) { return label(o).toLowerCase() === v.trim().toLowerCase(); }
    ];
    for (var t = 0; t < tests.length; t++) {
      for (var i = 0; i < opts.length; i++) {
        if (!optionDisabled(opts[i]) && tests[t](opts[i])) { out.push(i); return; }
      }
    }
    var avail = [];
    for (var j = 0; j < opts.length && avail.length < 30; j++) {
      var l = label(opts[j]);
      avail.push(JSON.stringify(opts[j].value) + (l && l !== opts[j].value ? ' (' + l + ')' : '') +
        (optionDisabled(opts[j]) ? ' [disabled]' : ''));
    }
    throw be('NO_MATCH', 'No option matches ' + JSON.stringify(v) + ' in ' + describe(el) + '. Options: ' +
      avail.join(', ') + (opts.length > 30 ? ', …' : '') + '.');
  });
  return out;
}

/* Throws if `value` can't be applied to `el`, without touching the page. */
function checkValue(el, value) {
  var t = inputType(el);
  if (t === 'checkbox' || t === 'radio') {
    var want = parseChecked(value);
    if (t === 'radio' && !want && el.checked) {
      throw be('NOT_SUPPORTED', describe(el) + ' is a selected radio button; select a different option in its group instead.');
    }
  } else if (el.tagName === 'SELECT') {
    matchOptions(el, el.multiple ? String(value).split(/\s*,\s*/) : [String(value)]);
  }
}

function fireInput(el, inputType, data) {
  var ev;
  try {
    ev = new InputEvent('input', { bubbles: true, composed: true, inputType: inputType || 'insertText', data: data === undefined ? null : data });
  } catch (e) { ev = new Event('input', { bubbles: true, composed: true }); }
  el.dispatchEvent(ev);
}

function fireChange(el) {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function nativeSetValue(el, text) {
  try {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  } catch (e) { el.value = text; }
}

function selectIndices(el, idx) {
  if (el.multiple) {
    for (var i = 0; i < el.options.length; i++) el.options[i].selected = idx.indexOf(i) >= 0;
  } else {
    el.selectedIndex = idx[0];
  }
  fireInput(el);
  fireChange(el);
}

/* Apply a value to an element already checked by editableTarget/checkValue.
   Returns a short note when the outcome isn't simply "value set". */
function setValue(el, text) {
  checkValue(el, text);
  var type = inputType(el);
  if (type === 'checkbox' || type === 'radio') {
    try { el.focus(); } catch (e) {}
    var want = parseChecked(text);
    // click() runs the page's handlers; only click when the state must change.
    if (el.checked !== want) el.click();
    if (el.checked !== want) throw be('NOT_SUPPORTED', 'The page kept ' + describe(el) + (el.checked ? ' checked' : ' unchecked') + '.');
    return;
  }
  if (el.tagName === 'SELECT') {
    try { el.focus(); } catch (e) {}
    selectIndices(el, matchOptions(el, el.multiple ? String(text).split(/\s*,\s*/) : [String(text)]));
    return;
  }
  if (el.isContentEditable) {
    try { el.focus(); } catch (e) {}
    try {
      var sel = window.getSelection();
      if (sel) {
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
    var inserted = false;
    try {
      inserted = text === '' ? document.execCommand('delete', false) : document.execCommand('insertText', false, text);
    } catch (e) { inserted = false; }
    if (!inserted) {
      el.textContent = text;
      fireInput(el, 'insertText', text);
    }
    return;
  }
  try { el.focus(); } catch (e) {}
  // Native value setter so React/Vue controlled inputs notice the change.
  nativeSetValue(el, text);
  fireInput(el, 'insertText', text);
  fireChange(el);
}

/* ---------------------------------------------------------------- submit */

/* Dispatch a key down/press/up on el. Returns true if the page cancelled keydown or keypress. */
function keySequence(el, key, init) {
  var opts = Object.assign({ key: key, bubbles: true, cancelable: true, composed: true }, init || {});
  var down = new KeyboardEvent('keydown', opts);
  el.dispatchEvent(down);
  var handled = down.defaultPrevented;
  if (!handled && (key.length === 1 || key === 'Enter')) {
    var press = new KeyboardEvent('keypress', opts);
    el.dispatchEvent(press);
    handled = press.defaultPrevented;
  }
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return handled;
}

function pressEnter(el) {
  return keySequence(el, 'Enter', { code: 'Enter', keyCode: 13, which: 13 });
}

/* The visible text of a field, to tell whether a submit consumed it. */
function fieldText(el) {
  if (el.isContentEditable) return (el.innerText || el.textContent || '').trim();
  return el.value !== undefined ? String(el.value).trim() : '';
}

function isEditableField(n) {
  return n.isContentEditable || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' ||
    (n.tagName === 'INPUT' && !NON_TEXT_INPUTS[inputType(n)]);
}

/* A form's default (first) submit button, like implicit submission uses. */
function formSubmitButton(form) {
  var els = form.elements;
  for (var i = 0; i < els.length; i++) {
    var b = els[i];
    if ((b.tagName === 'BUTTON' && (b.type || 'submit') === 'submit') ||
        (b.tagName === 'INPUT' && (b.type === 'submit' || b.type === 'image'))) return b;
  }
  return null;
}

var SEND_LABEL = /^(send|submit|post|reply|search|go|ask)\b|send (message|prompt)|submit/i;

var REGION_SEL = 'form, main, aside, nav, header, footer, section, article, dialog, [role="main"], [role="complementary"], ' +
  '[role="navigation"], [role="region"], [role="dialog"], [role="search"], [role="banner"], [role="contentinfo"]';

/* The nearest landmark/section/form/dialog around el, or null. */
function regionOf(el) {
  for (var n = flatParent(el); n; n = flatParent(n)) {
    try { if (n.matches(REGION_SEL)) return n; } catch (e) {}
  }
  return null;
}

function buttonLabel(b) {
  return (b.getAttribute('aria-label') || b.title || b.value || b.textContent || '').replace(/\s+/g, ' ').trim();
}

/* The Send-like button in the field's own composer (chat apps often have no
 * <form>). Climbs a few ancestors, never past the field's region or a level
 * holding another field, and ignores buttons that belong to some form.
 * Returns {button}, {ambiguous: [descriptions]} or null. */
function composerButton(el) {
  var region = regionOf(el);
  var p = el;
  for (var i = 0; i < 8; i++) {
    p = flatParent(p);
    if (!p || p === document.body || p === document.documentElement) break;
    var fields = p.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    var other = false;
    for (var f = 0; f < fields.length; f++) {
      var n = fields[f];
      if (n !== el && !el.contains(n) && !n.contains(el) && isEditableField(n) && visible(n)) { other = true; break; }
    }
    if (other) break;
    var found = [];
    var cands = p.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (var j = 0; j < cands.length; j++) {
      var b = cands[j];
      if (b === el || !visible(b) || isInert(b)) continue;
      if (b.form || (b.closest && b.closest('form'))) continue;
      var tid = b.getAttribute('data-testid') || '';
      if (SEND_LABEL.test(buttonLabel(b)) || /send-button|submit-button/i.test(tid)) found.push(b);
    }
    if (found.length === 1) return { button: found[0] };
    if (found.length > 1) {
      return { ambiguous: found.slice(0, 5).map(function (b) { return describe(b) + quoted(buttonLabel(b)); }) };
    }
    if (p === region) break;
  }
  return null;
}

/* Apps often enable the button only after reacting to the input event. */
async function whenEnabled(b, msg) {
  for (var t = 0; t < 10 && (isDisabled(b) || ariaDisabled(b)); t++) {
    await sleep(100);
    checkCancel(msg);
  }
  return !isDisabled(b) && !ariaDisabled(b);
}

/* The first field that would block submission, like the browser checks it. */
function invalidField(form, btn) {
  if (form.noValidate || (btn && btn.formNoValidate)) return null;
  var els = form.elements;
  for (var i = 0; i < els.length; i++) {
    var f = els[i];
    if (f.willValidate && f.validity && !f.validity.valid) return f;
  }
  return null;
}

/* Click a submit button; any failure becomes a note (the text is already typed). */
async function clickSubmit(btn) {
  try {
    var r = await doClick({}, btn);
    if (r.clicked === false) return { submitted: false, note: r.note };
  } catch (e) {
    return { submitted: false, note: e.message };
  }
  return { submitted: 'button', via: describe(btn) };
}

/* An explicit submit button from msg.submitRef / submitSelector / submitName, or null. */
async function submitTarget(msg) {
  if (!given(msg.submitRef) && !given(msg.submitSelector) && !given(msg.submitName)) return null;
  try {
    return await locate({ ref: msg.submitRef, selector: msg.submitSelector, name: msg.submitName, generation: msg.generation, opId: msg.opId, waitMs: 1000 }, 'click');
  } catch (e) {
    throw be(e.code || 'INVALID_PARAMS', 'Submit target: ' + e.message + ' Nothing was typed.');
  }
}

/* Submit like a user would, using exactly one mechanism chosen up front, so
 * nothing is ever sent twice:
 *  - an explicit submit button (submitRef/submitSelector): click it;
 *  - in a form: click its submit button, or requestSubmit if it has none;
 *  - outside a form (chat composers): click the composer's own Send button,
 *    or press Enter once if there is none.
 * Returns {submitted, via?, note?}. */
async function submitField(el, msg, explicit) {
  msg = msg || {};
  checkCancel(msg);
  if (explicit) {
    if (!(await whenEnabled(explicit, msg))) {
      return { submitted: false, note: describe(explicit) + ' stayed disabled; the page may consider the input incomplete.' };
    }
    return await clickSubmit(explicit);
  }
  var form = el.form || (el.closest && el.closest('form'));
  if (form) {
    var btn = formSubmitButton(form);
    if (btn && !(await whenEnabled(btn, msg))) {
      return { submitted: false, note: 'The form\'s submit button (' + describe(btn) + ') is disabled; the page may consider the form incomplete.' };
    }
    var bad = invalidField(form, btn);
    if (bad) {
      var badName = shortName(bad);
      return { submitted: false, note: describe(bad) + (badName && badName !== '#' + bad.id ? quoted(badName) : '') + ' is invalid' +
        (bad.validationMessage ? ' (' + bad.validationMessage + ')' : '') + ', so the form wasn\'t submitted.' };
    }
    checkCancel(msg);
    var fired = false;
    var onSubmit = function (e) { if (e.target === form) fired = true; };
    window.addEventListener('submit', onSubmit, true);
    form.addEventListener('submit', onSubmit, true); // forms in shadow roots
    var out;
    try {
      if (btn) out = await clickSubmit(btn);
      else if (typeof form.requestSubmit === 'function') { form.requestSubmit(); out = { submitted: 'form' }; }
      else { form.submit(); return { submitted: 'form' }; }
    } finally {
      window.removeEventListener('submit', onSubmit, true);
      form.removeEventListener('submit', onSubmit, true);
    }
    if (out.submitted && !fired) {
      out.note = 'No submit event fired, so the page handled the click itself or ignored it. Check the page before retrying.';
    }
    return out;
  }
  var cb = composerButton(el);
  if (cb && cb.ambiguous) {
    return { submitted: false, note: 'Several Send-like buttons are next to this field: ' + cb.ambiguous.join(', ') +
      '. Pass submitRef (or submitSelector) to pick one.' };
  }
  if (cb) {
    if (!(await whenEnabled(cb.button, msg))) {
      return { submitted: false, note: describe(cb.button) + ' stayed disabled; the page may consider the input incomplete.' };
    }
    return await clickSubmit(cb.button);
  }
  checkCancel(msg);
  var before = fieldText(el);
  var url = location.href;
  var handled = pressEnter(el);
  await sleep(300);
  if (handled || location.href !== url || !el.isConnected || fieldText(el) !== before) {
    return { submitted: 'enter' };
  }
  return {
    submitted: false,
    note: 'Pressed Enter once but saw no reaction (field and URL unchanged), and there is no form or Send button next to this field. ' +
      'Check the page with page_snapshot before retrying, since it may still be sending; to use a button, pass submitRef.'
  };
}

async function doType(msg) {
  var el;
  if (hasTarget(msg)) el = editableTarget(await locate(msg, 'type'));
  else {
    el = deepActive();
    if (!el || el === document.body || el === document.documentElement) {
      throw be('NOT_EDITABLE', 'Nothing has focus to type into. Pass the field (ref, or name such as its label or placeholder).');
    }
    el = editableTarget(el);
  }
  var text = (msg.text === undefined || msg.text === null) ? '' : String(msg.text);
  var explicit = await submitTarget(msg);
  checkCancel(msg);
  if (msg.append && isTextField(el) && !el.isContentEditable) text = String(el.value) + text;
  else if (msg.append && el.isContentEditable) text = (el.innerText || '').replace(/\n$/, '') + text;
  setValue(el, text);
  var out = { typed: true, ref: refOf(el) };
  if (isTextField(el) && inputType(el) !== 'password' && fieldText(el) !== text.trim()) {
    out.value = fieldText(el).slice(0, 200);
    out.note = 'The page changed the value after typing.';
  }
  if (msg.submit || explicit) Object.assign(out, await submitField(el, msg, explicit));
  return out;
}

function fieldSpec(f, msg) {
  return { ref: f.ref, selector: f.selector, name: f.name, role: f.role, nth: f.nth, generation: msg.generation, opId: msg.opId };
}

async function doFillForm(msg) {
  var fields = msg.fields || [];
  if (!fields.length) throw be('INVALID_PARAMS', 'page_fill needs at least one field');
  // Resolve and check every field before changing anything.
  var targets = [];
  for (var j = 0; j < fields.length; j++) {
    try {
      var spec = fieldSpec(fields[j], msg);
      if (!hasTarget(spec)) throw be('INVALID_PARAMS', 'needs a ref, name or selector');
      var el0 = editableTarget(await locate(Object.assign(spec, { waitMs: j ? 500 : 3000 }), 'fill'));
      checkValue(el0, fields[j].value === undefined || fields[j].value === null ? '' : String(fields[j].value));
      if (targets.indexOf(el0) >= 0) throw be('INVALID_PARAMS', 'is the same field as fields[' + targets.indexOf(el0) + ']');
      targets.push(el0);
    } catch (e) {
      throw be(e.code || 'INVALID_PARAMS', 'fields[' + j + ']: ' + e.message + ' Nothing was filled.');
    }
  }
  var explicit = await submitTarget(msg);
  for (var i = 0; i < targets.length; i++) {
    try {
      checkCancel(msg);
      // Earlier writes can make the page re-render: find the field again.
      var f = fields[i];
      var v = f.value === undefined || f.value === null ? '' : String(f.value);
      var el = targets[i].isConnected ? targets[i] : editableTarget(await locate(Object.assign(fieldSpec(f, msg), { waitMs: 1000 }), 'fill'));
      checkValue(el, v);
      setValue(el, v);
      targets[i] = el;
    } catch (e) {
      throw be(e.code || 'INTERNAL', 'fields[' + i + ']: ' + e.message + ' Filled ' + i + ' of ' + targets.length +
        ' fields before this one; the rest were not changed.');
    }
  }
  var out = { filled: targets.length, refs: targets.map(refOf) };
  if (msg.submit || explicit) Object.assign(out, await submitField(targets[targets.length - 1], msg, explicit));
  return out;
}

/* Visible options of a custom (ARIA) dropdown: inside its listbox if it names one, else anywhere. */
function ariaOptions(el) {
  var scope = null;
  var id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  if (id) {
    var root = el.getRootNode ? el.getRootNode() : document;
    scope = (root.getElementById ? root : document).getElementById(id.split(/\s+/)[0]);
  }
  if (!scope && tagRole(el, false) === 'listbox') scope = el;
  var opts = scope ? Array.prototype.slice.call(scope.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="treeitem"]'))
    : deepSelectAll('[role="option"], [role="menuitemradio"]');
  return opts.filter(visible);
}

function pickOption(opts, value) {
  var v = norm(value);
  var tests = [
    function (o) { return norm(computeName(o, o.tagName)) === v; },
    function (o) { return norm(o.getAttribute('data-value') || o.getAttribute('value')) === v; },
    function (o) { return norm(computeName(o, o.tagName)).indexOf(v) === 0; },
    function (o) { return norm(computeName(o, o.tagName)).indexOf(v) >= 0; }
  ];
  for (var t = 0; t < tests.length; t++) {
    var hits = opts.filter(tests[t]);
    if (hits.length) return hits[0];
  }
  return null;
}

/* A custom dropdown: open it, wait for its options, click the one that matches each value. */
async function selectCustom(el, msg) {
  var values = (msg.values || []).map(String);
  var picked = [];
  for (var i = 0; i < values.length; i++) {
    var opts = ariaOptions(el);
    if (!opts.length || (el.getAttribute('aria-expanded') === 'false')) {
      await doClick({}, el);
      for (var t = 0; t < 20; t++) {
        await sleep(100);
        checkCancel(msg);
        opts = ariaOptions(el);
        if (opts.length) break;
      }
    }
    if (!opts.length) {
      throw be('NO_MATCH', describe(el) + ' showed no options after it was clicked. Take a page_snapshot to see what opened, then page_click the option.');
    }
    var o = pickOption(opts, values[i]);
    if (!o) {
      var names = opts.slice(0, 30).map(function (x) { return JSON.stringify(shortName(x)); });
      throw be('NO_MATCH', 'No option matches ' + JSON.stringify(values[i]) + ' in ' + describe(el) + '. Options: ' + names.join(', ') + (opts.length > 30 ? ', …' : '') + '.');
    }
    var label = shortName(o);
    await doClick({}, o);
    picked.push(label);
    await sleep(100);
  }
  return { selected: picked, labels: picked, custom: true };
}

async function doSelect(msg) {
  var el = await locate(msg, 'select');
  if (el.tagName === 'LABEL' && el.control) el = el.control;
  if (el.tagName !== 'SELECT') {
    var inner = el.querySelector && el.querySelector('select');
    if (inner && visible(inner)) el = inner;
  }
  assertActionable(el, 'selecting');
  if (el.tagName !== 'SELECT') return await selectCustom(el, msg);
  var idx = matchOptions(el, (msg.values || []).map(String));
  try { el.focus(); } catch (e) {}
  selectIndices(el, idx);
  return {
    selected: idx.map(function (i) { return el.options[i].value; }),
    labels: idx.map(function (i) { return String(el.options[i].text || '').trim(); })
  };
}

async function doHover(msg) {
  var el = await locate(msg, 'hover');
  var atPoint = !given(msg.ref) && !given(msg.selector) && !given(msg.name) && !given(msg.role);
  var pos;
  if (atPoint) pos = { clientX: Number(msg.x), clientY: Number(msg.y) };
  else {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
    var rect = el.getBoundingClientRect();
    pos = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  }
  // Enter every element from the outside in, as a real pointer would.
  var chain = [];
  for (var n = el; n && n.nodeType === 1; n = flatParent(n)) chain.unshift(n);
  var ptr = function (t, type, bubbles) {
    try { t.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: bubbles, cancelable: bubbles, composed: true, pointerType: 'mouse', isPrimary: true }, pos))); } catch (e) {}
  };
  ptr(el, 'pointerover', true);
  el.dispatchEvent(mouseEvent('mouseover', pos));
  chain.forEach(function (t) {
    ptr(t, 'pointerenter', false);
    t.dispatchEvent(mouseEvent('mouseenter', Object.assign({ bubbles: false, cancelable: false }, pos)));
  });
  ptr(el, 'pointermove', true);
  el.dispatchEvent(mouseEvent('mousemove', pos));
  return {
    hovered: true,
    ref: refOf(el),
    note: 'Sent pointer/mouse hover events, which open JavaScript-driven menus and tooltips. Pure CSS :hover styles can\'t be triggered from an extension; if nothing appeared, page_click it instead.'
  };
}

/* Press on one element (or point), move in steps, release on another. Also runs
   HTML drag-and-drop for draggable elements. */
async function doDrag(msg) {
  var from = await locate(msg, 'drag');
  var toSpec = { ref: msg.toRef, selector: msg.toSelector, name: msg.toName, role: msg.toRole, x: msg.toX, y: msg.toY, generation: msg.generation, opId: msg.opId };
  if (!hasTarget(toSpec)) throw be('INVALID_PARAMS', 'Say where to drop: toRef, toName, toSelector, or toX and toY.');
  var to = await locate(toSpec, 'drag');
  var center = function (el, x, y) {
    if (given(x) && given(y)) return { clientX: Number(x), clientY: Number(y) };
    var r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  };
  var fromPoint = !given(msg.ref) && !given(msg.selector) && !given(msg.name) && !given(msg.role);
  if (!fromPoint) { try { from.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {} }
  var a = center(from, fromPoint ? msg.x : undefined, fromPoint ? msg.y : undefined);
  var toPoint = !given(toSpec.ref) && !given(toSpec.selector) && !given(toSpec.name) && !given(toSpec.role);
  var b = center(to, toPoint ? msg.toX : undefined, toPoint ? msg.toY : undefined);
  var ptr = function (el, type, pos, buttons) {
    try { el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true, buttons: buttons }, pos))); } catch (e) {}
    var mt = type.replace('pointer', 'mouse');
    el.dispatchEvent(mouseEvent(mt, Object.assign({ buttons: buttons }, pos)));
  };
  ptr(from, 'pointerdown', a, 1);
  var dt = null;
  var html5 = from.draggable || (from.closest && from.closest('[draggable="true"]'));
  if (html5) {
    try { dt = new DataTransfer(); } catch (e) { dt = null; }
    from.dispatchEvent(new DragEvent('dragstart', Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt }, a)));
  }
  var steps = 8, over = from;
  for (var i = 1; i <= steps; i++) {
    var p = { clientX: a.clientX + (b.clientX - a.clientX) * i / steps, clientY: a.clientY + (b.clientY - a.clientY) * i / steps };
    var under = deepPoint(p.clientX, p.clientY) || to;
    ptr(under, 'pointermove', p, 1);
    if (html5) {
      if (under !== over) under.dispatchEvent(new DragEvent('dragenter', Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt }, p)));
      under.dispatchEvent(new DragEvent('dragover', Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt }, p)));
    }
    over = under;
    await sleep(16);
    checkCancel(msg);
  }
  if (html5) {
    to.dispatchEvent(new DragEvent('drop', Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt }, b)));
    from.dispatchEvent(new DragEvent('dragend', Object.assign({ bubbles: true, cancelable: false, composed: true, dataTransfer: dt }, b)));
  }
  ptr(to, 'pointerup', b, 0);
  return { dragged: true, from: lineFor(from), to: lineFor(to) };
}

function base64Bytes(b64) {
  var bin = atob(String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, ''));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Put files into a file input (or drop them on a drop zone), like choosing them in the file picker. */
async function doUpload(msg) {
  var files = (msg.files || []).map(function (f, i) {
    if (!f || !f.name) throw be('INVALID_PARAMS', 'files[' + i + '] needs a name.');
    var data = given(f.base64) ? base64Bytes(f.base64) : new TextEncoder().encode(String(f.text === undefined ? '' : f.text));
    return new File([data], String(f.name), { type: String(f.mimeType || ''), lastModified: Date.now() });
  });
  if (!files.length) throw be('INVALID_PARAMS', 'page_upload needs at least one file.');
  var el;
  if (hasTarget(msg)) el = await locate(msg, 'upload');
  else {
    var inputs = deepSelectAll('input[type="file"]').filter(function (i) { return !isDisabled(i); });
    if (inputs.length !== 1) {
      throw be(inputs.length ? 'AMBIGUOUS' : 'REF_NOT_FOUND', inputs.length
        ? inputs.length + ' file inputs are on the page:\n' + inputs.slice(0, 8).map(lineFor).join('\n') + '\nPass the ref of the one to use.'
        : 'No file input is on the page. Pass the drop zone or the upload button as the target, or page_click the upload button first.');
    }
    el = inputs[0];
  }
  var input = el;
  if (inputType(input) !== 'file') {
    if (input.tagName === 'LABEL' && input.control && inputType(input.control) === 'file') input = input.control;
    else {
      var inner = input.querySelector && input.querySelector('input[type="file"]');
      if (!inner && input.getRootNode) { var host = input.closest && input.closest('form'); inner = host && host.querySelector('input[type="file"]'); }
      input = inner || null;
    }
  }
  var dt = new DataTransfer();
  files.forEach(function (f) { dt.items.add(f); });
  if (!input) {
    // No input: drop the files on the element, the way drag-and-drop zones expect.
    var r = el.getBoundingClientRect();
    var pos = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    ['dragenter', 'dragover', 'drop'].forEach(function (t) {
      el.dispatchEvent(new DragEvent(t, Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt }, pos)));
    });
    return { uploaded: files.length, via: 'drop on ' + describe(el), files: files.map(function (f) { return f.name; }) };
  }
  if (isDisabled(input)) throw be('ELEMENT_DISABLED', describe(input) + ' is disabled.');
  if (files.length > 1 && !input.multiple) throw be('INVALID_PARAMS', describe(input) + ' takes only one file; got ' + files.length + '.');
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  var out = { uploaded: input.files.length, ref: refOf(input), files: files.map(function (f) { return f.name + ' (' + f.size + ' bytes)'; }) };
  if (input.accept) {
    var acc = input.accept.split(',').map(function (a) { return a.trim().toLowerCase(); });
    var bad = files.filter(function (f) {
      return !acc.some(function (a) {
        return a === f.type || (a.slice(-2) === '/*' && f.type.indexOf(a.slice(0, -1)) === 0) || (a[0] === '.' && f.name.toLowerCase().slice(-a.length) === a);
      });
    });
    if (bad.length) out.warning = 'The input accepts ' + input.accept + ', so the page may reject ' + bad.map(function (f) { return f.name; }).join(', ') + '.';
  }
  return out;
}

/* ---------------------------------------------------------------- scroll */

function scrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function windowScrolls(vertical) {
  var r = scrollRoot();
  return vertical ? r.scrollHeight - r.clientHeight > 20 : r.scrollWidth - r.clientWidth > 20;
}

async function doScroll(msg) {
  var dir0 = String(msg.direction || 'down').toLowerCase();
  if (msg.to === 'top' || msg.to === 'bottom') {
    var box0 = windowScrolls(true) ? null : mainScroller(true);
    var top = msg.to === 'top' ? 0 : (box0 || scrollRoot()).scrollHeight;
    if (box0) box0.scrollTo({ left: box0.scrollLeft, top: top, behavior: 'instant' });
    else window.scrollTo({ left: window.scrollX, top: top, behavior: 'instant' });
    var b0 = box0 || scrollRoot();
    return { scrolled: true, to: msg.to, container: box0 ? describe(box0) : undefined, atEnd: atEnd(b0, msg.to === 'top' ? -1 : 1, true) };
  }
  var target = null;
  if (given(msg.ref) || given(msg.selector) || given(msg.name)) target = await locate(msg, 'scroll');
  var vertical = dir0 !== 'left' && dir0 !== 'right';
  var sign = (dir0 === 'up' || dir0 === 'left') ? -1 : 1;
  if (target && !given(msg.direction) && !given(msg.pixels)) {
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    return { scrolled: true, ref: refOf(target), inView: inViewport(target) };
  }
  if (target) {
    // A direction with a target: scroll inside it (or the nearest box around it that scrolls).
    var box = scrollableAround(target, vertical);
    if (!box) throw be('NOT_SUPPORTED', describe(target) + ' and the elements around it can\'t scroll ' + (vertical ? 'vertically' : 'sideways') + '.');
    var bpx = given(msg.pixels) ? Number(msg.pixels) : Math.round((vertical ? box.clientHeight : box.clientWidth) * 0.8);
    var bx = box.scrollLeft, by = box.scrollTop;
    box.scrollBy({ left: vertical ? 0 : sign * bpx, top: vertical ? sign * bpx : 0, behavior: 'instant' });
    return { scrolled: box.scrollLeft !== bx || box.scrollTop !== by, container: describe(box), x: box.scrollLeft, y: box.scrollTop, atEnd: atEnd(box, sign, vertical) };
  }
  // Default: most of a screen, so consecutive scrolls overlap a little.
  var px = msg.pixels !== undefined ? Number(msg.pixels) : Math.round((vertical ? window.innerHeight : window.innerWidth) * 0.8);
  if (!Number.isFinite(px) || px <= 0) px = 500;
  return scrollBy(vertical ? 0 : sign * px, vertical ? sign * px : 0);
}

function scrollableAround(el, vertical) {
  for (var n = el; n && n.nodeType === 1; n = flatParent(n)) {
    var cs;
    try { cs = getComputedStyle(n); } catch (e) { continue; }
    var ov = vertical ? cs.overflowY : cs.overflowX;
    var room = vertical ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
    if (room > 2 && /auto|scroll|overlay/.test(ov)) return n;
  }
  return null;
}

/* Scroll the window, or the page's main inner scroller when the window can't
   move. 'instant' so the position (and atEnd) is measured after the move. */
function scrollBy(dx, dy) {
  var vertical = dy !== 0;
  var sign = (dx || dy) < 0 ? -1 : 1;
  var sx = window.scrollX, sy = window.scrollY;
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  if (window.scrollX !== sx || window.scrollY !== sy) {
    return { scrolled: true, x: window.scrollX, y: window.scrollY, atEnd: atEnd(scrollRoot(), sign, vertical) };
  }
  // The window didn't move: apps like chat UIs scroll an inner container.
  var box = mainScroller(vertical);
  if (!box) return { scrolled: false, x: sx, y: sy, atEnd: true };
  var bx = box.scrollLeft, by = box.scrollTop;
  box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return {
    scrolled: box.scrollLeft !== bx || box.scrollTop !== by,
    container: describe(box),
    x: box.scrollLeft, y: box.scrollTop,
    atEnd: atEnd(box, sign, vertical)
  };
}

function atEnd(box, sign, vertical) {
  if (vertical) return sign > 0 ? box.scrollTop + box.clientHeight >= box.scrollHeight - 2 : box.scrollTop <= 0;
  return sign > 0 ? box.scrollLeft + box.clientWidth >= box.scrollWidth - 2 : box.scrollLeft <= 0;
}

/* The largest visible, on-screen element that can scroll on the given axis. */
function mainScroller(vertical) {
  var best = null, bestArea = 0;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var room = vertical ? e.scrollHeight - e.clientHeight : e.scrollWidth - e.clientWidth;
    if (room < 20) continue;
    var cs = getComputedStyle(e);
    var ov = cs[vertical ? 'overflowY' : 'overflowX'];
    if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') continue;
    if (cs.visibility !== 'visible' || axHidden(e)) continue;
    var r = e.getBoundingClientRect();
    var w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    var h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) continue;
    if (w * h > bestArea) { best = e; bestArea = w * h; }
  }
  return best;
}

/* A short name for el in messages: its role and name with its ref, e.g. button “Send” (ref=12). */
function describe(el) {
  var r = elToRef.get(el);
  var role = '', name = '';
  try { role = tagRole(el, false) || ''; } catch (e) {}
  try { name = shortName(el); } catch (e) {}
  if (r !== undefined && (role || name)) return (role || el.tagName.toLowerCase()) + (name ? ' “' + name + '”' : '') + ' (ref=' + r + ')';
  if (r !== undefined) return el.tagName.toLowerCase() + ' (ref=' + r + ')';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
}

/* ------------------------------------------------------------------- keys */

var KEY_ALIASES = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', 'return': 'Enter', tab: 'Tab', space: ' ', spacebar: ' ',
  backspace: 'Backspace', 'delete': 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End'
};
var KEY_CODES = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46
};

function normalizeMods(mods) {
  if (!Array.isArray(mods)) mods = mods ? [mods] : [];
  var out = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  mods.forEach(function (m) {
    var k = String(m).toLowerCase().replace(/key$/, '');
    if (k === 'ctrl' || k === 'control') out.ctrlKey = true;
    else if (k === 'shift') out.shiftKey = true;
    else if (k === 'alt' || k === 'option') out.altKey = true;
    else if (k === 'meta' || k === 'cmd' || k === 'command' || k === 'super' || k === 'win' || k === 'os') out.metaKey = true;
    else throw be('INVALID_PARAMS', 'Unknown modifier: ' + m);
  });
  return out;
}

/* The focused element, inside open shadow roots too. */
function deepActive() {
  var a = document.activeElement;
  for (;;) {
    if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    var inner = a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME') ? frameDoc(a) : null;
    if (inner && inner.activeElement && inner.activeElement !== inner.body) { a = inner.activeElement; continue; }
    return a;
  }
}

/* Would a real keystroke edit el now? (The page's handlers may have moved
   focus, disabled or removed it.) */
function canEdit(el) {
  return el.isConnected && !isDisabled(el) && !el.readOnly && !isInert(el) && deepActive() === el;
}

/* Elements matching sel in document order, descending into open shadow roots
 * where their hosts sit. */
function deepQueryAll(root, sel, out) {
  out = out || [];
  var all = root.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.matches(sel)) out.push(e);
    if (e.shadowRoot) deepQueryAll(e.shadowRoot, sel, out);
  }
  return out;
}

/* Focusable elements in tab order (positive tabindex first, then DOM order). */
function tabOrder() {
  var all = deepQueryAll(document, 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]');
  var pos = [], zero = [];
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (isDisabled(e) || inputType(e) === 'hidden' || !visible(e)) continue;
    var ti = e.tabIndex;
    if (ti < 0) continue;
    (ti > 0 ? pos : zero).push(e);
  }
  pos.sort(function (a, b) { return a.tabIndex - b.tabIndex; });
  return pos.concat(zero);
}

function insertText(el, s) {
  if (el.isContentEditable) {
    try { if (document.execCommand('insertText', false, s)) return true; } catch (e) {}
    return false;
  }
  if (typeof el.setRangeText !== 'function' || el.selectionStart === null) {
    nativeSetValue(el, String(el.value) + s);
  } else {
    var st = el.selectionStart, en = el.selectionEnd;
    var v = String(el.value);
    nativeSetValue(el, v.slice(0, st) + s + v.slice(en));
    try { el.setSelectionRange(st + s.length, st + s.length); } catch (e) {}
  }
  fireInput(el, s === '\n' ? 'insertLineBreak' : 'insertText', s);
  return true;
}

/* Character boundaries (grapheme clusters where supported, else code points),
   so keys never split an emoji or a letter with its accent. */
var graphemes = null;
try { graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch (e) {}
function boundaries(v) {
  var out = [0];
  if (graphemes) {
    for (var it = graphemes.segment(v)[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
      out.push(r.value.index + r.value.segment.length);
    }
  } else {
    for (var i = 0; i < v.length;) {
      i += (/[\uD800-\uDBFF]/.test(v[i]) && /[\uDC00-\uDFFF]/.test(v[i + 1] || '')) ? 2 : 1;
      out.push(i);
    }
  }
  return out;
}
function prevBoundary(v, i) {
  var b = boundaries(v), p = 0;
  for (var k = 0; k < b.length && b[k] < i; k++) p = b[k];
  return p;
}
function nextBoundary(v, i) {
  var b = boundaries(v);
  for (var k = 0; k < b.length; k++) if (b[k] > i) return b[k];
  return v.length;
}

/* Move the caret like the arrow/Home/End keys do: collapse a selection to its
   edge, or with Shift move only the selection's focus end. */
function moveCaret(el, key, shift) {
  var v = String(el.value), st = el.selectionStart, en = el.selectionEnd;
  var back = el.selectionDirection === 'backward';
  var anchor = back ? en : st, focus = back ? st : en;
  var to;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    var right = key === 'ArrowRight';
    if (!shift && st !== en) to = right ? en : st;
    else to = right ? nextBoundary(v, focus) : prevBoundary(v, focus);
  } else {
    var multi = el.tagName === 'TEXTAREA';
    to = key === 'Home' ? (multi && focus > 0 ? v.lastIndexOf('\n', focus - 1) + 1 : 0)
      : (multi && v.indexOf('\n', focus) >= 0 ? v.indexOf('\n', focus) : v.length);
  }
  if (!shift) { el.setSelectionRange(to, to); return 'moved the caret'; }
  if (to < anchor) el.setSelectionRange(to, anchor, 'backward');
  else el.setSelectionRange(anchor, to, 'forward');
  return 'extended the selection';
}

function deleteText(el, forward) {
  if (el.isContentEditable) {
    try { return document.execCommand(forward ? 'forwardDelete' : 'delete', false); } catch (e) { return false; }
  }
  var st = el.selectionStart, en = el.selectionEnd;
  if (st === null || st === undefined) return false;
  var v = String(el.value);
  if (st === en) {
    if (forward) en = nextBoundary(v, en); else st = prevBoundary(v, st);
  }
  if (st === en) return false;
  nativeSetValue(el, v.slice(0, st) + v.slice(en));
  try { el.setSelectionRange(st, st); } catch (e) {}
  fireInput(el, forward ? 'deleteContentForward' : 'deleteContentBackward');
  return true;
}

/* Synthetic key events are untrusted, so the browser runs none of a key's
 * default actions. After the page's handlers run (and didn't cancel the key),
 * perform the common ones ourselves and say what happened. */
async function keyDefault(key, mods, el, msg) {
  var tag = el.tagName;
  var type = inputType(el);
  var text = isTextField(el);
  var cmd = mods.ctrlKey || mods.metaKey;
  if (cmd && key.toLowerCase() === 'a' && !mods.altKey) {
    if (text && typeof el.select === 'function') { el.select(); return 'selected all text in ' + describe(el); }
    try { document.execCommand('selectAll'); return 'selected all'; } catch (e) { return ''; }
  }
  if (cmd || mods.altKey) return '';
  switch (key) {
    case 'Tab': {
      var order = tabOrder();
      if (!order.length) return '';
      var i = order.indexOf(el);
      var next = order[(i < 0 ? (mods.shiftKey ? order.length : -1) : i) + (mods.shiftKey ? -1 : 1)];
      if (!next) next = order[mods.shiftKey ? order.length - 1 : 0];
      try { next.focus(); } catch (e) {}
      return document.activeElement === next ? 'focus moved to ' + describe(next) : '';
    }
    case 'Enter':
      if (tag === 'TEXTAREA' || el.isContentEditable) {
        if (!canEdit(el)) return '';
        if (el.isContentEditable) { try { document.execCommand(mods.shiftKey ? 'insertLineBreak' : 'insertParagraph'); } catch (e) {} }
        else insertText(el, '\n');
        return 'inserted a new line';
      }
      if (tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY' || type === 'submit' || type === 'button' || type === 'reset' ||
          type === 'image' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
        assertActionable(el, 'activating it');
        el.click();
        return 'activated ' + describe(el);
      }
      if (tag === 'INPUT' && (el.form || el.closest('form'))) {
        var r = await submitField(el, msg);
        return r.submitted ? 'submitted the form' + (r.via ? ' via ' + r.via : '') : (r.note || '');
      }
      return '';
    case ' ':
      if (text) { if (!canEdit(el)) return ''; insertText(el, ' '); return 'typed a space'; }
      if (tag === 'BUTTON' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' ||
          el.getAttribute('role') === 'button' || el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
        assertActionable(el, 'activating it');
        el.click();
        return 'activated ' + describe(el);
      }
      scrollBy(0, (mods.shiftKey ? -1 : 1) * Math.round(window.innerHeight * 0.9));
      return 'scrolled the page';
    case 'Backspace': case 'Delete':
      if (text && canEdit(el)) return deleteText(el, key === 'Delete') ? 'deleted text' : '';
      return '';
    case 'ArrowUp': case 'ArrowDown':
      if (tag === 'SELECT' && !el.multiple) {
        if (isDisabled(el)) return '';
        var step = key === 'ArrowDown' ? 1 : -1;
        for (var ni = el.selectedIndex + step; ni >= 0 && ni < el.options.length; ni += step) {
          if (optionDisabled(el.options[ni])) continue;
          selectIndices(el, [ni]);
          return 'selected ' + JSON.stringify(el.options[ni].text.trim());
        }
        return '';
      }
      if (text) return '';
      scrollBy(0, key === 'ArrowDown' ? 40 : -40);
      return 'scrolled the page';
    case 'ArrowLeft': case 'ArrowRight':
      if (text) {
        if (typeof el.setSelectionRange === 'function' && el.selectionStart !== null) return moveCaret(el, key, mods.shiftKey);
        return '';
      }
      scrollBy(key === 'ArrowRight' ? 40 : -40, 0);
      return 'scrolled the page';
    case 'PageUp': case 'PageDown':
      if (text && tag !== 'TEXTAREA') return '';
      scrollBy(0, (key === 'PageDown' ? 1 : -1) * Math.round(window.innerHeight * 0.9));
      return 'scrolled the page';
    case 'Home': case 'End':
      if (text) {
        if (typeof el.setSelectionRange === 'function' && el.selectionStart !== null) return moveCaret(el, key, mods.shiftKey);
        return '';
      }
      doScroll({ to: key === 'Home' ? 'top' : 'bottom' });
      return 'scrolled to the ' + (key === 'Home' ? 'top' : 'bottom');
  }
  if (key.length === 1 || (key.length === 2 && /[\uD800-\uDBFF]/.test(key[0]))) {
    if (text && canEdit(el)) { insertText(el, mods.shiftKey ? key.toUpperCase() : key); return 'typed ' + JSON.stringify(key); }
  }
  return '';
}

/* "Ctrl+Shift+K" -> key "K" plus modifiers. A lone "+" is the plus key. */
function splitCombo(raw, modifiers) {
  var parts = raw.length > 1 ? raw.split('+') : [raw];
  if (raw.length > 1 && raw.slice(-1) === '+') { parts = raw.slice(0, -2).split('+').concat('+'); }
  var key = parts.pop();
  var mods = (Array.isArray(modifiers) ? modifiers : modifiers ? [modifiers] : []).concat(parts.filter(Boolean));
  return { key: KEY_ALIASES[key.toLowerCase()] || key, mods: normalizeMods(mods) };
}

async function doKey(msg) {
  var times = msg.times === undefined ? 1 : Math.floor(Number(msg.times));
  if (!Number.isFinite(times) || times < 1 || times > 50) throw be('INVALID_PARAMS', 'times must be 1 to 50.');
  if (hasTarget(msg)) {
    var t0 = await locate(msg, 'key');
    if (t0.tagName === 'LABEL' && t0.control) t0 = t0.control;
    try { t0.focus({ preventScroll: false }); } catch (e) {}
  }
  var last = null, effects = [];
  for (var i = 0; i < times; i++) {
    checkCancel(msg);
    last = await pressKey(msg);
    if (effects.indexOf(last.effect) < 0) effects.push(last.effect);
    if (times > 1) await sleep(20);
  }
  if (times > 1) { last.times = times; last.effect = effects.join('; '); }
  return last;
}

async function pressKey(msg) {
  var raw = String(msg.key);
  var sp = splitCombo(raw, msg.modifiers);
  var key = sp.key;
  var mods = sp.mods;
  var target = deepActive() || document.body;
  var init = Object.assign({}, mods);
  if (KEY_CODES[key] !== undefined) { init.keyCode = KEY_CODES[key]; init.which = KEY_CODES[key]; init.code = key === ' ' ? 'Space' : key; }
  else if (key.length === 1) {
    var up = key.toUpperCase();
    if (/[A-Z]/.test(up)) { init.code = 'Key' + up; init.keyCode = init.which = up.charCodeAt(0); }
    else if (/[0-9]/.test(key)) { init.code = 'Digit' + key; init.keyCode = init.which = key.charCodeAt(0); }
  }
  var combo = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].filter(function (m) { return mods[m]; })
    .map(function (m) { return { ctrlKey: 'Ctrl', altKey: 'Alt', shiftKey: 'Shift', metaKey: 'Meta' }[m]; })
    .concat([key === ' ' ? 'Space' : key]).join('+');
  var opts = Object.assign({ key: key, bubbles: true, cancelable: true, composed: true }, init);
  // keydown (and keypress) first; the default action runs between them and keyup.
  var down = new KeyboardEvent('keydown', opts);
  target.dispatchEvent(down);
  var handled = down.defaultPrevented;
  var printable = key.length === 1 || /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(key);
  if (!handled && (printable || key === 'Enter') && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
    var press = new KeyboardEvent('keypress', opts);
    target.dispatchEvent(press);
    handled = press.defaultPrevented;
  }
  var effect = handled ? 'handled by the page' : await keyDefault(key, mods, target, msg);
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return {
    pressed: combo,
    target: target === document.body ? 'page' : describe(target),
    effect: effect || 'none: only the page\'s own key handlers ran (browser shortcuts and other built-in actions can\'t be triggered)'
  };
}

var cancelled = new Set(); // opIds the background asked us to stop (expire after 2 min)

function checkCancel(msg) {
  if (msg && msg.opId && cancelled.has(String(msg.opId))) throw be('CANCELLED', 'The command was cancelled.');
}

function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

/* Wait for text or an element to appear, or with gone:true to go away. With nothing
   to wait for, wait until the page stops changing. */
async function doWait(msg) {
  var timeoutMs = msg.timeoutMs !== undefined ? Number(msg.timeoutMs) : 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 10000;
  timeoutMs = Math.min(timeoutMs, 60000);
  var start = Date.now();
  var wantText = given(msg.text) ? norm(msg.text) : null;
  var spec = { selector: msg.selector, name: msg.name, role: msg.role, ref: msg.ref, generation: msg.generation };
  var wantEl = given(spec.selector) || given(spec.name) || given(spec.role) || given(spec.ref);
  if (given(spec.selector)) checkSelector(String(spec.selector));
  if (!wantText && !wantEl) {
    await settle(Math.max(300, timeoutMs), 500);
    checkCancel(msg);
    return { found: true, settled: true, elapsedMs: Date.now() - start };
  }
  var gone = !!msg.gone;
  for (;;) {
    checkCancel(msg);
    var el = null, ok = true;
    try {
      if (wantEl) {
        el = given(spec.ref) && !elForRef(Number(spec.ref)) ? null : findTarget(Object.assign({}, spec), 'wait');
        if (el && !visible(el)) el = null;
        if (!el) ok = false;
      }
      if (ok && wantText) ok = norm(document.body ? document.body.innerText : '').indexOf(wantText) >= 0 || deepTextHas(wantText);
    } catch (e) {
      if (e.code === 'AMBIGUOUS') ok = true; // several matches: it's there
      else if (e.code === 'INVALID_PARAMS') throw e;
      else ok = false;
    }
    if (ok !== gone) {
      var out = { found: !gone, gone: gone || undefined, elapsedMs: Date.now() - start };
      if (el && !gone) { out.ref = refOf(el); out.line = lineFor(el); }
      return out;
    }
    if (Date.now() - start >= timeoutMs) {
      return { found: gone, timedOut: true, elapsedMs: Date.now() - start,
        note: gone ? 'It was still on the page when the wait ran out.' : 'It did not appear before the wait ran out.' };
    }
    await sleep(100);
  }
}

/* Text inside open shadow roots, which body.innerText leaves out. */
function deepTextHas(needle) {
  var hit = false;
  (function walk(root) {
    if (hit) return;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length && !hit; i++) {
      var sr = all[i].shadowRoot;
      if (sr) {
        if (norm(sr.textContent).indexOf(needle) >= 0) { hit = true; return; }
        walk(sr);
      }
    }
  })(document);
  return hit;
}

/* Visible text matches: up to 20 with snippets, and how many there are in all. */
function doFind(msg) {
  var q = String(msg.query === undefined || msg.query === null ? '' : msg.query).toLowerCase();
  if (!q) throw be('INVALID_PARAMS', 'page_find needs a query');
  var root = document.body || document.documentElement;
  var matches = [], count = 0;
  var shown = new Map(); // parent element -> visible?
  if (!root) return { matches: matches, count: 0, truncated: false };
  // Text nodes in document order, including open shadow roots.
  (function walk(r) {
    var walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (n.shadowRoot) walk(n.shadowRoot);
        continue;
      }
      var parent = n.parentElement;
      if (!parent || SKIP_TAGS[parent.tagName]) continue;
      var val = n.nodeValue || '';
      var low = val.toLowerCase();
      var idx = low.indexOf(q);
      if (idx < 0) continue;
      var vis = shown.get(parent);
      if (vis === undefined) { vis = visible(parent); shown.set(parent, vis); }
      if (!vis) continue;
      for (; idx >= 0; idx = low.indexOf(q, idx + q.length)) {
        count++;
        if (matches.length >= 20) continue;
        var m = { snippet: val.slice(Math.max(0, idx - 30), idx + q.length + 30).replace(/\s+/g, ' ').trim() };
        var at = clickableAncestor(parent) || parent;
        m.ref = refFor(at);
        if (at !== parent || isInteresting(at)) m.element = describe(at);
        if (!inViewport(parent)) m.offscreen = true;
        matches.push(m);
      }
    }
  })(root);
  return { matches: matches, count: count, truncated: count > matches.length };
}

/* -------------------------------------------------------------- AI cursor */

function shortName(el) {
  var n = '';
  try { n = computeName(el, String(el.tagName || '').toLowerCase()) || ''; } catch (e) {}
  n = String(n).replace(/\s+/g, ' ').trim();
  return n.length > 40 ? n.slice(0, 39) + '…' : n;
}

/* Cursor narration in the browser's language. key + "Named" takes the element's name. */
function say(key, name) {
  var full = name ? key + 'Named' : key;
  var m = '';
  try { m = B.i18n.getMessage(full, name ? [String(name)] : undefined); } catch (e) {}
  return m || (name ? key + ' “' + name + '”' : key);
}
function clip(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

function quoted(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length > 40) s = s.slice(0, 39) + '…';
  return s ? ' “' + s + '”' : '';
}

function ensureVisible(el) {
  var r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  }
}

/* A field whose contents shouldn't be shown in the cursor bubble. */
function isSecret(el) {
  if (!el || !el.getAttribute) return false;
  if (inputType(el) === 'password') return true;
  if (/password|one-time-code/i.test(el.getAttribute('autocomplete') || '')) return true;
  try { return !!(el.querySelector && el.querySelector('input[type="password"]')); } catch (e) { return false; }
}

/* Before an action: glide the cursor to its target and say what's happening.
 * msg.cursor is set by the background only when the cursor is enabled;
 * msg.cursor.note is the model's own words, if it gave any. */
async function cursorBefore(msg) {
  var C = window.__fxmcpCursor;
  if (!msg.cursor || !C) return;
  var note = msg.cursor.note ? String(msg.cursor.note) : '';
  var el = null;
  try {
    switch (msg.kind) {
      case 'act-click': case 'act-type': case 'act-select': case 'act-hover': case 'act-drag': case 'act-upload': case 'act-key':
        el = peekTarget(msg, msg.kind.slice(4));
        if (!el && msg.kind === 'act-type') el = deepActive();
        break;
      case 'act-fillForm': {
        var f = (msg.fields || [])[0];
        if (f) el = peekTarget(fieldSpec(f, msg), 'fill');
        break;
      }
      case 'act-scroll':
        if (given(msg.ref) || given(msg.selector) || given(msg.name)) el = peekTarget(msg, 'scroll');
        break;
    }
  } catch (e) { el = null; } // a bad target is reported by the action itself
  var name = el ? shortName(el) : '';
  var dflt;
  switch (msg.kind) {
    case 'act-click': dflt = say('curClick', name); break;
    case 'act-type': {
      var field = null;
      try { field = el && editableTarget(el); } catch (e) {}
      dflt = !el ? say('curType') : (isSecret(el) || isSecret(field)) ? say('curTypePassword') : say('curType', clip(msg.text));
      break;
    }
    case 'act-fillForm': dflt = say('curFillForm'); break;
    case 'act-select': dflt = say('curChoose', clip((msg.values || []).join(', '))); break;
    case 'act-hover': dflt = say('curHover', name); break;
    case 'act-scroll':
      dflt = el ? say('curScrollTo', name) : msg.to === 'top' ? say('curScrollTop') : msg.to === 'bottom' ? say('curScrollBottom')
        : say({ up: 'curScrollUp', left: 'curScrollLeft', right: 'curScrollRight' }[String(msg.direction || '').toLowerCase()] || 'curScrollDown');
      break;
    case 'act-key': dflt = isSecret(el || deepActive()) ? say('curKey') : say('curKey', String(msg.key)); break;
    case 'act-wait': dflt = (msg.text || msg.name || msg.selector) ? say('curWait', clip(msg.text || msg.name || msg.selector)) : say('curWait'); break;
    case 'act-drag': dflt = say('curDrag', name); break;
    case 'act-upload': dflt = say('curUpload', clip((msg.files || []).map(function (x) { return x && x.name; }).join(', '))); break;
    case 'act-find': dflt = say('curFind', clip(msg.query)); break;
    default: dflt = say('curRead');
  }
  var shape = (msg.kind === 'act-click' || msg.kind === 'act-drag') ? 'hand'
    : (msg.kind === 'act-type' || msg.kind === 'act-fillForm') ? 'text'
    : msg.kind === 'act-wait' ? 'wait' : 'arrow';
  if (el) {
    ensureVisible(el);
    await C.moveTo(el, note || dflt, shape);
  } else {
    C.say(note || dflt, shape);
  }
}

function cursorAfter(msg, result, err) {
  var C = window.__fxmcpCursor;
  if (!msg.cursor || !C) return;
  try {
    // Don't leave "Clicking …" up when nothing was clicked.
    if (err) C.say(err.code === 'CANCELLED' ? say('curStopped') : say('curFailed'), 'arrow');
    else if (msg.kind === 'act-click' && result && result.clicked) C.click();
  } catch (e) {} // the overlay must never fail an action
}

function cursorCommand(msg) {
  var C = window.__fxmcpCursor;
  if (!C) return { shown: false };
  switch (msg.op) {
    case 'say': C.say(msg.note); return { shown: true };
    case 'conceal':
      // Give the compositor a moment to drop the overlay before the screenshot.
      if (!C.conceal()) return { ok: true };
      return new Promise(function (r) { setTimeout(function () { r({ ok: true }); }, 60); });
    case 'reveal': C.reveal(); return { ok: true };
    case 'hide': C.hide(); return { ok: true };
    default: throw be('INVALID_PARAMS', 'Unknown cursor op: ' + msg.op);
  }
}

/* ---------------------------------------------------------------- dialogs */

/* alert/confirm/prompt stop the page until someone answers, which would freeze an action half-way
 * (the click never returns) and leave the dialog up for the user. While the AI acts, and briefly
 * after, the page's dialogs are answered here instead: alert is acknowledged; confirm and prompt
 * are cancelled unless the call asked for dialog:"accept". The result says what the page asked.
 * Dialogs answered after an action returned are reported with the next one. */
var DIALOG_GRACE_MS = 1500;
var dialogDepth = 0, dialogRestore = null, dialogTimer = 0;
var dialogPolicy = { accept: false, promptText: undefined };
var dialogLog = [];

function installDialogs() {
  if (dialogRestore || typeof exportFunction !== 'function' || !window.wrappedJSObject) return;
  var page = window.wrappedJSObject;
  var saved = {};
  ['alert', 'confirm', 'prompt'].forEach(function (type) {
    var own = false;
    try { own = Object.prototype.hasOwnProperty.call(page, type); } catch (e) {}
    saved[type] = { own: own, fn: own ? page[type] : null };
    try {
      page[type] = exportFunction(function (message, dflt) {
        var text = String(message === undefined ? '' : message).slice(0, 300);
        var accept = dialogPolicy.accept;
        var answer = type === 'alert' ? undefined
          : type === 'confirm' ? accept
          : accept ? String(dialogPolicy.promptText !== undefined ? dialogPolicy.promptText : (dflt === undefined ? '' : dflt)) : null;
        dialogLog.push({ type: type, message: text, answered: type === 'alert' ? 'ok' : accept ? 'accepted' : 'cancelled' });
        return answer;
      }, window);
    } catch (e) {}
  });
  dialogRestore = function () {
    Object.keys(saved).forEach(function (type) {
      try {
        if (saved[type].own) page[type] = saved[type].fn;
        else delete page[type];
      } catch (e) {}
    });
  };
}

function beginDialogs(msg) {
  dialogDepth += 1;
  clearTimeout(dialogTimer);
  dialogPolicy = { accept: msg.dialog === 'accept', promptText: msg.promptText };
  installDialogs();
}

function endDialogs() {
  dialogDepth = Math.max(0, dialogDepth - 1);
  if (dialogDepth) return;
  clearTimeout(dialogTimer);
  // A page often asks a moment later (after a fetch, a timer); keep answering for a little while.
  dialogTimer = setTimeout(function () {
    if (dialogDepth || !dialogRestore) return;
    dialogRestore();
    dialogRestore = null;
  }, DIALOG_GRACE_MS);
}

/* Attach the dialogs the page showed (since the last report) to a result. */
function withDialogLog(result) {
  if (!dialogLog.length) return result;
  var shown = dialogLog.splice(0, dialogLog.length);
  var out = (result && typeof result === 'object' && !Array.isArray(result)) ? result : { result: result };
  out.dialogs = shown;
  var asked = shown.filter(function (d) { return d.type !== 'alert' && d.answered === 'cancelled'; });
  out.dialogNote = 'The page showed ' + shown.map(function (d) { return d.type + '(' + JSON.stringify(d.message) + ')'; }).join(', ') +
    '. ' + (asked.length ? 'It was answered "Cancel"; to answer "OK" instead, repeat the action with dialog:"accept".' : 'It was acknowledged.');
  return out;
}

/* ---------------------------------------------------------------- settle */

/* Wait until the page stops changing (apps render after the load event), up to maxMs. */
function settle(maxMs, quietMs) {
  quietMs = quietMs || 300;
  return new Promise(function (resolve) {
    var start = Date.now(), last = start, mo = null;
    try {
      mo = new MutationObserver(function () { last = Date.now(); });
      mo.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true });
    } catch (e) { resolve(); return; }
    (function tick() {
      var now = Date.now();
      // A document still loading counts as changing.
      if ((now - last >= quietMs && document.readyState !== 'loading') || now - start >= maxMs) {
        mo.disconnect();
        resolve();
      } else setTimeout(tick, 50);
    })();
  });
}

/* ---------------------------------------------------------------- changes */

/* What an action changed on the page, so the agent rarely needs a new snapshot to
   see the effect: elements that appeared, how many went away, expanded/collapsed
   toggles and new messages in alerts, status regions and dialogs. */
var WATCH_SEL = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"],h1,h2,h3,h4,h5,h6,dialog[open]';
var LIVE_SEL = '[role="alert"],[role="status"],[role="log"],[aria-live]:not([aria-live="off"]),output,[role="alertdialog"],[role="dialog"],dialog[open]';
var TRACKED = { 'act-click': 1, 'act-type': 1, 'act-fillForm': 1, 'act-select': 1, 'act-key': 1, 'act-hover': 1, 'act-drag': 1, 'act-upload': 1 };

function shownFast(el) {
  try { if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true }) && !axHidden(el); } catch (e) {}
  return visible(el);
}

function watchState() {
  var shown = new Set(), expanded = new Map(), live = new Map();
  var els = deepSelectAll(WATCH_SEL + ',' + LIVE_SEL);
  if (els.length > 5000) els = els.slice(0, 5000);
  els.forEach(function (el) {
    if (!shownFast(el)) return;
    var isLive = false;
    try { isLive = el.matches(LIVE_SEL); } catch (e) {}
    if (isLive) live.set(el, norm(el.innerText || el.textContent).slice(0, 300));
    shown.add(el);
    var x = el.getAttribute('aria-expanded');
    if (x !== null) expanded.set(el, x);
  });
  return { shown: shown, expanded: expanded, live: live, url: location.href, title: document.title || '' };
}

function diffState(before) {
  var after = watchState();
  var out = {};
  if (after.url !== before.url) out.url = after.url;
  if (after.title !== before.title) out.title = after.title;
  var added = [];
  after.shown.forEach(function (el) {
    if (before.shown.has(el) || !isInteresting(el)) return;
    added.push(el);
  });
  var removed = 0;
  before.shown.forEach(function (el) { if (!after.shown.has(el)) removed++; });
  if (added.length) {
    out.added = added.slice(0, 15).map(lineFor);
    if (added.length > 15) out.addedMore = added.length - 15;
  }
  if (removed) out.removed = removed;
  var toggled = [];
  after.expanded.forEach(function (v, el) {
    var b = before.expanded.get(el);
    if (b !== undefined && b !== v) toggled.push(lineFor(el));
  });
  if (toggled.length) out.toggled = toggled.slice(0, 10);
  var messages = [];
  after.live.forEach(function (t, el) {
    if (t && before.live.get(el) !== t && messages.indexOf(t) < 0) messages.push(t);
  });
  if (messages.length) out.messages = messages.slice(0, 5);
  return Object.keys(out).length ? out : null;
}

function startWatch(msg) {
  var w = { kind: msg.kind, before: null, count: 0, last: 0, unloading: false };
  try { w.before = watchState(); } catch (e) { return null; }
  try {
    w.mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].target && records[i].target.nodeName === 'FXMCP-CURSOR') continue;
        w.count++;
        w.last = Date.now();
      }
    });
    w.mo.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true, attributes: true });
  } catch (e) {}
  w.onUnload = function () { w.unloading = true; };
  window.addEventListener('beforeunload', w.onUnload);
  window.addEventListener('pagehide', w.onUnload);
  return w;
}

/* After the action: give the page a moment to react, then report what changed. */
async function finishWatch(w, result) {
  try {
    var start = Date.now();
    for (;;) {
      if (w.unloading) break;
      var now = Date.now();
      if (!w.count && now - start > 400) break;           // nothing reacted
      if (w.count && now - w.last >= 300 && now - start >= 150) break; // reacted, then went quiet
      if (now - start > 2500) break;
      await sleep(50);
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (w.unloading) {
        result.navigating = true;
      } else {
        var ch = diffState(w.before);
        if (ch) result.changes = ch;
        else if (!w.count && /click|hover|drag/.test(w.kind)) result.changes = 'none: the page did not change';
      }
    }
  } catch (e) {} // reporting must never fail the action
  finally {
    if (w.mo) w.mo.disconnect();
    window.removeEventListener('beforeunload', w.onUnload);
    window.removeEventListener('pagehide', w.onUnload);
  }
  return result;
}

/* ---------------------------------------------------------------- reading */

/* The part of the page a read is limited to: msg.within = {ref|selector|name|role}. */
async function scopeRoot(msg) {
  var w = msg.within;
  if (!w || typeof w !== 'object' || !hasTarget(w)) return null;
  var el = await locate(Object.assign({ generation: msg.generation, opId: msg.opId, waitMs: 2000 }, w), 'read');
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') { var d = frameDoc(el); if (d && d.body) return d.body; }
  return el;
}

function pageText(root) {
  if (!root) return '';
  var t = '';
  try { t = root.innerText || ''; } catch (e) {}
  if (!t && root.shadowRoot) try { t = root.shadowRoot.textContent || ''; } catch (e) {}
  return String(t).replace(/\n{3,}/g, '\n\n');
}

/* Document coordinates of an element (crossing same-origin frames), for screenshots. */
function docRect(el) {
  var r = el.getBoundingClientRect();
  var x = r.left, y = r.top;
  var win = el.ownerDocument.defaultView;
  while (win && win !== window && win.frameElement) {
    var fr = win.frameElement.getBoundingClientRect();
    x += fr.left + (win.frameElement.clientLeft || 0);
    y += fr.top + (win.frameElement.clientTop || 0);
    win = win.parent;
  }
  return { x: Math.max(0, x + window.scrollX), y: Math.max(0, y + window.scrollY), width: r.width, height: r.height };
}

function pageMetrics() {
  var r = scrollRoot();
  return {
    width: Math.max(r ? r.scrollWidth : 0, window.innerWidth), height: Math.max(r ? r.scrollHeight : 0, window.innerHeight),
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    scrollX: window.scrollX, scrollY: window.scrollY, devicePixelRatio: window.devicePixelRatio || 1
  };
}

var STORAGE_VALUE_MAX = 20000;

/* The page's own localStorage / sessionStorage. */
function doPageStorage(msg) {
  var area = msg.area === 'session' ? 'session' : 'local';
  var st;
  try { st = area === 'session' ? window.sessionStorage : window.localStorage; } catch (e) {
    throw be('NOT_SUPPORTED', 'This page can\'t use ' + area + 'Storage (' + (e && e.message) + ').');
  }
  if (!st) throw be('NOT_SUPPORTED', 'This page has no ' + area + 'Storage.');
  var key = given(msg.key) ? String(msg.key) : null;
  switch (msg.op) {
    case 'get': {
      if (key === null) {
        var keys = [];
        for (var i = 0; i < st.length && keys.length < 500; i++) {
          var k = st.key(i);
          keys.push({ key: k, chars: String(st.getItem(k) || '').length });
        }
        return { area: area, origin: location.origin, count: st.length, keys: keys, truncated: st.length > keys.length };
      }
      var v = st.getItem(key);
      if (v === null) return { area: area, origin: location.origin, key: key, found: false };
      var cut = v.length > STORAGE_VALUE_MAX;
      return { area: area, origin: location.origin, key: key, found: true, value: cut ? v.slice(0, STORAGE_VALUE_MAX) : v, chars: v.length, truncated: cut || undefined };
    }
    case 'set': {
      if (key === null) throw be('INVALID_PARAMS', 'storage_set needs a key.');
      var val = typeof msg.value === 'string' ? msg.value : JSON.stringify(msg.value === undefined ? null : msg.value);
      try { st.setItem(key, val); } catch (e) { throw be('PAYLOAD_TOO_LARGE', 'The page\'s ' + area + 'Storage refused it: ' + (e && e.message)); }
      return { area: area, origin: location.origin, key: key, saved: true, chars: val.length };
    }
    case 'remove': {
      if (key === null) throw be('INVALID_PARAMS', 'storage_remove needs a key.');
      var had = st.getItem(key) !== null;
      st.removeItem(key);
      return { area: area, origin: location.origin, key: key, removed: had };
    }
    default: throw be('INVALID_PARAMS', 'Unknown storage op: ' + msg.op);
  }
}

/* ------------------------------------------------------------------ dispatch */

async function handleMessage(msg) {
  if (!msg || typeof msg.kind !== 'string') return undefined; // not ours
  if (msg.kind === 'cursor') return cursorCommand(msg);
  if (msg.kind === 'cancel') {
    if (msg.opId) { cancelled.add(String(msg.opId)); setTimeout(function () { cancelled.delete(String(msg.opId)); }, 120000); }
    return { ok: true };
  }
  checkCancel(msg);
  var acts = /^act-/.test(msg.kind);
  if (acts) beginDialogs(msg);
  var watch = null;
  try {
    if (msg.cursor) await cursorBefore(msg);
    checkCancel(msg); // the glide takes a moment
    if (TRACKED[msg.kind] && msg.changes !== false) watch = startWatch(msg);
    var result = await dispatch(msg);
    if (watch) { result = await finishWatch(watch, result); watch = null; }
    if (msg._notes && result && typeof result === 'object') result.notes = (result.notes || []).concat(msg._notes);
    if (msg.cursor) cursorAfter(msg, result, null);
    return withDialogLog(result);
  } catch (e) {
    if (msg.cursor) cursorAfter(msg, null, e);
    throw e;
  } finally {
    if (watch && watch.mo) watch.mo.disconnect();
    if (watch) { window.removeEventListener('beforeunload', watch.onUnload); window.removeEventListener('pagehide', watch.onUnload); }
    if (acts) endDialogs();
  }
}

async function dispatch(msg) {
  switch (msg.kind) {
    case 'ax-snapshot': {
      await settle(1500);
      var maxChars = (msg.maxChars !== undefined && Number.isFinite(Number(msg.maxChars))) ? Number(msg.maxChars) : 50000;
      var sroot = await scopeRoot(msg);
      var snap = buildSnapshot(msg.compact !== false, maxChars, sroot, !!msg.viewportOnly);
      if (sroot) snap.within = lineFor(sroot);
      if (snap.truncated) {
        snap.hint = 'Cut off at ' + maxChars + ' characters. To see the rest: pass viewportOnly:true after page_scroll, ' +
          'limit it with within:{ref} to one region, or use page_find to locate something specific.';
      }
      return snap;
    }
    case 'page-text': {
      await settle(1500);
      var mc = (msg.maxChars !== undefined && Number.isFinite(Number(msg.maxChars))) ? Number(msg.maxChars) : 20000;
      var off = Math.max(0, Math.floor(Number(msg.offset) || 0));
      var troot = await scopeRoot(msg);
      var t = pageText(troot || document.body || document.documentElement);
      var part = t.slice(off, off + mc);
      var out = { text: part, totalChars: t.length, offset: off, truncated: off + mc < t.length, url: location.href, title: document.title || '' };
      if (out.truncated) out.nextOffset = off + part.length;
      if (troot) out.within = lineFor(troot);
      return out;
    }
    case 'page-html': {
      var mc2 = (msg.maxChars !== undefined && Number.isFinite(Number(msg.maxChars))) ? Number(msg.maxChars) : 50000;
      var html;
      var hroot = msg.selector ? deepSelect(String(msg.selector)) : await scopeRoot(msg);
      if (msg.selector && !hroot) throw be('REF_NOT_FOUND', 'No element matches selector: ' + msg.selector);
      html = hroot ? hroot.outerHTML : (document.documentElement ? document.documentElement.outerHTML : '');
      html = String(html).replace(/<fxmcp-cursor\b[^>]*><\/fxmcp-cursor>/g, ''); // our overlay isn't page content
      var trunc2 = html.length > mc2;
      return { html: trunc2 ? html.slice(0, mc2) : html, truncated: trunc2, totalChars: html.length, url: location.href, title: document.title || '' };
    }
    case 'page-storage': return doPageStorage(msg);
    case 'page-metrics': return pageMetrics();
    case 'element-rect': {
      var rel = await locate(msg, 'read');
      try { rel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
      return Object.assign({ rect: docRect(rel), line: lineFor(rel) }, pageMetrics());
    }
    case 'act-click': return await doClick(msg);
    case 'act-type': return await doType(msg);
    case 'act-fillForm': return await doFillForm(msg);
    case 'act-select': return await doSelect(msg);
    case 'act-hover': return await doHover(msg);
    case 'act-scroll': return await doScroll(msg);
    case 'act-key': return await doKey(msg);
    case 'act-wait': return await doWait(msg);
    case 'act-find': await settle(1500); return doFind(msg);
    case 'act-drag': return await doDrag(msg);
    case 'act-upload': return await doUpload(msg);
    default:
      throw be('UNKNOWN_METHOD', 'Unknown content kind: ' + msg.kind);
  }
}

if (B.runtime && B.runtime.onMessage) {
  B.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // Sync foreign-message guard: handleMessage is async, so its
    // `return undefined` would arrive as Promise<undefined> and get
    // wrapped in an envelope. Check here so non-ours messages fall
    // through to other listeners untouched.
    if (!msg || typeof msg.kind !== 'string') return undefined; // not ours — let other listeners run
    var p;
    try { p = handleMessage(msg); } catch (e) {
      if (typeof sendResponse === 'function') {
        try { sendResponse({ __fxmcp: true, ok: false, error: errToObj(e) }); } catch (e2) {}
        return true;
      }
      return Promise.reject(e);
    }
    if (p === undefined) return undefined; // (unreachable after guard — kept for safety)
    var done = function (result) {
      var env = { __fxmcp: true, ok: true, result: (result === undefined ? null : result) };
      if (typeof sendResponse === 'function') { try { sendResponse(env); } catch (e) {} }
      return env;
    };
    var fail = function (err) {
      var env = { __fxmcp: true, ok: false, error: errToObj(err) };
      if (typeof sendResponse === 'function') { try { sendResponse(env); } catch (e) {} }
      return env;
    };
    if (p && typeof p.then === 'function') {
      // Serve both worlds: callback (chrome) and promise (Firefox `browser`).
      if (typeof sendResponse === 'function') {
        p.then(done, fail);
        return true;
      }
      return p.then(function (r) { return { __fxmcp: true, ok: true, result: r }; },
                     function (e) { return { __fxmcp: true, ok: false, error: errToObj(e) }; });
    }
    return done(p);
  });
}

})();
