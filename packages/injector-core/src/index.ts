/**
 * @enhancely/injector-core — public API.
 *
 * Orchestrates: normalize → cache lookup → conditional fetch (ETag) → inject.
 * Every failure mode collapses into "serve the original HTML" (fail-open);
 * neither getJsonLdSnippet nor handleHtml ever throws.
 */

export type {
  Fetcher,
  InjectorConfig,
  InjectorConfigInput,
  CacheEntry,
  CacheBackend,
  JsonLdLookupResult,
  JsonLdFetchResult,
  HtmlContext,
} from './types.js';
export {
  defineConfig,
  DEFAULT_ENHANCELY_BASE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_JSONLD_BYTES,
} from './config.js';
export { normalizeForEnhancely, normalizeLite } from './normalize.js';
export { MemoryCache, isFresh } from './cache.js';
export { fetchJsonLd, registerJsonLd, registerOrRevalidate, parseRetryAfter } from './client.js';
export { buildScriptTag, findHeadInjectionPoint, injectIntoHead } from './inject.js';
export {
  charsetOf,
  containsOnlyAscii,
  declaresUtf8MetaInPrescan,
  hasUtf8Bom,
  isUtf8SafeHtmlBytes,
  isValidUtf8,
} from './encoding.js';
export { matchesExcludedPath } from './exclude.js';
export { blocksIndexing } from './robots.js';
export { isAttachmentDisposition } from './representation.js';
export { __resetRateLimitCircuitForTests } from './rate-limit-circuit.js';

import type {
  CacheBackend,
  CacheEntry,
  HtmlContext,
  InjectorConfig,
  JsonLdFetchResult,
  JsonLdLookupResult,
} from './types.js';
import { normalizeForEnhancely } from './normalize.js';
import { isFresh } from './cache.js';
import { fetchJsonLd, registerOrRevalidate } from './client.js';
import { buildScriptTag, findHeadInjectionPoint, injectIntoHead } from './inject.js';
import { getRateLimitDeadline, recordRateLimitDeadline } from './rate-limit-circuit.js';

/** Positive entry → script tag, negative entry (404 memo) → null. */
function snippetFromEntry(entry: CacheEntry): string | null {
  return entry.jsonldRaw !== null ? buildScriptTag(entry.jsonldRaw, entry.etag) : null;
}

/**
 * Turn a cache entry into the adapter-facing lookup result.
 *
 * A negative entry becomes meaningful again at the later of its normal TTL
 * (for a stored 404) and any temporary upstream backoff. Clamp to one
 * millisecond so adapters never accidentally emit a zero-second downstream
 * TTL because the clock advanced between lookup and header construction.
 */
function lookupFromEntry(
  entry: CacheEntry,
  cacheTtlMs: number,
  now: number = Date.now()
): JsonLdLookupResult {
  if (entry.jsonldRaw !== null) {
    return { snippet: snippetFromEntry(entry), revalidateInMs: null };
  }

  const cacheExpiry = entry.storedAt > 0 ? entry.storedAt + cacheTtlMs : 0;
  const nextLookupAt = Math.max(cacheExpiry, entry.retryNotBefore ?? 0);
  return {
    snippet: null,
    revalidateInMs: Math.max(1, nextLookupAt - now),
  };
}

/**
 * True only for the EXACT `text/html` media type (parameters stripped).
 * A prefix check would wrongly match e.g. `text/htmlx` (repo rule 5).
 * Shared with the adapters so the gate logic has one source of truth.
 */
export function isHtmlMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
}

/** Backoff after an upstream error/timeout (or a 429 without Retry-After). */
const DEFAULT_RETRY_BACKOFF_MS = 10_000;
/** Upper bound for honoring 429 Retry-After (keeps memos short-lived). */
const MAX_RETRY_BACKOFF_MS = 60_000;
/**
 * Upper bound for honoring Retry-After on the register-or-revalidate path.
 * Durable server states (plan hard cap 403, monthly limit 429) send day-scale
 * values; honoring them only up to 60 s would re-POST every URL every TTL for
 * the rest of a billing cycle. Still bounded so a bogus header cannot park a
 * URL forever.
 */
const MAX_REGISTER_BACKOFF_MS = 86_400_000;

type LookupFlightMode = 'conditional-get' | 'register-or-revalidate';

/**
 * One in-flight lookup per cache instance, normalized URL and lookup mode.
 * A WeakMap avoids retaining adapter-owned cache instances after an execution
 * environment is discarded; each inner entry is removed in `finally`.
 */
