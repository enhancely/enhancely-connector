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
  hasPerRequestCacheControl,
  headerValue,
  headerValues,
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
   * (the operator assertion documented by the Lambda adapter). Requests
   * carrying Cookie/Authorization are
   * untouched regardless, so this only ever affects the shared
   * (crawler-facing) cache variant. Default false.
   */
  capSetCookieResponses: boolean;
}

type CacheDirectiveResult =
  { state: 'absent' } | { state: 'invalid' } | { state: 'valid'; seconds: number };

interface ParsedCacheDirective {
  name: string;
  value: string | null;
}

const CACHE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** HTTP optional whitespace is SP / HTAB only — never JavaScript trim(). */
function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * Parse the Cache-Control list without treating commas inside quoted-string
 * extension values as directive separators. Any malformed/ambiguous syntax
 * invalidates the whole policy: a retry cap may become stricter, but must
 * never infer a longer origin lifetime from a fragment another cache parses
 * differently.
 */
function parseCacheControl(policy: string): ParsedCacheDirective[] | null {
  const rawDirectives: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;

  for (let index = 0; index < policy.length; index += 1) {
    const char = policy[index];
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuotes = false;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      rawDirectives.push(policy.slice(start, index));
      start = index + 1;
    }
  }
  if (inQuotes || escaped) return null;
  rawDirectives.push(policy.slice(start));

  const parsed: ParsedCacheDirective[] = [];
  for (const rawDirective of rawDirectives) {
    const directive = trimOws(rawDirective);
    // RFC list extensions permit empty elements around/between commas.
    if (directive === '') continue;

    const equalsAt = directive.indexOf('=');
    const namePart = equalsAt === -1 ? directive : directive.slice(0, equalsAt);
    const rawName = namePart;
    // cache-directive permits no OWS/BWS around "=". Accepting it here could
    // infer freshness from syntax that CloudFront legitimately ignores.
    if (!CACHE_TOKEN.test(rawName)) return null;

    if (equalsAt === -1) {
      parsed.push({ name: rawName.toLowerCase(), value: null });
      continue;
    }

    const valuePart = directive.slice(equalsAt + 1);
    const rawValue = valuePart;
    if (rawValue === '') return null;
    if (rawValue.startsWith('"')) {
      if (!rawValue.endsWith('"') || rawValue.length < 2) return null;
      const inner = rawValue.slice(1, -1);
      for (let index = 0; index < inner.length; index += 1) {
        const char = inner[index];
        const code = char?.charCodeAt(0) ?? 0;
        if (char === '"' || (code < 0x20 && char !== '\t') || code === 0x7f) return null;
        // Quoted-pair is valid HTTP syntax, but caches differ on accepting it
        // inside freshness values. Treat the whole policy as stale instead of
        // risking a more permissive interpretation than CloudFront's.
        if (char === '\\') return null;
      }
      parsed.push({ name: rawName.toLowerCase(), value: inner });
      continue;
    }

    if (!CACHE_TOKEN.test(rawValue)) return null;
    parsed.push({ name: rawName.toLowerCase(), value: rawValue });
  }
  return parsed;
}

/** Parse each wire field instance separately so malformed quotes cannot heal. */
function parseCacheControlFields(
  headers: CloudFrontHeaders
): ParsedCacheDirective[] | null | undefined {
  const entries = headers['cache-control'];
  if (entries === undefined) return undefined;

  const directives: ParsedCacheDirective[] = [];
  for (const entry of entries) {
    const parsed = parseCacheControl(entry.value);
    if (parsed === null) return null;
    directives.push(...parsed);
  }
  return directives;
}

/**
 * Parse one freshness directive without conflating absence with invalidity.
 * Duplicate or malformed values make freshness ambiguous; treating them as
 * already stale is the only choice that cannot extend an origin policy.
 */
function parseCacheDirective(
  directives: ParsedCacheDirective[] | null,
  wanted: 'max-age' | 's-maxage'
): CacheDirectiveResult {
  if (directives === null) return { state: 'invalid' };
  let matchedValue: string | null = null;

  for (const directive of directives) {
    if (directive.name !== wanted) continue;
    if (matchedValue !== null || directive.value === null) return { state: 'invalid' };
    matchedValue = directive.value;
  }

  if (matchedValue === null) return { state: 'absent' };

  if (!/^\d+$/.test(matchedValue)) return { state: 'invalid' };

  const seconds = Number(matchedValue);
  return Number.isSafeInteger(seconds) ? { state: 'valid', seconds } : { state: 'invalid' };
}

/** Numeric Cache-Control directive value, or null when absent/invalid. */
export function cacheDirectiveSeconds(
  policy: string,
  wanted: 'max-age' | 's-maxage'
): number | null {
  const parsed = parseCacheDirective(parseCacheControl(policy), wanted);
  return parsed.state === 'valid' ? parsed.seconds : null;
}

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Strict modern HTTP-date parser; invalid/obsolete forms conservatively stale. */
function strictHttpDate(value: string): number | null {
  const match = IMF_FIXDATE.exec(value);
  if (match === null) return null;

  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = MONTHS.indexOf(monthText ?? '');
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1601 || month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return date.getTime();
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
  const directives = parseCacheControlFields(headers);

  if (directives === null) return 0;
  if (directives !== undefined) {
    // no-cache is an explicit "revalidate every time" — honor it with s-maxage=0.
    if (directives.some((directive) => directive.name === 'no-cache')) {
      return 0;
    }
    // Validate BOTH freshness directives before applying the s-maxage
    // precedence. A valid s-maxage must not hide an ambiguous max-age list.
    const sharedTtl = parseCacheDirective(directives, 's-maxage');
    const browserTtl = parseCacheDirective(directives, 'max-age');
    if (sharedTtl.state === 'invalid' || browserTtl.state === 'invalid') return 0;
    if (sharedTtl.state === 'valid') {
      return Math.min(retryTtl, sharedTtl.seconds);
    }
    if (browserTtl.state === 'valid') {
      return Math.min(retryTtl, browserTtl.seconds);
    }
  }

  // No max-age/s-maxage: Expires is the only other explicit lifetime.
  const expiresEntries = headers['expires'];
  if (expiresEntries !== undefined) {
    // Expires is a singleton field. Multiple values are ambiguous and must not
    // create freshness regardless of which one a cache happens to select.
    if (expiresEntries.length !== 1) return 0;
    const expires = expiresEntries[0]?.value ?? '';
    const expiresAt = strictHttpDate(expires);
    if (expiresAt === null) {
      // RFC 9111 §5.3: an invalid Expires (the common `Expires: 0` included)
      // means ALREADY EXPIRED. Falling through to the assertion path would
      // write a fresh s-maxage onto a response the origin declared stale —
      // the one direction the cap must never move. Honor it as lifetime 0.
      return 0;
    }
    const dateEntries = headers['date'];
    let reference = Date.now();
    if (dateEntries !== undefined) {
      if (dateEntries.length !== 1) return 0;
      const responseDate = strictHttpDate(headerValue(headers, 'date') ?? '');
      if (responseDate === null) return 0;
      reference = responseDate;
    }
    return Math.min(retryTtl, Math.max(0, Math.floor((expiresAt - reference) / 1000)));
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
  // Never replace an ambiguous/malformed policy. In particular, joining two
  // individually unbalanced field instances can otherwise hide `no-store`
  // inside a healed quoted-string and manufacture shared-cache semantics.
  if (parseCacheControlFields(originalHeaders) === null) {
    return response;
  }
  if (hasPerRequestCacheControl(headerValues(originalHeaders, 'cache-control'))) {
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
