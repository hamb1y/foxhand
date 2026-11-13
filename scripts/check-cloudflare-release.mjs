// Validate GitHub release metadata only. No binaries are downloaded or modified.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function checkRelease(release, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || release.tagName !== `v${version}` || release.isDraft) throw new Error('Expected an existing published versioned release');
  const names = ['SHA256SUMS', 'install.sh', 'install.ps1', 'foxhand.zip'];
  for (const os of ['darwin', 'linux', 'windows']) for (const arch of ['arm64', 'x64']) for (const prefix of ['foxhand', 'webmcp']) names.push(`${prefix}-host-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
  for (const name of names) {
    const asset = release.assets?.find(asset => asset.name === name);
    if (!asset || !(asset.size > 0) || asset.state !== 'uploaded') throw new Error(`Missing or incomplete release asset: ${name}`);
  }
  return names;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = checkRelease(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.env.RELEASE_VERSION || '');
  console.log(`Verified published release metadata for ${names.length} required assets; bytes/checksums were not downloaded.`);
}
