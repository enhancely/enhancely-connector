/**
 * CloudFront Lambda@Edge **origin-request** adapter for the Enhancely injector.
 *
 * Alternative entrypoint to `index.ts` (origin-response): same core, different
 * trigger — and a materially different cost profile AND coverage.
 *
 * WHY THIS EXISTS
 * An origin-response trigger cannot read the origin body, so `index.ts` has to
 * fetch the page a SECOND time and then prove the two responses describe the
 * same object (X-Robots-Tag, Cache-Control, Expires and CSP must all line up).
 * On an origin-request trigger a function may instead GENERATE the response;
 * CloudFront then never contacts the origin at all. There is exactly one
 * response, so there is nothing to reconcile:
 *
 *   origin-response:  CloudFront fetch + our re-fetch = 2 origin hits per
 *                     injected cache miss, plus four cross-response equality
 *                     gates that silently skip injection when they disagree.
 *   origin-request:   1 origin hit, no equality gates.
 *
 * COVERAGE: per-request state is injected here
 * `index.ts` skips any response carrying `Set-Cookie` or
 * `Cache-Control: private|no-store`, because a re-fetch cannot faithfully
 * reproduce a page that stamps new state into the viewer. That reasoning is a
 * property of the double fetch, not of the page — so this trigger does not
 * apply it. The response handed to the viewer IS the one the origin just
 * produced, Set-Cookie included verbatim. On sites behind a stickiness-enabled
 * load balancer, where every response carries a session cookie, the old rule
 * silently meant "never inject at all".
 *
 * CloudFront's cache policy and response cache directives determine whether a
 * generated response is cached; `Set-Cookie` alone is not a cache veto.
 * Injecting into a page that sets a cookie therefore does not make CloudFront
 * cache anything it would not have cached anyway — the shared-cookie risk is a
 * property of the distribution's cache policy, not of this injection.
 *
 * Precise wording matters here: the generated response is NOT byte-identical
 * to the passed-through one (ETag, Last-Modified and Content-Length are
 * deliberately dropped, see STALE_BODY_HEADERS). It is identical in the only
 * respect that governs caching.
 *
 * ORDER OF OPERATIONS — origin-first (changed in v0.9.0)
 * Up to v0.8.0 the Enhancely lookup ran BEFORE the origin fetch. That is the
 * cheapest order in origin hits, but it forces the adapter to decide from the
 * REQUEST alone whether a URL is worth asking about — and from the request
 * alone that is unknowable. The extension pre-filter catches assets; an
 * extension-less URI may still be a redirect, a JSON endpoint or a 404. Asking
 * Enhancely first would spend an API call and its latency on every such request.
 *
 * No request-side signal fixes this. `Accept` cannot: Googlebot sends the
 * wildcard media range WITHOUT `text/html` (Google Search Central), so
 * requiring `text/html` would exclude the single most important consumer of
 * the injected JSON-LD — while also accepting the wildcard excludes nothing,
 * because every script, image and XHR carries it too. Fetch
 * Metadata (`Sec-Fetch-Dest`) is absent on http://, on pre-2023 browsers and
 * on crawlers, and it is not normally part of the cache key — gating on a
 * header outside the cache key means the un-injected variant can win the cache
 * entry and be served to everyone.
 *
 * So the order is inverted: fetch the origin first, and look up only once the
 * RESPONSE proves this is a servable, injectable HTML page. That is exactly
 * what the Cloudflare and sidecar adapters do — they see the response before
 * deciding and never had this problem. The fetch is not extra work; CloudFront
 * would issue the same request, it just moves into this function:
 *
 *   HTML + snippet    → 1 own fetch, no CloudFront fetch  = 1
 *   HTML, no snippet  → 1 own fetch, response generated   = 1
 *   non-2xx (404, 3xx) → 1 own fetch, returned verbatim   = 1
 *   small status-200 veto → 1 own fetch, returned verbatim = 1
 *   over-quota/other 2xx → 1 own + 1 CloudFront fetch     = 2  (first time)
 *                         → 0 own + 1 CloudFront fetch     = 1  (remembered)
 *
 * A reproducible answer never costs two hits: its exact bytes are base64-
 * framed from the fetch already made (verbatimOriginResponse). For non-2xx,
 * CloudFront still applies an operator's configured custom error response.
 * Small status-200 vetoes (JSON, noindex, legacy charset,
 * ignored identity encoding) use the same safe primitive. Only responses that
 * cannot fit or whose successful status has not been live-validated hand back;
 * their verdict is memoized per execution environment (see nonPageMemo). No
 * private coordination header is added to the real origin request: a generic
 * origin or WAF may vary on any header, so doing so would not be customer-
 * independent. The companion repeats cheap request/response gates solely to
 * decide whether an eligible handback may receive a shorter cache lifetime;
 * it never performs a recovery lookup. Two consequences follow, both of which
 * the previous order could not deliver:
 *   - REGISTRATION is precise. The adapter knows the response is real HTML, so
 *     autoRegister no longer has to be forced off (v0.7.0/v0.8.0 could only
 *     have registered redirects, JSON endpoints and 404s).
 *   - The retry cache cap works. The un-injected response is now generated
 *     here, so assertedDefaultTtlSeconds bounds it directly instead of leaving
 *     CloudFront to cache the origin's own copy for the full DefaultTTL.
 *
 * FAIL-OPEN
 * Every failure path returns the untouched `request`. CloudFront then behaves
 * exactly as if this function were not associated at all — the cheapest and
 * least breakable fallback the platform offers. Notably this also covers the
 * 1 MB generated-response quota: where the origin-response adapter must fail
 * OPEN by returning a response it already holds (and a body over quota there
 * is a viewer-facing 502), here an oversized page simply hands control back to
 * CloudFront, which streams it with no size limit at all.
 *
 * All connector logic (API client, cache + ETag revalidation, injection,
 * fail-open orchestration) lives in @enhancely/injector-core; this file only
 * translates CloudFront event shapes (repo rule 8). Everything it shares with
 * the origin-response entrypoint comes from ./shared.js, so the two triggers
 * cannot drift apart.
 */
