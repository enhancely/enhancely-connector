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
 * Generated-response caching follows Cache-Control semantics; Set-Cookie alone does not determine cacheability.
 *
 * Precise wording matters here: the generated response is NOT byte-identical
 * to the passed-through one (ETag, Last-Modified and Content-Length are
 * deliberately dropped, see STALE_BODY_HEADERS). It is identical in the only
 * respect that governs caching.
 *
 * ORDER OF OPERATIONS — deliberately lookup-first
 * The Enhancely lookup runs BEFORE the origin fetch, and a missing snippet
 * returns the request unmodified so CloudFront does its own normal fetch:
 *
 *   no snippet → 0 own fetches + 1 CloudFront fetch = 1  (same as today)
 *   snippet    → 1 own fetch, no CloudFront fetch   = 1  (today: 2)
 *
 * Running both concurrently would shave the lookup latency off the snippet
 * path, but it would spend a wasted origin fetch on every page WITHOUT a
 * snippet — and while a catalog is still filling up that is the large
 * majority of requests. Serial is the cheaper default; the lookup is a memory
 * cache hit in steady state anyway (and after an upstream failure the core's
 * `retryNotBefore` memo skips the call entirely).
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
 * translates CloudFront event shapes (repo rule 7). Everything it shares with
 * the origin-response entrypoint comes from ./shared.js, so the two triggers
 * cannot drift apart.
 */
import type {
  CloudFrontHeaders,
  CloudFrontRequestHandler,
  CloudFrontResultResponse,
} from 'aws-lambda';
import {
  getJsonLdLookup,
  injectIntoHead,
  matchesExcludedPath,
  MemoryCache,
} from '@enhancely/injector-core';
import { getExcludePaths, getOriginTimeoutMs, resolveAdapterConfig } from './config.js';
import { fetchOriginHtml } from './origin-fetch.js';
import {
  blocksIndexing,
  buildOriginUrl,
  buildPageUrl,
  charsetOf,
  containsOnlyAscii,
  customHeaderValue,
  declaresUtf8MetaInPrescan,
  forwardedHeaders,
  GENERATED_HTML_CONTENT_TYPE,
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  hasUtf8Bom,
  headerValue,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  originCustomHeaders,
  PAGE_HOST_HEADER,
  serializedHeaderBytes,
  shouldAttemptGeneratedResponse,
  withoutConditionalHeaders,
} from './shared.js';

/**
 * Extensions that can never be an injectable HTML document. Checked BEFORE any
 * config, lookup or fetch so asset traffic on the same cache behavior costs
 * nothing but a regex.
 *
 * This is the one structural downside of the origin-request trigger: the
 * decision to fetch has to be made from the REQUEST, before any Content-Type
 * exists. The list is therefore a cheap pre-filter, not the gate — anything it
 * lets through is still checked against the real response Content-Type below,
 * and a wrong guess costs one discarded fetch, never a wrong body.
 */
