/**
 * Page-reading tools: the accessibility outline, text, HTML, screenshots,
 * page metadata and text search.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, fmt, hasTarget, oneLine, refusal, tabIdField, targetFields, targetOf, text, toBridgeError, untrusted, withinField } from "./helpers.js";

function errText(e: unknown) {
  const { code, message } = toBridgeError(e);
  return text(`ERROR [${code}]: ${message}`);
}

const REF_HINT =
  "Act on these with page_click/page_type/... and {ref: N}. A ref keeps pointing at the same element until the page navigates. " +
  "You can also target by name (the quoted text) and role without a ref. Indented lines are inside the line above " +
  "(a row, list item, dialog, form or frame). \"clickable\" marks elements the page made clickable with script only.";

export function registerUnderstandTools(
  server: McpServer,
  bridge: ExtensionBridge,
  _config: ServerConfig,
): void {
  server.registerTool(
    "page_snapshot",
    {
      description:
        "Works in background tabs: pass tabId. Outline of what you can act on, one element per line: role \"name\" [ref=N] plus state " +
        "([checked], [disabled], [expanded], values), nested under the landmark, dialog, form, row or list item it belongs to. " +
        "Includes buttons the page made from plain divs, icon-only buttons (named by their tooltip or icon), shadow DOM (open and closed) " +
        "and iframes, cross-origin ones too. Waits for pages that render late. Take it before acting on a page you haven't seen; " +
        "refs are the most reliable targets. Long page? Use within to read one region, or viewportOnly after page_scroll.",
      inputSchema: {
        tabId: tabIdField,
        within: withinField,
        viewportOnly: z.boolean().optional().describe("Only elements currently on screen (cheap; pair with page_scroll)"),
        links: z
          .enum(["full", "short", "none"])
          .optional()
          .describe("Links: \"short\" (default) text only, \"full\" with their URLs, \"none\" left out. page_links finds one link's URL"),
        maxChars: z.number().int().positive().max(100000).optional().describe("Max chars (default 50000)"),
        compact: z
          .boolean()
          .optional()
          .describe("true (default): interactive elements and landmarks only. false: also headings and text blocks"),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        result = await bridge.call("page.snapshot", {
          tabId: args.tabId,
          within: args.within,
          viewportOnly: args.viewportOnly,
          links: args.links,
          maxChars: args.maxChars ?? 50000,
          compact: args.compact ?? true,
        });
      } catch (e) {
        return errText(e);
      }
      const r = (result ?? {}) as Record<string, unknown>;
      if (typeof r["text"] !== "string") return text(fmt(result, args.maxChars ?? 50000));
      const scroll = r["scroll"] as { y?: number; viewportHeight?: number; pageHeight?: number } | undefined;
      const head = [`url: ${oneLine(r["url"])}`, `title: ${oneLine(r["title"])}`, `generation: ${oneLine(r["generation"])}`];
      if (r["within"]) head.push(`within: ${oneLine(r["within"])}`);
      if (scroll && scroll.pageHeight) {
        head.push(`scroll: ${scroll.y ?? 0} of ${Math.max(0, scroll.pageHeight - (scroll.viewportHeight ?? 0))}px`);
      }
      if (r["modal"]) head.push(`MODAL OPEN: ${oneLine(r["modal"])}. The rest of the page is blocked until it's answered or closed.`);
      else if (r["overlay"]) head.push(`OVERLAY: ${oneLine(r["overlay"])} covers the middle of the screen (a banner or pop-up?). Clicks behind it may not reach their target; close it first.`);
      if (r["hint"]) head.push(`TRUNCATED: ${oneLine(r["hint"])}`);
      const body = r["text"] ? untrusted(r["text"] as string) : "(nothing interactive here; try compact:false or page_text)";
      return text(`${head.join("\n")}\n\n${body}\n\n${REF_HINT}`);
    },
  );

  server.registerTool(
    "page_text",
    {
      description:
        "Read a tab by its id (no focus needed). The page's visible text, as a reader sees it, including the text of iframes. format \"markdown\" keeps headings, lists, " +
        "tables, emphasis and link URLs ([text](url)), and shows form fields; use it when structure or links matter. " +
        "Long pages come in chunks: when it says more follows, call again with offset set to nextOffset. " +
        "Use within to read one region (e.g. {role: \"main\"}).",
      inputSchema: {
        tabId: tabIdField,
        within: withinField,
        maxChars: z.number().int().positive().max(200000).optional().describe("Chunk size (default 20000)"),
        offset: z.number().int().min(0).optional().describe("Start at this character (from a previous nextOffset)"),
        format: z.enum(["text", "markdown"]).optional().describe("\"text\" (default) or \"markdown\" (headings, lists, tables, links with URLs)"),
      },
    },
    async (args) => {
      try {
        const result = await bridge.call("page.text", {
          tabId: args.tabId,
          within: args.within,
          maxChars: args.maxChars ?? 20000,
          offset: args.offset,
          format: args.format,
        });
        const r = (result ?? {}) as Record<string, unknown>;
        if (typeof r["text"] !== "string") return text(fmt(result));
        const head = [`url: ${oneLine(r["url"])}`, `title: ${oneLine(r["title"])}`];
        if (r["within"]) head.push(`within: ${oneLine(r["within"])}`);
        const total = Number(r["totalChars"] ?? 0);
        const off = Number(r["offset"] ?? 0);
        if (off > 0 || r["truncated"]) {
          head.push(`chars ${off}-${off + (r["text"] as string).length} of ${total}`);
        }
        const tail = r["truncated"] ? `\n\n[more follows: call page_text again with offset: ${String(r["nextOffset"])}]` : "";
        return text(`${head.join("\n")}\n\n${untrusted(r["text"] as string)}${tail}`);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "page_html",
    {
      description:
        "HTML of the page or of one part of it. Prefer a selector or within: a whole page is mostly noise. " +
        "For reading, page_text and page_snapshot are cheaper.",
      inputSchema: {
        tabId: tabIdField,
        selector: z.string().optional().describe("CSS selector of the part to return"),
        within: withinField,
        maxChars: z.number().int().positive().max(100000).optional().describe("Max chars (default 50000)"),
      },
    },
    async (args) => {
      const maxChars = args.maxChars ?? 50000;
      try {
        const result = await bridge.call("page.html", {
          tabId: args.tabId,
          selector: args.selector,
          within: args.within,
          maxChars,
        });
        const r = result as { html?: unknown; url?: unknown; title?: unknown; truncated?: unknown; totalChars?: unknown } | null;
        if (r && typeof r.html === "string") {
          const head = [`url: ${oneLine(r.url)}`, `title: ${oneLine(r.title)}`];
          if (r.truncated) {
            head.push(`TRUNCATED to ${maxChars} of ${String(r.totalChars)} chars. Pass a selector or within to get one part.`);
          }
          return text(`${head.join("\n")}\n\n${untrusted(r.html)}`);
        }
        return text(fmt(result, maxChars));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "page_screenshot",
    {
      description:
        "Screenshot as an image: the visible area (default), one element (ref/name/selector), or the whole page (fullPage). " +
        "Default: jpeg, scaled so the longest side is at most 1280px; pass scale for more detail. Never switches tabs: pass the tab id; a background tab is captured in place, or you get an error (do not tab_focus to work around it).",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        fullPage: z.boolean().optional().describe("Capture the whole scrollable page (up to 16000px tall)"),
        format: z.enum(["png", "jpeg"]).optional().describe("jpeg (default) or png"),
        quality: z.number().int().min(10).max(100).optional().describe("jpeg quality (default 80)"),
        scale: z
          .number()
          .min(0.1)
          .max(2)
          .optional()
          .describe("Resize factor, e.g. 0.5 for half size (default: longest side at most 1280px)"),
      },
    },
    async (args) => {
      if (args.fullPage && hasTarget(args)) return refusal("ERROR [INVALID_PARAMS]: pass an element or fullPage, not both");
      let result: unknown;
      try {
        result = await bridge.call("page.shot", {
          ...targetOf(args),
          fullPage: args.fullPage,
          format: args.format,
          quality: args.quality,
          scale: args.scale,
        });
      } catch (e) {
        return errText(e);
      }
      const obj = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
      const dataUrl = obj?.["image"] ?? obj?.["dataUrl"] ?? obj?.["dataURL"];
      const m = typeof dataUrl === "string" ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl) : null;
      if (m) {
        const [, mimeType, data] = m as unknown as [string, string, string];
        const meta = { ...(obj ?? {}) };
        delete meta["image"];
        delete meta["dataUrl"];
        delete meta["dataURL"];
        return {
          content: [
            { type: "image" as const, data, mimeType },
            { type: "text" as const, text: fmt(meta) },
          ],
        };
      }
      return text(fmt(result));
    },
  );

  server.registerTool(
    "page_info",
    {
      description: "A tab's URL, title, load status and whether it is active. Cheap: no page access.",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "page.info", { tabId: args.tabId })),
  );

  server.registerTool(
    "page_links",
    {
      description:
        "Only the links of a tab (or of one part, with within) whose text or URL matches, with refs and full URLs. " +
        "Returns at most limit (default 50) and the total that matched. Cheaper than reading the page to find one link.",
      inputSchema: {
        tabId: tabIdField,
        within: withinField,
        text: z.string().optional().describe("Text the link must contain (case-insensitive)"),
        hrefContains: z.string().optional().describe("Text its URL must contain"),
        limit: z.number().int().positive().max(500).optional().describe("Max links (default 50)"),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        result = await bridge.call("page.links", { tabId: args.tabId, within: args.within, text: args.text, hrefContains: args.hrefContains, limit: args.limit ?? 50 });
      } catch (e) {
        return errText(e);
      }
      const r = result as { url?: unknown; title?: unknown; within?: unknown; total?: number; returned?: number; truncated?: boolean; links?: { ref?: number; text?: string; href?: string }[] } | null;
      if (!r || !Array.isArray(r.links)) return text(fmt(result));
      const head = [`url: ${oneLine(r.url)}`, `title: ${oneLine(r.title)}`];
      if (r.within) head.push(`within: ${oneLine(r.within)}`);
      head.push(`links: ${r.returned ?? r.links.length} of ${r.total ?? r.links.length} matching${r.truncated ? " (raise limit, or narrow with text, hrefContains or within)" : ""}`);
      const body = r.links.map((l) => `[ref=${l.ref}] ${JSON.stringify(l.text ?? "")} -> ${l.href ?? ""}`).join("\n");
      return text(`${head.join("\n")}\n\n${body ? untrusted(body) : "(no matching links)"}`);
    },
  );

  server.registerTool(
    "page_find",
    {
      description:
        "Find visible text on the page (and in its iframes), case-insensitively, even when it spans several elements. " +
        "Each match has a snippet, the ref of the element to click for it, and offscreen:true when you'd need to scroll. " +
        "Faster than reading the whole page to locate one thing. At most 30 matches, with the total count.",
      inputSchema: {
        tabId: tabIdField,
        query: z.string().min(1).describe("Text to look for"),
      },
    },
    async (args) => text(await callBridge(bridge, "act.find", { tabId: args.tabId, query: args.query })),
  );
}