const lookupFlights = new WeakMap<CacheBackend, Map<string, Promise<JsonLdLookupResult>>>();

/**
 * Per-cache/key write serialization for the two deliberately separate lookup
 * modes. CacheBackend has no compare-and-set primitive, so a get-then-set
 * snapshot guard is only atomic when the complete decision runs under this
 * local lock. The same guarantee across processes/isolates requires an atomic
 * compare-and-set operation from the distributed backend; Workers KV does not
 * provide one. This lock closes every in-execution-environment race.
 */
const cacheWriteLocks = new WeakMap<CacheBackend, Map<string, Promise<void>>>();

async function withCacheWriteLock<T>(
  cache: CacheBackend,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  let locks = cacheWriteLocks.get(cache);
  if (locks === undefined) {
    locks = new Map();
    cacheWriteLocks.set(cache, locks);
  }

  const previous = locks.get(key) ?? Promise.resolve();
  const state: { release?: () => void } = {};
  const current = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  locks.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    state.release?.();
    if (locks.get(key) === current) {
      locks.delete(key);
      if (locks.size === 0) cacheWriteLocks.delete(cache);
    }
  }
}

function runLookupSingleFlight(
  cache: CacheBackend,
  flightKey: string,
  operation: () => Promise<JsonLdLookupResult>
): Promise<JsonLdLookupResult> {
  let flights = lookupFlights.get(cache);
  if (flights === undefined) {
    flights = new Map();
    lookupFlights.set(cache, flights);
  }

  const existing = flights.get(flightKey);
  if (existing !== undefined) return existing;

  const pending = operation().finally(() => {
    if (flights?.get(flightKey) === pending) {
      flights.delete(flightKey);
      if (flights.size === 0) lookupFlights.delete(cache);
    }
  });
  flights.set(flightKey, pending);
  return pending;
}

/** The fields that identify the cache snapshot read before an upstream call. */
function sameCacheEntry(left: CacheEntry | undefined, right: CacheEntry | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.jsonldRaw === right.jsonldRaw &&
    left.etag === right.etag &&
    left.storedAt === right.storedAt &&
    left.registrationPending === right.registrationPending &&
    left.retryNotBefore === right.retryNotBefore
  );
}

/**
 * Store a result only if no other lookup advanced this key in the meantime.
 * There is no atomic CAS in CacheBackend, but this closes the important local
 * GET-vs-register race; same-mode calls are already coalesced above.
 */
async function storeIfSnapshotUnchanged(
  cache: CacheBackend,
  key: string,
  snapshot: CacheEntry | undefined,
  entry: CacheEntry,
  preferPositive: boolean = false
): Promise<CacheEntry> {
  return withCacheWriteLock(cache, key, async () => {
    const current = await cache.get(key);
    if (
      current !== undefined &&
      !sameCacheEntry(current, snapshot) &&
      !(preferPositive && entry.jsonldRaw !== null && current.jsonldRaw === null)
    ) {
      return current;
    }
    await cache.set(key, entry);
    return entry;
  });
}

/** A usable fresh/backoff entry can answer without joining an upstream flight. */
function localLookup(
  cached: CacheEntry | undefined,
  cacheTtlMs: number
): JsonLdLookupResult | null {
  if (cached && isFresh(cached, cacheTtlMs)) return lookupFromEntry(cached, cacheTtlMs);
  if (cached?.retryNotBefore !== undefined && Date.now() < cached.retryNotBefore) {
    return lookupFromEntry(cached, cacheTtlMs);
  }
  return null;
}

/** Serve cache/miss state locally while an API-key-wide circuit is open. */
function lookupDuringRateLimit(
  cached: CacheEntry | undefined,
  cacheTtlMs: number,
  retryNotBefore: number,
  now: number = Date.now()
): JsonLdLookupResult {
  const entry: CacheEntry = cached
    ? {
        ...cached,
        retryNotBefore: Math.max(cached.retryNotBefore ?? 0, retryNotBefore),
      }
    : {
        jsonldRaw: null,
        etag: null,
        storedAt: 0,
        retryNotBefore,
      };
  return lookupFromEntry(entry, cacheTtlMs, now);
}

