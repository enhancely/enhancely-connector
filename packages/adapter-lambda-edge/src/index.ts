/**
 * CloudFront Lambda@Edge origin-response adapter for the Enhancely injector.
 *
 * THE central CloudFront constraint: origin-response triggers CANNOT read the
 * origin response body — CloudFront only hands the function status + headers.
 * So for eligible responses (GET, status 200, text/html, no Content-Encoding,
 * UTF-8-compatible charset, no Set-Cookie, no private/no-store Cache-Control)
 * this handler RE-FETCHES the page directly from the custom origin (same
 * URI + querystring, incoming Host header so vhosts resolve, forwarded
 * Cookie/Authorization/Accept-Language so the origin serves the same
 * representation, `Accept-Encoding: identity`), runs the core's `handleHtml`
 * over the fetched HTML, and replaces the response body with the injected
 * result. CloudFront then caches the injected page, so the extra origin
 * roundtrip is paid once per CloudFront cache miss — origin-response does not
 * fire on cache hits.
 *
 * Fail-open invariant: the whole handler is wrapped in try/catch and ALWAYS
 * returns the original response on any failure — config unresolvable, origin
 * re-fetch error/timeout/non-200, body over the generated-response quota
 * (1 MB INCLUDING headers; see MAX_BODY_BYTES), unexpected charset/encoding,
 * lossy UTF-8 decode, core errors.
 *
 * All connector logic (Enhancely API client, cache + ETag revalidation,
 * injection, fail-open orchestration) lives in @enhancely/injector-core; this
 * file only translates CloudFront event shapes (repo rule 7).
 */
import type {
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontResponseHandler,
  CloudFrontResultResponse,
} from 'aws-lambda';
import { handleHtml, MemoryCache } from '@enhancely/injector-core';
import { getOriginTimeoutMs, resolveAdapterConfig } from './config.js';
import { fetchOriginHtml } from './origin-fetch.js';

export {
  resolveAdapterConfig,
  DEFAULT_ORIGIN_TIMEOUT_MS,
  DEFAULT_SSM_PARAMETER_NAME,
  DEFAULT_SSM_REGION,
  DEFAULT_SSM_TIMEOUT_MS,
  CONFIG_FILE_NAME,
} from './config.js';
export type { BakedConnectorConfig } from './config.js';
export { fetchOriginHtml } from './origin-fetch.js';
export type { OriginFetchResult } from './origin-fetch.js';

/**
 * Lambda@Edge quota for a response GENERATED in an origin-response trigger:
 * 1 MB — and per the AWS limits documentation that is the size of the whole
 * generated response, "including headers and body". Exceeding it is NOT
 * fail-open: CloudFront answers the viewer with a 502.
 */
export const MAX_GENERATED_RESPONSE_BYTES = 1_048_576;

/**
 * Headroom reserved for the serialized response headers (status line, header
 * names/values, per-header overhead). The origin's full header set is spread
 * into the generated response, so the body alone must stay this far under the
 * 1 MB quota. 16 KB comfortably covers real-world header sets (typically well
 * under 8 KB) while giving up under 1.6 % of the usable body budget.
 */
export const HEADER_ALLOWANCE_BYTES = 16_384;

/**
 * Effective cap for a generated BODY: the 1 MB headers-and-body quota minus
 * the header allowance. Fetched HTML above this — and injected HTML pushed
 * above it — passes through untouched (fail-open) instead of producing an
 * over-quota generated response (viewer-facing 502).
 */
export const MAX_BODY_BYTES = MAX_GENERATED_RESPONSE_BYTES - HEADER_ALLOWANCE_BYTES;

/* ------------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                          */
/* ------------------------------------------------------------------------ */

/**
 * Charsets whose bytes survive a Buffer utf8 decode/re-encode round-trip
 * (mirrors the sidecar's charset gate — transcoding legacy charsets is not
 * supported; such pages pass through byte-identical and uninjected).
 */
const UTF8_COMPATIBLE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/** Lower-cased `charset` parameter of a Content-Type header value, or null. */
export function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

export interface AttemptInput {
  /** Method of the request CloudFront sent to the origin. */
  method: string;
  /** CloudFront response status — a STRING in Lambda@Edge events. */
  status: string;
  /** Response Content-Type header value (may include a charset). */
  contentType: string | null;
  /** Response Content-Encoding header value. */
  contentEncoding: string | null;
  /** Response Cache-Control header value. */
  cacheControl: string | null;
  /** True when the response carries any Set-Cookie header. */
  hasSetCookie: boolean;
}

/** `private` / `no-store` as Cache-Control directives (not substrings). */
const PER_REQUEST_CACHE_CONTROL = /(?:^|[\s,])(?:private|no-store)(?:$|[\s,=])/i;

