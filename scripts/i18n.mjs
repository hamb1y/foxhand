// Turn i18n/<locale>.json (plain "key": "text with $1") into extension/_locales/<locale>/messages.json.
//   node scripts/i18n.mjs          write the locale files
//   node scripts/i18n.mjs --check  fail if a translation is incomplete or the locale files are stale
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "i18n");
const out = path.join(root, "extension", "_locales");
const check = process.argv.includes("--check");

const read = (f) => JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
const slots = (s) => [...new Set(s.match(/\$\d/g) ?? [])].sort().join(",");

const en = read("en.json");
const keys = Object.keys(en);
let problems = 0;
const fail = (msg) => { console.error(msg); problems++; };

/* WebExtension messages: $1.. only via named placeholders, and a literal $ is written $$. */
function toMessages(strings) {
  const out = {};
  for (const k of keys) {
    const text = strings[k];
    const placeholders = {};
    const message = text.replace(/\$(\d)|\$/g, (m, n) => {
      if (!n) return "$$";
      placeholders[`p${n}`] = { content: `$${n}` };
      return `$P${n}$`;
    });
    out[k] = Object.keys(placeholders).length ? { message, placeholders } : { message };
  }
  return out;
}

for (const file of fs.readdirSync(src).filter((f) => f.endsWith(".json")).sort()) {
  const locale = file.replace(/\.json$/, "");
  const strings = read(file);
  for (const k of keys) {
    if (typeof strings[k] !== "string" || !strings[k].trim()) fail(`${locale}: missing "${k}"`);
    else if (slots(strings[k]) !== slots(en[k])) fail(`${locale}: "${k}" uses ${slots(strings[k]) || "no slots"}, English uses ${slots(en[k]) || "none"}`);
  }
  for (const k of Object.keys(strings)) if (!(k in en)) fail(`${locale}: "${k}" isn't an English key`);
  if (problems) continue;
  const json = `${JSON.stringify(toMessages(strings), null, 2)}\n`;
  const dest = path.join(out, locale, "messages.json");
  if (check) {
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
    if (have !== json) fail(`${path.relative(root, dest)} is out of date: run node scripts/i18n.mjs`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, json);
    console.log(`wrote ${path.relative(root, dest)} (${keys.length} strings)`);
  }
}
if (problems) process.exit(1);
if (check) console.log("translations complete and up to date");
