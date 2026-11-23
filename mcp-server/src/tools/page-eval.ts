/**
 * page_eval: run the agent's JavaScript in a tab's page, as the page itself would.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { tabIdField, text, toBridgeError } from "./helpers.js";

interface PageEvalResult {
  type?: string;
  value?: string;
  truncated?: boolean;
  totalChars?: number;
}

export function registerPageEvalTools(server: McpServer, bridge: ExtensionBridge, _config: ServerConfig): void {
  server.registerTool(
    "page_eval",
    {
      description:
        "Run JavaScript in the page, like the devtools console, and get the result back as JSON. " +
        "Powerful: the code can read everything the page can and act as the logged-in user. " +
        "Prefer page_snapshot, page_text and page_click when they are enough. " +
        "Returns the value of the last expression; a returned promise is awaited. Code that uses await runs as an async function, so use return. " +
        "DOM nodes come back as labels like \"<button#send>\". Pages whose Content-Security-Policy forbids eval refuse it.",
      inputSchema: {
        code: z.string().min(1).max(100000).describe("JavaScript to run, e.g. \"document.querySelectorAll('tr').length\""),
        tabId: tabIdField,
        frameId: z.number().int().min(0).optional().describe("Frame to run in (default 0, the top page)"),
        timeoutMs: z.number().int().min(100).max(60000).optional().describe("How long to wait for the result (default 10000)"),
        maxChars: z.number().int().min(100).max(100000).optional().describe("Cut the JSON result to this many characters (default 20000)"),
      },
    },
    async (args) => {
      const timeoutMs = args.timeoutMs ?? 10000;
      try {
        const r = (await bridge.call(
          "page.eval",
          { code: args.code, tabId: args.tabId, frameId: args.frameId, timeoutMs, maxChars: args.maxChars },
          { timeoutMs: timeoutMs + 10000 },
        )) as PageEvalResult;
        if (r.value === undefined) return text(r.type === "undefined" ? "undefined" : `(no JSON value; type ${r.type ?? "unknown"})`);
        const cut = r.truncated ? `\n… [truncated: ${r.value.length} of ${r.totalChars} chars; return less or raise maxChars]` : "";
        return text(r.value + cut);
      } catch (e) {
        const { code, message } = toBridgeError(e);
        const hint = code === "UNKNOWN_METHOD" ? " (the Firefox add-on is older than this helper: update Foxhand in about:addons, then try again)" : "";
        return text(`ERROR [${code}]: ${message}${hint}`);
      }
    },
  );
}