/**
 * True only when injection may be attempted: GET + status exactly "200" +
 * media type exactly text/html + UTF-8-compatible (or absent) charset + no
 * Content-Encoding + no Set-Cookie + no `private`/`no-store` Cache-Control.
 * Applied to the CloudFront response first (cheap gate before any network
 * work) and to the re-fetched origin answer again (the representation we
 * actually inject into).
 *
 * Set-Cookie / private / no-store mark a per-request representation (session
 * being established, personalized body). Even though the re-fetch forwards
 * Cookie/Authorization/Accept-Language, a page that is stamping NEW state
 * into the viewer cannot be re-fetched faithfully — pass it through.
 */
export function shouldAttempt(input: AttemptInput): boolean {
  if (input.method !== 'GET') return false;
  if (input.status !== '200') return false;

  const contentType = input.contentType ?? '';
  // Exact media-type match (parameters stripped) — a prefix check would
  // wrongly match e.g. "text/htmlx".
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;

  const charset = charsetOf(contentType);
  if (charset !== null && !UTF8_COMPATIBLE_CHARSETS.has(charset)) return false;

  if (input.hasSetCookie) return false;
  if (input.cacheControl !== null && PER_REQUEST_CACHE_CONTROL.test(input.cacheControl)) {
    return false;
  }

  return input.contentEncoding === null;
}

/**
 * Public page URL as sent to Enhancely (RAW — the server normalizes
 * authoritatively). CloudFront always terminates TLS for viewers, so https.
 */
export function buildPageUrl(host: string, uri: string, querystring: string): string {
  return `https://${host}${uri}${querystring !== '' ? `?${querystring}` : ''}`;
}

/**
 * URL for the origin re-fetch:
 * `{protocol}://{domainName}[:port]{originPath}{uri}[?querystring]` — exactly
 * what CloudFront itself requests from a custom origin. Returns null for
 * non-custom origins (S3 REST origins speak a different protocol; those
 * distributions should not attach this function).
 */
export function buildOriginUrl(
  request: Pick<CloudFrontRequest, 'origin' | 'uri' | 'querystring'>
): string | null {
  const custom = request.origin?.custom;
  if (custom === undefined) return null;
  const defaultPort = custom.protocol === 'https' ? 443 : 80;
  const portPart = custom.port !== defaultPort ? `:${custom.port}` : '';
  const query = request.querystring !== '' ? `?${request.querystring}` : '';
  return `${custom.protocol}://${custom.domainName}${portPart}${custom.path}${request.uri}${query}`;
}

/**
 * Static origin custom header that carries the public page hostname for
 * distributions whose origin cannot receive the viewer Host header
 * (e.g. S3 website endpoints). Configured on the CloudFront origin.
 */
export const PAGE_HOST_HEADER = 'x-enhancely-page-host';

/** First value of a static origin custom header, or null. */
function customHeaderValue(
  request: Pick<CloudFrontRequest, 'origin'>,
  name: string
): string | null {
  const value = request.origin?.custom?.customHeaders[name]?.[0]?.value ?? null;
  return value !== null && value !== '' ? value : null;
}

/** First value of a (lowercase-keyed) CloudFront header, or null. */
function headerValue(headers: CloudFrontHeaders, name: string): string | null {
  return headers[name]?.[0]?.value ?? null;
}

/**
 * Representation-selecting request headers forwarded on the origin re-fetch,
 * so the origin answers with the SAME variant of the page it already served
 * (logged-in vs anonymous, Accept-Language negotiation, …) instead of the
 * cookie-less default.
 */
const FORWARDED_REQUEST_HEADERS = ['cookie', 'authorization', 'accept-language'] as const;

