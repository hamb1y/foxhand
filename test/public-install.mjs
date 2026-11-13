// CI-only public installation smoke test. No local release server/base override.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run only on disposable GitHub Actions runners');
const want = process.env.PUBLIC_VERSION || '0.5.7';
assert.match(want, /^\d+\.\d+\.\d+$/);
const home = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'foxhand-public-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') };
delete env.FOXHAND_BASE; delete env.WEBMCP_BASE;
if (process.platform === 'win32') {
  // The workflow's pwsh parent supplies a PS7 module path. Give Windows
  // PowerShell 5.1 its own built-ins so Get-FileHash can autoload normally.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
}
for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true });
const latest = await (await fetch('https://foxhand.pages.dev/download/latest.json', { cache: 'no-store' })).json();
assert.equal(latest.version, want, 'Live pinned release differs from requested smoke-test version');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://foxhand.pages.dev/download/ps | iex']);
else run('bash', ['-c', 'set -eo pipefail; curl -fsSL https://foxhand.pages.dev/download/sh | sh']);
const binary = process.platform === 'win32' ? path.join(env.LOCALAPPDATA, 'foxhand/foxhand-host.exe') : process.platform === 'darwin' ? path.join(home, 'Library/Application Support/foxhand/foxhand-host') : path.join(home, '.local/share/foxhand/foxhand-host');
// The native host reserves stdout; version/status normally write to stderr.
const merged = args => run(process.execPath, ['--input-type=module', '-e', 'import {spawnSync} from "node:child_process"; const r=spawnSync(process.argv[1],process.argv.slice(2),{encoding:"utf8"});process.stdout.write((r.stdout||"")+(r.stderr||""));process.exit(r.status??1);', binary, ...args]).trim();
assert.equal(merged(['version']), want);
console.log(merged(['status']));
const fd = openSync(binary, 'r'), header = Buffer.alloc(512); readSync(fd, header, 0, header.length, 0);
if (process.platform === 'linux') assert.equal(header.readUInt16LE(18), process.arch === 'arm64' ? 183 : 62, 'ELF architecture');
if (process.platform === 'win32') {
 const pe = header.readUInt32LE(60), signature = Buffer.alloc(6); readSync(fd, signature, 0, 6, pe);
 assert.equal(signature.readUInt16LE(4), process.arch === 'arm64' ? 0xaa64 : 0x8664, 'PE architecture');
}
closeSync(fd);
if (process.platform === 'darwin') {
 run('codesign', ['--verify', '--verbose=2', binary]);
 assert.ok(run('lipo', ['-archs', binary]).trim().split(/\s+/).includes(process.arch === 'arm64' ? 'arm64' : 'x86_64'), 'Mach-O architecture');
}
console.log(`Public install passed: ${process.platform}/${process.arch}, helper ${want}, isolated home ${home}. No base override; no user Firefox profile used.`);
