/**
 * Enhancely companion — CloudFront Lambda@Edge, ORIGIN-RESPONSE trigger,
 * paired with the origin-request injector on the SAME cache behavior.
 *
 * It never injects, never fetches the origin, never touches the body. Two
 * jobs, both impossible on the origin-request trigger (design doc
 * `docs/architecture/2026-08-21-companion-trigger-design.md`):
 *
 *  (a) REGISTER real, servable HTML pages unknown to Enhancely — via ONE
 *      register-or-revalidate POST (`getJsonLdRegisterLookup`): unknown URLs
 *      are enrolled, known ones revalidated (412) or fetched (200) in the
 *      same round-trip, and a fetched snippet is cached so the NEXT miss gets
 *      injected. The origin-request trigger cannot do this because its lookup
 *      runs before any response exists (it would enroll redirects and 404s).
 *  (b) CAP the cache lifetime of UN-injected pass-through responses
 *      (`retryablePassThroughResponse`), restoring `assertedDefaultTtlSeconds`
 *      semantics — the origin-request trigger hands the request back on a
 *      miss and never sees the response CloudFront caches.
 *
 * WHY THIS PAIRING IS SAFE (the load-bearing AWS facts, both documented):
 * when the origin-request function GENERATES a response, the origin-response
 * trigger does NOT fire; and cached responses invoke neither function. The
 * companion therefore only ever sees uninjected pass-through traffic — no
 * "was this already injected?" detection is needed. The X-Enhancely-Injected
 * check below is a pure never-touch-injected-content invariant (origins
 * echoing the header, hypothetical AWS semantic changes) — nothing depends
 * on it, and it cannot detect a mis-paired origin-response injector.
 *
 * Fail-open (repo rule 3), sharpened for this trigger: any error → return the
 * received response byte-for-byte. A crash in an origin-response function is
 * a viewer-facing 502, so the entire handler body sits in one try/catch.
 */
import type { CloudFrontResponseEvent, CloudFrontResponseResult } from 'aws-lambda';

import {
  MemoryCache,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  matchesExcludedPath,
} from '@enhancely/injector-core';

import {
  blocksIndexing,
  buildOriginUrl,
  buildPageUrl,
  cacheControlValue,
  combinedHeaderValue,
  customHeaderValue,
  headerValue,
  INJECTED_MARKER_HEADER,
  PAGE_HOST_HEADER,
  shouldRegisterRepresentation,
} from './shared.js';
import type { AttemptInput } from './shared.js';
import { retryablePassThroughResponse } from './cache-cap.js';
import type { CapOptions } from './cache-cap.js';
import {
  getAssertedDefaultTtlSeconds,
  getCapSetCookieResponses,
  getConfigRetryInMs,
  getExcludePaths,
  resolveAdapterConfig,
} from './config.js';
import {
  isUpstreamDown,
  noteUpstreamCallDuration,
  upstreamDownRemainingMs,
  __resetUpstreamMemoForTests,
} from './upstream-memo.js';

// Re-exported so tests keep one import path per entrypoint.
export { __resetUpstreamMemoForTests };

/**
 * Per-execution-environment JSON-LD cache. A third fleet with its own memory
 * by construction: Lambda@Edge functions cannot share runtime state, so this
 * cache is disjoint from the origin-request injector's — the skew between the
 * two is why the "snippet ready but response uninjected" cap below exists.
 */
let cache = new MemoryCache();

/** TEST-ONLY: fresh cache between tests. */
export function __resetCompanionStateForTests(): void {
  cache = new MemoryCache();
}

/** Both operator assertions, resolved after resolveAdapterConfig() settled. */
function capOptions(): CapOptions {
  return {
    assertedDefaultTtlSeconds: getAssertedDefaultTtlSeconds(),
    capSetCookieResponses: getCapSetCookieResponses(),
  };
}

