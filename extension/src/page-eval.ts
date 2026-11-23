/* page_eval: the function Firefox runs in the page's own JavaScript world (scripting.executeScript,
 * world "MAIN"). Firefox serializes it into the page, so it must not use anything outside its body.
 * The code string comes from the agent's tool call, never from page content, and it only ever runs
 * in the page: nothing here evaluates code in the add-on. The page can redefine eval, JSON, Promise
 * and setTimeout, so what comes back is as untrusted as the page itself. */

export interface PageEvalResult {
  /** typeof the value, or "null" / "array" / "node". */
  type?: string;
  /** The value as JSON text, cut to maxChars. */
  value?: string;
  truncated?: boolean;
  totalChars?: number;
  error?: { code: 'SCRIPT_ERROR' | 'TIMEOUT' | 'RESTRICTED_PAGE'; message: string };
}

export function evalInPage(code: string, timeoutMs: number, maxChars: number): PageEvalResult | Promise<PageEvalResult> {
  function describe(e: unknown): string {
    if (e && typeof e === 'object' && 'message' in e) {
      var err = e as Error;
      var head = (err.name || 'Error') + ': ' + err.message;
      var stack = typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 5).join('\n').trim() : '';
      return stack ? head + '\n' + stack : head;
    }
    var s: string | undefined;
    try { s = JSON.stringify(e); } catch (x) { s = undefined; }
    return 'Uncaught ' + (s === undefined ? String(e) : s);
  }
  function fail(e: unknown): PageEvalResult {
    var msg = describe(e);
    if ((typeof EvalError === 'function' && e instanceof EvalError) || /\bCSP\b|Content[- ]Security[- ]Policy/i.test(msg)) {
      return { error: { code: 'RESTRICTED_PAGE', message: 'This page\'s Content-Security-Policy blocks running code strings, so page_eval can\'t run here. Firefox said: ' + msg } };
    }
    return { error: { code: 'SCRIPT_ERROR', message: msg } };
  }
  function nodeLabel(n: Node): string {
    if (n.nodeType === 1) {
      var el = n as Element;
      return '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '>';
    }
    if (n.nodeType === 3) return '#text ' + JSON.stringify(String(n.nodeValue).slice(0, 80));
    return n.nodeName;
  }
  function finish(v: unknown): PageEvalResult {
    if (v === undefined) return { type: 'undefined' };
    var isNode = typeof Node === 'function' && v instanceof Node;
    var type = v === null ? 'null' : Array.isArray(v) ? 'array' : isNode ? 'node' : typeof v;
    var seen = new WeakSet<object>();
    var json: string | undefined;
    try {
      json = JSON.stringify(v, function (_key: string, x: unknown) {
        if (typeof x === 'bigint') return x.toString() + 'n';
        if (typeof x === 'function') return '[function ' + ((x as Function).name || 'anonymous') + ']';
        if (typeof x === 'symbol') return x.toString();
        if (typeof x === 'number' && !isFinite(x)) return String(x);
        if (x && typeof x === 'object') {
          if (typeof Node === 'function' && x instanceof Node) return nodeLabel(x);
          if (typeof Window === 'function' && x instanceof Window) return '[Window]';
          if (seen.has(x)) return '[circular or repeated reference]';
          seen.add(x);
          if (x instanceof Map) return { '[Map]': Array.from(x.entries()) };
          if (x instanceof Set) return { '[Set]': Array.from(x) };
          if (x instanceof Error) return { name: x.name, message: x.message };
        }
        return x;
      });
    } catch (e) {
      return { error: { code: 'SCRIPT_ERROR', message: 'The result can\'t be turned into JSON: ' + describe(e) } };
    }
    if (json === undefined) return { type: type };
    if (json.length > maxChars) return { type: type, value: json.slice(0, maxChars), truncated: true, totalChars: json.length };
    return { type: type, value: json };
  }

  var run = eval; // indirect: runs in the page's global scope
  var value: unknown;
  try {
    value = run(code);
  } catch (e) {
    // Top-level await isn't valid in a script: run it as an async expression, then as an async function body.
    if (!(e instanceof SyntaxError) || !/\bawait\b/.test(code)) return fail(e);
    try {
      value = run('(async () => (\n' + code + '\n))()');
    } catch (e2) {
      if (!(e2 instanceof SyntaxError)) return fail(e2);
      try { value = run('(async () => {\n' + code + '\n})()'); } catch (e3) { return fail(e3); }
    }
  }
  if (value && (typeof value === 'object' || typeof value === 'function') && typeof (value as PromiseLike<unknown>).then === 'function') {
    return new Promise<PageEvalResult>(function (resolve) {
      var timer = setTimeout(function () {
        resolve({ error: { code: 'TIMEOUT', message: 'The returned promise did not settle within ' + timeoutMs + ' ms.' } });
      }, timeoutMs);
      (value as PromiseLike<unknown>).then(
        function (v) { clearTimeout(timer); resolve(finish(v)); },
        function (e) { clearTimeout(timer); resolve(fail(e)); },
      );
    });
  }
  return finish(value);
}
