/**
 * Pure helpers shared by BOTH Lambda@Edge entrypoints.
 *
 * `index.ts` (origin-response) and `origin-request.ts` need the same gates,
 * URL builders, charset probes and size accounting. Keeping them here means
 * the two triggers cannot drift apart — a divergence would show up as one
 * trigger injecting a page the other refuses, which is exactly the class of
 * bug that is hardest to notice in production.
 *
 * Nothing in this module holds state or performs I/O; both entrypoints import
 * from it, and `index.ts` re-exports the public names so existing consumers
 * and tests keep their import paths.
 */
import type { CloudFrontHeaders, CloudFrontRequest } from 'aws-lambda';

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

export function containsOnlyAscii(body: Buffer): boolean {
  return body.every((byte) => byte <= 0x7f);
}

/** A byte-order mark is unambiguous UTF-8 evidence without parsing HTML. */
export function hasUtf8Bom(body: Buffer): boolean {
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
export function declaresUtf8MetaInPrescan(body: Buffer): boolean {
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
function isInjectableRepresentation(input: AttemptInput): boolean {
  if (input.method !== 'GET') return false;
  if (input.status !== '200') return false;

  const contentType = input.contentType ?? '';
  // Exact media-type match (parameters stripped) — a prefix check would
  // wrongly match e.g. "text/htmlx".
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;

  const charset = charsetOf(contentType);
  return charset === null || UTF8_COMPATIBLE_CHARSETS.has(charset);
}

/**
 * Gate for a body obtained by RE-FETCHING a page CloudFront already answered
 * (the origin-response trigger). On top of the representation check it refuses
 * per-request state, because a second fetch cannot reproduce it faithfully.
 */
export function shouldAttempt(input: AttemptInput, ignoreContentEncoding = false): boolean {
  if (!isInjectableRepresentation(input)) return false;

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

/** `noindex` / `none` as complete X-Robots-Tag directives, not substrings. */
export function blocksIndexing(xRobotsTag: string | null): boolean {
  return xRobotsTag !== null && /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i.test(xRobotsTag);
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
