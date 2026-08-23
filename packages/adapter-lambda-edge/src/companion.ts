/**
 * Enhancely companion — CloudFront Lambda@Edge, ORIGIN-RESPONSE trigger,
 * paired with the origin-request injector on the SAME cache behavior.
 *
 * This function is deliberately cache-cap-only. It never injects, never reads
 * or fetches the body, never fetches the origin, and never calls Enhancely.
 * The body-less origin-response event cannot prove that a response has a real
 * <head>, valid UTF-8 bytes, or enough generated-response quota. Making an API
 * call from this trigger would therefore violate the connector invariant that
 * Enhancely is contacted only after the response is proven injectable.
 *
 * The companion only shortens the cache lifetime of a safely eligible
 * pass-through response so CloudFront eventually gives the origin-request
 * injector another opportunity. The retry bound matches the injector's
 * hard-handback memo. All cache rewrites remain subject to the conservative
 * credential, response-cache and operator-assertion gates in cache-cap.ts.
 *
 * AWS guarantees that an origin-request GENERATED response does not run the
 * origin-response trigger, and cached responses run neither function. The
 * companion therefore sees only CloudFront's normal handback path.
 *
 * Fail-open: any error returns the received response byte-for-byte. A crash in
 * an origin-response function is a viewer-facing 502, so the whole handler is
 * contained in one try/catch.
 */
import type { CloudFrontResponseEvent, CloudFrontResponseResult } from 'aws-lambda';

import { isHostIncluded, matchesExcludedPath } from '@enhancely/injector-core';

import {
  blocksIndexing,
  buildOriginUrl,
  combinedHeaderValue,
  headerValues,
  INJECTED_MARKER_HEADER,
  NON_HTML_EXTENSION,
  resolvePageRequestTarget,
  shouldAttemptGeneratedResponse,
} from './shared.js';
import type { AttemptInput } from './shared.js';
import { retryablePassThroughResponse } from './cache-cap.js';
import type { CapOptions } from './cache-cap.js';
import {
  getAssertedDefaultTtlSeconds,
  getCapSetCookieResponses,
  getConfigRetryInMs,
  getExcludePaths,
  getIncludeHosts,
  getNonPageMemoTtlMs,
  resolveAdapterConfig,
} from './config.js';

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
  const record = event.Records[0];
  if (!record) return undefined;
  const { request, response } = record.cf;

  try {
    // Never touch a response that already claims to be injected. In a correct
    // pairing this marker cannot reach the companion because GENERATED skips
    // origin-response; an echoed marker or changed platform behavior should
    // still fail closed for mutation and fail open for delivery.
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

    // Request gates must match the injector. In particular, an asset-shaped
    // URI or Range handback is permanently outside the injection path and
    // must not be put on an artificial retry cadence.
    if (matchesExcludedPath(getExcludePaths(), request.uri)) return response;
    if (NON_HTML_EXTENSION.test(request.uri)) return response;
    if (request.headers['range'] !== undefined) return response;

    // A host excluded from the injector must also retain CloudFront's native
    // cache semantics. This check precedes config/SSM and every cache cap.
    const target = resolvePageRequestTarget(request);
    if (target === null || !isHostIncluded(target.pageHost, getIncludeHosts())) return response;

    // Header-only eligibility is sufficient for a conservative cache cap, but
    // explicitly NOT sufficient for an Enhancely call. Content-Encoding is
    // ignored here because the companion never reads or changes the body.
    const input: AttemptInput = {
      method: request.method,
      status: response.status,
      contentType: headerValues(response.headers, 'content-type'),
      contentEncoding: null,
      cacheControl: headerValues(response.headers, 'cache-control'),
      contentDisposition: headerValues(response.headers, 'content-disposition'),
      hasSetCookie: response.headers['set-cookie'] !== undefined,
    };
    if (!shouldAttemptGeneratedResponse(input)) return response;
    if (blocksIndexing(combinedHeaderValue(response.headers, 'x-robots-tag'))) return response;

    // Only a syntactically safe Custom Origin can become injectable on a later
    // origin-request attempt. S3 REST and path-escape cases stay on
    // CloudFront's native cache semantics. Header-only origin-response events
    // cannot prove network reachability, so operators must keep the pair off
    // private/sign-protected origins it cannot fetch directly.
    if (buildOriginUrl(request) === null) return response;

    // Config resolution is the only I/O this function may perform. It proves
    // that the connector is enabled and loads the operator's cap assertions;
    // neither the core client nor an Enhancely URL is reachable from here.
    const config = await resolveAdapterConfig();
    if (config === null) {
      const retryInMs = getConfigRetryInMs();
      return retryInMs === null
        ? response
        : retryablePassThroughResponse(response, request.headers, retryInMs, capOptions());
    }

    return retryablePassThroughResponse(
      response,
      request.headers,
      getNonPageMemoTtlMs(),
      capOptions()
    );
  } catch (error) {
    console.error(
      '[enhancely-lambda-edge:companion] fail-open:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return response;
  }
};
