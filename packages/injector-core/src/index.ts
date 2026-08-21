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
export { normalizeLite } from './normalize.js';
export { MemoryCache, isFresh } from './cache.js';
export { fetchJsonLd, registerJsonLd, registerOrRevalidate, parseRetryAfter } from './client.js';
export { buildScriptTag, injectIntoHead } from './inject.js';
export { matchesExcludedPath } from './exclude.js';

import type {
  CacheBackend,
  CacheEntry,
  HtmlContext,
  InjectorConfig,
  JsonLdFetchResult,
  JsonLdLookupResult,
} from './types.js';
import { normalizeLite } from './normalize.js';
import { isFresh } from './cache.js';
import { fetchJsonLd, registerJsonLd, registerOrRevalidate } from './client.js';
import { buildScriptTag, injectIntoHead } from './inject.js';

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

/**
 * Resolve the ready-to-inject `<script type="application/ld+json">…</script>`
 * snippet for a page URL plus an optional retryable-miss revalidation delay
 * for adapters that manage a downstream page cache.
 *
 * - Fresh cache entry → answered locally (positive → snippet, negative → null).
 * - Entry carrying a retry backoff memo (previous 429/error) that has not
 *   elapsed → answered locally too, so page views never hammer a rate-limited
 *   or down API (nor pay the fetch timeout each time).
 * - Stale/missing → one upstream call (`call`: conditional GET for the
 *   lookup path, register-or-revalidate POST for the companion path; both
 *   send If-None-Match when we hold an ETag):
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
 *     min(Retry-After, maxBackoffMs) when sent, 10 s otherwise
 *
 * The API request carries the query-stripped URL (`normalizeLite(url)`, = the
 * cache key), never a locally computed hash. The server normalizes identically,
 * so the record is the same — but no query string (tokens/PII) leaves the edge.
 *
 * Never throws.
 */
