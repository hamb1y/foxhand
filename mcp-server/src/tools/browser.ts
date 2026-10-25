/**
 * Browser-data tools: bookmarks, history, downloads, cookies, storage
 * (the agent's own store plus a page's localStorage/sessionStorage),
 * and recently-closed session restore.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, confirmField, refusal, requireConfirm, tabIdField, text } from "./helpers.js";

const cookieUrlField = z
  .string()
  .optional()
  .describe("Site whose cookies to use, e.g. \"github.com\" (default: the tab's page). Uses the tab's container/private jar.");

const areaField = z
  .enum(["agent", "local", "session"])
  .optional()
  .describe(
    "\"agent\" (default): your own notes, kept in Firefox across sessions and pages, private to you. " +
      "\"local\" / \"session\": the page's localStorage / sessionStorage for the tab's site.",
  );

export function registerBrowserTools(
  server: McpServer,
  bridge: ExtensionBridge,
  config: ServerConfig,
): void {
  server.registerTool(
    "bookmark_query",
    {
      description: "Find bookmarks whose title or URL contains the text (empty: all). Each has an id for bookmark_remove.",
      inputSchema: {
        query: z.string().optional().describe("Text to look for"),
      },
    },
    async (args) => text(await callBridge(bridge, "bookmarks.search", { query: args.query ?? "" })),
  );

  server.registerTool(
    "bookmark_create",
    {
      description: "Add a bookmark (or a folder, with no url).",
      inputSchema: {
        title: z.string().describe("Title"),
        url: z.string().optional().describe("Address (omit to create a folder)"),
        parentId: z.string().optional().describe("Folder id to put it in (default: Other Bookmarks)"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "bookmarks.create", { title: args.title, url: args.url, parentId: args.parentId })),
  );

  server.registerTool(
    "bookmark_remove",
    {
      description: "Delete a bookmark by id (from bookmark_query). Destructive: needs confirm:true unless the user turned the guard off.",
      inputSchema: {
        id: z.string().describe("Bookmark id"),
        confirm: confirmField,
      },
    },
    async (args) => {
      const denied = requireConfirm(config, args.confirm, "bookmark_remove");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "bookmarks.remove", { id: args.id }));
    },
  );

  server.registerTool(
    "history_query",
    {
      description: "Search browsing history by title/URL text (empty: most recent). Searches all of it unless startTime is given.",
      inputSchema: {
        query: z.string().optional().describe("Text to look for"),
        maxResults: z.number().int().positive().max(1000).optional().describe("Max results (default 20)"),
        startTime: z.number().int().positive().optional().describe("Only visits after this time (ms since 1970)"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "history.search", {
          query: args.query ?? "",
          maxResults: args.maxResults ?? 20,
          startTime: args.startTime,
        }),
      ),
  );

  server.registerTool(
    "download_query",
    {
      description:
        "List downloads, newest first: file path on disk, state (in_progress/complete/interrupted), size, progress, " +
        "and why one failed. Filter by id, text in the URL/filename, or state.",
      inputSchema: {
        id: z.number().int().optional().describe("One download, e.g. from download_start or a click's result"),
        query: z.string().optional().describe("Words that must appear in the URL or file path"),
        state: z.enum(["in_progress", "complete", "interrupted"]).optional(),
        limit: z.number().int().positive().max(200).optional().describe("Max entries (default 20)"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "downloads.query", { id: args.id, query: args.query, state: args.state, limit: args.limit ?? 20 })),
  );

  server.registerTool(
    "download_start",
    {
      description:
        "Download a URL into the user's downloads folder (with the browser's cookies, so logged-in files work). " +
        "Waits until it finishes by default and returns where the file landed.",
      inputSchema: {
        url: z.string().describe("What to download"),
        filename: z.string().optional().describe("File name or subfolder path inside the downloads folder (default: from the server)"),
        wait: z.boolean().optional().describe("Wait for it to finish (default true)"),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe("How long to wait (default 60000)"),
      },
    },
    async (args) => {
      const t = args.wait === false ? 0 : (args.timeoutMs ?? 60000);
      return text(
        await callBridge(
          bridge,
          "downloads.start",
          { url: args.url, filename: args.filename, wait: args.wait, timeoutMs: args.timeoutMs },
          { timeoutMs: t + 20000 },
        ),
      );
    },
  );

  server.registerTool(
    "cookie_query",
    {
      description: "Cookies a page sees (name, value, domain, path, flags, expiry), including partitioned ones. Useful for debugging logins.",
      inputSchema: {
        tabId: tabIdField,
        url: cookieUrlField,
        name: z.string().optional().describe("Only cookies with this name"),
      },
    },
    async (args) => text(await callBridge(bridge, "cookies.query", { tabId: args.tabId, url: args.url, name: args.name })),
  );

  server.registerTool(
    "cookie_set",
    {
      description:
        "Create or overwrite a cookie for a site. Reload the page (tab_navigate go:\"reload\") for it to take effect. " +
        "Without an expiry it's a session cookie.",
      inputSchema: {
        tabId: tabIdField,
        url: cookieUrlField,
        name: z.string().min(1).describe("Cookie name"),
        value: z.string().describe("Cookie value"),
        domain: z.string().optional().describe("e.g. \".example.com\" to share with subdomains (default: host-only)"),
        path: z.string().optional().describe("Default \"/\""),
        secure: z.boolean().optional(),
        httpOnly: z.boolean().optional(),
        sameSite: z.enum(["no_restriction", "lax", "strict"]).optional(),
        expiresInSeconds: z.number().int().positive().optional().describe("Lifetime from now"),
        expires: z.string().optional().describe("Or an absolute ISO date"),
      },
    },
    async (args) => text(await callBridge(bridge, "cookies.set", { ...args, path: args.path ?? "/" })),
  );

  server.registerTool(
    "cookie_remove",
    {
      description:
        "Delete a site's cookies with this name (every domain/path variant the page sees). " +
        "Can log the user out. Destructive: needs confirm:true unless the user turned the guard off.",
      inputSchema: {
        tabId: tabIdField,
        url: cookieUrlField,
        name: z.string().min(1).describe("Cookie name"),
        confirm: confirmField,
      },
    },
    async (args) => {
      const denied = requireConfirm(config, args.confirm, "cookie_remove");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "cookies.remove", { tabId: args.tabId, url: args.url, name: args.name }));
    },
  );

  server.registerTool(
    "storage_get",
    {
      description:
        "Read a stored value by key. With no key, lists the keys (agent area: optionally those starting with prefix). " +
        "Check the agent area at the start of a task for notes you left yourself.",
      inputSchema: {
        area: areaField,
        key: z.string().optional().describe("Key to read (omit to list keys)"),
        prefix: z.string().optional().describe("Agent area: only list keys starting with this"),
        tabId: tabIdField,
      },
    },
    async (args) =>
      text(await callBridge(bridge, "storage.get", { area: args.area, key: args.key, prefix: args.prefix, tabId: args.tabId })),
  );

  server.registerTool(
    "storage_set",
    {
      description:
        "Save a value under a key. Agent area: any JSON (up to 100000 chars, 1000 keys), survives restarts; " +
        "use it to remember progress, preferences or findings between tasks. Page areas store a string (objects become JSON).",
      inputSchema: {
        area: areaField,
        key: z.string().min(1).max(200).describe("Key, e.g. \"shopping/last-order\""),
        value: z.unknown().describe("The value"),
        tabId: tabIdField,
      },
    },
    async (args) =>
      text(await callBridge(bridge, "storage.set", { area: args.area, key: args.key, value: args.value, tabId: args.tabId })),
  );

  server.registerTool(
    "storage_remove",
    {
      description: "Delete a stored key.",
      inputSchema: {
        area: areaField,
        key: z.string().min(1).describe("Key to delete"),
        tabId: tabIdField,
      },
    },
    async (args) => text(await callBridge(bridge, "storage.remove", { area: args.area, key: args.key, tabId: args.tabId })),
  );

  server.registerTool(
    "session_query",
    {
      description: "Recently closed tabs and windows, newest first, with the sessionId session_restore needs.",
      inputSchema: {
        limit: z.number().int().positive().max(25).optional().describe("Max entries (default 10)"),
      },
    },
    async (args) => text(await callBridge(bridge, "sessions.recentlyClosed", { limit: args.limit ?? 10 })),
  );

  server.registerTool(
    "session_restore",
    {
      description: "Reopen a recently closed tab or window (sessionId from session_query).",
      inputSchema: {
        sessionId: z.string().describe("Session id"),
      },
    },
    async (args) => text(await callBridge(bridge, "sessions.restore", { sessionId: args.sessionId })),
  );
}
