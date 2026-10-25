/**
 * Page-reading tools: the accessibility outline, text, HTML, screenshots,
 * page metadata and text search.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, fmt, hasTarget, refusal, tabIdField, targetFields, targetOf, text, toBridgeError, withinField } from "./helpers.js";

function errText(e: unknown) {
  const { code, message } = toBridgeError(e);
  return text(`ERROR [${code}]: ${message}`);
}

const REF_HINT =
  "Act on these with page_click/page_type/... and {ref: N}. A ref keeps pointing at the same element until the page navigates. " +
  "You can also target by name (the quoted text) and role without a ref.";

export function registerUnderstandTools(
  server: McpServer,
  bridge: ExtensionBridge,
  _config: ServerConfig,
): void {
  server.registerTool(
    "page_snapshot",
    {
      description:
        "Outline of the page's interactive and structural elements, one per line: role \"name\" [ref=N] plus state " +
        "([checked], [disabled], values). Take it before acting on a page you haven't seen; refs are the most reliable targets. " +
        "Includes shadow DOM and same-origin iframes and waits for pages that render late. " +
        "Long page? Use within to read one region, or viewportOnly after page_scroll.",
      inputSchema: {
        tabId: tabIdField,
        within: withinField,
        viewportOnly: z.boolean().optional().describe("Only elements currently on screen (cheap; pair with page_scroll)"),
        maxChars: z.number().int().positive().optional().describe("Max chars (default 50000)"),
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
          maxChars: args.maxChars ?? 50000,
          compact: args.compact ?? true,
        });
      } catch (e) {
        return errText(e);
      }
      const r = (result ?? {}) as Record<string, unknown>;
      if (typeof r["text"] !== "string") return text(fmt(result, args.maxChars ?? 50000));
      const scroll = r["scroll"] as { y?: number; viewportHeight?: number; pageHeight?: number } | undefined;
      const head = [`url: ${String(r["url"] ?? "")}`, `title: ${String(r["title"] ?? "")}`, `generation: ${String(r["generation"] ?? "")}`];
      if (r["within"]) head.push(`within: ${String(r["within"])}`);
      if (scroll && scroll.pageHeight) {
        head.push(`scroll: ${scroll.y ?? 0} of ${Math.max(0, scroll.pageHeight - (scroll.viewportHeight ?? 0))}px`);
      }
      if (r["hint"]) head.push(`TRUNCATED: ${String(r["hint"])}`);
      const body = r["text"] || "(nothing interactive here; try compact:false or page_text)";
      return text(`${head.join("\n")}\n\n${body}\n\n${REF_HINT}`);
    },
  );

  server.registerTool(
    "page_text",
    {
      description:
        "The page's visible text, as a reader sees it. Long pages come in chunks: when it says more follows, " +
        "call again with offset set to nextOffset. Use within to read one region (e.g. {role: \"main\"}).",
      inputSchema: {
        tabId: tabIdField,
        within: withinField,
        maxChars: z.number().int().positive().max(200000).optional().describe("Chunk size (default 20000)"),
        offset: z.number().int().min(0).optional().describe("Start at this character (from a previous nextOffset)"),
      },
    },
    async (args) => {
      try {
        const result = await bridge.call("page.text", {
          tabId: args.tabId,
          within: args.within,
          maxChars: args.maxChars ?? 20000,
          offset: args.offset,
        });
        const r = (result ?? {}) as Record<string, unknown>;
        if (typeof r["text"] !== "string") return text(fmt(result));
        const head = [`url: ${String(r["url"] ?? "")}`, `title: ${String(r["title"] ?? "")}`];
        if (r["within"]) head.push(`within: ${String(r["within"])}`);
        const total = Number(r["totalChars"] ?? 0);
        const off = Number(r["offset"] ?? 0);
        if (off > 0 || r["truncated"]) {
          head.push(`chars ${off}-${off + (r["text"] as string).length} of ${total}`);
        }
        const tail = r["truncated"] ? `\n\n[more follows: call page_text again with offset: ${String(r["nextOffset"])}]` : "";
        return text(`${head.join("\n")}\n\n${r["text"]}${tail}`);
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
        maxChars: z.number().int().positive().optional().describe("Max chars (default 50000)"),
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
          const head = [`url: ${String(r.url ?? "")}`, `title: ${String(r.title ?? "")}`];
          if (r.truncated) {
            head.push(`TRUNCATED to ${maxChars} of ${String(r.totalChars)} chars. Pass a selector or within to get one part.`);
          }
          return text(`${head.join("\n")}\n\n${r.html}`);
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
        "Use jpeg and a scale below 1 to save tokens. Background tabs are captured without switching where Firefox allows.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        fullPage: z.boolean().optional().describe("Capture the whole scrollable page (up to 16000px tall)"),
        format: z.enum(["png", "jpeg"]).optional().describe("png (default) or jpeg (much smaller)"),
        quality: z.number().int().min(10).max(100).optional().describe("jpeg quality (default 80)"),
        scale: z
          .number()
          .min(0.1)
          .max(2)
          .optional()
          .describe("Resize factor, e.g. 0.5 for half size (default 1; big element/full-page shots shrink to fit 4000px)"),
        keepActive: z.boolean().optional().describe("Leave the captured tab focused afterwards"),
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
          keepActive: args.keepActive,
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
      description: "A tab's URL, title and load status. Cheap: no page access.",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "page.info", { tabId: args.tabId })),
  );

  server.registerTool(
    "page_find",
    {
      description:
        "Find visible text on the page, case-insensitively. Each match has a snippet, the ref of the element to click " +
        "for it, and offscreen:true when you'd need to scroll. Faster than reading the whole page to locate one thing.",
      inputSchema: {
        tabId: tabIdField,
        query: z.string().min(1).describe("Text to look for"),
      },
    },
    async (args) => text(await callBridge(bridge, "act.find", { tabId: args.tabId, query: args.query })),
  );
}
