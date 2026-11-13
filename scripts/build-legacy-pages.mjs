// Compatibility deployment only. The Cloudflare build continues using site/.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
rmSync('_site', { recursive: true, force: true });
mkdirSync('_site', { recursive: true });
cpSync('site', '_site', { recursive: true });
cpSync('scripts/install.sh', '_site/sh');
cpSync('scripts/install.ps1', '_site/ps');
for (const file of ['extension/icons/icon.svg', 'extension/fonts/GoogleSansFlex-latin.woff2']) cpSync(file, `_site/${file.split('/').at(-1)}`);
writeFileSync('_site/index.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=https://foxhand.pages.dev/"><link rel="canonical" href="https://foxhand.pages.dev/"><title>Foxhand has moved</title><style>body{background:#0a0a0a;color:#f5f5f5;font:18px/1.6 system-ui;padding:3rem}a{color:#FF7139}</style></head><body><h1>Foxhand has moved</h1><p><a href="https://foxhand.pages.dev/">Continue to foxhand.pages.dev</a></p><p>Existing installer links still work.</p></body></html>\n`);
console.log('Prepared legacy _site: homepage redirect, original sh/ps preserved.');