/**
 * Resolve the ready-to-inject `<script type="application/ld+json">…</script>`
 * snippet for a page URL plus an optional retryable-miss revalidation delay
 * for adapters that manage a downstream page cache.
 *
 * - Fresh cache entry → answered locally (positive → snippet, negative → null).
 * - Entry carrying a retry backoff memo (previous 429/error) that has not
 *   elapsed → answered locally too, so page views never hammer a rate-limited
 *   or down API (nor pay the fetch timeout each time).
 * - Concurrent requests for the same cache, normalized URL and lookup mode
 *   share one in-flight operation.
 * - A rate limit opens an execution-environment-local circuit for the same
 *   Enhancely base/API-key/fetch scope. Other stale or missing URLs then
 *   answer locally until the already-capped retry deadline; GET and register
 *   POST share that scope.
 * - Stale/missing → one upstream call (`call`: conditional GET for the lookup
 *   path, register-or-revalidate POST for the discovery path; both send
 *   If-None-Match when we hold an ETag):
 *   - 200 → store + inject
 *   - 304/412 → refresh the stored entry's storedAt, serve from cache
 *   - 404 → store a NEGATIVE entry (stops dead-URL polling), inject nothing;
 *     the lookup path additionally fires ONE registration when autoRegister
 *   - 202 pending → negative entry re-polling at the server's Retry-After
 *     (capped at cacheTtlMs), or resting a full TTL without a hint
 *   - terminal-negative (ignored / empty record / rejected) → negative entry
 *     for a full TTL, never re-registered
 *   - 429/403/error/timeout → serve the stale entry as-is if we have one
 *     (without touching storedAt) and record a retryNotBefore memo:
 *     min(Retry-After, maxBackoffMs) when sent, 10 s otherwise. Rate-limited
 *     results also open the API-key-wide circuit; plain errors remain URL-local.
 *
 * The API request carries the strictly validated, query-stripped URL
 * (`normalizeLite` semantics, = the cache key), never a locally computed hash.
 * Invalid, relative, non-HTTP(S), credential-bearing, and normalization-unstable
 * URLs fail locally before cache access or network I/O.
 *
 * Never throws.
 */
