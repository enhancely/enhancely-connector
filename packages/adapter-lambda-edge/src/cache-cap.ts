/**
 * Retry cache-lifetime capping for UN-injected pass-through responses.
 *
 * Shared by the origin-response injector (`index.ts`) and the companion
 * entrypoint (`companion.ts`) — repo rule 5: neither trigger may duplicate the
 * other's gates. Pure functions: all configuration (the operator assertions)
 * is threaded in as parameters, so this module holds no state and reads no
 * config, matching `shared.ts`'s charter.
 *
 * The invariant every branch enforces: the written TTL can only SHORTEN
 * effective shared cacheability, never extend it, and a response whose origin
 * declared per-request semantics (`private`/`no-store`) is never rewritten.
 */
import type { CloudFrontHeaders, CloudFrontResultResponse } from 'aws-lambda';

import {
  MAX_RESPONSE_HEADER_BYTES,
  cacheControlValue,
  hasPerRequestCacheControl,
  headerValue,
  serializedHeaderBytes,
} from './shared.js';

/** Operator assertions consumed by the cap (both from the baked config). */
export interface CapOptions {
  /**
   * "Every associated cache behavior's DefaultTTL is at least this many
   * seconds" — enables capping lifetime-less responses. 0 = off.
   */
  assertedDefaultTtlSeconds: number;
  /**
   * "Set-Cookie on responses to credential-less requests is load-balancer
   * plumbing, not session material" — enables capping Set-Cookie responses
   * (companion design §3.3). Requests carrying Cookie/Authorization are
   * untouched regardless, so this only ever affects the shared
   * (crawler-facing) cache variant. Default false.
   */
  capSetCookieResponses: boolean;
}

/** Numeric Cache-Control directive value, or null when absent/invalid. */
export function cacheDirectiveSeconds(
  policy: string,
  wanted: 'max-age' | 's-maxage'
): number | null {
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
 * `assertedDefaultTtlSeconds` is the operator's way OUT of that blindness:
 * the baked config asserts that every associated cache behavior's DefaultTTL
 * is AT LEAST that many seconds for this content, i.e. a lifetime-less
 * pass-through is ALREADY shared-cached for at least that long. The written
 * TTL is `min(retryTtl, asserted)`, so the write can only SHORTEN effective
 * cacheability — the invariant is enforced arithmetically rather than
 * trusted (an assertion of "nonzero" alone would let retryTtl EXTEND a
 * DefaultTTL of one second). Without the assertion a single lookup timeout
 * pins an uninjected response in CloudFront for the full DefaultTTL (a day
 * on the common default) instead of the seconds the retry logic intends.
 * Note: applying the cap REPLACES the whole Cache-Control value, so
 * non-freshness directives on a lifetime-less response (`no-transform`,
 * `stale-while-revalidate`) are dropped for the capped copy — bounded by the
 * short TTL, and only under the assertion.
 */
export function retrySharedTtlSeconds(
  headers: CloudFrontHeaders,
  revalidateInMs: number,
  assertedDefaultTtlSeconds: number
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
    if (Number.isNaN(expiresAt)) {
      // RFC 9111 §5.3: an invalid Expires (the common `Expires: 0` included)
      // means ALREADY EXPIRED. Falling through to the assertion path would
      // write a fresh s-maxage onto a response the origin declared stale —
      // the one direction the cap must never move. Honor it as lifetime 0.
      return 0;
    }
    const responseDate = Date.parse(headerValue(headers, 'date') ?? '');
    const reference = Number.isNaN(responseDate) ? Date.now() : responseDate;
    return Math.min(retryTtl, Math.max(0, Math.ceil((expiresAt - reference) / 1000)));
  }

  // Origin declared no explicit lifetime. Without the operator assertion, do
  // not introduce shared caching; with it, the response is already cached
  // for at least the asserted DefaultTTL, and min() guarantees the written
  // value never exceeds what the operator vouched for.
  return assertedDefaultTtlSeconds > 0
    ? Math.min(retryTtl, Math.floor(assertedDefaultTtlSeconds))
    : null;
}

/**
 * Keep a retryable pass-through response in CloudFront only until the core or
 * config resolver will try again. Validators for the untouched origin body
 * are removed deliberately: after this short TTL CloudFront must obtain a full
 * origin response, so the injecting entrypoint runs again (origin-response
 * re-fetches with the viewer's conditional headers stripped; origin-request
 * strips them from its own fetch too — either way a revalidation yields a full
 * 200 to inject into, never a 304 that re-pins the old uninjected body).
 *
 * Never add cacheability to a request carrying credentials/personalization.
 * In particular, s-maxage/public/must-revalidate override the normal shared
 * cache restriction on Authorization responses (RFC 9111 §3.5).
 *
 * Response-side vetoes (load-bearing for the companion, redundant behind the
 * origin-response injector's shouldAttempt gate):
 * - `private`/`no-store` → NEVER rewritten: replacing them with an s-maxage
 *   would grant shared cacheability the origin explicitly forbade.
 * - `Set-Cookie` → rewritten only under the operator's
 *   `capSetCookieResponses` assertion (and, via the request check above,
 *   only for credential-less requests). Without it, an s-maxage would
 *   license downstream shared caches to replay the cookie across users.
 */
export function retryablePassThroughResponse(
  response: CloudFrontResultResponse,
  requestHeaders: CloudFrontHeaders,
  revalidateInMs: number,
  opts: CapOptions
): CloudFrontResultResponse {
  if (requestHeaders['authorization'] !== undefined || requestHeaders['cookie'] !== undefined) {
    return response;
  }

  const originalHeaders = response.headers ?? {};
  if (hasPerRequestCacheControl(cacheControlValue(originalHeaders))) {
    return response;
  }
  if (originalHeaders['set-cookie'] !== undefined && !opts.capSetCookieResponses) {
    return response;
  }

  const sharedTtlSeconds = retrySharedTtlSeconds(
    originalHeaders,
    revalidateInMs,
    opts.assertedDefaultTtlSeconds
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
