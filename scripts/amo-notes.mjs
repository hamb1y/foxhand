// Print a version's CHANGELOG.md section as plain text for the AMO release notes.
//   node scripts/amo-notes.mjs 0.5.0
// AMO shows release notes as text, so Markdown is flattened: no ** or `, links
// become "text (url)", and hard-wrapped lines are joined.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) { console.error('usage: node scripts/amo-notes.mjs X.Y.Z'); process.exit(2); }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.indexOf(`## ${version}`);
if (start < 0) { console.error(`CHANGELOG.md has no '## ${version}' section`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
if (end < 0) end = lines.length;

const inline = (s) => s
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    text.replace(/\/$/, '') === url.replace(/^https?:\/\//, '').replace(/\/$/, '') ? url : `${text} (${url})`)
  .replace(/\*\*/g, '')
  .replace(/`/g, '');

// Blocks: a heading, a list item or a paragraph. Wrapped lines join their block.
const out = [];
let block = null;
for (const raw of lines.slice(start + 1, end)) {
  if (!raw.trim()) { block = null; if (out.length && out.at(-1) !== '') out.push(''); continue; }
  const heading = raw.match(/^#{3,}\s+(.*)/);
  if (heading) {
    if (out.length && out.at(-1) !== '') out.push('');
    out.push(inline(heading[1]));
    block = null;
    continue;
  }
  if (/^\s*- /.test(raw) || block === null) { out.push(inline(raw.trimEnd())); block = out.length - 1; continue; }
  out[block] += ' ' + inline(raw.trim());
}
while (out.length && out.at(-1) === '') out.pop();
while (out.length && out[0] === '') out.shift();

// AMO takes at most 3000 characters. A longer section is shortened: each bullet
// keeps its lead sentence (they're written as summaries), tables point to the
// full notes, and a link to the GitHub release gives everything.
const MAX = 3000;
let text = out.join('\n');
if (text.length > MAX) {
  const full = `All the details: https://github.com/hamb1y/foxhand/releases/tag/v${version}`;
  const short = [];
  let inTable = false;
  for (const l of out) {
    if (/^\|/.test(l)) {
      if (!inTable) short.push('(The table of old and new names is in the full notes.)');
      inTable = true;
      continue;
    }
    inTable = false;
    const m = /^(\s*- )(.+?[.!?])(\s|$)/.exec(l);
    short.push(m ? m[1] + m[2] : l);
  }
  while (short.length && short.join('\n').length + full.length + 2 > MAX) {
    short.pop();
    while (short.length && short.at(-1) === '') short.pop();
  }
  text = short.join('\n') + '\n\n' + full;
}
process.stdout.write(text + '\n');