async function resolveLookup(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig,
  call: (key: string, etag: string | null | undefined) => Promise<JsonLdFetchResult>,
  opts: {
    registerOnNotFound: boolean;
    maxBackoffMs: number;
    flightMode: LookupFlightMode;
  }
): Promise<JsonLdLookupResult> {
  try {
    const key = normalizeForEnhancely(url);
    // Invalid/relative/non-HTTP(S)/credential-bearing/normalization-unstable
    // input fails locally. In
    // particular, never fall back to sending the raw value: it may carry query
    // tokens or PII that URL normalization could not remove safely.
    if (key === null) return { snippet: null, revalidateInMs: null };

    const autoRegisterSuffix =
      opts.registerOnNotFound && config.autoRegister ? ':auto-register' : ':lookup-only';
    const flightKey = `${opts.flightMode}${autoRegisterSuffix}:${key}`;

    return await runLookupSingleFlight(cache, flightKey, async () => {
      const cached = await cache.get(key);
      const rateLimitDeadline = getRateLimitDeadline(config);
      if (rateLimitDeadline !== null) {
        return lookupDuringRateLimit(cached, config.cacheTtlMs, rateLimitDeadline);
      }
      const local = localLookup(cached, config.cacheTtlMs);
      if (local !== null) return local;

      // Send the query-stripped URL (= the cache key), NOT the raw request URL.
      // The strict normalization boundary above guarantees that malformed URL
      // input can never fall through with a query string still attached.
      const result = await call(key, cached?.etag);

      switch (result.status) {
        case 'ok': {
          const entry = await storeIfSnapshotUnchanged(
            cache,
            key,
            cached,
            {
              jsonldRaw: result.jsonldRaw,
              etag: result.etag,
              storedAt: Date.now(),
            },
            true
          );
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case 'not-modified': {
          // 304 (GET) or 412 (register POST) without a cached entry should be
          // impossible (we only send If-None-Match when we hold one) — treat it
          // like an error: nothing to serve, nothing to store. Rebuilding the
          // entry (instead of spreading) drops any leftover retryNotBefore memo.
          if (!cached) return { snippet: null, revalidateInMs: null };
          const refreshed = await storeIfSnapshotUnchanged(cache, key, cached, {
            jsonldRaw: cached.jsonldRaw,
            etag: cached.etag,
            storedAt: Date.now(),
            ...(cached.registrationPending === true && { registrationPending: true }),
          });
          return lookupFromEntry(refreshed, config.cacheTtlMs);
        }
        case 'pending': {
          // The record exists but generation has produced no content yet. The
          // server explicitly told us there is no current snippet, so any stale
          // positive we hold describes a dead record incarnation — drop it.
          // With a Retry-After hint the entry re-polls exactly then (storedAt 0
          // keeps it permanently stale so only retryNotBefore gates the next
          // call); without one it rests for a full TTL.
          const candidate: CacheEntry =
            result.retryAfterSeconds !== null
              ? {
                  jsonldRaw: null,
                  etag: null,
                  storedAt: 0,
                  retryNotBefore:
                    Date.now() +
                    Math.min(Math.max(result.retryAfterSeconds, 1) * 1000, config.cacheTtlMs),
                }
              : { jsonldRaw: null, etag: null, storedAt: Date.now() };
          const entry = await storeIfSnapshotUnchanged(cache, key, cached, candidate);
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case 'terminal-negative': {
          // Ignored record, never-succeeded generation, or rejected
          // registration. The server knows the URL — re-registering it would be
          // pure load, so unlike `not-found` this NEVER triggers autoRegister.
          const entry = await storeIfSnapshotUnchanged(cache, key, cached, {
            jsonldRaw: null,
            etag: null,
            storedAt: Date.now(),
          });
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case 'not-found': {
          // Keep the explicit conditional-GET API backwards-compatible: it can
          // still register after a 404. Higher-level auto-register callers use
          // getJsonLdRegisterLookup directly and therefore need only one POST.
          if (opts.registerOnNotFound && config.autoRegister) {
            const registration = await registerOrRevalidate(config, key);
            if (registration.status === 'ok') {
              const entry = await storeIfSnapshotUnchanged(
                cache,
                key,
                cached,
                {
                  jsonldRaw: registration.jsonldRaw,
                  etag: registration.etag,
                  storedAt: Date.now(),
                },
                true
              );
              return lookupFromEntry(entry, config.cacheTtlMs);
            }

            if (registration.status === 'pending') {
              const entry = await storeIfSnapshotUnchanged(
                cache,
                key,
                cached,
                registration.retryAfterSeconds !== null
                  ? {
                      jsonldRaw: null,
                      etag: null,
                      storedAt: 0,
                      registrationPending: true,
                      retryNotBefore:
                        Date.now() +
                        Math.min(
                          Math.max(registration.retryAfterSeconds, 1) * 1000,
                          config.cacheTtlMs
                        ),
                    }
                  : {
                      jsonldRaw: null,
                      etag: null,
                      storedAt: Date.now(),
                      registrationPending: true,
                    }
              );
              return lookupFromEntry(entry, config.cacheTtlMs);
            }

            if (registration.status === 'terminal-negative') {
              const entry = await storeIfSnapshotUnchanged(cache, key, cached, {
                jsonldRaw: null,
                etag: null,
                storedAt: Date.now(),
              });
              return lookupFromEntry(entry, config.cacheTtlMs);
            }

            // The compatibility POST is still an Enhancely call: retain its
            // Retry-After and open the shared org circuit exactly like the
            // one-call register path. Treat the impossible hint-less 412 as a
            // short transient error rather than caching the GET 404 for a full
            // TTL and silently discarding the registration outcome.
            if (
              registration.status === 'rate-limited' ||
              registration.status === 'error' ||
              registration.status === 'not-modified'
            ) {
              const backoffMs =
                registration.status === 'rate-limited' && registration.retryAfterSeconds !== null
                  ? Math.min(
                      Math.max(registration.retryAfterSeconds, 1) * 1000,
                      MAX_REGISTER_BACKOFF_MS
                    )
                  : DEFAULT_RETRY_BACKOFF_MS;
              const retryNotBefore = Date.now() + backoffMs;
              if (registration.status === 'rate-limited') {
                recordRateLimitDeadline(config, retryNotBefore);
              }
              const entry = await storeIfSnapshotUnchanged(cache, key, cached, {
                jsonldRaw: null,
                etag: null,
                storedAt: 0,
                retryNotBefore,
              });
              return lookupFromEntry(entry, config.cacheTtlMs);
            }
          }
          const entry = await storeIfSnapshotUnchanged(cache, key, cached, {
            jsonldRaw: null,
            etag: null,
            storedAt: Date.now(),
            ...(opts.registerOnNotFound && config.autoRegister && { registrationPending: true }),
          });
          return lookupFromEntry(entry, config.cacheTtlMs);
        }
        case 'rate-limited':
        case 'error': {
          // Serve stale rather than nothing, but do NOT refresh storedAt: after
          // the backoff below, the next request retries Enhancely instead of
          // trusting this entry for another full TTL.
          const backoffMs =
            result.status === 'rate-limited' && result.retryAfterSeconds !== null
              ? Math.min(Math.max(result.retryAfterSeconds, 1) * 1000, opts.maxBackoffMs)
              : DEFAULT_RETRY_BACKOFF_MS;
          const retryNotBefore = Date.now() + backoffMs;
          if (result.status === 'rate-limited') {
            recordRateLimitDeadline(config, retryNotBefore);
          }
          const memo: CacheEntry = {
            jsonldRaw: cached?.jsonldRaw ?? null,
            etag: cached?.etag ?? null,
            storedAt: cached?.storedAt ?? 0,
            ...(cached?.registrationPending === true && { registrationPending: true }),
            retryNotBefore,
          };
          let served = memo;
          try {
            served = await withCacheWriteLock(cache, key, async () => {
              const current = await cache.get(key);
              if (sameCacheEntry(current, cached)) {
                await cache.set(key, memo);
                return memo;
              }
              // A different-mode flight completed while ours was failing. Use
              // its newer result for this response and never overwrite it.
              return current ?? memo;
            });
          } catch {
            // The memo is best-effort; serving stale must not depend on it.
          }
          return lookupFromEntry(served, config.cacheTtlMs);
        }
      }
    });
  } catch {
    return { snippet: null, revalidateInMs: null };
  }
}

export async function getJsonLdLookup(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<JsonLdLookupResult> {
  return resolveLookup(url, cache, config, (key, etag) => fetchJsonLd(config, key, etag), {
    registerOnNotFound: true,
    maxBackoffMs: MAX_RETRY_BACKOFF_MS,
    flightMode: 'conditional-get',
  });
}

/**
 * Register-or-revalidate lookup for adapters that both DISCOVER pages and
 * consume snippets in one place (including every Lambda entrypoint): a single
 * `POST /api/v1/jsonld { url }` with `If-None-Match` replaces the GET→404→POST
 * pair — unknown URLs are registered, known ones are revalidated (412) or
 * fetched (200) in the same round-trip, and the entry this stores makes the
 * NEXT miss inject. `autoRegister` is irrelevant here: the call itself is the
 * registration. Rate-limit backoffs honor day-scale Retry-After values
 * (plan caps), bounded by MAX_REGISTER_BACKOFF_MS.
 *
 * Never throws.
 */
export async function getJsonLdRegisterLookup(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<JsonLdLookupResult> {
  return resolveLookup(url, cache, config, (key, etag) => registerOrRevalidate(config, key, etag), {
    registerOnNotFound: false,
    maxBackoffMs: MAX_REGISTER_BACKOFF_MS,
    flightMode: 'register-or-revalidate',
  });
}

/**
 * Snippet-only API for adapters that do not manage a downstream page cache.
 * With autoRegister enabled it uses the one-call register-or-revalidate path;
 * otherwise it remains a conditional GET lookup.
 */
export async function getJsonLdSnippet(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<string | null> {
  const lookup = config.autoRegister
    ? await getJsonLdRegisterLookup(url, cache, config)
    : await getJsonLdLookup(url, cache, config);
  return lookup.snippet;
}

/**
 * Adapter entry point: given the upstream response's HTML + metadata, return
 * the HTML to serve. Only looks up Enhancely after proving that an exact-200 text/html
 * body contains a safe injection point. Anything unexpected (including our own
 * bugs, via the outer try/catch) serves the original HTML.
 *
 * Never throws.
 */
export async function handleHtml(
  ctx: HtmlContext,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<string> {
  try {
    if (ctx.status !== 200) return ctx.html;
    if (!isHtmlMediaType(ctx.contentType)) return ctx.html;
    if (config.apiKey === '') return ctx.html;
    const injectionPoint = findHeadInjectionPoint(ctx.html);
    if (injectionPoint === null) return ctx.html;

    const snippet = await getJsonLdSnippet(ctx.url, cache, config);
    if (snippet === null) return ctx.html;
    return injectIntoHead(ctx.html, snippet, injectionPoint);
  } catch {
    return ctx.html;
  }
}
