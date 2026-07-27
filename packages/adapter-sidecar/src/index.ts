/**
 * Enhancely sidecar — minimal node:http reverse proxy.
 *
 * Sits between your TLS terminator (nginx/Apache/ALB, see ../../examples/)
 * and your origin. HTML responses get the Enhancely JSON-LD snippet injected
 * via @enhancely/injector-core; everything else streams through untouched.
 *
 * Functional skeleton — NOT production-hardened. Known TODOs:
 * - TODO(tls): no TLS termination — run behind nginx/Apache/a load balancer.
 * - TODO(http2): plain HTTP/1.1 only (node:http), no h2 upstream or downstream.
 * - TODO(gzip): if the upstream sends Content-Encoding (gzip/br/…) we do NOT
 *   attempt injection — the response passes through unchanged. Disable
 *   compression between origin and sidecar, compress at the edge instead.
 * - TODO(charset-transcode): only HTML that declares no charset or a
 *   UTF-8-compatible one is buffered/injected (see gate.ts); other charsets
 *   (iso-8859-1, windows-1252, …) stream through byte-identical and
 *   uninjected — transcoding them is not supported.
 */
import * as http from 'node:http';
import * as https from 'node:https';
// handleHtml(ctx: HtmlContext, cache: CacheBackend, config: InjectorConfig) → Promise<string>
// is the core orchestrator: cache lookup + ETag revalidation + fetch + inject,
// fail-open by contract (any failure returns ctx.html unchanged).
import { defineConfig, handleHtml, MemoryCache } from '@enhancely/injector-core';
import { isInjectableUpstream } from './gate.js';

const UPSTREAM_ORIGIN = process.env['UPSTREAM_ORIGIN'];
const ENHANCELY_API_KEY = process.env['ENHANCELY_API_KEY'] ?? '';
const ENHANCELY_BASE = process.env['ENHANCELY_BASE'] ?? '';
const PORT = Number.parseInt(process.env['PORT'] ?? '8080', 10);

/** HTML bodies above this size pass through uninjected (memory guard). */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

if (!UPSTREAM_ORIGIN) {
  console.error('[enhancely-sidecar] FATAL: UPSTREAM_ORIGIN is not set (e.g. http://origin:3000)');
  process.exit(1);
}
if (ENHANCELY_API_KEY === '') {
  // Loud but non-fatal: fail-open means the customer site keeps working as a
  // plain proxy; injection is skipped by the core when the key is missing.
  console.error(
    '[enhancely-sidecar] ERROR: ENHANCELY_API_KEY is not set — running as a pass-through proxy, NO JSON-LD will be injected'
  );
}

const upstream = new URL(UPSTREAM_ORIGIN);
const upstreamLib = upstream.protocol === 'https:' ? https : http;
const config = defineConfig({
  apiKey: ENHANCELY_API_KEY,
  ...(ENHANCELY_BASE !== '' && { enhancelyBase: ENHANCELY_BASE }),
});
const cache = new MemoryCache();

/** Hop-by-hop headers that must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) out[name] = value;
  }
  return out;
}

function isInjectable(req: http.IncomingMessage, res: http.IncomingMessage): boolean {
  return isInjectableUpstream({
    method: req.method,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    contentEncoding: res.headers['content-encoding'],
    apiKeyPresent: ENHANCELY_API_KEY !== '',
  });
}

/** Public page URL as the visitor requested it (core normalizes before use). */
function pageUrl(req: http.IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim() ?? 'https';
  const host = req.headers['x-forwarded-host']?.toString() ?? req.headers.host ?? upstream.host;
  return `${proto}://${host}${req.url ?? '/'}`;
}

/** Exported for the integration test; listening starts at module load. */
export const server = http.createServer((req, res) => {
  const headers = forwardableHeaders(req.headers);
  headers['host'] = upstream.host;
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] ?? req.headers.host ?? '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'http';
  const clientIp = req.socket.remoteAddress ?? '';
  const priorXff = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = priorXff ? `${priorXff.toString()}, ${clientIp}` : clientIp;

  const proxyReq = upstreamLib.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      path: req.url ?? '/',
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = forwardableHeaders(proxyRes.headers);
      const status = proxyRes.statusCode ?? 502;

      if (!isInjectable(req, proxyRes)) {
        // Streaming passthrough for everything that is not injectable HTML.
        res.writeHead(status, responseHeaders);
        proxyRes.pipe(res);
        return;
      }

      // Buffer the HTML body (bounded), inject, re-serve. Fail-open on
      // anything unexpected: the original bytes are always still available.
      const chunks: Buffer[] = [];
      let size = 0;
      let overflowed = false;

      proxyRes.on('data', (chunk: Buffer) => {
        if (overflowed) return; // pipe() below handles the rest of the stream
        size += chunk.length;
        if (size > MAX_HTML_BYTES) {
          overflowed = true;
          res.writeHead(status, responseHeaders);
          for (const buffered of chunks) res.write(buffered);
          res.write(chunk);
          proxyRes.pipe(res);
          return;
        }
        chunks.push(chunk);
      });

      proxyRes.on('end', () => {
        if (overflowed) return;
        void (async () => {
          const originalBody = Buffer.concat(chunks);
          // The gate only lets UTF-8-compatible declared charsets in here; if
          // the bytes are still not valid UTF-8 (mislabeled page) the decode
          // is lossy — which is why the ORIGINAL bytes are served verbatim
          // below whenever injection did not change anything.
          const originalHtml = originalBody.toString('utf8');
          let html = originalHtml;
          try {
            html = await handleHtml(
              {
                html: originalHtml,
                url: pageUrl(req),
                contentType: proxyRes.headers['content-type'] ?? null,
                status,
              },
              cache,
              config
            );
          } catch {
            html = originalHtml; // core is fail-open by contract; belt and braces
          }
          // Fail-open must be byte-exact: only re-encode when injection
          // actually modified the HTML.
          const body = html === originalHtml ? originalBody : Buffer.from(html, 'utf8');
          responseHeaders['content-length'] = body.byteLength; // injection changed the size
          res.writeHead(status, responseHeaders);
          res.end(body);
        })();
      });

      proxyRes.on('error', () => {
        // Upstream died mid-body: nothing valid to serve anymore.
        res.destroy();
      });
    }
  );

  proxyReq.on('error', (error) => {
    console.error(`[enhancely-sidecar] upstream error for ${req.url ?? '/'}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad Gateway');
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(
    `[enhancely-sidecar] listening on :${PORT} → ${upstream.origin} (injection ${ENHANCELY_API_KEY === '' ? 'DISABLED — no API key' : 'enabled'})`
  );
});