/** Extract the forwarded headers from the origin request's header map. */
export function forwardedHeaders(headers: CloudFrontHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const entries = headers[name];
    if (entries === undefined || entries.length === 0) continue;
    // CloudFront may split repeated headers into multiple entries; cookies
    // recombine with "; " (RFC 6265), everything else with ", " (RFC 9110).
    out[name] = entries.map((entry) => entry.value).join(name === 'cookie' ? '; ' : ', ');
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Per-execution-environment JSON-LD cache. Execution environments survive
 * many invocations (and are replicated per edge location), so hit rates are
 * decent; CloudFront's own cache in front does the heavy lifting.
 */
let cache = new MemoryCache();

/** TEST-ONLY: fresh cache between tests. */
export function __resetHandlerStateForTests(): void {
  cache = new MemoryCache();
}

export const handler: CloudFrontResponseHandler = async (event) => {
  const record = event.Records[0];
  if (!record) {
    // A CloudFront origin-response event always carries exactly one record;
    // this guard exists only to satisfy noUncheckedIndexedAccess.
    throw new Error('unreachable: CloudFront origin-response event without records');
  }
  const { request, response } = record.cf;

  try {
    // Cheap gate on what CloudFront already knows — no network work unless
    // this looks like an injectable HTML page.
    if (
      !shouldAttempt({
        method: request.method,
        status: response.status,
        contentType: headerValue(response.headers, 'content-type'),
        contentEncoding: headerValue(response.headers, 'content-encoding'),
        cacheControl: headerValue(response.headers, 'cache-control'),
        hasSetCookie: response.headers['set-cookie'] !== undefined,
      })
    ) {
      return response;
    }

    // No resolvable API key → pure pass-through (logged loudly once).
    const config = await resolveAdapterConfig();
    if (config === null) return response;

    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return response;

    // Host header CloudFront sent to the origin (the viewer Host when the
    // origin request policy forwards it — recommended, see README). This is
    // what the origin re-fetch must present so vhosts resolve.
    const originHost =
      headerValue(request.headers, 'host') ?? request.origin?.custom?.domainName ?? '';
    if (originHost === '') return response;

    // Public page host for the Enhancely lookup. Origins that must NOT
    // receive the viewer Host (S3 website endpoints reject foreign hosts, so
    // their distributions cannot forward it) declare the public hostname as a
    // static origin custom header instead: X-Enhancely-Page-Host.
    const pageHost = customHeaderValue(request, PAGE_HOST_HEADER) ?? originHost;
    const pageUrl = buildPageUrl(pageHost, request.uri, request.querystring);

    // Re-fetch the page: origin-response events do not expose the body.
    const origin = await fetchOriginHtml(
      originUrl,
      originHost,
      getOriginTimeoutMs(),
      MAX_BODY_BYTES,
      forwardedHeaders(request.headers)
    );
    // Over the generated-body cap — a body that large can never be returned.
    if (origin.truncated) return response;
    if (
      !shouldAttempt({
        method: 'GET',
        status: String(origin.status),
        contentType: origin.contentType,
        // Non-null despite Accept-Encoding: identity → origin ignored us; the
        // bytes are not injectable HTML.
        contentEncoding: origin.contentEncoding,
        cacheControl: origin.cacheControl,
        hasSetCookie: origin.hasSetCookie,
      })
    ) {
      return response;
    }

    const originalHtml = origin.body.toString('utf8');
    // Charset gate, part 2: a page may omit the charset parameter yet carry
    // non-UTF-8 bytes (e.g. `<meta charset="iso-8859-1">` in the markup). A
    // lossy utf8 decode replaces those bytes with U+FFFD, and CloudFront would
    // CACHE the mojibake. Prove the decode was lossless before doing anything
    // with it; otherwise pass through byte-identical.
    if (!Buffer.from(originalHtml, 'utf8').equals(origin.body)) return response;
    // Core orchestration: cache + ETag revalidation + Enhancely fetch +
    // injection; fail-open by contract (returns the input HTML unchanged).
    const injected = await handleHtml(
      { html: originalHtml, url: pageUrl, contentType: origin.contentType, status: origin.status },
      cache,
      config
    );

    // Nothing injected → return the untouched response; CloudFront serves the
    // origin's own (byte-identical) body without us generating one.
    if (injected === originalHtml) return response;

    // The injected page must itself fit the generated-response quota (which
    // includes the headers — hence the allowance baked into MAX_BODY_BYTES);
    // an over-quota generated response is a viewer-facing 502, not fail-open.
    if (Buffer.byteLength(injected, 'utf8') > MAX_BODY_BYTES) return response;

    const headers: CloudFrontHeaders = { ...response.headers };
    // The origin's Content-Length describes the ORIGINAL body and is wrong for
    // the replaced one. Per the Lambda@Edge body-replacement rules CloudFront
    // computes Content-Length from the returned body itself; deleting the
    // stale header (rather than recomputing it here) is the documented, safe
    // way to let that happen — a mismatched explicit value risks truncated or
    // hung responses.
    delete headers['content-length'];
    // ETag / Last-Modified are validators for the ORIGINAL body; keeping them
    // would let two different bodies circulate under one strong validator
    // (a client holding the uninjected page revalidates → 304 → never sees
    // the injected version). Drop them so caches treat the body as new.
    delete headers['etag'];
    delete headers['last-modified'];

    const result: CloudFrontResultResponse = {
      ...response,
      headers,
      body: injected,
      bodyEncoding: 'text',
    };
    return result;
  } catch (error) {
    // Fail-open: whatever went wrong, the viewer gets the original page.
    console.error(
      '[enhancely-lambda-edge] fail-open:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return response;
  }
};
