/**
 * Tab / window management tools.
 * Thin wrappers: validate input, enforce the destructive-action guard,
 * then forward to the extension over the bridge.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, paginationFields, confirmField, optionalTabIdField, refusal, requireConfirm, tabIdField, text } from "./helpers.js";

const waitForLoadField = z
  .boolean()
  .optional()
  .describe("Wait for the page to finish loading before returning (default true)");

const loadTimeoutField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Max ms to wait for the load (default 20000, max 60000)");

function loadTimeout(ms: number | undefined): number {
  return Math.min(Math.max(ms ?? 20000, 1000), 60000);
}

const windowIdField = z.number().int().positive().describe("Firefox window id");

export function registerTabTools(
  server: McpServer,
  bridge: ExtensionBridge,
  config: ServerConfig,
): void {
  server.registerTool(
    "tab_query",
    {
      description:
        "List or find tabs. query \"*\" (or nothing) lists every tab; other text matches URL or title, case-insensitively. " +
        "Each tab has id, url, title, windowId and active/pinned/audible flags. Usually your first call.",
      inputSchema: {
        ...paginationFields,
        query: z.string().optional().describe("\"*\" for all tabs, or text to look for in the URL or title"),
        urlPattern: z
          .string()
          .optional()
          .describe("Regex on the URL (no backreferences or nested quantifiers like (a+)+)"),
        titlePattern: z.string().optional().describe("Regex on the title (same rules)"),
        active: z.boolean().optional().describe("Only the active tab of each window (true) or only background tabs (false)"),
        pinned: z.boolean().optional().describe("Only pinned (true) or unpinned (false) tabs"),
        audible: z.boolean().optional().describe("Only tabs playing sound"),
        windowId: z.number().int().positive().optional().describe("Only tabs in this window"),
        includeDiscarded: z.boolean().optional().describe("Include unloaded (discarded) tabs (default true)"),
      },
    },
    async (args) => text(await callBridge(bridge, "tabs.query", { ...args })),
  );

  server.registerTool(
    "tab_check_active",
    {
      description: "The only way to ask what the user is looking at: the active tab of the focused window (id, url, title, windowId). Do not act on it by default; work in your own background tab.",
      inputSchema: {},
    },
    async () => text(await callBridge(bridge, "active.tab")),
  );

  server.registerTool(
    "tab_create",
    {
      description:
        "Open a new tab in the background; the user's view does not change (tab_focus shows it, only when the user asks). A URL without a scheme gets one: \"example.com\" opens https://example.com, " +
        "\"localhost:3000\" opens http://localhost:3000. Pass duplicateOf to copy an existing tab (with its history) instead. " +
        "Waits for the page to load by default and returns the new tab.",
      inputSchema: {
        url: z.string().optional().describe("Address to open (default: the new-tab page)"),
        duplicateOf: z.number().int().positive().optional().describe("Duplicate this tab instead of opening a URL"),
        windowId: z.number().int().positive().optional().describe("Open it in this window (default: the current one)"),
        waitForLoad: waitForLoadField,
        timeoutMs: loadTimeoutField,
      },
    },
    async (args) => {
      const wait = args.url !== undefined && args.waitForLoad !== false;
      const t = loadTimeout(args.timeoutMs);
      return text(
        await callBridge(
          bridge,
          "tab.create",
          { url: args.url, duplicateOf: args.duplicateOf, active: false, windowId: args.windowId, waitForLoad: wait, timeoutMs: t },
          { timeoutMs: t + 10000 },
        ),
      );
    },
  );

  server.registerTool(
    "tab_navigate",
    {
      description:
        "Load a URL in tab tabId, or go back, forward or reload with `go`. Stays in the background. Missing http(s):// is added like tab_create. " +
        "Waits for the load by default; loadComplete=false means it was still loading when the wait ran out.",
      inputSchema: {
        tabId: tabIdField,
        url: z.string().optional().describe("Address to open"),
        go: z.enum(["back", "forward", "reload"]).optional().describe("History step or reload, instead of url"),
        bypassCache: z.boolean().optional().describe("With go:\"reload\": hard reload, skipping the cache"),
        waitForLoad: waitForLoadField,
        timeoutMs: loadTimeoutField,
      },
    },
    async (args) => {
      if (!args.url && !args.go) return refusal("ERROR [INVALID_PARAMS]: pass url, or go: \"back\" | \"forward\" | \"reload\"");
      const t = loadTimeout(args.timeoutMs);
      return text(
        await callBridge(
          bridge,
          "tab.navigate",
          { tabId: args.tabId, url: args.url, go: args.url ? undefined : args.go, bypassCache: args.bypassCache, waitForLoad: args.waitForLoad !== false, timeoutMs: t },
          { timeoutMs: t + 10000 },
        ),
      );
    },
  );

  server.registerTool(
    "tab_focus",
    {
      description: "Switch to a tab and bring its window to the front, changing what the user sees. Only when the user asked to see it; never to read or screenshot (those work by tab id in the background).",
      inputSchema: {
        tabId: z.number().int().positive().describe("Tab to switch to"),
      },
    },
    async (args) => text(await callBridge(bridge, "tab.update", { tabId: args.tabId, active: true })),
  );

  server.registerTool(
    "tab_close",
    {
      description:
        "Close tabs: several (tabIds) or one (tabId); one of them is required. " +
        "Destructive: needs confirm:true unless the user turned the guard off. session_restore can reopen them.",
      inputSchema: {
        tabIds: z.array(z.number().int().positive()).min(1).optional().describe("Tab ids to close"),
        tabId: optionalTabIdField,
        confirm: confirmField,
      },
    },
    async (args) => {
      if (!args.tabIds && args.tabId === undefined) return refusal("ERROR [INVALID_PARAMS]: tab_close needs tabId or tabIds; it never closes a tab you didn't name.");
      const denied = requireConfirm(config, args.confirm, "tab_close");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "tab.close", args.tabIds ? { tabIds: args.tabIds } : { tabId: args.tabId }));
    },
  );

  server.registerTool(
    "tab_pin",
    {
      description: "Pin a tab, or unpin it with pinned:false.",
      inputSchema: {
        tabId: tabIdField,
        pinned: z.boolean().optional().describe("true to pin (default), false to unpin"),
      },
    },
    async (args) => text(await callBridge(bridge, "tab.pin", { tabId: args.tabId, pinned: args.pinned ?? true })),
  );

  server.registerTool(
    "tab_mute",
    {
      description: "Mute a tab, or unmute it with muted:false.",
      inputSchema: {
        tabId: tabIdField,
        muted: z.boolean().optional().describe("true to mute (default), false to unmute"),
      },
    },
    async (args) => text(await callBridge(bridge, "tab.mute", { tabId: args.tabId, muted: args.muted ?? true })),
  );

  server.registerTool(
    "window_query",
    {
      description: "List Firefox windows (id, focused, private, tab count).",
      inputSchema: {},
    },
    async () => text(await callBridge(bridge, "windows.list")),
  );

  server.registerTool(
    "window_create",
    {
      description: "Open a new window behind the current one (it does not take focus), optionally with a URL (missing http(s):// is added).",
      inputSchema: {
        url: z.string().optional().describe("Address to open in the new window"),
      },
    },
    async (args) => text(await callBridge(bridge, "window.create", { url: args.url })),
  );

  server.registerTool(
    "window_focus",
    {
      description: "Bring a window to the front, changing what the user sees. Only when the user asked to see it.",
      inputSchema: { windowId: windowIdField },
    },
    async (args) => text(await callBridge(bridge, "window.focus", { windowId: args.windowId })),
  );

  server.registerTool(
    "window_close",
    {
      description: "Close a window and all its tabs. Destructive: needs confirm:true unless the user turned the guard off.",
      inputSchema: {
        windowId: windowIdField,
        confirm: confirmField,
      },
    },
    async (args) => {
      const denied = requireConfirm(config, args.confirm, "window_close");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "window.remove", { windowId: args.windowId }));
    },
  );
}