const NON_HTML_EXTENSION =
  /\.(?:js|mjs|cjs|css|map|json|xml|txt|csv|wasm|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogv|mp3|wav|flac|mov|avi|pdf|zip|gz|tgz|bz2|xz|7z|rar|apk|dmg|exe|bin)$/i;

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
export function buildResponseHeaders(allHeaders: Record<string, string[]>): CloudFrontHeaders {
  const headers: CloudFrontHeaders = {};
  for (const [name, values] of Object.entries(allHeaders)) {
    if (isDisallowedResponseHeader(name)) continue;
    if (STALE_BODY_HEADERS.includes(name)) continue;
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
 * Global "upstream is unwell" memo, in addition to the core's per-URL
 * `retryNotBefore`.
 *
 * WHY BOTH. The core's backoff lives on the cache entry, so it is keyed by
 * URL. That is right for a 404 or a per-record problem, but an API outage is
 * not per-record — it affects every URL at once. Without a wider memo, every distinct URL would pay the full timeout once per execution environment.
 *
 * So the FIRST lookup that runs into the timeout parks every other lookup in
 * this execution environment for a short window. Pages then serve at full
 * speed without JSON-LD, which is the right trade: the snippet is optional,
 * the page is not.
 *
 * Detection is by elapsed time, because the core collapses every failure into
 * "no snippet" and a 404 is indistinguishable from a timeout by return value.
 * A lookup that consumed essentially the whole budget did not get an answer.
 */
let upstreamDownUntil = 0;

/** Window to park lookups after a timeout. Short: recovery must be quick. */
const UPSTREAM_DOWN_MS = 10_000;

/** A lookup that used up (almost) the whole budget did not get an answer. */
const TIMEOUT_DETECTION_RATIO = 0.9;

/** TEST-ONLY. */
export function __resetUpstreamMemoForTests(): void {
  upstreamDownUntil = 0;
}

/**
 * Per-execution-environment JSON-LD cache. Separate from the origin-response
 * entrypoint's cache by construction — only one of the two is ever bundled
 * into a given artifact.
 */
let cache = new MemoryCache();

/** TEST-ONLY: fresh cache between tests. */
export function __resetOriginRequestStateForTests(): void {
  cache = new MemoryCache();
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

    // Only custom origins can be re-issued by this adapter (S3 REST origins
    // speak a different protocol and would need SigV4 signing).
    const originUrl = buildOriginUrl(request);
    if (originUrl === null) return request;

    // Host header CloudFront would have sent to the origin. The generated
    // fetch must present it so name-based vhosts resolve to the right site.
    const originHost =
      headerValue(request.headers, 'host') ?? request.origin?.custom?.domainName ?? '';
    if (originHost === '') return request;

    // No resolvable API key → hand the request back untouched. Unlike the
    // origin-response path there is no response to re-cache here, so a missing
    // key costs literally nothing: CloudFront proceeds as usual.
    const config = await resolveAdapterConfig();
    if (config === null) return request;

    // Public page host for the Enhancely lookup. Origins that must NOT receive
    // the viewer Host (S3 website endpoints reject foreign hosts) declare the
    // public hostname as a static origin custom header instead.
    const pageHost = customHeaderValue(request, PAGE_HOST_HEADER) ?? originHost;
    const pageUrl = buildPageUrl(pageHost, request.uri, request.querystring);

    // Lookup FIRST — see the module header. No snippet means this function
    // adds zero origin traffic and zero latency beyond a memory-cache probe.
    // autoRegister is forced OFF here. It fires on a 404 from Enhancely, and on
    // this trigger the lookup runs BEFORE the origin answers — so the adapter
    // does not yet know whether this URL is an HTML page at all. Leaving it on
    // would register redirects, JSON endpoints and 404s as pages. The
    // origin-response trigger gates on the response first and can keep it.
    // Follow-up: teach the core a "look up, register later" split so the
    // registration can happen after the gate instead of being dropped.
    // A recent lookup already burned the full timeout — the API is not
    // answering, and it will not answer for THIS url either. Skip straight to
    // pass-through so the page is not delayed a second time.
    if (Date.now() < upstreamDownUntil) return request;

    const startedAt = Date.now();
    const lookup = await getJsonLdLookup(pageUrl, cache, { ...config, autoRegister: false });
    // config.timeoutMs is the ENHANCELY budget (getOriginTimeoutMs is the
    // separate origin-fetch budget and would be the wrong yardstick here).
    if (Date.now() - startedAt >= config.timeoutMs * TIMEOUT_DETECTION_RATIO) {
      upstreamDownUntil = Date.now() + UPSTREAM_DOWN_MS;
    }
    if (lookup.snippet === null) return request;

    // From here on we own the origin fetch: CloudFront will not contact the
    // origin for this request unless we hand the request back.
    const origin = await fetchOriginHtml(
      originUrl,
      originHost,
      getOriginTimeoutMs(),
      MAX_ORIGIN_BODY_BYTES,
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

    // Over the conservative fetch cap. Handing the request back is strictly
    // better than the origin-response path's equivalent: CloudFront fetches it
    // itself and streams it with no generated-response quota at all.
    if (origin.truncated) return request;

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
        contentType: origin.contentType,
        contentEncoding: origin.contentEncoding,
        cacheControl: origin.cacheControl,
        hasSetCookie: origin.hasSetCookie,
      })
    ) {
      return request;
    }

    // A page the origin marks noindex is not schema-markup territory.
    if (blocksIndexing(origin.xRobotsTag)) return request;

    const originalHtml = origin.body.toString('utf8');
    // Charset gate, part 2: prove the utf8 decode was lossless before touching
    // the bytes — a lossy decode would put U+FFFD into a body CloudFront then
    // caches.
    if (!Buffer.from(originalHtml, 'utf8').equals(origin.body)) return request;
    const originCharset = charsetOf(origin.contentType ?? '');
    const asciiBody = containsOnlyAscii(origin.body);
    // Relabeling non-ASCII bytes as UTF-8 can change visible text even when
    // those bytes form valid UTF-8, so only genuinely ASCII source bytes are
    // safe under an `ascii`/`us-ascii` label.
    if ((originCharset === 'ascii' || originCharset === 'us-ascii') && !asciiBody) {
      return request;
    }
    // With no header charset, valid UTF-8 bytes are not proof of UTF-8 intent:
    // browsers run a context-sensitive encoding prescan and might read the same
    // bytes as windows-1252. Safe to relabel are ASCII bytes, a UTF-8 BOM, or a
    // meta tag in the prescan window that declares UTF-8 itself.
    if (
      originCharset === null &&
      !asciiBody &&
      !hasUtf8Bom(origin.body) &&
      !declaresUtf8MetaInPrescan(origin.body)
    ) {
      return request;
    }

    const injected = injectIntoHead(originalHtml, lookup.snippet);
    // Nothing injected (no </head>) → let CloudFront fetch and serve the
    // origin's own bytes rather than generating a byte-identical copy.
    if (injected === originalHtml) return request;

    const headers = buildResponseHeaders(origin.allHeaders);
    // The generated text is UTF-8 regardless of what the origin declared, so
    // Unicode in the injected JSON-LD can never be decoded under a stale label.
    headers['content-type'] = [{ key: 'Content-Type', value: GENERATED_HTML_CONTENT_TYPE }];

    // CloudFront caps response headers at 32 KB independently of the 1 MB
    // quota; exceeding it is a viewer-facing 502 after Lambda has completed.
    const responseHeaderBytes = serializedHeaderBytes(headers, String(origin.status));
    if (responseHeaderBytes > MAX_RESPONSE_HEADER_BYTES) return request;

    // The 1 MB generated-response quota counts headers AND body together.
    const bodyBudgetBytes =
      MAX_GENERATED_RESPONSE_BYTES - responseHeaderBytes - GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;
    if (Buffer.byteLength(injected, 'utf8') > bodyBudgetBytes) return request;

    const result: CloudFrontResultResponse = {
      status: String(origin.status),
      headers,
      body: injected,
      bodyEncoding: 'text',
    };
    return result;
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
