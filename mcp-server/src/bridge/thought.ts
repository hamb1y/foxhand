/**
 * Per-tool-call context carried in AsyncLocalStorage, so every bridge.call()
 * made while handling one MCP request picks it up without each tool passing it
 * along by hand:
 *  - a "thought" to show beside the AI cursor in Firefox;
 *  - an AbortSignal that fires when the MCP client cancels the request or
 *    drops the connection.
 *
 * The `thought` tool displays its note immediately. A pending note may also
 * be consumed once within the same request; independent requests never share it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface CallContext {
  thought?: string;
  signal?: AbortSignal;
  pendingScope?: { thought?: { text: string; at: number } };
}

const store = new AsyncLocalStorage<CallContext>();

export const currentThought = (): string | undefined => store.getStore()?.thought;
export const currentSignal = (): AbortSignal | undefined => store.getStore()?.signal;

export function withThought<T>(thought: string | undefined, fn: () => T): T {
  return thought ? store.run({ ...store.getStore(), thought }, fn) : fn();
}

/** Run fn with `signal` in scope, combined with any signal already in scope. */
export function withSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (!signal) return fn();
  const outer = store.getStore()?.signal;
  const combined = outer && outer !== signal ? AbortSignal.any([outer, signal]) : signal;
  return store.run({ ...store.getStore(), signal: combined, pendingScope: store.getStore()?.pendingScope ?? {} }, fn);
}

const PENDING_TTL_MS = 30_000;
// A stateless endpoint cannot identify clients across requests. Never share a
// pending note globally; the thought tool already shows its note immediately.

export function setPendingThought(text: string): void {
  const scope = store.getStore()?.pendingScope;
  if (scope) scope.thought = { text, at: Date.now() };
}

/** The thought left by the `thought` tool, if it is fresh; it is used up. */
export function takePendingThought(): string | undefined {
  const scope = store.getStore()?.pendingScope;
  const p = scope?.thought;
  if (scope) scope.thought = undefined;
  return p && Date.now() - p.at < PENDING_TTL_MS ? p.text : undefined;
}
