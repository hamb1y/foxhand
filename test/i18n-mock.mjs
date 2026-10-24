// The real English strings, for tests that fake the WebExtension API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MESSAGES = JSON.parse(fs.readFileSync(path.join(root, "extension/_locales/en/messages.json"), "utf8"));

/** browser.i18n.getMessage, as Firefox resolves it: named placeholders, then $$ -> $. */
export function getMessage(key, subs) {
  const m = MESSAGES[key];
  if (!m) return "";
  const args = subs === undefined ? [] : [].concat(subs).map(String);
  return m.message
    .replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => {
      const ph = m.placeholders?.[name.toLowerCase()];
      return ph ? ph.content.replace(/\$(\d)/g, (__, n) => args[Number(n) - 1] ?? "") : "";
    })
    .replace(/\$\$/g, "$");
}

/** Page-side version: adds browser.i18n to whatever fake `browser` the page has. */
export const I18N_SHIM = `(() => {
  const MESSAGES = ${JSON.stringify(MESSAGES)};
  const getMessage = ${getMessage.toString()};
  window.browser = window.browser || {};
  window.browser.i18n = { getMessage, getUILanguage: () => "en" };
})();`;
