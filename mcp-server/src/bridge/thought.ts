/**
 * Per-tool-call context carried in AsyncLocalStorage, so every bridge.call()
 * made while handling one MCP request picks it up without each tool passing it
 * along by hand:
 *  - a "thought" to show beside the AI cursor in Firefox;
 *  - an AbortSignal that fires when the MCP client cancels the request or
 *    drops the connection.
 *
 * The `thought` tool also leaves a pending thought: the next command that
 * reaches a page shows it instead of the cursor's own description. It is used
 * once and expires after PENDING_TTL_MS.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface CallContext {
  thought?: string;
  signal?: AbortSignal;
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
  return store.run({ ...store.getStore(), signal: combined }, fn);
}

const PENDING_TTL_MS = 30_000;
let pending: { text: string; at: number } | undefined;

export function setPendingThought(text: string): void {
  pending = { text, at: Date.now() };
}

/** The thought left by the `thought` tool, if it is fresh; it is used up. */
export function takePendingThought(): string | undefined {
  const p = pending;
  pending = undefined;
  return p && Date.now() - p.at < PENDING_TTL_MS ? p.text : undefined;
}
