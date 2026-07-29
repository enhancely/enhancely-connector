/**
 * CloudFront Lambda@Edge origin-response adapter for the Enhancely injector.
 *
 * THE central CloudFront constraint: origin-response triggers CANNOT read the
 * origin response body — CloudFront only hands the function status + headers.
 * So for eligible responses (GET, status 200, text/html, no Set-Cookie, no
 * private/no-store Cache-Control — Content-Encoding on THIS response is fine,
 * see below) the handler first asks Enhancely for a snippet (needs no body);
 * only when there is one does it RE-FETCH the page from the custom origin (same
 * URI + querystring, incoming Host header so vhosts resolve, ALL request
 * headers CloudFront sent to the origin forwarded — except Host, Accept-Encoding
 * and hop-by-hop — so the origin serves the same representation, with
 * `Accept-Encoding: identity` for raw injectable bytes), injects the snippet
 * before </head> and replaces the body. The first gate IGNORES the CloudFront
 * response's Content-Encoding (real viewers get gzip/br, but we re-fetch
 * identity); the identity re-fetch is re-gated on encoding. Representation
 * headers are handled conservatively: Content-Type becomes explicit UTF-8;
 * Cache-Control/Expires must be stable across both responses; and CSP structure
 * must remain stable except for body-bound nonces/hashes (the accepted
 * re-fetch value matches its body). CloudFront then caches the
 * injected page, so the extra origin roundtrip is paid once per CloudFront
 * cache miss — origin-response does not fire on hits. A retryable no-snippet
 * result receives a short shared-cache TTL aligned with the core/config retry
 * and loses its origin validators, unless the request carries Authorization
 * or Cookie. That prevents a long default TTL (or later 304) from pinning a
 * transiently uninjected public representation.
 *
 * Fail-open invariant: the whole handler is wrapped in try/catch and ALWAYS
 * returns the original response on any failure — config unresolvable, origin
 * re-fetch error/timeout/non-200, body over the generated-response quota
 * (1 MB INCLUDING headers; see MAX_ORIGIN_BODY_BYTES and
 * serializedHeaderBytes), unstable cache/security metadata, ambiguous
 * charset/encoding, lossy UTF-8 decode, core errors.
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
import {
  getJsonLdLookup,
  injectIntoHead,
  matchesExcludedPath,
  MemoryCache,
} from '@enhancely/injector-core';
import {
  getCapUninjectedTtl,
  getConfigRetryInMs,
  getExcludePaths,
  getOriginTimeoutMs,
  resolveAdapterConfig,
} from './config.js';
import { fetchOriginHtml } from './origin-fetch.js';

export {
  resolveAdapterConfig,
  DEFAULT_ORIGIN_TIMEOUT_MS,
  DEFAULT_SSM_PARAMETER_NAME,
  DEFAULT_SSM_REGION,
  DEFAULT_SSM_TIMEOUT_MS,
  CONFIG_FILE_NAME,
  getConfigRetryInMs,
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
 * CloudFront's own hard cap on the total response header size: 32,768 bytes.
 * Header sets a fixed small allowance would not cover ARE possible — so the
 * body budget must be computed from the ACTUAL headers being returned (see
 * serializedHeaderBytes), not from an optimistic constant.
 */
export const MAX_RESPONSE_HEADER_BYTES = 32_768;

/**
 * Safety margin subtracted from the generated-response budget on top of the
 * measured header bytes — absorbs serialization details this adapter cannot
 * see (exact status-line text, header framing CloudFront adds). Exceeding the
 * 1 MB quota is a viewer-facing 502, so err on the side of passing through.
 */
export const GENERATED_RESPONSE_SAFETY_MARGIN_BYTES = 1_024;

/**
 * Conservative cap for the origin re-fetch download: the 1 MB headers-and-body
 * quota minus the WORST-CASE header size CloudFront permits (32 KB) minus the
 * safety margin — i.e. "1 MB − 33 KB". A deliberate constant, not the measured
 * per-response header size: the download bound must be known BEFORE the final
 * response headers exist (the fetch streams first), and any body above this
 * cap could never be returned even under maximal headers, so aborting the
 * download early wastes nothing. The precise, per-response budget check
 * happens later against serializedHeaderBytes of the actual headers.
 */
