/**
 * Direct custom-origin fetch for the Lambda@Edge origin-request injector.
 *
 * Implemented with node:http/node:https instead of global fetch for one
 * load-bearing reason: undici's fetch treats `Host` as a forbidden header and
 * silently DROPS it, but the fetch must present the incoming viewer Host
 * so name-based virtual hosts on the origin resolve to the right site.
 * node:http honors `headers.host` verbatim.
 *
 * Properties:
 * - `Accept-Encoding: identity` — we need the raw bytes; a compressed body
 *   cannot be injected into (and any Content-Encoding on the answer makes the
 *   caller fail open).
 * - The caller forwards the FULL request header set CloudFront sent to the
 *   origin via `extraHeaders` (minus Host, Accept-Encoding, conditional/range,
 *   and hop-by-hop headers). Any representation-forming header left out would
 *   make the direct fetch return a different variant (User-Agent detection,
 *   Accept negotiation, CloudFront geo/device headers, cookies, …).
 * - Bounded buffering: bodies larger than `maxBytes` abort the download and
 *   come back as `truncated: true` (Lambda@Edge caps generated responses at
 *   about 1 MB, so there is no point buffering more).
 * - `AbortSignal.timeout` — a hung origin rejects and the caller fails open.
 * - No redirect following: the caller returns the origin's redirect verbatim.
 * - `agent: false` — one clean connection per request; frozen Lambda execution
 *   environments and kept-alive sockets are a flaky combination.
 */
import * as http from 'node:http';
import * as https from 'node:https';

type OriginFetchFailureScope = 'endpoint' | 'request';

/**
 * A failed origin fetch annotated with the widest scope it is safe to memoize.
 * `endpoint` is reserved for DNS/connect/TLS failures observed before the
 * transport became usable; everything after that point is representation- or
 * request-specific and must not suppress healthy paths on the same origin.
 */
class OriginFetchError extends Error {
  readonly scope: OriginFetchFailureScope;

  constructor(scope: OriginFetchFailureScope, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Origin fetch failed', { cause });
    this.name = 'OriginFetchError';
    this.scope = scope;
  }
}

/** Unknown failures are deliberately request-scoped to limit blast radius. */
export function originFetchFailureScope(error: unknown): OriginFetchFailureScope {
  return error instanceof OriginFetchError ? error.scope : 'request';
}

