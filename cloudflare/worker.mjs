// Pages advanced-mode worker: stable public URLs redirect to published GitHub assets.
const VERSION = /^\d+\.\d+\.\d+$/;
const ASSET = /^(?:(?:foxhand|webmcp)-host-(?:darwin|linux)-(?:arm64|x64)|(?:foxhand|webmcp)-host-windows-(?:arm64|x64)\.exe|SHA256SUMS|install\.sh|install\.ps1|foxhand\.zip)$/;
const error = (status, text) => new Response(text, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'Method not allowed');
    // Legacy aliases on the new hostname, too. The old Pages projects remain untouched.
    const aliases = { '/sh': '/download/sh', '/ps': '/download/ps', '/popup.json': '/endpoint/announcement' };
    if (aliases[url.pathname]) return Response.redirect(new URL(aliases[url.pathname], url), 302);
    if (url.pathname === '/endpoint/announcement') {
      const response = await env.ASSETS.fetch(new Request(new URL('/announcement.json', url), request));
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    }
    if (['/download/sh', '/download/ps', '/download/latest.json'].includes(url.pathname)) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('Content-Type', url.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith('/endpoint/')) return error(404, 'Not found');
    if (url.pathname === '/download' || url.pathname === '/download/') return env.ASSETS.fetch(new Request(new URL('/download/', url), request));
    const match = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const [, version, name] = match;
      if (!ASSET.test(name)) return error(404, 'Not found');
      if (version === 'latest') {
        const metadata = await env.ASSETS.fetch(new Request(new URL('/download/latest.json', url)));
        if (!metadata.ok) return error(503, 'Release metadata unavailable');
        const latest = await metadata.json();
        if (!VERSION.test(latest.version)) return error(503, 'Invalid release metadata');
        return new Response(null, { status: 302, headers: { Location: `/download/${latest.version}/${name}`, 'Cache-Control': 'no-store' } });
      }
      if (!VERSION.test(version)) return error(404, 'Not found');
      return new Response(null, { status: 302, headers: {
        Location: `https://github.com/hamb1y/foxhand/releases/download/v${version}/${name}`,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      } });
    }
    if (url.pathname.startsWith('/download/') && !['/download/sh', '/download/ps', '/download/latest.json'].includes(url.pathname)) return error(404, 'Not found');
    return env.ASSETS.fetch(request);
  }
};
