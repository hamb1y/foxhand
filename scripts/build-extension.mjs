// Build the add-on: extension/src/**/*.ts -> build/extension/ (classic scripts), plus the static
// assets from extension/ (manifest, html, css, icons, fonts, cursors, generated _locales).
// Each entry point is bundled to ONE readable, unminified IIFE: no runtime, no module syntax, so the
// manifest and the HTML pages load the files in the same order as before.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'build', 'extension');

const ENTRIES = [
  'background', 'announcements', 'common', 'options', 'popup', 'onboarding', 'announcement', 'regex-worker',
  'content/cursor', 'content/ax',
];
// Same allow-list scripts/pack-extension.sh ships (README-INSTALL.md and local files stay out).
const STATIC = [
  'manifest.json', 'ui.css', 'popup.html', 'announcement.html', 'announcement.css', 'options.html',
  'onboarding.html', '_locales', 'icons', 'fonts', 'cursors',
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of STATIC) {
  const from = path.join(src, entry);
  if (!existsSync(from)) throw new Error('missing extension/' + entry + (entry === '_locales' ? ' (run node scripts/i18n.mjs)' : ''));
  cpSync(from, path.join(out, entry), { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });
}

await build({
  entryPoints: ENTRIES.map((e) => path.join(src, 'src', e + '.ts')),
  outdir: out,
  outbase: path.join(src, 'src'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'firefox142',
  charset: 'utf8',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

const built = readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith('.js')).length;
console.log('[foxhand] built ' + built + ' scripts into ' + path.relative(root, out));
