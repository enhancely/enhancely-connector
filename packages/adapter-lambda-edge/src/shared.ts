/**
 * Pure helpers shared by all Lambda@Edge entrypoints.
 *
 * `index.ts` (origin-response), `origin-request.ts`, and the cache-cap-only
 * `companion.ts` share the relevant gates and URL helpers. Charset probes and
 * size accounting are shared by the two body-aware injectors. Keeping these
 * invariants here prevents the entrypoints from silently drifting apart.
 *
 * Nothing in this module holds state or performs I/O; all entrypoints import
 * the helpers they need, and `index.ts` re-exports the public names so existing
 * consumers and tests keep their import paths.
 */
import type { CloudFrontHeaders, CloudFrontRequest } from 'aws-lambda';
import { charsetOf, isAttachmentDisposition } from '@enhancely/injector-core';
export {
  blocksIndexing,
  charsetOf,
  containsOnlyAscii,
  declaresUtf8MetaInPrescan,
  hasUtf8Bom,
  isUtf8SafeHtmlBytes,
  isValidUtf8,
} from '@enhancely/injector-core';

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
export const GENERATED_HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * Extensions that can never be an injectable HTML document. Both members of
 * the recommended Lambda@Edge pair apply this before config or network work,
 * so an asset-shaped handback cannot be reconsidered by the companion.
 */
export const NON_HTML_EXTENSION =
  /\.(?:js|mjs|cjs|css|map|json|jsonld|geojson|xml|rss|atom|txt|csv|tsv|yaml|yml|wasm|webmanifest|ics|vcf|png|jpe?g|jfif|gif|webp|avif|heic|heif|svg|ico|bmp|tiff?|psd|eps|woff2?|ttf|otf|eot|mp4|m4v|webm|ogv|mkv|flv|mov|avi|mp3|m4a|aac|opus|wav|flac|oga|ogg|vtt|srt|pdf|docx?|xlsx?|pptx?|odt|ods|odp|epub|mobi|zip|gz|tgz|bz2|xz|7z|rar|tar|iso|apk|dmg|exe|msi|deb|rpm|bin)$/i;

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
  /** Response Content-Disposition header value. */
  contentDisposition: string | null;
  /** True when the response carries any Set-Cookie header. */
  hasSetCookie: boolean;
}

/** `private` / `no-store` as Cache-Control directives (not substrings). */
const PER_REQUEST_CACHE_CONTROL = /(?:^|[\s,])(?:private|no-store)(?:$|[\s,=])/i;
const NO_TRANSFORM_CACHE_CONTROL = /(?:^|[\s,])no-transform(?:$|[\s,=])/i;

/** True when the Cache-Control marks a per-request representation. */
export function hasPerRequestCacheControl(cacheControl: string | null): boolean {
  return cacheControl !== null && PER_REQUEST_CACHE_CONTROL.test(cacheControl);
}

/**
 * Marker header the origin-request entrypoint stamps on injected GENERATED
 * responses. It is a field-debugging aid and a never-touch-injected-content
 * tripwire: per AWS docs an origin-response trigger does not run for generated
 * responses, so the companion should never observe it. If it does (for
 * example because an origin echoed it), the companion abstains. This is not a
 * reliable deployment-pairing detector, and injection never depends on it.
 */
export const INJECTED_MARKER_HEADER = 'x-enhancely-injected';
export const INJECTED_MARKER_VALUE = '1';

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
function isInjectableRepresentation(input: AttemptInput): boolean {
  if (input.method !== 'GET') return false;
  if (input.status !== '200') return false;

  const contentType = input.contentType ?? '';
  // Exact media-type match (parameters stripped) — a prefix check would
  // wrongly match e.g. "text/htmlx".
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;

  const charset = charsetOf(contentType);
  if (charset !== null && !UTF8_COMPATIBLE_CHARSETS.has(charset)) return false;
  if (NO_TRANSFORM_CACHE_CONTROL.test(input.cacheControl ?? '')) return false;
  if (isAttachmentDisposition(input.contentDisposition)) return false;
  return true;
}

/**
 * Gate for a body obtained by RE-FETCHING a page CloudFront already answered
 * (the origin-response trigger). On top of the representation check it refuses
 * per-request state, because a second fetch cannot reproduce it faithfully.
 */
