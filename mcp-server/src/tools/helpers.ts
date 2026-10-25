/**
 * Shared helpers for MCP tool implementations.
 *
 * Individual tool modules (tabs.ts, understand.ts, act.ts, browser.ts)
 * build on these so formatting / error handling stays uniform.
 */

import { z } from "zod";
import type { BridgeMethod } from "@webmcp-controller/shared";
import { BridgeError, type ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";

const DEFAULT_MAX_TEXT = 20000;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n… [truncated ${s.length - maxLen} chars]`;
}

/** Render a bridge result as display text. Long output is truncated with a notice. */
export function fmt(res: unknown, maxLen = DEFAULT_MAX_TEXT): string {
  if (typeof res === "string") return truncate(res, maxLen);
  if (
    res !== null &&
    typeof res === "object" &&
    "text" in res &&
    typeof (res as { text: unknown }).text === "string" &&
    Object.keys(res).length === 1
  ) {
    return truncate((res as { text: string }).text, maxLen);
  }
  try {
    return truncate(JSON.stringify(res ?? null, null, 2), maxLen);
  } catch {
    return truncate(String(res), maxLen);
  }
}

/** Normalize any thrown value into a { code, message } pair. */
export function toBridgeError(e: unknown): { code: string; message: string } {
  if (e instanceof BridgeError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: "UNKNOWN", message: e.message };
  return { code: "UNKNOWN", message: String(e) };
}

/**
 * Destructive-action guard. Returns an error message when the action must be
 * refused (caller should surface it as a tool error), else null.
 */
export function requireConfirm(
  config: ServerConfig,
  confirmed: boolean | undefined,
  action: string,
): string | null {
  if (config.confirmDestructive && !confirmed) {
    return (
      `Refused ${action}: destructive action requires explicit confirm:true ` +
      `(pass confirm:true to proceed; the user can turn this guard off in the add-on settings).`
    );
  }
  return null;
}

/** Optional Firefox tab id; when omitted the extension uses the active tab. */
export const tabIdField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Firefox tab id; defaults to active tab");

/**
 * Call the extension over the bridge and format the result as text.
 * Bridge failures are returned as `ERROR [CODE]: message` text, never thrown.
 */
export async function callBridge(
  bridge: ExtensionBridge,
  method: BridgeMethod,
  params: Record<string, unknown> = {},
  opts?: { timeoutMs?: number },
): Promise<string> {
  try {
    const result = await bridge.call(method, params, opts);
    return fmt(result);
  } catch (e) {
    const { code, message } = toBridgeError(e);
    const hint =
      code === "UNKNOWN_METHOD"
        ? " (the Firefox add-on is older than this helper: update Foxhand in about:addons, then try again)"
        : "";
    return `ERROR [${code}]: ${message}${hint}`;
  }
}

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** A tool result from callBridge text; "ERROR ..." text is flagged as a tool error. */
export function text(t: string): TextResult {
  const res: TextResult = { content: [{ type: "text", text: t }] };
  if (t.startsWith("ERROR")) res.isError = true;
  return res;
}

/** A tool error the server raises itself (bad arguments, the confirm guard). */
export function refusal(t: string): TextResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

export const confirmField = z
  .boolean()
  .optional()
  .describe("Pass true to confirm this destructive action (required unless the user turned the guard off)");

/**
 * How page tools name an element. One of: ref (from page_snapshot), name
 * (+ optional role and nth), selector, or a viewport point x,y.
 */
export const targetFields = {
  ref: z.number().int().positive().optional().describe("Element ref from page_snapshot ([ref=N]): the most reliable target"),
  name: z
    .string()
    .optional()
    .describe("Element by its visible label or text, as page_snapshot shows it in quotes (e.g. \"Sign in\"); no snapshot needed"),
  role: z
    .string()
    .optional()
    .describe("With name: narrow by role (button, link, textbox, checkbox, combobox, tab, menuitem, ...)"),
  nth: z.number().int().positive().optional().describe("With name/role: pick the nth match (1 = first) when several match"),
  selector: z.string().optional().describe("CSS selector (looks into shadow DOM and same-origin iframes)"),
  x: z.number().optional().describe("With y: a point in CSS pixels from the viewport's top-left (for canvas, maps, games)"),
  y: z.number().optional().describe("With x: see x"),
  generation: z
    .string()
    .optional()
    .describe("page_snapshot's generation: refuses a ref if the page has navigated since, instead of guessing"),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .optional()
    .describe("How long to wait for the element to appear (default 3000)"),
};

/** A region of the page (same ways of naming an element as targets), for reading only part of it. */
export const withinField = z
  .object({
    ref: z.number().int().positive().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    nth: z.number().int().positive().optional(),
    selector: z.string().optional(),
  })
  .optional()
  .describe("Only this part of the page, e.g. {ref: 12} or {role: \"main\"} or {selector: \"article\"}");

/** The target fields given in args, to forward to the bridge. */
export function targetOf(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...Object.keys(targetFields), "tabId"]) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** True when args name an element. */
export function hasTarget(args: Record<string, unknown>): boolean {
  return (
    args["ref"] !== undefined ||
    args["selector"] !== undefined ||
    args["name"] !== undefined ||
    args["role"] !== undefined ||
    (args["x"] !== undefined && args["y"] !== undefined)
  );
}