const ENDPOINT_SETUP_ERROR_CODES = new Set([
  // DNS.
  'ENOTFOUND',
  'EAI_AGAIN',
  // TCP/routing. AbortSignal timeouts surface as ABORT_ERR on Node 20/22.
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'EPIPE',
  // TLS/OpenSSL codes without a shared prefix.
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Only known network/TLS setup failures may open the endpoint-wide circuit. */
function isEndpointSetupFailure(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  const code = errorCode(error);
  if (code === null) return false;
  return (
    ENDPOINT_SETUP_ERROR_CODES.has(code) ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('ERR_OSSL_') ||
    code.startsWith('CERT_')
  );
}

export interface OriginFetchResult {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  /**
   * X-Robots-Tag of the fetched answer (all instances combined). Injection is
   * vetoed when that exact representation blocks indexing.
   */
  xRobotsTag: string | null;
  body: Buffer;
  /** True when the body exceeded `maxBytes` and buffering was aborted. */
  truncated: boolean;
  /**
   * EVERY response header, lowercase-keyed, with each value preserved
   * separately (never comma-joined — `Set-Cookie` must not be folded).
   *
   * The origin-request injector generates the whole viewer response, so every
   * origin header must remain available; dropping Vary, Link,
   * Strict-Transport-Security, X-Frame-Options, or similar fields would strip
   * security and caching metadata silently.
   */
  allHeaders: Record<string, string[]>;
}

export function fetchOriginHtml(
  originUrl: string,
  hostHeader: string,
  timeoutMs: number,
  maxBytes: number,
  maxHeaderBytes: number,
  extraHeaders: Record<string, string> = {}
): Promise<OriginFetchResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(originUrl);
    const lib = url.protocol === 'https:' ? https : http;
    let transportReady = false;

    const rejectScoped = (error: unknown): void => {
      const scope = !transportReady && isEndpointSetupFailure(error) ? 'endpoint' : 'request';
      reject(new OriginFetchError(scope, error));
    };

    // The request path is taken from the ORIGINAL string, never from
    // `url.pathname`: `new URL` resolves dot-segments, so a URI containing
    // `..` — or its encoded form `%2e%2e` — would be silently rewritten before
    // it reaches the origin. CloudFront forwards the raw path and lets the
    // origin decide, so this fetch must send exactly the same bytes or it can
    // receive a different document than the viewer is entitled to.
    // (buildOriginUrl separately refuses URIs that escape the origin path.)
    const authorityEnd = originUrl.indexOf('/', originUrl.indexOf('://') + 3);
    const rawPath = authorityEnd === -1 ? '/' : originUrl.slice(authorityEnd);

    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port !== '' ? Number(url.port) : undefined,
        path: rawPath,
        method: 'GET',
        agent: false,
        // Node's client default is 16 KiB, but CloudFront accepts 32 KiB.
        // The caller supplies the connector's single quota constant so this
        // low-level module neither duplicates it nor imports shared.ts.
        maxHeaderSize: maxHeaderBytes,
        // TLS SNI (and cert-hostname verification) must present the PUBLIC
        // host, not the origin's own DNS name. A CloudFront custom origin is
        // usually addressed by an internal name (for example an ALB under
        // `elb.amazonaws.com`) whose certificate is issued for the public
        // domain, and the origin selects the right cert by SNI. Node would
        // otherwise default SNI to the origin hostname, the cert fails
        // verification, the fetch rejects and the handler fails open (no
        // injection). Using the same value as the Host header is correct for
        // every name-based vhosted origin and needs no per-site configuration.
        // Ignored for plain-http origins.
        servername: hostHeader,
        headers: {
          // Fallback identity — a forwarded viewer User-Agent (in
          // extraHeaders) overrides it, so the origin receives the intended
          // request variant signal.
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
        // Receiving a response proves DNS, TCP and (for HTTPS) TLS succeeded.
        // Any later reset, timeout or parser/body error may be path-specific.
        transportReady = true;
        const status = response.statusCode ?? 0;

        // node lowercases header names already; keep multi-value headers as
        // separate entries so the caller can emit them faithfully.
        // Header values arrive as Latin-1 bytes (node reads them that way). A
        // value the origin actually sent as UTF-8 would otherwise reach the
        // viewer double-encoded, because CloudFront serializes what we return
        // as UTF-8. Recover it only when the round-trip is exact — otherwise
        // the value really was Latin-1 and must stay untouched.
        const decodeHeaderValue = (raw: string): string => {
          const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
          return Buffer.from(utf8, 'utf8').toString('latin1') === raw ? utf8 : raw;
        };
        const allHeaders: Record<string, string[]> = {};
        for (const [name, values] of Object.entries(response.headersDistinct)) {
          if (values === undefined) continue;
          allHeaders[name.toLowerCase()] = values.map(decodeHeaderValue);
        }
        const combinedHeader = (name: string): string | null =>
          allHeaders[name]?.join(', ') ?? null;

        // `response.headers` applies Node's singleton duplicate-discard rules.
        // Gates must instead see every wire instance: conflicting Content-Type
        // or Content-Disposition values are ambiguous and therefore veto
        // rewriting rather than being hidden behind whichever value came first.
        const contentType = combinedHeader('content-type');
        const contentEncoding = combinedHeader('content-encoding');
        const xRobotsTag = combinedHeader('x-robots-tag');

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
              xRobotsTag,
              body: Buffer.alloc(0),
              truncated: true,
              allHeaders,
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
            xRobotsTag,
            body: Buffer.concat(chunks),
            truncated: false,
            allHeaders,
          });
        });

        response.on('error', (error) => {
          if (settled) return;
          settled = true;
          rejectScoped(error);
        });
      }
    );

    request.once('socket', (socket) => {
      if (url.protocol === 'https:') {
        // TCP connect alone is insufficient for HTTPS: certificate validation
        // and SNI selection complete only at `secureConnect`.
        socket.once('secureConnect', () => {
          transportReady = true;
        });
        return;
      }
      if (!socket.connecting) {
        transportReady = true;
        return;
      }
      socket.once('connect', () => {
        transportReady = true;
      });
    });
    request.on('error', rejectScoped); // no-op if resolve/reject already happened
    request.end();
  });
}
