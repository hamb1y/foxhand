// Dev preview only. Builds what the preview serves; contacts nothing and deploys nothing.
//   - dist/cloudflare: the website exactly as `npm run build:cloudflare` makes it (pinned to package.json's version)
//   - dev-preview/before: the extension and website as they are in git HEAD, for before/after comparison
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const before = path.join(here, 'before');

export function prepare({ refresh = false } = {}) {
  execFileSync(process.execPath, ['scripts/build-cloudflare.mjs'], { cwd: root, stdio: 'inherit' });
  if (refresh || !existsSync(path.join(before, 'dist/cloudflare/index.html'))) {
    rmSync(before, { recursive: true, force: true });
    mkdirSync(before, { recursive: true });
    const base = process.env.PREVIEW_BASE_REF || '00aa3ed81441593ad7997489409dfc8f409ca85f';
    const files = ['extension', 'site', 'scripts', 'docs', 'CHANGELOG.md', 'popup-endpoint', 'cloudflare', 'package.json'];
    const tar = execFileSync('git', ['archive', base, ...files], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', before], { input: tar });
    execFileSync(process.execPath, ['scripts/build-cloudflare.mjs'], { cwd: before, stdio: 'inherit' });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) prepare({ refresh: process.argv.includes('--refresh') });
