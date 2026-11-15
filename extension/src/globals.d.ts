/* Globals the add-on's scripts share. Everything else lives inside each script's own IIFE. */
import type { FxMcpApi } from './common';

declare global {
  interface Window {
    /** common.ts: helpers shared by the popup, settings and onboarding pages. */
    FxMcp: FxMcpApi;
    /** ax.ts sets this so a re-injected content script exits early. */
    __fxmcp?: boolean;
    /** cursor.ts: the AI cursor that ax.ts drives. */
    __fxmcpCursor?: import('./content/cursor').CursorApi;
  }
  /** Chrome-style namespace; only referenced behind a typeof check. */
  const chrome: typeof browser | undefined;
  /** Firefox-only: makes a page-facing function from a content script (Xray waiver). */
  function exportFunction<T extends (...args: never[]) => unknown>(fn: T, target: object, options?: { defineAs?: string; allowCallbacks?: boolean }): T;
}
export {};