import type { OriginFetchResult } from './origin-fetch.js';
import type {
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestHandler,
  CloudFrontResultResponse,
} from 'aws-lambda';
import {
  __resetRateLimitCircuitForTests,
  buildScriptTag,
  findHeadInjectionPoint,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  injectIntoHead,
  isHostIncluded,
  matchesExcludedPath,
  MemoryCache,
  normalizeForEnhancely,
} from '@enhancely/injector-core';
import type { InjectorConfig, JsonLdLookupResult } from '@enhancely/injector-core';
import {
  getAssertedDefaultTtlSeconds,
  getCapSetCookieResponses,
  getExcludePaths,
  getIncludeHosts,
  getNonPageMemoTtlMs,
  getOriginTimeoutMs,
  resolveAdapterConfig,
} from './config.js';
import { retryablePassThroughResponse } from './cache-cap.js';
import {
  isUpstreamDown,
  noteUpstreamCallDuration,
  upstreamDownRemainingMs,
  __resetUpstreamMemoForTests,
} from './upstream-memo.js';

// Re-exported so tests (and consumers) keep their import path.
export { __resetUpstreamMemoForTests };
import { fetchOriginHtml, originFetchFailureScope } from './origin-fetch.js';
import {
  blocksIndexing,
  buildOriginUrl,
  forwardedHeaders,
  GENERATED_HTML_CONTENT_TYPE,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  INJECTED_MARKER_HEADER,
  INJECTED_MARKER_VALUE,
  isUtf8SafeHtmlBytes,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  NON_HTML_EXTENSION,
  originCustomHeaders,
  resolvePageRequestTarget,
  serializedHeaderBytes,
  shouldAttemptGeneratedResponse,
  withoutConditionalHeaders,
} from './shared.js';

/** Smallest script wrapper an injectable Enhancely answer can add. */
const MINIMUM_INJECTED_SNIPPET_BYTES = Buffer.byteLength(buildScriptTag('', null), 'utf8');

/**
 * Headers an edge function may not emit. Adding one of these to a generated
 * response fails CloudFront validation and produces a viewer-facing 502 —
 * which is exactly the fail-CLOSED outcome this adapter exists to avoid, so
 * they are stripped rather than trusted to be absent.
 *
 * Sources (AWS "Restrictions on all edge functions"):
 * - "Disallowed headers": not exposed to edge functions and functions can't
 *   add them.
 * - "Read-only headers in origin request events": Accept-Encoding, CDN-Loop,
 *   Content-Length, If-*, Transfer-Encoding, Via. Only the ones that can
 *   plausibly appear on an origin RESPONSE are listed here.
 */
const DISALLOWED_RESPONSE_HEADERS = new Set([
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'x-accel-buffering',
  'x-accel-charset',
  'x-accel-limit-rate',
  'x-accel-redirect',
  'x-amzn-auth',
  'x-amzn-cf-billing',
  'x-amzn-cf-id',
  'x-amzn-cf-xff',
  'x-amzn-errortype',
  'x-amzn-fle-profile',
  'x-amzn-header-count',
  'x-amzn-header-order',
  'x-amzn-lambda-integration-tag',
  'x-amzn-requestid',
  'x-cache',
  'x-forwarded-proto',
  'x-real-ip',
  'cloudfront-viewer-cert-pem',
  'client-cert',
  'client-cert-chain',
  // Read-only in origin request events (full AWS list, so this stays 1:1 with
  // the documented set rather than a judgement call about which of them could
  // plausibly appear on a response).
  'transfer-encoding',
  'via',
  'cdn-loop',
  'accept-encoding',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  // CloudFront computes Content-Length from the body it receives; a stale
  // value describing the UNINJECTED body risks a truncated or hung response.
  'content-length',
]);