async function resolveLookup(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig,
  call: (key: string, etag: string | null | undefined) => Promise<JsonLdFetchResult>,
  opts: { registerOnNotFound: boolean; maxBackoffMs: number }
): Promise<JsonLdLookupResult> {
  try {
    const key = normalizeLite(url);
    const cached = await cache.get(key);

    if (cached && isFresh(cached, config.cacheTtlMs)) {
      return lookupFromEntry(cached, config.cacheTtlMs);
    }

    // Backoff memo from a previous 429/error: answer locally, no upstream call.
    if (cached?.retryNotBefore !== undefined && Date.now() < cached.retryNotBefore) {
      return lookupFromEntry(cached, config.cacheTtlMs);
    }

    // Send the query-stripped URL (= the cache key), NOT the raw request URL.
    // The server normalizes identically (same 4 rules, same `new URL()`), so
    // the resolved record is byte-for-byte the same — but query strings (which
    // routinely carry tokens, search terms and PII) never leave the edge, and
    // the URL we look up matches the URL we cache under (`?a=1` and `?a=2`
    // share one entry precisely because they are the same page server-side).
    const result = await call(key, cached?.etag);

    switch (result.status) {
      case 'ok': {
        await cache.set(key, {
          jsonldRaw: result.jsonldRaw,
          etag: result.etag,
          storedAt: Date.now(),
        });
        return { snippet: buildScriptTag(result.jsonldRaw, result.etag), revalidateInMs: null };
      }
      case 'not-modified': {
        // 304 (GET) or 412 (register POST) without a cached entry should be
        // impossible (we only send If-None-Match when we hold one) — treat it
        // like an error: nothing to serve, nothing to store. Rebuilding the
        // entry (instead of spreading) drops any leftover retryNotBefore memo.
        if (!cached) return { snippet: null, revalidateInMs: null };
        const refreshed: CacheEntry = {
          jsonldRaw: cached.jsonldRaw,
          etag: cached.etag,
          storedAt: Date.now(),
          ...(cached.registrationPending === true && { registrationPending: true }),
        };
        await cache.set(key, refreshed);
        return lookupFromEntry(refreshed, config.cacheTtlMs);
      }
      case 'pending': {
        // The record exists but generation has produced no content yet. The
        // server explicitly told us there is no current snippet, so any stale
        // positive we hold describes a dead record incarnation — drop it.
        // With a Retry-After hint the entry re-polls exactly then (storedAt 0
        // keeps it permanently stale so only retryNotBefore gates the next
        // call); without one it rests for a full TTL.
        const entry: CacheEntry =
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
        await cache.set(key, entry);
        return lookupFromEntry(entry, config.cacheTtlMs);
      }
      case 'terminal-negative': {
        // Ignored record, never-succeeded generation, or rejected
        // registration. The server knows the URL — re-registering it would be
        // pure load, so unlike `not-found` this NEVER triggers autoRegister.
        // A plain negative entry re-checks after a full TTL (self-healing
        // when the operator un-ignores the record or fixes the domain).
        const negative: CacheEntry = { jsonldRaw: null, etag: null, storedAt: Date.now() };
        await cache.set(key, negative);
        return lookupFromEntry(negative, config.cacheTtlMs);
      }
      case 'not-found': {
        // Auto-registration: the page is really being served (adapters gate on
        // 200 + text/html) but unknown to Enhancely — register it once. The
        // negative entry below suppresses further lookups (and thus further
        // registrations) for a full TTL; after expiry the next view picks up
        // the generated JSON-LD via the normal GET path.
        if (opts.registerOnNotFound && config.autoRegister) {
          // Register the query-stripped URL for the same reason (see above):
          // no query string is ever POSTed to the third party.
          await registerJsonLd(config, key);
        }
        const negative: CacheEntry = {
          jsonldRaw: null,
          etag: null,
          storedAt: Date.now(),
          ...(opts.registerOnNotFound && config.autoRegister && { registrationPending: true }),
        };
        await cache.set(key, negative);
        return lookupFromEntry(negative, config.cacheTtlMs);
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
        const memo: CacheEntry = {
          jsonldRaw: cached?.jsonldRaw ?? null,
          etag: cached?.etag ?? null,
          // No previous entry → storedAt 0 keeps the memo permanently stale,
          // so it only suppresses retries until retryNotBefore, nothing more.
          storedAt: cached?.storedAt ?? 0,
          ...(cached?.registrationPending === true && { registrationPending: true }),
          retryNotBefore: Date.now() + backoffMs,
        };
        try {
          // No single-flight across concurrent requests — a parallel request
          // may have stored a FRESH result while ours was failing. Re-read and
          // only write the backoff memo if the entry is unchanged; never
          // clobber newer data with a stale snapshot.
          const current = await cache.get(key);
          const unchanged =
            (current?.storedAt ?? null) === (cached?.storedAt ?? null) &&
            (current?.etag ?? null) === (cached?.etag ?? null);
          if (unchanged) {
            await cache.set(key, memo);
          }
        } catch {
          // The memo is best-effort; serving stale must not depend on it.
        }
        return lookupFromEntry(memo, config.cacheTtlMs);
      }
    }
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
  });
}

/**
 * Register-or-revalidate lookup for adapters that both DISCOVER pages and
 * consume snippets in one place (the Lambda@Edge companion): a single
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
  });
}

/**
 * Backwards-compatible snippet-only API for adapters that do not manage a
 * downstream page cache.
 */
export async function getJsonLdSnippet(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<string | null> {
  return (await getJsonLdLookup(url, cache, config)).snippet;
}

/**
 * Adapter entry point: given the upstream response's HTML + metadata, return
 * the HTML to serve. Only touches 2xx text/html responses; anything unexpected
 * (including our own bugs, via the outer try/catch) serves the original HTML.
 *
 * Never throws.
 */
export async function handleHtml(
  ctx: HtmlContext,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<string> {
  try {
    if (ctx.status < 200 || ctx.status > 299) return ctx.html;
    if (!isHtmlMediaType(ctx.contentType)) return ctx.html;
    if (config.apiKey === '') return ctx.html;

    const snippet = await getJsonLdSnippet(ctx.url, cache, config);
    if (snippet === null) return ctx.html;
    return injectIntoHead(ctx.html, snippet);
  } catch {
    return ctx.html;
  }
}