export const handler = async (
  event: CloudFrontResponseEvent
): Promise<CloudFrontResponseResult | undefined> => {
  // A malformed event without a record leaves nothing to return; undefined
  // lets CloudFront proceed with the response unmodified. (Everything AFTER
  // this destructuring runs inside the fail-open try/catch below.)
  const record = event.Records[0];
  if (!record) return undefined;
  const { request, response } = record.cf;
  try {
    // Invariant, not detection: never touch a response that already claims
    // to be injected, whoever produced it. Per AWS docs a response GENERATED
    // by the origin-request injector cannot reach this trigger at all, so in
    // a correct deployment this never fires; if it does, either the origin
    // itself echoes the header (harmless to skip — but investigate why) or
    // AWS trigger semantics changed under us (then skipping is exactly the
    // safe behavior). It does NOT detect a mis-paired origin-response
    // injector — that one never stamps the marker.
    if (response.headers[INJECTED_MARKER_HEADER] !== undefined) {
      console.error(
        '[enhancely-lambda-edge:companion] X-Enhancely-Injected present on an ' +
          'origin-response event — leaving the response untouched. In a correct ' +
          'deployment this header never reaches this trigger; check whether the ' +
          'origin echoes it or the trigger wiring changed.'
      );
      return response;
    }

    if (request.method !== 'GET') return response;

    // Operator exclusions: no lookup, no registration, no cache rewriting —
    // checked before any config/SSM work (existing contract).
    if (matchesExcludedPath(getExcludePaths(), request.uri)) return response;

    // Register gate: real, servable, indexable HTML only. Content-Encoding is
    // deliberately not consulted — the CloudFront copy is usually gzip/br and
    // the companion reads no body. Per-request state (Set-Cookie / private /
    // no-store) does NOT veto here: the paired injector injects those pages,
    // so refusing to register them would starve it (§3.2). The cap applies
    // its own stricter vetoes inside retryablePassThroughResponse.
    const input: AttemptInput = {
      method: request.method,
      status: response.status,
      contentType: headerValue(response.headers, 'content-type'),
      contentEncoding: null,
      cacheControl: cacheControlValue(response.headers),
      hasSetCookie: response.headers['set-cookie'] !== undefined,
    };
    if (!shouldRegisterRepresentation(input)) return response;

    // Never register or re-poll pages the operator hides from indexing.
    if (blocksIndexing(combinedHeaderValue(response.headers, 'x-robots-tag'))) return response;

    // Same origin discipline as the fetching entrypoints, kept purely for its
    // vetoes (custom origin present, no dot-segment/host escape) — the URL
    // string itself goes unused: the companion never fetches the origin.
    if (buildOriginUrl(request) === null) return response;

    const originHost =
      headerValue(request.headers, 'host') ?? request.origin?.custom?.domainName ?? '';
    if (originHost === '') return response;

    // No resolvable API key → pass through, with a bounded cache retry so the
    // key-less window cannot pin uninjected copies for the full DefaultTTL.
    const config = await resolveAdapterConfig();
    if (config === null) {
      const retryInMs = getConfigRetryInMs();
      return retryInMs === null
        ? response
        : retryablePassThroughResponse(response, request.headers, retryInMs, capOptions());
    }

    const pageHost = customHeaderValue(request, PAGE_HOST_HEADER) ?? originHost;
    const pageUrl = buildPageUrl(pageHost, request.uri, request.querystring);

    // Outage memo open: skip the upstream call entirely, but still cap with
    // the remaining window — an outage must not pin uninjected copies either.
    if (isUpstreamDown()) {
      return retryablePassThroughResponse(
        response,
        request.headers,
        Math.max(1, upstreamDownRemainingMs()),
        capOptions()
      );
    }

    // autoRegister on → the single register-or-revalidate POST (registration
    // IS the call). Off → plain conditional GET: a cap-only companion.
    const startedAt = Date.now();
    const lookup = config.autoRegister
      ? await getJsonLdRegisterLookup(pageUrl, cache, config)
      : await getJsonLdLookup(pageUrl, cache, { ...config, autoRegister: false });
    noteUpstreamCallDuration(Date.now() - startedAt, config.timeoutMs);

    if (lookup.snippet !== null) {
      // The record is READY but this response passed through uninjected: the
      // origin-request fleet's own negative entry is still fresh (its cache
      // is disjoint from ours, so the two expire de-aligned). Without a cap
      // this one miss would pin the uninjected copy for the full DefaultTTL;
      // cap at the cacheTtl-scale bound so the next CloudFront miss reaches
      // the injector while the record is known-ready. Accepted tradeoff: a
      // page that is PERMANENTLY uninjectable on the origin-request side (no
      // </head>, oversize) now refreshes every ~cacheTtl instead of resting
      // at DefaultTTL — move such pages to excludePaths when discovered.
      return retryablePassThroughResponse(
        response,
        request.headers,
        config.cacheTtlMs,
        capOptions()
      );
    }
    if (lookup.revalidateInMs !== null) {
      return retryablePassThroughResponse(
        response,
        request.headers,
        lookup.revalidateInMs,
        capOptions()
      );
    }
    return response;
  } catch (error) {
    // Fail-open: the received response, byte-for-byte.
    console.error(
      '[enhancely-lambda-edge:companion] fail-open:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return response;
  }
};