export const MAX_ORIGIN_BODY_BYTES =
  MAX_GENERATED_RESPONSE_BYTES - MAX_RESPONSE_HEADER_BYTES - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;

/* ------------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                          */
/* ------------------------------------------------------------------------ */

/**
 * Charsets whose bytes survive a Buffer utf8 decode/re-encode round-trip
 * (mirrors the sidecar's charset gate — transcoding legacy charsets is not
 * supported; such pages pass through byte-identical and uninjected).
 */
const UTF8_COMPATIBLE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/** Lambda's text response is serialized as UTF-8, so advertise that explicitly. */
const GENERATED_HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * Bytes reserved for the response status line and framing overhead on top of
 * the per-header bytes in serializedHeaderBytes.
 */
const RESPONSE_STATUS_LINE_OVERHEAD_BYTES = 64;

/**
 * Serialized size of a CloudFront header map as it will count against the
 * 1 MB generated-response quota: per header value, name + value + 4 bytes
 * (": " separator + CRLF), plus the actual status line and final CRLF (never
 * less than the existing conservative 64-byte framing allowance).
 * CloudFront passes header values to edge functions as UTF-8, so JavaScript
 * string length is not a byte count for non-ASCII values.
 */
export function serializedHeaderBytes(
  headers: CloudFrontHeaders,
  status = '200',
  statusDescription = 'OK'
): number {
  const actualFramingBytes =
    Buffer.byteLength(`HTTP/1.1 ${status} ${statusDescription}\r\n`, 'utf8') + 2;
  let total = Math.max(RESPONSE_STATUS_LINE_OVERHEAD_BYTES, actualFramingBytes);
  for (const [name, entries] of Object.entries(headers)) {
    for (const entry of entries) {
      total +=
        Buffer.byteLength(entry.key ?? name, 'utf8') + Buffer.byteLength(entry.value, 'utf8') + 4;
    }
  }
  return total;
}

/** Lower-cased `charset` parameter of a Content-Type header value, or null. */
export function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

function containsOnlyAscii(body: Buffer): boolean {
  return body.every((byte) => byte <= 0x7f);
}

/** A byte-order mark is unambiguous UTF-8 evidence without parsing HTML. */
function hasUtf8Bom(body: Buffer): boolean {
  return body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
}

/**
 * Positive-only slice of the WHATWG encoding prescan, for the one case that
 * is unambiguous: a meta tag inside the first 1024 bytes (the same window
 * browsers prescan) that declares UTF-8, either as `<meta charset="utf-8">`
 * or as `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`.
 *
 * Deliberately narrow. HTML comments are skipped (a commented-out meta is not
 * a declaration), the attribute must literally be `charset` (`data-charset`
 * and lookalikes do not count), the http-equiv form only counts for
 * Content-Type, and only UTF-8 answers true. A declaration of any OTHER
 * encoding, a meta beyond the window, or anything malformed stays ambiguous
 * and the caller fails open, exactly as before. False negatives are safe
 * (pass-through); the shape of the check makes false positives require a page
 * that literally declares UTF-8 while meaning something else, at which point
 * browsers decode it as UTF-8 too.
 */
