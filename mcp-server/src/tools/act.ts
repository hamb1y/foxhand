/**
 * Page-interaction tools. An element is named by ref (from page_snapshot),
 * by name (+ role, nth), by CSS selector, or by a viewport point x,y.
 * Every action reports what changed on the page (`changes`) and anything
 * worth knowing (`notes`), and follows a navigation it caused.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeMethod } from "@webmcp-controller/shared";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, hasTarget, refusal, tabIdField, targetFields, targetOf, text } from "./helpers.js";

const dialogField = z
  .enum(["accept", "dismiss"])
  .optional()
  .describe(
    "How to answer a confirm()/prompt() this action makes the page show (default dismiss = Cancel). " +
      "Dialogs never block; the result lists them (`dialogs`). Repeat with \"accept\" to answer OK.",
  );

const promptTextField = z.string().max(1000).optional().describe("Text to answer a prompt() with, when dialog is \"accept\"");

const changesField = z
  .boolean()
  .optional()
  .describe("Report what changed on the page after the action (default true; false is a little faster)");

const submitFields = {
  submit: z
    .boolean()
    .optional()
    .describe(
      "Submit once afterwards. In a form: its submit button (unless a field is invalid). Outside a form (chat boxes): " +
        "the box's own Send button if there is exactly one, else Enter. `submitted` says how; false comes with a note.",
    ),
  submitRef: z.number().int().positive().optional().describe("Ref of the button that submits (implies submit)"),
  submitName: z.string().optional().describe("Label of the button that submits, e.g. \"Send\" (implies submit)"),
  submitSelector: z.string().optional().describe("CSS selector of the button that submits (implies submit)"),
};

const TARGET_HELP = "Name the element with ref, name (+role), selector, or x,y.";

function needTarget(args: Record<string, unknown>, tool: string) {
  return hasTarget(args) ? null : refusal(`ERROR [INVALID_PARAMS]: ${tool} needs an element. ${TARGET_HELP}`);
}

export function registerActTools(
  server: McpServer,
  bridge: ExtensionBridge,
  _config: ServerConfig,
): void {
  /** Forward an action, with room for the element wait on top of the bridge timeout. */
  const act = async (method: BridgeMethod, params: Record<string, unknown>, extraMs = 0) => {
    const wait = typeof params["waitMs"] === "number" ? (params["waitMs"] as number) : 3000;
    return text(await callBridge(bridge, method, params, { timeoutMs: 30000 + wait + extraMs }));
  };

  server.registerTool(
    "page_click",
    {
      description:
        "Click an element. " + TARGET_HELP + " Use x,y for canvas apps (maps, editors, games). " +
        "Returns what changed, tabs the click opened (openedTabs), and the new URL if it navigated.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        double: z.boolean().optional().describe("Double-click"),
        button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button (default left; right opens the page's own context menu)"),
        modifiers: z.array(z.enum(["Ctrl", "Alt", "Shift", "Meta"])).optional().describe("Keys held while clicking"),
        dialog: dialogField,
        promptText: promptTextField,
        changes: changesField,
      },
    },
    async (args) => {
      const bad = needTarget(args, "page_click");
      if (bad) return bad;
      return act("act.click", {
        ...targetOf(args),
        double: args.double,
        button: args.button,
        modifiers: args.modifiers,
        dialog: args.dialog,
        promptText: args.promptText,
        changes: args.changes,
      });
    },
  );

  server.registerTool(
    "page_type",
    {
      description:
        "Type into a text field, textarea or rich editor, replacing its text (append:true adds to it). " +
        "Name the field by ref, or by name (its label or placeholder); with none, types into the focused field. " +
        "Also sets checkboxes (\"true\"/\"false\") and selects (option label). Can submit afterwards.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        text: z.string().describe("The text"),
        append: z.boolean().optional().describe("Add to the existing text instead of replacing it"),
        ...submitFields,
        dialog: dialogField,
        promptText: promptTextField,
        changes: changesField,
      },
    },
    async (args) =>
      act("act.type", {
        ...targetOf(args),
        text: args.text,
        append: args.append,
        submit: args.submit,
        submitRef: args.submitRef,
        submitName: args.submitName,
        submitSelector: args.submitSelector,
        dialog: args.dialog,
        promptText: args.promptText,
        changes: args.changes,
      }),
  );

  server.registerTool(
    "page_fill",
    {
      description:
        "Fill several fields in one call (same rules as page_type). Every field is found and checked before anything changes, " +
        "so a wrong field fails the call without partial edits. Fields can be named by ref, name (label/placeholder) or selector.",
      inputSchema: {
        tabId: tabIdField,
        fields: z
          .array(
            z
              .object({
                ref: z.number().int().positive().optional(),
                name: z.string().optional().describe("The field's label or placeholder"),
                role: z.string().optional(),
                nth: z.number().int().positive().optional(),
                selector: z.string().optional(),
                value: z.string().describe("Text; \"true\"/\"false\" for checkboxes; option label or value for selects"),
              })
              .refine((f) => f.ref !== undefined || f.selector !== undefined || f.name !== undefined || f.role !== undefined, {
                message: "each field needs a ref, name or selector",
              }),
          )
          .min(1)
          .describe("The fields and their values"),
        generation: targetFields.generation,
        ...submitFields,
        dialog: dialogField,
        promptText: promptTextField,
        changes: changesField,
      },
    },
    async (args) =>
      act("act.fillForm", {
        tabId: args.tabId,
        fields: args.fields,
        generation: args.generation,
        submit: args.submit,
        submitRef: args.submitRef,
        submitName: args.submitName,
        submitSelector: args.submitSelector,
        dialog: args.dialog,
        promptText: args.promptText,
        changes: args.changes,
      }),
  );

  server.registerTool(
    "page_select",
    {
      description:
        "Choose option(s) in a dropdown: a native <select>, or a custom one (combobox/listbox) that it opens and clicks for you. " +
        "Values match the option's label or value. On NO_MATCH the error lists the options.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        values: z.array(z.string()).min(1).describe("Option label(s) or value(s); several only for multi-selects"),
        changes: changesField,
      },
    },
    async (args) => {
      const bad = needTarget(args, "page_select");
      if (bad) return bad;
      return act("act.select", { ...targetOf(args), values: args.values, changes: args.changes });
    },
  );

  server.registerTool(
    "page_hover",
    {
      description:
        "Move the pointer over an element, for menus and tooltips that open on hover in JavaScript. " +
        "Effects that are pure CSS :hover can't be triggered by an add-on; click instead if nothing opens.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        changes: changesField,
      },
    },
    async (args) => {
      const bad = needTarget(args, "page_hover");
      if (bad) return bad;
      return act("act.hover", { ...targetOf(args), changes: args.changes });
    },
  );

  server.registerTool(
    "page_scroll",
    {
      description:
        "Scroll: the page by direction (default ~80% of the screen), to top/bottom, an element into view (name it), " +
        "or inside a scrollable element (name it and pass direction). Uses the page's main inner scroller when the window can't scroll " +
        "(chat apps). atEnd:true means there's nothing further.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        pixels: z.number().int().positive().optional().describe("How far (default ~80% of the viewport)"),
        to: z.enum(["top", "bottom"]).optional().describe("Jump to the top or bottom"),
      },
    },
    async (args) =>
      act("act.scroll", { ...targetOf(args), direction: args.direction, pixels: args.pixels, to: args.to, changes: false }),
  );

  server.registerTool(
    "page_key",
    {
      description:
        "Press a key, optionally with modifiers, on the focused element or on a named one (it is focused first). " +
        "The page's handlers run, and the add-on performs the usual default action when the page doesn't: " +
        "Tab moves focus, Enter activates or submits, Space toggles, text keys and Backspace edit, arrows/PageDown scroll, Ctrl+A selects all. " +
        "Browser shortcuts (Ctrl+T, Ctrl+L) aren't possible. `effect` says what happened.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        key: z.string().describe("e.g. \"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"a\""),
        modifiers: z.array(z.enum(["Ctrl", "Alt", "Shift", "Meta"])).optional().describe("Keys held down"),
        times: z.number().int().min(1).max(50).optional().describe("Press it this many times (default 1)"),
        dialog: dialogField,
        promptText: promptTextField,
        changes: changesField,
      },
    },
    async (args) =>
      act("act.key", {
        ...targetOf(args),
        key: args.key,
        modifiers: args.modifiers,
        times: args.times,
        dialog: args.dialog,
        promptText: args.promptText,
        changes: args.changes,
      }),
  );

  server.registerTool(
    "page_wait",
    {
      description:
        "Wait until text or an element appears, or with gone:true until it disappears (spinners, \"Loading…\"). " +
        "With nothing to wait for, waits until the page stops changing. Use it after an action that loads content.",
      inputSchema: {
        tabId: tabIdField,
        text: z.string().optional().describe("Text to wait for"),
        ref: targetFields.ref,
        name: targetFields.name,
        role: targetFields.role,
        selector: targetFields.selector,
        gone: z.boolean().optional().describe("Wait for it to disappear instead"),
        timeoutMs: z.number().int().min(500).max(60000).optional().describe("Give up after this long (default 10000)"),
      },
    },
    async (args) => {
      const timeoutMs = args.timeoutMs ?? 10000;
      return text(
        await callBridge(
          bridge,
          "act.wait",
          {
            tabId: args.tabId,
            text: args.text,
            ref: args.ref,
            name: args.name,
            role: args.role,
            selector: args.selector,
            gone: args.gone,
            timeoutMs,
            changes: false,
          },
          { timeoutMs: timeoutMs + 15000 },
        ),
      );
    },
  );

  server.registerTool(
    "page_drag",
    {
      description:
        "Drag one element (or point) onto another: sortable lists, kanban cards, sliders, map panning. " +
        "Name the source like any target and the drop with toRef, toName (+toRole), toSelector, or toX,toY.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        toRef: z.number().int().positive().optional(),
        toName: z.string().optional(),
        toRole: z.string().optional(),
        toSelector: z.string().optional(),
        toX: z.number().optional().describe("With toY: a viewport point to drop at"),
        toY: z.number().optional(),
        changes: changesField,
      },
    },
    async (args) => {
      const bad = needTarget(args, "page_drag");
      if (bad) return bad;
      const hasDrop =
        args.toRef !== undefined ||
        args.toName !== undefined ||
        args.toRole !== undefined ||
        args.toSelector !== undefined ||
        (args.toX !== undefined && args.toY !== undefined);
      if (!hasDrop) return refusal("ERROR [INVALID_PARAMS]: say where to drop: toRef, toName, toSelector, or toX and toY");
      return act("act.drag", {
        ...targetOf(args),
        toRef: args.toRef,
        toName: args.toName,
        toRole: args.toRole,
        toSelector: args.toSelector,
        toX: args.toX,
        toY: args.toY,
        changes: args.changes,
      });
    },
  );

  server.registerTool(
    "page_upload",
    {
      description:
        "Attach files to a file input or drop zone, as if chosen in the file picker. You supply the contents " +
        "(text, or base64 for binary), about 500KB in all; files on disk can't be read. With no element, uses the page's only file input.",
      inputSchema: {
        tabId: tabIdField,
        ...targetFields,
        files: z
          .array(
            z
              .object({
                name: z.string().min(1).describe("File name, e.g. \"notes.txt\""),
                text: z.string().optional().describe("Contents as text"),
                base64: z.string().optional().describe("Contents as base64 (for binary files)"),
                mimeType: z.string().optional().describe("e.g. \"image/png\" (default: none)"),
              })
              .refine((f) => f.text !== undefined || f.base64 !== undefined, { message: "each file needs text or base64" }),
          )
          .min(1),
        changes: changesField,
      },
    },
    async (args) => act("act.upload", { ...targetOf(args), files: args.files, changes: args.changes }),
  );
}