export function shouldAttempt(input: AttemptInput, ignoreContentEncoding = false): boolean {
  if (!isInjectableRepresentation(input)) return false;

  if (input.hasSetCookie) return false;
  if (hasPerRequestCacheControl(input.cacheControl)) {
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
 * Gate for the origin-request trigger, which GENERATES the response from the
 * one and only origin answer it fetched itself.
 *
 * Deliberately does NOT refuse per-request state. `shouldAttempt` skips
 * responses carrying `Set-Cookie` or `Cache-Control: private|no-store` because
 * a page stamping new state into the viewer cannot be re-fetched faithfully —
 * that reasoning is specific to the double fetch and does not apply here:
 * there IS no second fetch, and the response returned to the viewer is the
 * very one the origin just produced, its Set-Cookie included verbatim.
 *
 * Nor does abstaining buy anything. Handing the request back makes CloudFront
 * fetch the identical page and cache the identical Set-Cookie; the only
 * difference is that the viewer gets no JSON-LD. On any site behind a
 * stickiness-enabled load balancer — where every response carries a session
 * cookie — the old rule silently meant "never inject at all".
 */
export function shouldAttemptGeneratedResponse(input: AttemptInput): boolean {
  if (!isInjectableRepresentation(input)) return false;
  // A compressed body cannot be injected into: the fetch asked for `identity`,
  // so a Content-Encoding here means the origin ignored us.
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
 * URL for the origin fetch:
 * `{protocol}://{domainName}[:port]{originPath}{uri}[?querystring]` — exactly
 * what CloudFront itself requests from a custom origin. Returns null for
 * non-custom origins (S3 REST origins speak a different protocol; those
 * distributions should not attach this function).
 *
 * ALSO returns null when the URI would escape the configured origin path.
 * The fetch layer parses this string with `new URL()`, which resolves
 * dot-segments — so a URI containing `..` silently rewrites the target:
 *
 *   originPath "/prefix" + uri "/../secret"  →  https://host/secret
 *
 * That is outside the subtree CloudFront's own request would ever reach, so
 * the only safe answer is to decline and let CloudFront fetch normally. The
 * check compares the RESOLVED path against the origin path rather than
 * scanning for `..`, which also covers encoded and nested forms.
 */
export function buildOriginUrl(
  request: Pick<CloudFrontRequest, 'origin' | 'uri' | 'querystring'>
): string | null {
  const custom = request.origin?.custom;
  if (custom === undefined) return null;
  const defaultPort = custom.protocol === 'https' ? 443 : 80;
  const portPart = custom.port !== defaultPort ? `:${custom.port}` : '';
  const query = request.querystring !== '' ? `?${request.querystring}` : '';
  const origin = `${custom.protocol}://${custom.domainName}${portPart}`;
  const url = `${origin}${custom.path}${request.uri}${query}`;

  let resolved: URL;
  try {
    resolved = new URL(url);
  } catch {
    return null;
  }
  // The host must not have moved either (a protocol-relative-looking URI or a
  // malformed origin path could otherwise redirect the fetch elsewhere).
  if (`${resolved.protocol}//${resolved.host}` !== origin) return null;
  const prefix = custom.path === '' ? '/' : `${custom.path}/`;
  if (resolved.pathname !== custom.path && !resolved.pathname.startsWith(prefix)) return null;

  return url;
}

/**
 * Static origin custom header that carries the public page hostname for
 * distributions whose origin cannot receive the viewer Host header
 * (e.g. S3 website endpoints). Configured on the CloudFront origin.
 */
export const PAGE_HOST_HEADER = 'x-enhancely-page-host';

/**
 * The distribution's origin custom headers, as CloudFront would send them.
 *
 * These are configured ON THE ORIGIN and CloudFront adds them to every request
 * it forwards — they never appear in `request.headers`. A fetch this adapter
 * issues itself therefore has to add them back, or the origin sees a request
 * CloudFront would never have made: shared-secret headers are missing, and any
 * origin that varies its response on them answers with a DIFFERENT variant
 * than the one the viewer is entitled to.
 *
 * CloudFront gives origin custom headers precedence over a viewer header of
 * the same name, so callers must spread these last.
 */
export function originCustomHeaders(
  request: Pick<CloudFrontRequest, 'origin'>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entries] of Object.entries(request.origin?.custom?.customHeaders ?? {})) {
    const value = entries?.[0]?.value;
    if (value !== undefined) out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * Conditional and range headers that must NOT be replayed on a fetch whose
 * body we intend to inject into. A viewer holding a cached copy sends
 * `If-None-Match`; forwarding it makes the origin answer `304 Not Modified`
 * with no body at all — the gate then rejects it and the fetch was wasted.
 * `Range` has the same effect with a partial body.
 *
 * Only relevant where the fetched body IS the returned body. The
 * origin-response trigger deliberately forwards everything so its re-fetch
 * reproduces the same representation CloudFront already received.
 */
const CONDITIONAL_REQUEST_HEADERS = [
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'range',
];

/** Strip conditional/range headers from an already-forwarded header set. */
export function withoutConditionalHeaders(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  for (const name of CONDITIONAL_REQUEST_HEADERS) delete out[name];
  return out;
}

/** First value of a static origin custom header, or null. */
export function customHeaderValue(
  request: Pick<CloudFrontRequest, 'origin'>,
  name: string
): string | null {
  const value = request.origin?.custom?.customHeaders[name]?.[0]?.value ?? null;
  return value !== null && value !== '' ? value : null;
}

/** First value of a (lowercase-keyed) CloudFront header, or null. */
export function headerValue(headers: CloudFrontHeaders, name: string): string | null {
  return headers[name]?.[0]?.value ?? null;
}

/** Cache-Control is a list field: every CloudFront header entry is operative. */
export function cacheControlValue(headers: CloudFrontHeaders): string | null {
  const entries = headers['cache-control'];
  return entries === undefined ? null : entries.map((entry) => entry.value).join(', ');
}

/** Combine every value of a list-like response header. */
export function combinedHeaderValue(headers: CloudFrontHeaders, name: string): string | null {
  const entries = headers[name];
  return entries === undefined ? null : entries.map((entry) => entry.value).join(', ');
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
  'proxy-connection',
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
  const blocked = new Set(NON_FORWARDED_REQUEST_HEADERS);
  for (const entry of headers['connection'] ?? []) {
    for (const token of entry.value.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') blocked.add(name);
    }
  }
  for (const [name, entries] of Object.entries(headers)) {
    // CloudFront keys the map with lowercase names already; normalize anyway
    // so the exclusion set can never be dodged by casing.
    const key = name.toLowerCase();
    if (blocked.has(key)) continue;
    if (entries.length === 0) continue;
    // CloudFront may split repeated headers into multiple entries; cookies
    // recombine with "; " (RFC 6265), everything else with ", " (RFC 9110).
    out[key] = entries.map((entry) => entry.value).join(key === 'cookie' ? '; ' : ', ');
  }
  return out;
}
