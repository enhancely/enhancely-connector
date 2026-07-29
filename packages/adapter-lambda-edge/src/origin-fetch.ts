/**
 * Origin re-fetch for the Lambda@Edge adapter.
 *
 * Implemented with node:http/node:https instead of global fetch for one
 * load-bearing reason: undici's fetch treats `Host` as a forbidden header and
 * silently DROPS it, but the re-fetch must present the incoming viewer Host
 * so name-based virtual hosts on the origin resolve to the right site.
 * node:http honors `headers.host` verbatim.
 *
 * Properties:
 * - `Accept-Encoding: identity` — we need the raw bytes; a compressed body
 *   cannot be injected into (and any Content-Encoding on the answer makes the
 *   caller fail open).
 * - The caller forwards the FULL request header set CloudFront sent to the
 *   origin via `extraHeaders` (minus Host, Accept-Encoding and hop-by-hop
 *   headers): origin-response also fires for non-cacheable responses, and
 *   any header left out would make the re-fetch return a DIFFERENT variant
 *   of a page whose body varies on it (User-Agent device detection,
 *   Accept negotiation, CloudFront geo/device headers, cookies, …).
 * - Bounded buffering: bodies larger than `maxBytes` abort the download and
 *   come back as `truncated: true` (Lambda@Edge caps generated origin-response
 *   bodies at ~1 MB anyway, so there is no point buffering more).
 * - `AbortSignal.timeout` — a hung origin rejects and the caller fails open.
 * - No redirect following: a redirect is a non-200 and the caller fails open
 *   (the original response being decorated was a 200, so a re-fetch redirect
 *   means the origin disagrees with itself — not something to paper over).
 * - `agent: false` — one clean connection per request; frozen Lambda execution
 *   environments and kept-alive sockets are a flaky combination.
 */
import * as http from 'node:http';
import * as https from 'node:https';

/** Node http headers are string | string[] | undefined; preserve every value. */
function combinedHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? null;
}

export interface OriginFetchResult {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  /** Cache-Control of the re-fetched answer (per-request gate in the caller). */
  cacheControl: string | null;
  /** Expires of the re-fetched answer, synchronized with its generated body. */
  expires: string | null;
  /** True when the re-fetched answer carries any Set-Cookie header. */
  hasSetCookie: boolean;
  /**
   * Content-Security-Policy of the re-fetched answer. The injected body comes
   * from THIS response, so if the origin mints a per-response CSP nonce the
   * matching header is this one — not the first response's. The caller copies
   * it onto the generated response so header and body stay consistent.
   */
  contentSecurityPolicy: string | null;
  /** CSP report-only variant, copied for the same reason. */
  contentSecurityPolicyReportOnly: string | null;
  /**
   * X-Robots-Tag of the re-fetched answer (all instances combined). The
   * injected body comes from THIS response, so the noindex/none gate must
   * hold for this representation too, not only for the first response.
   */
  xRobotsTag: string | null;
  body: Buffer;
  /** True when the body exceeded `maxBytes` and buffering was aborted. */
  truncated: boolean;
}

export function fetchOriginHtml(
  originUrl: string,
  hostHeader: string,
  timeoutMs: number,
  maxBytes: number,
  extraHeaders: Record<string, string> = {}
): Promise<OriginFetchResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(originUrl);
    const lib = url.protocol === 'https:' ? https : http;

    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port !== '' ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        // TLS SNI (and cert-hostname verification) must present the PUBLIC
        // host, not the origin's own DNS name. A CloudFront custom origin is
        // usually addressed by an internal name (for example an ALB under
        // `elb.amazonaws.com`) whose certificate is issued for the public
        // domain, and the origin selects the right cert by SNI. Node would
        // otherwise default SNI to the origin hostname, the cert fails
        // verification, the re-fetch rejects and the handler fails open (no
        // injection). Using the same value as the Host header is correct for
        // every name-based vhosted origin and needs no per-site configuration.
        // Ignored for plain-http origins.
        servername: hostHeader,
        headers: {
          // Fallback identity — a forwarded viewer User-Agent (in
          // extraHeaders) overrides it, so the origin sees the same UA it
          // already answered.
          'user-agent': 'enhancely-connector-lambda-edge',
          // Full forwarded request header set from the caller.
          ...extraHeaders,
          // Non-negotiable, always win over anything forwarded: the vhost
          // Host header and the raw (uncompressed) bytes for injection.
          host: hostHeader,
          'accept-encoding': 'identity',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'] ?? null;
        const contentEncoding = response.headers['content-encoding'] ?? null;
        const cacheControl = response.headers['cache-control'] ?? null;
        const expires = response.headers['expires'] ?? null;
        const hasSetCookie = response.headers['set-cookie'] !== undefined;
        const csp = combinedHeaderValue(response.headers['content-security-policy']);
        const cspReportOnly = combinedHeaderValue(
          response.headers['content-security-policy-report-only']
        );
        const xRobotsTag = combinedHeaderValue(response.headers['x-robots-tag']);

        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;

        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            settled = true;
            resolve({
              status,
              contentType,
              contentEncoding,
              cacheControl,
              expires,
              hasSetCookie,
              contentSecurityPolicy: csp,
              contentSecurityPolicyReportOnly: cspReportOnly,
              xRobotsTag,
              body: Buffer.alloc(0),
              truncated: true,
            });
            response.destroy(); // stop paying for bytes we will never use
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            contentType,
            contentEncoding,
            cacheControl,
            expires,
            hasSetCookie,
            contentSecurityPolicy: csp,
            contentSecurityPolicyReportOnly: cspReportOnly,
            xRobotsTag,
            body: Buffer.concat(chunks),
            truncated: false,
          });
        });

        response.on('error', (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      }
    );

    request.on('error', reject); // no-op if resolve/reject already happened
    request.end();
  });
}