function declaresUtf8MetaInPrescan(body: Buffer): boolean {
  // The prescan window is byte-based; latin1 maps every byte 1:1 to a code
  // point, so string offsets stay byte offsets.
  let window = body.subarray(0, 1024).toString('latin1');
  // Drop complete comments, then everything after an unterminated opener.
  window = window.replace(/<!--[\s\S]*?-->/g, ' ');
  const openComment = window.indexOf('<!--');
  if (openComment !== -1) window = window.slice(0, openComment);

  const metaRe = /<meta\b([^>]*)>/gi;
  const attrRe = /([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/g;
  let tag: RegExpExecArray | null;
  while ((tag = metaRe.exec(window)) !== null) {
    const attrs = new Map<string, string>();
    attrRe.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(tag[1] ?? '')) !== null) {
      const name = attr[1]?.toLowerCase() ?? '';
      // First occurrence wins, matching how browsers treat duplicates.
      if (!attrs.has(name)) attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const direct = attrs.get('charset');
    const declared =
      direct !== undefined
        ? direct.trim().toLowerCase()
        : attrs.get('http-equiv')?.trim().toLowerCase() === 'content-type'
          ? charsetOf(attrs.get('content') ?? '')
          : null;
    if (declared === 'utf-8' || declared === 'utf8') return true;
  }
  return false;
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
 * the full request header set, a page that is stamping NEW state into the
 * viewer cannot be re-fetched faithfully — pass it through.
 */
export function shouldAttempt(input: AttemptInput, ignoreContentEncoding = false): boolean {
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

  // The FIRST gate (on the CloudFront response) IGNORES content-encoding: with
  // Compress enabled CloudFront forwards Accept-Encoding, so most real-viewer
  // responses arrive gzip/br — but we re-fetch the origin with
  // `Accept-Encoding: identity` anyway, so a compressed first response is fine.
  // The SECOND gate (on that identity re-fetch) enforces it: if the origin
  // ignored identity and still compressed, we cannot inject → pass through.
  if (ignoreContentEncoding) return true;
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

/** Cache-Control is a list field: every CloudFront header entry is operative. */
function cacheControlValue(headers: CloudFrontHeaders): string | null {
  const entries = headers['cache-control'];
  return entries === undefined ? null : entries.map((entry) => entry.value).join(', ');
}

/** Combine every value of a list-like response header. */
function combinedHeaderValue(headers: CloudFrontHeaders, name: string): string | null {
  const entries = headers[name];
  return entries === undefined ? null : entries.map((entry) => entry.value).join(', ');
}

/** Numeric Cache-Control directive value, or null when absent/invalid. */
function cacheDirectiveSeconds(policy: string, wanted: 'max-age' | 's-maxage'): number | null {
  for (const directive of policy.split(',')) {
    const [rawName, rawValue] = directive.trim().split('=', 2);
    if (rawName?.toLowerCase() !== wanted || rawValue === undefined) continue;
    const value = rawValue.trim().replace(/^"|"$/g, '');
    if (!/^\d+$/.test(value)) return null;
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  return null;
}

/** Compare Cache-Control semantically enough to ignore order/casing/spacing. */
function normalizedCacheControl(policy: string | null): string | null {
  if (policy === null) return null;
  return policy
    .split(',')
    .map((directive) => directive.trim().toLowerCase())
    .sort()
    .join(',');
}

/**
 * Compare CSP structure while allowing per-response nonces and body hashes to
 * rotate. Every other directive/source must remain stable or injection fails
 * open rather than weakening the policy seen on the first response.
 */
function normalizedCspStructure(policy: string): string {
  return policy
    .split(';')
    .map((rawDirective) => {
      const [rawName, ...rawSources] = rawDirective.trim().split(/\s+/);
      if (rawName === undefined || rawName === '') return '';
      const sources = rawSources.map((source) => {
        if (/^'nonce-[^']+'$/i.test(source)) return "'nonce-*'";
        const hash = /^'(sha256|sha384|sha512)-[^']+'$/i.exec(source);
        return hash?.[1] === undefined ? source : `'${hash[1].toLowerCase()}-*'`;
      });
      return [rawName.toLowerCase(), ...sources].join(' ');
    })
    .filter((directive) => directive !== '')
    .join(';');
}

/**
 * Shared-cache TTL to impose on a retryable pass-through, or `null` when the
 * origin declared NO explicit cache lifetime.
 *
 * `null` is load-bearing: without an origin-declared lifetime the response's
 * cacheability is governed by the distribution's DefaultTTL, which this
 * function cannot see. Writing an s-maxage there could make an
 * origin-uncacheable response (DefaultTTL=0) shared-cacheable — the opposite of
 * the invariant "never make a response more cacheable than it already was". So
 * we only ever SHORTEN an explicit lifetime (max-age/s-maxage/Expires) and
 * leave header-less responses untouched.
 *
 * `capWithoutExplicitLifetime` is the operator's way OUT of that blindness:
 * the baked config flag `capUninjectedTtl` asserts that the distribution's
 * DefaultTTL is nonzero for this content, i.e. a lifetime-less pass-through
 * is ALREADY shared-cached (typically for far longer than the retry TTL).
 * Under that assertion the cap still only shortens effective cacheability,
 * so the invariant holds; without it a single lookup timeout pins an
 * uninjected response in CloudFront for the full DefaultTTL (a day on the
 * common default) instead of the seconds the retry logic intends.
 */
function retrySharedTtlSeconds(
  headers: CloudFrontHeaders,
  revalidateInMs: number,
  capWithoutExplicitLifetime: boolean
): number | null {
  const retryTtl = Math.max(1, Math.ceil(revalidateInMs / 1000));
  const policy = cacheControlValue(headers);

  if (policy !== null) {
    const directiveNames = policy
      .split(',')
      .map((directive) => directive.split('=', 1)[0]?.trim().toLowerCase());
    // no-cache is an explicit "revalidate every time" — honor it with s-maxage=0.
    if (directiveNames.includes('no-cache')) {
      return 0;
    }
    const originTtl =
      cacheDirectiveSeconds(policy, 's-maxage') ?? cacheDirectiveSeconds(policy, 'max-age');
    if (originTtl !== null) {
      return Math.min(retryTtl, originTtl);
    }
  }

  // No max-age/s-maxage: Expires is the only other explicit lifetime.
  const expires = headerValue(headers, 'expires');
  if (expires !== null) {
    const expiresAt = Date.parse(expires);
    if (!Number.isNaN(expiresAt)) {
      const responseDate = Date.parse(headerValue(headers, 'date') ?? '');
      const reference = Number.isNaN(responseDate) ? Date.now() : responseDate;
      return Math.min(retryTtl, Math.max(0, Math.ceil((expiresAt - reference) / 1000)));
    }
  }

  // Origin declared no explicit lifetime. Without the operator assertion, do
  // not introduce shared caching; with it, the response is already cached for
  // the (longer) DefaultTTL, so the retry TTL only shortens it.
  return capWithoutExplicitLifetime ? retryTtl : null;
}

/**
 * Keep a retryable pass-through response in CloudFront only until the core or
 * config resolver will try again. Validators for the untouched origin body
 * are removed deliberately: after this short TTL CloudFront must obtain a full
 * origin response, so the origin-response Lambda runs again. A 304 would
 * otherwise keep the old uninjected body.
 *
 * Never add cacheability to a request carrying credentials/personalization.
 * In particular, s-maxage/public/must-revalidate override the normal shared
 * cache restriction on Authorization responses (RFC 9111 §3.5).
 */
function retryablePassThroughResponse(
  response: CloudFrontResultResponse,
  requestHeaders: CloudFrontHeaders,
  revalidateInMs: number
): CloudFrontResultResponse {
  if (requestHeaders['authorization'] !== undefined || requestHeaders['cookie'] !== undefined) {
    return response;
  }

  const originalHeaders = response.headers ?? {};
  const sharedTtlSeconds = retrySharedTtlSeconds(
    originalHeaders,
    revalidateInMs,
    getCapUninjectedTtl()
  );
  // The origin declared no explicit cache lifetime → leave the response exactly
  // as it is (its cacheability is the distribution's DefaultTTL, which we must
  // not override upward). Adding s-maxage here could cache an
  // origin-uncacheable response.
  if (sharedTtlSeconds === null) return response;

  const headers: CloudFrontHeaders = { ...originalHeaders };
  headers['cache-control'] = [
    {
      key: 'Cache-Control',
      value: `max-age=0, s-maxage=${sharedTtlSeconds}, must-revalidate`,
    },
  ];
  delete headers['expires'];
  delete headers['etag'];
  delete headers['last-modified'];

  // Header edits are still subject to CloudFront's independent 32 KB limit.
  // If the safer policy would cross it, retain the byte-for-byte response.
  if (
    serializedHeaderBytes(headers, response.status, response.statusDescription) >
    MAX_RESPONSE_HEADER_BYTES
  ) {
    return response;
  }
  return { ...response, headers };
}

/**
 * Request headers NEVER forwarded on the origin re-fetch:
 * - `host` — set explicitly by the caller (vhost resolution),
 * - `accept-encoding` — forced to `identity` (injection needs raw bytes),
 * - the hop-by-hop headers (RFC 9110 §7.6.1) — connection-level, never
 *   meaningful to replay end-to-end.
 */
const NON_FORWARDED_REQUEST_HEADERS = new Set([
  'host',
  'accept-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * ALL headers to forward on the origin re-fetch, extracted from the
 * origin-response event's request.headers — which is exactly the header set
 * CloudFront sent to the origin, already filtered by the origin request
 * policy. Forwarding the full set (User-Agent, Accept, CloudFront-Is-*-Viewer
 * device headers, CloudFront geo headers, …) means the origin answers with
 * the SAME representation it already served, whatever it varies on — a
 * partial forward list would silently fetch a different variant. Only Host,
 * Accept-Encoding and hop-by-hop headers are excluded (see
 * NON_FORWARDED_REQUEST_HEADERS).
 */
export function forwardedHeaders(headers: CloudFrontHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entries] of Object.entries(headers)) {
    // CloudFront keys the map with lowercase names already; normalize anyway
    // so the exclusion set can never be dodged by casing.
    const key = name.toLowerCase();
    if (NON_FORWARDED_REQUEST_HEADERS.has(key)) continue;
    if (entries.length === 0) continue;
    // CloudFront may split repeated headers into multiple entries; cookies
    // recombine with "; " (RFC 6265), everything else with ", " (RFC 9110).
    out[key] = entries.map((entry) => entry.value).join(key === 'cookie' ? '; ' : ', ');
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
    // Operator-excluded paths (login/account areas, robots.txt-disallowed
    // sections) pay NOTHING: no config/SSM resolution, no lookup, no
    // auto-registration, no cache rewriting — byte-identical pass-through
    // with the origin's normal caching. Checked first because it is the
    // cheapest gate and the only purely policy-driven one.
    if (matchesExcludedPath(getExcludePaths(), request.uri)) {
      return response;
    }

    // Cheap gate on what CloudFront already knows — no network work unless
    // this looks like an injectable HTML page.
    if (
      !shouldAttempt(
        {
          method: request.method,
          status: response.status,
          contentType: headerValue(response.headers, 'content-type'),
          contentEncoding: headerValue(response.headers, 'content-encoding'),
          cacheControl: cacheControlValue(response.headers),
          hasSetCookie: response.headers['set-cookie'] !== undefined,
        },
        // Ignore the first response's content-encoding — we re-fetch identity.
        true
      )
    ) {
      return response;
    }

    // A page the origin itself marks noindex is not schema-markup territory:
    // pass it through untouched (normal caching, no lookup, no registration).
    // Only the header form is visible here — origin-response triggers never
    // see the body, so a `<meta name="robots">` cannot be honored at this
    // layer; use excludePaths for those sections instead.
    const xRobotsTag = combinedHeaderValue(response.headers, 'x-robots-tag');
    if (xRobotsTag !== null && /(?:^|[\s,:])noindex(?:$|[\s,])/i.test(xRobotsTag)) {
      return response;
    }

    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return response;

    // Host header CloudFront sent to the origin (the viewer Host when the
    // origin request policy forwards it — recommended, see README). This is
    // what the origin re-fetch must present so vhosts resolve.
    const originHost =
      headerValue(request.headers, 'host') ?? request.origin?.custom?.domainName ?? '';
    if (originHost === '') return response;

    // No resolvable API key → body pass-through (logged once per failed
    // resolution), with a bounded cache retry only for an otherwise eligible
    // custom-origin response.
    const config = await resolveAdapterConfig();
    if (config === null) {
      const retryInMs = getConfigRetryInMs();
      return retryInMs === null
        ? response
        : retryablePassThroughResponse(response, request.headers, retryInMs);
    }

    // Public page host for the Enhancely lookup. Origins that must NOT
    // receive the viewer Host (S3 website endpoints reject foreign hosts, so
    // their distributions cannot forward it) declare the public hostname as a
    // static origin custom header instead: X-Enhancely-Page-Host.
    const pageHost = customHeaderValue(request, PAGE_HOST_HEADER) ?? originHost;
    const pageUrl = buildPageUrl(pageHost, request.uri, request.querystring);

    // Ask Enhancely FIRST — this needs no page body (cache + ETag + API call
    // only). Only when there is actually something to inject do we pay the
    // origin re-fetch below. Pages with no JSON-LD yet (unregistered, 404,
    // rate-limited, upstream error) therefore never double the origin load —
    // during an early pilot that is the large majority of requests, and it also
    // means a not-yet-configured key (no snippet) costs zero extra origin hits.
    const lookup = await getJsonLdLookup(pageUrl, cache, config);
    if (lookup.snippet === null) {
      return lookup.revalidateInMs === null
        ? response
        : retryablePassThroughResponse(response, request.headers, lookup.revalidateInMs);
    }

    // Re-fetch the page: origin-response events do not expose the body.
    const origin = await fetchOriginHtml(
      originUrl,
      originHost,
      getOriginTimeoutMs(),
      MAX_ORIGIN_BODY_BYTES,
      forwardedHeaders(request.headers)
    );
    // Over the conservative fetch cap — a body that large can never be
    // returned, not even under the most favorable header set.
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

    // Cache semantics must be stable across the first response and the
    // representation we re-fetch. Choosing either side of a mismatch can make
    // the viewer response more cacheable than the other one intended, so the
    // only fail-open choice is to leave the first response untouched.
    const firstCacheControl = cacheControlValue(response.headers);
    if (normalizedCacheControl(firstCacheControl) !== normalizedCacheControl(origin.cacheControl)) {
      return response;
    }
    if (headerValue(response.headers, 'expires') !== origin.expires) {
      return response;
    }

    // Dropping or structurally weakening a CSP that protected the first
    // response would be a security downgrade. Per-response nonces/hashes may
    // rotate; every other directive/source must remain stable. The re-fetch's
    // accepted value is copied below because it matches that body.
    const firstCsp = combinedHeaderValue(response.headers, 'content-security-policy');
    const firstCspReportOnly = combinedHeaderValue(
      response.headers,
      'content-security-policy-report-only'
    );
    if (
      (firstCsp !== null && origin.contentSecurityPolicy === null) ||
      (firstCsp !== null &&
        origin.contentSecurityPolicy !== null &&
        normalizedCspStructure(firstCsp) !==
          normalizedCspStructure(origin.contentSecurityPolicy)) ||
      (firstCspReportOnly !== null && origin.contentSecurityPolicyReportOnly === null) ||
      (firstCspReportOnly !== null &&
        origin.contentSecurityPolicyReportOnly !== null &&
        normalizedCspStructure(firstCspReportOnly) !==
          normalizedCspStructure(origin.contentSecurityPolicyReportOnly))
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
    const originCharset = charsetOf(origin.contentType ?? '');
    const asciiBody = containsOnlyAscii(origin.body);
    // `ascii`/`us-ascii` are legacy web-encoding labels. Relabeling non-ASCII
    // bytes as UTF-8 can change visible origin text even when those bytes form
    // valid UTF-8, so only genuinely ASCII source bytes are safe.
    if ((originCharset === 'ascii' || originCharset === 'us-ascii') && !asciiBody) {
      return response;
    }
    // With no header charset, valid UTF-8 bytes are not proof of UTF-8 intent:
    // browsers perform a context-sensitive HTML encoding prescan and might
    // interpret the same bytes as windows-1252. Safe to relabel are ASCII
    // bytes, an unambiguous UTF-8 BOM, or a meta tag in the prescan window
    // that itself declares UTF-8 (then the browser decodes it as UTF-8 too,
    // and the lossless-decode proof above already showed the bytes ARE valid
    // UTF-8). Everything else stays ambiguous and passes through. In the
    // field this matters for origins that send a bare `text/html` for German
    // pages carrying umlauts plus `<meta charset="utf-8">`: before this
    // prescan every such page silently failed open.
    if (
      originCharset === null &&
      !asciiBody &&
      !hasUtf8Bom(origin.body) &&
      !declaresUtf8MetaInPrescan(origin.body)
    ) {
      return response;
    }
    // We already hold the snippet — inject it directly. injectIntoHead returns
    // the HTML unchanged when there is no </head>, preserving fail-open.
    const injected = injectIntoHead(originalHtml, lookup.snippet);

    // Nothing injected (no </head>) → return the untouched response; CloudFront
    // serves the origin's own (byte-identical) body without us generating one.
    if (injected === originalHtml) return response;

    const headers: CloudFrontHeaders = { ...response.headers };
    // The origin's Content-Length describes the ORIGINAL body and is wrong for
    // the replaced one. Per the Lambda@Edge body-replacement rules CloudFront
    // computes Content-Length from the returned body itself; deleting the
    // stale header (rather than recomputing it here) is the documented, safe
    // way to let that happen — a mismatched explicit value risks truncated or
    // hung responses.
    delete headers['content-length'];
    // The generated body is the identity (uncompressed) re-fetch, but the
    // original response we cloned these headers from may have been gzip/br
    // (CloudFront forwards Accept-Encoding when Compress is on). Drop the stale
    // Content-Encoding so the viewer does not try to gunzip plain HTML;
    // CloudFront re-compresses the generated response for the viewer.
    delete headers['content-encoding'];
    // ETag / Last-Modified are validators for the ORIGINAL body; keeping them
    // would let two different bodies circulate under one strong validator
    // (a client holding the uninjected page revalidates → 304 → never sees
    // the injected version). Drop them so caches treat the body as new.
    delete headers['etag'];
    delete headers['last-modified'];
    // Integrity digests describe the ORIGINAL bytes too — a Content-MD5 /
    // Digest / Content-Digest / Repr-Digest computed over the uninjected body
    // would make any verifying client reject the replaced one as corrupted.
    delete headers['content-md5'];
    delete headers['digest'];
    delete headers['content-digest'];
    delete headers['repr-digest'];

    // The generated text is UTF-8 regardless of whether the re-fetch declared
    // UTF-8, ASCII, or no charset. Canonicalize the Content-Type so Unicode in
    // the injected JSON-LD can never be decoded under a stale ASCII label.
    headers['content-type'] = [{ key: 'Content-Type', value: GENERATED_HTML_CONTENT_TYPE }];

    // The equality gate above proved the cache policy stable across both
    // responses. Re-emit the re-fetch's canonical value with its body.
    if (origin.cacheControl === null) {
      delete headers['cache-control'];
    } else {
      headers['cache-control'] = [{ key: 'Cache-Control', value: origin.cacheControl }];
    }
    if (origin.expires === null) {
      delete headers['expires'];
    } else {
      headers['expires'] = [{ key: 'Expires', value: origin.expires }];
    }

    // The generated body is the re-fetch's, so the CSP that matches it (an
    // origin minting a per-response nonce would put a DIFFERENT nonce in each
    // response) is the re-fetch's — not the first response's. Copy it over so
    // header and body agree; otherwise the page's own inline scripts would be
    // CSP-blocked (a page-breaking, fail-CLOSED outcome). The asymmetry gate
    // above already returned the original response if a first-response CSP
    // disappeared; deleting first is now safe and prevents duplicate values.
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    if (origin.contentSecurityPolicy !== null) {
      headers['content-security-policy'] = [
        { key: 'Content-Security-Policy', value: origin.contentSecurityPolicy },
      ];
    }
    if (origin.contentSecurityPolicyReportOnly !== null) {
      headers['content-security-policy-report-only'] = [
        {
          key: 'Content-Security-Policy-Report-Only',
          value: origin.contentSecurityPolicyReportOnly,
        },
      ];
    }

    // CloudFront independently caps an origin response's headers at 32 KB.
    // A larger per-response CSP from the re-fetch can push a previously valid
    // first-response header set over that limit; returning it would produce a
    // viewer-facing 502 after Lambda has completed, so fail open here.
    const responseHeaderBytes = serializedHeaderBytes(
      headers,
      response.status,
      response.statusDescription
    );
    if (responseHeaderBytes > MAX_RESPONSE_HEADER_BYTES) return response;

    // The injected page must also fit the 1 MB generated-response quota, which
    // counts headers AND body together. Budget the body against the ACTUAL
    // serialized header size plus a safety margin. An over-quota generated
    // response is a viewer-facing 502, not fail-open — so when in doubt, pass
    // through.
    const bodyBudgetBytes =
      MAX_GENERATED_RESPONSE_BYTES - responseHeaderBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
    if (Buffer.byteLength(injected, 'utf8') > bodyBudgetBytes) return response;

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
