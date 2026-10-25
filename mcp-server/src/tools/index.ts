/**
 * Tool aggregation: wires every tool group onto the McpServer, plus the meta
 * tools owned here (extension_status, thought, event_wait).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeEvent } from "@webmcp-controller/shared";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, fmt, tabIdField, text, toBridgeError } from "./helpers.js";
import { registerTabTools } from "./tabs.js";
import { registerUnderstandTools } from "./understand.js";
import { registerActTools } from "./act.js";
import { registerBrowserTools } from "./browser.js";
import { setPendingThought, withSignal } from "../bridge/thought.js";

export const SERVER_INSTRUCTIONS = [
  "Controls the user's real Firefox, with their logins. The user watches an AI cursor move to whatever you act on.",
  "Workflow: tab_query to find or pick a tab (or tab_create), page_snapshot to see what's there, then act with page_click / page_type / page_fill / page_select / page_key. " +
    "Read with page_text (chunked: follow nextOffset) or page_find; page_screenshot when layout matters.",
  "Targets: prefer {ref: N} from the latest page_snapshot. Without a ref, use name (the visible label, e.g. name: \"Sign in\") with role to narrow it " +
    "(role: \"button\"), and nth when several match; a CSS selector; or x,y viewport coordinates for canvas apps. " +
    "Errors say what went wrong: REF_STALE means take a new snapshot; AMBIGUOUS lists the candidates.",
  "Every action returns `changes` (what appeared, disappeared or changed), `notes` and, if it navigated, the new url. Read them instead of re-snapshotting; " +
    "snapshot again only when you need refs for new content. Use page_wait for content that loads later (gone:true waits for spinners to go).",
  "Use the `thought` tool now and then to tell the user in one short sentence what you're about to do and why; it shows beside the cursor. " +
    "Without one, the cursor describes each action itself.",
  "storage_* with the default \"agent\" area is your private notebook that survives restarts: check it at the start of a task and save progress worth keeping. " +
    "Area \"local\"/\"session\" reads and writes the page's own storage.",
  "Closing tabs/windows and deleting bookmarks or cookies need confirm:true. Don't do anything irreversible (purchases, sending messages, deleting data) the user didn't ask for.",
].join("\n\n");

export function registerFirefoxTools(
  server: McpServer,
  bridge: ExtensionBridge,
  config: ServerConfig,
): void {
  // Every handler runs with the request's cancellation signal in scope, so the bridge can abort.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = server.registerTool.bind(server) as (name: string, config: any, cb: any) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, cfg: any, cb: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(name, cfg, (args: any, extra: unknown) =>
      withSignal((extra as { signal?: AbortSignal } | undefined)?.signal, () => cb(args, extra)),
    );

  registerTabTools(server, bridge, config);
  registerUnderstandTools(server, bridge, config);
  registerActTools(server, bridge, config);
  registerBrowserTools(server, bridge, config);

  server.registerTool(
    "extension_status",
    {
      description: "Whether the Firefox add-on is connected, its version and profile. Use it when calls fail with NOT_CONNECTED.",
      inputSchema: {},
    },
    async () => text(fmt({ connected: bridge.connected, extension: bridge.extensionInfo })),
  );

  server.registerTool(
    "thought",
    {
      description:
        "Tell the user what you're doing: one short first-person sentence shown beside the AI cursor in Firefox " +
        "(e.g. \"Checking the cart total before checkout\"). It stays with your next page action. " +
        "Use it when starting a step, changing plans or pausing to think; skip it for routine steps. Does nothing if the cursor is off.",
      inputSchema: {
        thought: z.string().min(1).max(300).describe("What you're doing and why"),
        tabId: tabIdField,
      },
    },
    async (args) => {
      const note = args.thought.trim();
      setPendingThought(note);
      return text(await callBridge(bridge, "cursor.say", { note, tabId: args.tabId }));
    },
  );

  server.registerTool(
    "event_wait",
    {
      description:
        "Wait for a browser event: a tab loading/changing (tab.updated), closing (tab.removed), being switched to (tab.activated), " +
        "or a download finishing (download.done), optionally for one tab. Each result has a `seq`; pass it as afterSeq next time " +
        "to also catch events that happened in between (the last 200 are kept).",
      inputSchema: {
        types: z
          .array(z.enum(["tab.updated", "tab.removed", "tab.activated", "download.done"]))
          .min(1)
          .describe("Event types to wait for"),
        tabId: tabIdField,
        timeoutMs: z.number().int().min(1000).max(120000).optional().describe("How long to wait (default 15000)"),
        afterSeq: z.number().int().min(0).optional().describe("Also match buffered events newer than this seq"),
      },
    },
    async (args) => {
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 15000, 1000), 120000);
      const predicate = (e: BridgeEvent): boolean => args.tabId === undefined || e.data["tabId"] === args.tabId;
      try {
        return text(fmt(await bridge.waitForEvent(args.types, predicate, timeoutMs, { afterSeq: args.afterSeq })));
      } catch (e) {
        const { code, message } = toBridgeError(e);
        return text(`ERROR [${code}]: ${message}`);
      }
    },
  );
}
