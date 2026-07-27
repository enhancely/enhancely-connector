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
 * - Representation-selecting request headers (`Cookie`, `Authorization`,
 *   `Accept-Language`) are forwarded by the caller via `extraHeaders`:
 *   origin-response also fires for non-cacheable responses, and without them
 *   the re-fetch would fetch the anonymous/default variant of a page whose
 *   body varies on those headers (logged-in vs logged-out, language, …).
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

export interface OriginFetchResult {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  /** Cache-Control of the re-fetched answer (per-request gate in the caller). */
  cacheControl: string | null;
  /** True when the re-fetched answer carries any Set-Cookie header. */
  hasSetCookie: boolean;
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
        headers: {
          // Forwarded representation-selecting headers first — the fixed
          // trio below must always win on a (pathological) key clash.
          ...extraHeaders,
          host: hostHeader,
          'accept-encoding': 'identity',
          'user-agent': 'enhancely-connector-lambda-edge',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'] ?? null;
        const contentEncoding = response.headers['content-encoding'] ?? null;
        const cacheControl = response.headers['cache-control'] ?? null;
        const hasSetCookie = response.headers['set-cookie'] !== undefined;

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
              hasSetCookie,
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
            hasSetCookie,
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