/** Wildcard families from the same AWS list (`X-Amz-Cf-*`, `X-Edge-*`). */
const DISALLOWED_RESPONSE_HEADER_PREFIXES = ['x-amz-cf-', 'x-edge-'];

/**
 * Headers that described the ORIGINAL bytes and would be wrong for the
 * injected ones. Same reasoning as the origin-response path: a validator or
 * digest computed over the uninjected body would either let a stale copy
 * circulate under a strong validator (ETag → 304 → the viewer never sees the
 * injected page) or make a verifying client reject the body as corrupted.
 */
const STALE_BODY_HEADERS = [
  'etag',
  'last-modified',
  'content-md5',
  'digest',
  'content-digest',
  'repr-digest',
  // The fetch asked for `identity`, so the body we return is uncompressed.
  // CloudFront re-compresses the generated response for the viewer when the
  // cache behavior has Compress enabled.
  'content-encoding',
];

function isDisallowedResponseHeader(name: string): boolean {
  return (
    DISALLOWED_RESPONSE_HEADERS.has(name) ||
    DISALLOWED_RESPONSE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Convert the origin's own header set into CloudFront's shape, dropping what
 * must not be emitted and what no longer describes the injected body.
 *
 * Everything else is preserved verbatim — Vary, Link, Strict-Transport-
 * Security, X-Frame-Options, Content-Security-Policy and any custom header the
 * origin set. This adapter generates the WHOLE viewer response, so silently
 * dropping an origin header would be a behavior (and possibly security)
 * regression that no test on the injected markup would catch.
 */
/**
 * How faithfully the body we are about to return reproduces the origin's.
 * - `injected`  — bytes changed: validators and digests are now wrong, and the
 *   body is re-emitted as identity text, so Content-Encoding must go too.
 * - `decoded`   — bytes unchanged but re-emitted as text after an identity
 *   fetch: validators still describe them truthfully, Content-Encoding does not.
 * - `verbatim`  — the exact bytes, base64-framed: every header the origin sent
 *   still describes the body, Content-Encoding included.
 */
export type BodyFidelity = 'injected' | 'decoded' | 'verbatim';

export function buildResponseHeaders(
  allHeaders: Record<string, string[]>,
  fidelity: BodyFidelity = 'injected'
): CloudFrontHeaders {
  const headers: CloudFrontHeaders = {};
  // RFC 9110 allows Connection to name additional hop-by-hop fields. Those
  // names are dynamic, so dropping only the fixed `connection` header can
  // leak origin-connection metadata into the generated viewer response.
  const connectionSpecific = new Set<string>();
  for (const value of allHeaders['connection'] ?? []) {
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') connectionSpecific.add(name);
    }
  }
  for (const [name, values] of Object.entries(allHeaders)) {
    if (isDisallowedResponseHeader(name) || connectionSpecific.has(name)) continue;
    // Validators and digests describe the ORIGINAL bytes: wrong once the body
    // carries an injected snippet, still accurate when it does not. On the
    // pass-through path only Content-Encoding must go — the fetch asked for
    // identity, so the bytes we return are uncompressed whatever the origin
    // labelled them.
    if (fidelity === 'injected' && STALE_BODY_HEADERS.includes(name)) continue;
    if (fidelity === 'decoded' && name === 'content-encoding') continue;
    // CloudFront expects the canonical casing in `key` and lowercase keys in
    // the map; the origin's own casing is not preserved by node anyway.
    // EVERY value, not just the first: Set-Cookie is the case that matters —
    // folding two cookies into one would drop the second one silently.
    headers[name] = values.map((value) => ({ key: canonicalHeaderName(name), value }));
  }
  return headers;
}

/** `content-security-policy` → `Content-Security-Policy`. */
function canonicalHeaderName(lowercase: string): string {
  return lowercase
    .split('-')
    .map((part) => (part === '' ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('-');
}

/**
 * Per-execution-environment JSON-LD cache. Separate from the origin-response
 * entrypoint's cache by construction — only one of the two is ever bundled
 * into a given artifact.
 */
let cache = new MemoryCache();

/**
 * Per-execution-environment memo of URLs whose origin answer cannot be
 * injected AND cannot safely be generated from the fetch already made — for
 * example an over-quota response or an unsupported 2xx representation.
 *
 * WHY. Origin-first buys precision at the cost of ONE extra origin hit for
 * exactly that class: we fetch to find out what it is, then hand the request
 * back so CloudFront fetches it again. The first time that is unavoidable —
 * nothing in the request tells us. The SECOND time is pure waste. Small
 * redirects, errors and status-200 veto bodies are instead reproduced from
 * the first fetch and never enter this memo.
 *
 * So the verdict is remembered and the fetch is skipped: repeats hand back
 * immediately and cost exactly what they cost before origin-first — one
 * CloudFront fetch, nothing else. The memo is per execution environment
 * (Lambda@Edge cannot share state), bounded in size, and expires, so a URL
 * that later becomes a real page is picked up again; until then it is served
 * un-injected, which is the same bounded staleness the core's negative cache
 * already accepts.
 */
let nonPageMemo = new Map<string, number>();
let nonPageMemoEstimatedBytes = 0;

/**
 * Short origin-failure circuits. A proven DNS/connect/TLS setup failure is
 * scoped to endpoint + virtual host because every path shares that transport.
 * Errors after the transport is ready (including a slow/reset response) are
 * scoped to the exact origin request so one bad URL cannot suppress healthy
 * pages while repeats of that URL still avoid a known-doomed extra fetch.
 */
let originFailureMemo = new Map<string, number>();
let originRequestFailureMemo = new Map<string, number>();
const ORIGIN_FAILURE_MEMO_TTL_MS = 10_000;
const ORIGIN_FAILURE_MEMO_MAX_ENTRIES = 256;

/**
 * Bounded so a scan of unique dead URLs cannot grow the map without limit.
 * 10 000 entries is a few hundred KB against the function's 256 MB — cheap
 * enough that the cap only ever exists as a runaway guard.
 */
const NON_PAGE_MEMO_MAX_ENTRIES = 10_000;
const NON_PAGE_MEMO_MAX_ESTIMATED_BYTES = 4 * 1024 * 1024;

function estimatedNonPageMemoBytes(url: string): number {
  return 64 + url.length * 2;
}

function deleteNonPageMemo(url: string): void {
  if (!nonPageMemo.delete(url)) return;
  nonPageMemoEstimatedBytes -= estimatedNonPageMemoBytes(url);
}

function originFailureKey(originUrl: string, originHost: string): string | null {
  try {
    return `${new URL(originUrl).origin}\0${originHost.toLowerCase()}`;
  } catch {
    return null;
  }
}

function originRequestFailureKey(endpointKey: string, originUrl: string): string {
  // Keep the original string: fetchOriginHtml deliberately preserves its raw
  // path/query bytes instead of accepting WHATWG dot-segment rewriting.
  return `${endpointKey}\0${originUrl}`;
}

function originFailureRemainingMs(memo: Map<string, number>, key: string): number | null {
  const until = memo.get(key);
  if (until === undefined) return null;
  const remaining = until - Date.now();
  if (remaining > 0) return remaining;
  memo.delete(key);
  return null;
}

function rememberOriginFailure(memo: Map<string, number>, key: string): void {
  if (!memo.has(key) && memo.size >= ORIGIN_FAILURE_MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, Date.now() + ORIGIN_FAILURE_MEMO_TTL_MS);
}

function rememberNonPage(url: string, ttlMs: number): number {
  // Bound both count and retained key bytes: CloudFront paths can be long, so
  // a count-only 10k cap would still be large enough to threaten the 256 MiB
  // Lambda memory limit. Refreshing an existing verdict moves it to the end.
  deleteNonPageMemo(url);
  const entryBytes = estimatedNonPageMemoBytes(url);
  while (
    nonPageMemo.size >= NON_PAGE_MEMO_MAX_ENTRIES ||
    nonPageMemoEstimatedBytes + entryBytes > NON_PAGE_MEMO_MAX_ESTIMATED_BYTES
  ) {
    const oldest = nonPageMemo.keys().next().value;
    if (oldest === undefined) break;
    deleteNonPageMemo(oldest);
  }
  const until = Date.now() + ttlMs;
  if (entryBytes <= NON_PAGE_MEMO_MAX_ESTIMATED_BYTES) {
    nonPageMemo.set(url, until);
    nonPageMemoEstimatedBytes += entryBytes;
  }
  return Math.max(1, until - Date.now());
}

function rememberedNonPageRemainingMs(url: string): number | null {
  const until = nonPageMemo.get(url);
  if (until === undefined) return null;
  const remaining = until - Date.now();
  if (remaining > 0) return remaining;
  deleteNonPageMemo(url);
  return null;
}

/** Remember an expensive hard veto, then let CloudFront perform its fetch. */
function memoizedPassThrough(request: CloudFrontRequest, pageUrl: string): CloudFrontRequest {
  rememberNonPage(pageUrl, getNonPageMemoTtlMs());
  return request;
}

/**
 * The global outage memo blocks network, not useful local data. Positive
 * entries — fresh or stale — remain injectable. A negative/missing entry gets
 * a retry bound no earlier than both its own memo and the outage window.
 */
async function lookupWhileUpstreamIsDown(
  pageUrl: string,
  config: InjectorConfig
): Promise<JsonLdLookupResult> {
  const now = Date.now();
  const outageRemaining = Math.max(1, upstreamDownRemainingMs());
  try {
    const key = normalizeForEnhancely(pageUrl);
    if (key === null) {
      return { snippet: null, revalidateInMs: outageRemaining };
    }
    const entry = await cache.get(key);
    if (entry?.jsonldRaw !== null && entry?.jsonldRaw !== undefined) {
      return {
        snippet: buildScriptTag(entry.jsonldRaw, entry.etag),
        revalidateInMs: null,
      };
    }

    const cacheExpiry =
      entry !== undefined && entry.storedAt > 0 ? entry.storedAt + config.cacheTtlMs : 0;
    const nextOwnLookup = Math.max(cacheExpiry, entry?.retryNotBefore ?? 0);
    return {
      snippet: null,
      revalidateInMs: Math.max(1, outageRemaining, nextOwnLookup - now),
    };
  } catch {
    // MemoryCache cannot currently throw, but a cache peek must stay fail-open
    // if its implementation changes. The outage window remains a safe bound.
    return { snippet: null, revalidateInMs: outageRemaining };
  }
}

/**
 * Return a reproducible origin answer straight from the fetch we already
 * made, instead of handing the request back for CloudFront to fetch it again.
 * Returns null when that is not safe or not enabled, and the caller then
 * hands back as before.
 *
 * Alongside non-2xx answers this includes status 200 representations rejected
 * before the Enhancely gate (small JSON, noindex, legacy charset, ignored
 * Content-Encoding). The bytes are framed as base64, so their encoding and
 * charset are reproduced exactly without decoding.
 *
 * CloudFront applies configured custom error responses to generated error
 * statuses as well. The viewer outcome therefore remains governed by the
 * distribution configuration while generation saves the second origin fetch.
 *
 * Excluded regardless:
 * - body-bearing 204 / every 304 — a generated 204 carrying a body is a
 *   viewer-facing 502, and a 304 must not be manufactured from a full fetch.
 * - Range requests — our fetch drops Range, so the origin answered in full;
 *   returning that as a 200/206 substitute would be wrong.
 * - Anything over the generated-response quota.
 */
function verbatimOriginResponse(
  origin: OriginFetchResult,
  request: CloudFrontRequest
): CloudFrontResultResponse | null {
  // A true empty 204 is safely reproducible only without a body. Other 2xx
  // statuses retain the conservative handback until explicitly validated.
  if (origin.status === 204 && origin.body.length > 0) return null;
  if (origin.status === 304) return null;
  if (origin.status > 200 && origin.status <= 299 && origin.status !== 204) return null;
  if (origin.status < 200 || origin.status > 599) return null;
  if (request.headers['range'] !== undefined) return null;

  const headers = buildResponseHeaders(origin.allHeaders, 'verbatim');
  const headerBytes = serializedHeaderBytes(headers, String(origin.status));
  if (headerBytes > MAX_RESPONSE_HEADER_BYTES) return null;

  const body = origin.body.toString('base64');
  const budget =
    MAX_GENERATED_RESPONSE_BYTES - headerBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
  // base64 is what CloudFront counts, so measure the encoded length.
  if (body.length > budget) return null;

  return {
    status: String(origin.status),
    headers,
    ...(body === '' ? {} : { body, bodyEncoding: 'base64' as const }),
  };
}

/**
 * Generate the already-fetched HTML unchanged when it fits CloudFront's
 * response quotas. The caller has already proved the UTF-8 round trip is
 * lossless, so validators remain valid; only Content-Encoding is removed
 * because the identity body is emitted as text.
 */
function decodedHtmlResponse(
  origin: OriginFetchResult,
  html: string
): CloudFrontResultResponse | null {
  const headers = buildResponseHeaders(origin.allHeaders, 'decoded');
  const headerBytes = serializedHeaderBytes(headers, String(origin.status));
  if (headerBytes > MAX_RESPONSE_HEADER_BYTES) return null;

  const bodyBudgetBytes =
    MAX_GENERATED_RESPONSE_BYTES - headerBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
  if (Buffer.byteLength(html, 'utf8') > bodyBudgetBytes) return null;

  return {
    status: String(origin.status),
    headers,
    body: html,
    bodyEncoding: 'text',
  };
}

/** TEST-ONLY: fresh cache between tests. */
export function __resetOriginRequestStateForTests(): void {
  cache = new MemoryCache();
  nonPageMemo = new Map();
  nonPageMemoEstimatedBytes = 0;
  originFailureMemo = new Map();
  originRequestFailureMemo = new Map();
  __resetRateLimitCircuitForTests();
}

export const handler: CloudFrontRequestHandler = async (event) => {
  // A CloudFront origin-request event always carries exactly one record. If it
  // somehow did not, throwing here would be the ONE path without a fail-open
  // answer — CloudFront would return 502. There is no request to hand back in
  // that case, so return undefined: CloudFront then treats the event as
  // unmodified and proceeds with its own origin fetch.
  const record = event.Records[0];
  if (!record) return undefined;
  const { request } = record.cf;

  try {
    // Only GET can be an injectable HTML document, and only GET is safe to
    // replay: this adapter re-issues the request against the origin itself, so
    // anything with side effects (POST/PUT/PATCH/DELETE) must never be touched.
    // HEAD is excluded too — generating a body for it would be wrong.
    if (request.method !== 'GET') return request;

    // Operator-excluded paths (login/account areas, robots.txt-disallowed
    // sections) pay NOTHING: no config/SSM resolution, no lookup, no
    // auto-registration. Cheapest gate, and the only purely policy-driven one.
    if (matchesExcludedPath(getExcludePaths(), request.uri)) return request;

    // Cheap pre-filter for asset traffic sharing this cache behavior.
    if (NON_HTML_EXTENSION.test(request.uri)) return request;

    // Our fetch deliberately removes Range to obtain a full injectable body.
    // Generating that full body for a range request would change semantics, so
    // let CloudFront perform the one correct origin request. The companion has
    // the same Range gate, so an origin that ignores Range still causes no API
    // lookup without adding any private coordination header to the origin.
    if (request.headers['range'] !== undefined) return request;

    // Host policy is deliberately request-only and synchronous: an excluded
    // public hostname pays no SSM lookup, connector origin fetch, cache read,
    // Enhancely call, registration, or companion cache rewrite. The target
    // helper is shared by all three Lambda entrypoints so the checked host is
    // exactly the one used in the URL sent to Enhancely.
    const target = resolvePageRequestTarget(request);
    if (target === null || !isHostIncluded(target.pageHost, getIncludeHosts())) return request;
    const { originHost, pageUrl } = target;

    // Only custom origins can be re-issued by this adapter (S3 REST origins
    // speak a different protocol and would need SigV4 signing).
    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return request;

    // Proven transport failures suppress this endpoint+vhost; ambiguous or
    // post-connect failures suppress only the exact request target. Either
    // circuit avoids a known-doomed fetch before CloudFront's fail-open retry.
    const failureKey = originFailureKey(originUrl, originHost);
    if (failureKey === null) return request;
    const requestFailureKey = originRequestFailureKey(failureKey, originUrl);
    if (
      originFailureRemainingMs(originFailureMemo, failureKey) !== null ||
      originFailureRemainingMs(originRequestFailureMemo, requestFailureKey) !== null
    ) {
      return request;
    }

    // No resolvable API key → hand the request back untouched. Unlike the
    // origin-response path there is no response to re-cache here, so a missing
    // key costs literally nothing: CloudFront proceeds as usual.
    const config = await resolveAdapterConfig();
    if (config === null) return request;

    // Already known not to be an injectable page: skip our fetch entirely, so
    // this costs exactly one CloudFront fetch and nothing else.
    const rememberedRemaining = rememberedNonPageRemainingMs(pageUrl);
    if (rememberedRemaining !== null) {
      return request;
    }

    // ORIGIN FIRST (v0.9.0 — see the module header). The trigger cannot know
    // from the request alone whether this URL is an HTML page: the extension
    // pre-filter catches assets, but an extension-less URI may just as well be
    // a redirect, a JSON endpoint or a 404. Asking Enhancely first therefore
    // spends one unnecessary API call and its latency on every such request.
    //
    // Fetching the origin first inverts that: the lookup happens only once the
    // response PROVES this is a servable, injectable HTML page, exactly like
    // the Cloudflare and sidecar adapters, which never had this problem. The
    // fetch is not extra work — CloudFront would issue the same request — it
    // just moves into this function, so the common paths still cost ONE origin
    // hit. Handing the request back after fetching is the only case that costs
    // two, and it is reserved for representations this adapter must not touch.
    //
    // From here on we own the origin fetch: CloudFront will not contact the
    // origin for this request unless we hand the request back.
    let origin: OriginFetchResult;
    try {
      origin = await fetchOriginHtml(
        originUrl,
        originHost,
        getOriginTimeoutMs(),
        MAX_ORIGIN_BODY_BYTES,
        MAX_RESPONSE_HEADER_BYTES,
        {
          // Conditional/range headers must go: a viewer holding a cached copy
          // sends If-None-Match, the origin answers 304 with no body, the gate
          // rejects it and the fetch was spent for nothing.
          ...withoutConditionalHeaders(forwardedHeaders(request.headers)),
          // Origin custom headers never appear in request.headers — CloudFront
          // adds them on its way to the origin. Without them the origin sees a
          // request CloudFront would never have made. Spread last because
          // CloudFront gives them precedence over same-named viewer headers.
          ...originCustomHeaders(request),
        }
      );
      originFailureMemo.delete(failureKey);
      originRequestFailureMemo.delete(requestFailureKey);
    } catch (error) {
      if (originFetchFailureScope(error) === 'endpoint') {
        rememberOriginFailure(originFailureMemo, failureKey);
      } else {
        rememberOriginFailure(originRequestFailureMemo, requestFailureKey);
      }
      return request;
    }

    // Over the conservative fetch cap. Handing the request back is strictly
    // better than the origin-response path's equivalent: CloudFront fetches it
    // itself and streams it with no generated-response quota at all.
    if (origin.truncated) {
      return memoizedPassThrough(request, pageUrl);
    }

    // Pair-wide invariant: an upstream connector may already have injected
    // this representation. Preserve it from the fetch we made and never ask
    // Enhancely or append a duplicate script. If it cannot be generated under
    // CloudFront quotas, hand back; the companion applies the same marker gate.
    if (origin.allHeaders[INJECTED_MARKER_HEADER] !== undefined) {
      return verbatimOriginResponse(origin, request) ?? memoizedPassThrough(request, pageUrl);
    }

    // The ONE response gate. On the origin-response trigger this same check
    // has to run twice — here there is only one representation, and it is the
    // one we return.
    //
    // Note it is shouldAttemptGeneratedResponse, not shouldAttempt: pages that
    // set a cookie or mark themselves private/no-store ARE injected here. The
    // re-fetch-fidelity argument behind that veto does not exist on this
    // trigger, and abstaining would not change what CloudFront caches — it
    // would only drop the JSON-LD. See shared.ts for the full reasoning.
    if (
      !shouldAttemptGeneratedResponse({
        method: 'GET',
        status: String(origin.status),
        contentType: origin.allHeaders['content-type'] ?? null,
        contentEncoding: origin.contentEncoding,
        cacheControl: origin.allHeaders['cache-control'] ?? null,
        contentDisposition: origin.allHeaders['content-disposition'] ?? null,
        hasSetCookie: origin.hasSetCookie,
      })
    ) {
      // A non-2xx answer we can reproduce exactly goes straight back: one
      // origin hit, and nothing to remember, because handing it back would
      // have cost the same one hit via CloudFront.
      const verbatim = verbatimOriginResponse(origin, request);
      if (verbatim !== null) return verbatim;
      // Everything else (2xx non-HTML, oversized, unreproducible) hands back
      // and IS worth remembering: that path costs a second origin fetch.
      return memoizedPassThrough(request, pageUrl);
    }

    // A page the origin marks noindex is not schema-markup territory.
    if (blocksIndexing(origin.xRobotsTag)) {
      const verbatim = verbatimOriginResponse(origin, request);
      return verbatim ?? memoizedPassThrough(request, pageUrl);
    }

    if (!isUtf8SafeHtmlBytes(origin.body, origin.contentType ?? '')) {
      const verbatim = verbatimOriginResponse(origin, request);
      return verbatim ?? memoizedPassThrough(request, pageUrl);
    }
    const originalHtml = origin.body.toString('utf8');

    // Prove there is a real structural </head> insertion point BEFORE asking
    // Enhancely. The core scanner skips raw-text elements, comments and quoted
    // attributes; using its returned offset again below prevents preflight and
    // injection from ever disagreeing.
    const injectionPoint = findHeadInjectionPoint(originalHtml);
    if (injectionPoint === null) {
      return decodedHtmlResponse(origin, originalHtml) ?? memoizedPassThrough(request, pageUrl);
    }

    // All injected-response headers are known before the JSON-LD body is. If
    // they already exceed CloudFront's independent 32 KiB cap, no snippet can
    // make this response valid — skip Enhancely and hand back with a hard veto.
    const injectedHeaders = buildResponseHeaders(origin.allHeaders, 'injected');
    injectedHeaders['content-type'] = [{ key: 'Content-Type', value: GENERATED_HTML_CONTENT_TYPE }];
    injectedHeaders[INJECTED_MARKER_HEADER] = [
      { key: 'X-Enhancely-Injected', value: INJECTED_MARKER_VALUE },
    ];
    const injectedHeaderBytes = serializedHeaderBytes(injectedHeaders, String(origin.status));
    if (injectedHeaderBytes > MAX_RESPONSE_HEADER_BYTES) {
      return decodedHtmlResponse(origin, originalHtml) ?? memoizedPassThrough(request, pageUrl);
    }

    // Likewise, if the original HTML plus even an empty script wrapper cannot
    // fit, every successful lookup is unusable. This is only a lower-bound
    // veto; the exact snippet-sized check remains after the lookup.
    const injectedBodyBudgetBytes =
      MAX_GENERATED_RESPONSE_BYTES - injectedHeaderBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
    if (
      Buffer.byteLength(originalHtml, 'utf8') + MINIMUM_INJECTED_SNIPPET_BYTES >
      injectedBodyBudgetBytes
    ) {
      return decodedHtmlResponse(origin, originalHtml) ?? memoizedPassThrough(request, pageUrl);
    }

    // ── The response has now PROVEN this is a servable, injectable HTML page.
    // Only here is an Enhancely call justified — and only here does the
    // adapter know enough to REGISTER the page, which is why autoRegister is
    // no longer forced off (v0.7.0-v0.8.0 had to, deciding before the fetch).
    //
    // A recent call already burned the full timeout: the API is not answering
    // and will not answer for THIS url either. Skip the lookup, but still
    // serve the body we already hold — handing back would make CloudFront
    // fetch the very same page a second time.
    let lookup: JsonLdLookupResult;
    if (isUpstreamDown()) {
      lookup = await lookupWhileUpstreamIsDown(pageUrl, config);
    } else {
      const startedAt = Date.now();
      lookup = config.autoRegister
        ? await getJsonLdRegisterLookup(pageUrl, cache, config)
        : await getJsonLdLookup(pageUrl, cache, config);
      // config.timeoutMs is the ENHANCELY budget (getOriginTimeoutMs is the
      // separate origin-fetch budget and would be the wrong yardstick here).
      noteUpstreamCallDuration(Date.now() - startedAt, config.timeoutMs);
    }

    // No snippet, or nothing to inject into (no </head>) → serve the origin's
    // own bytes, byte-for-byte. Generating the unmodified body instead of
    // handing the request back keeps this at ONE origin hit, and it is what
    // lets the retry cache cap below work at all: the response CloudFront
    // caches is now ours to bound.
    const injected =
      lookup.snippet === null
        ? originalHtml
        : injectIntoHead(originalHtml, lookup.snippet, injectionPoint);
    const didInject = injected !== originalHtml;

    // Validators describe the ORIGINAL bytes. They stay accurate on the
    // pass-through path and must go on the injected one.
    // The injected header candidate was built and quota-checked before the
    // lookup. Reuse it verbatim; the pass-through path retains validators.
    const headers = didInject
      ? injectedHeaders
      : buildResponseHeaders(origin.allHeaders, 'decoded');
    const originalResult = decodedHtmlResponse(origin, originalHtml);
    const fallbackToOriginal = (): CloudFrontRequest | CloudFrontResultResponse => {
      if (originalResult === null) return memoizedPassThrough(request, pageUrl);
      const retryInMs = lookup.snippet === null ? lookup.revalidateInMs : config.cacheTtlMs;
      return retryInMs === null
        ? originalResult
        : retryablePassThroughResponse(originalResult, request.headers, retryInMs, {
            assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
            capSetCookieResponses: getCapSetCookieResponses(),
          });
    };

    // CloudFront caps response headers at 32 KB independently of the 1 MB
    // quota; exceeding it is a viewer-facing 502 after Lambda has completed.
    const responseHeaderBytes = serializedHeaderBytes(headers, String(origin.status));
    if (responseHeaderBytes > MAX_RESPONSE_HEADER_BYTES) {
      return fallbackToOriginal();
    }

    // The 1 MB generated-response quota counts headers AND body together.
    const bodyBudgetBytes =
      MAX_GENERATED_RESPONSE_BYTES - responseHeaderBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
    if (Buffer.byteLength(injected, 'utf8') > bodyBudgetBytes) {
      return fallbackToOriginal();
    }

    const result: CloudFrontResultResponse = {
      status: String(origin.status),
      headers,
      body: injected,
      bodyEncoding: 'text',
    };
    if (didInject) return result;

    // Un-injected pass-through: bound how long CloudFront may keep this copy,
    // so the page flips as soon as the record exists instead of resting for
    // the behavior's DefaultTTL. This is what makes assertedDefaultTtlSeconds
    // effective on this trigger — v0.7.0/v0.8.0 could not do it here because
    // the un-injected response was CloudFront's, not ours.
    return lookup.revalidateInMs === null
      ? result
      : retryablePassThroughResponse(result, request.headers, lookup.revalidateInMs, {
          assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
          capSetCookieResponses: getCapSetCookieResponses(),
        });
  } catch (error) {
    // Fail-open: hand the request back and CloudFront proceeds exactly as if
    // this function were not associated.
    console.error(
      '[enhancely-lambda-edge:origin-request] fail-open:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return request;
  }
};
