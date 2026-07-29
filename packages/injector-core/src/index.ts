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
export { fetchJsonLd, registerJsonLd, parseRetryAfter } from './client.js';
export { buildScriptTag, injectIntoHead } from './inject.js';
export { matchesExcludedPath } from './exclude.js';

import type {
  CacheBackend,
  CacheEntry,
  HtmlContext,
  InjectorConfig,
  JsonLdLookupResult,
} from './types.js';
import { normalizeLite } from './normalize.js';
import { isFresh } from './cache.js';
import { fetchJsonLd, registerJsonLd } from './client.js';
import { buildScriptTag, injectIntoHead } from './inject.js';

/** Positive entry → script tag, negative entry (404 memo) → null. */
function snippetFromEntry(entry: CacheEntry): string | null {
  return entry.jsonldRaw !== null ? buildScriptTag(entry.jsonldRaw) : null;
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
 * Resolve the ready-to-inject `<script type="application/ld+json">…</script>`
 * snippet for a page URL plus an optional retryable-miss revalidation delay
 * for adapters that manage a downstream page cache.
 *
 * - Fresh cache entry → answered locally (positive → snippet, negative → null).
 * - Entry carrying a retry backoff memo (previous 429/error) that has not
 *   elapsed → answered locally too, so page views never hammer a rate-limited
 *   or down API (nor pay the fetch timeout each time).
 * - Stale/missing → conditional GET (If-None-Match when we hold an ETag):
 *   - 200 → store + inject
 *   - 304 → refresh the stored entry's storedAt, serve from cache
 *   - 404 → store a NEGATIVE entry (stops dead-URL polling), inject nothing
 *   - 429/error/timeout → serve the stale entry as-is if we have one
 *     (without touching storedAt) and record a short retryNotBefore memo:
 *     min(Retry-After, 60 s) on 429, 10 s otherwise
 *
 * The API request carries the query-stripped URL (`normalizeLite(url)`, = the
 * cache key), never a locally computed hash. The server normalizes identically,
 * so the record is the same — but no query string (tokens/PII) leaves the edge.
 *
 * Never throws.
 */
export async function getJsonLdLookup(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig
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
    const result = await fetchJsonLd(config, key, cached?.etag);

    switch (result.status) {
      case 'ok': {
        await cache.set(key, {
          jsonldRaw: result.jsonldRaw,
          etag: result.etag,
          storedAt: Date.now(),
        });
        return { snippet: buildScriptTag(result.jsonldRaw), revalidateInMs: null };
      }
      case 'not-modified': {
        // 304 without a cached entry should be impossible (we only send
        // If-None-Match when we hold one) — treat it like an error: nothing
        // to serve, nothing to store. Rebuilding the entry (instead of
        // spreading) drops any leftover retryNotBefore memo.
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
      case 'not-found': {
        // Auto-registration: the page is really being served (adapters gate on
        // 200 + text/html) but unknown to Enhancely — register it once. The
        // negative entry below suppresses further lookups (and thus further
        // registrations) for a full TTL; after expiry the next view picks up
        // the generated JSON-LD via the normal GET path.
        if (config.autoRegister) {
          // Register the query-stripped URL for the same reason (see above):
          // no query string is ever POSTed to the third party.
          await registerJsonLd(config, key);
        }
        const negative: CacheEntry = {
          jsonldRaw: null,
          etag: null,
          storedAt: Date.now(),
          ...(config.autoRegister && { registrationPending: true }),
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
            ? Math.min(Math.max(result.retryAfterSeconds, 1) * 1000, MAX_RETRY_BACKOFF_MS)
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
