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
  JsonLdFetchResult,
  HtmlContext,
} from './types.js';
export {
  defineConfig,
  DEFAULT_ENHANCELY_BASE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
} from './config.js';
export { normalizeLite } from './normalize.js';
export { MemoryCache, isFresh } from './cache.js';
export { fetchJsonLd, registerJsonLd, parseRetryAfter } from './client.js';
export { buildScriptTag, injectIntoHead } from './inject.js';

import type { CacheBackend, CacheEntry, HtmlContext, InjectorConfig } from './types.js';
import { normalizeLite } from './normalize.js';
import { isFresh } from './cache.js';
import { fetchJsonLd, registerJsonLd } from './client.js';
import { buildScriptTag, injectIntoHead } from './inject.js';

/** Positive entry → script tag, negative entry (404 memo) → null. */
function snippetFromEntry(entry: CacheEntry): string | null {
  return entry.jsonldRaw !== null ? buildScriptTag(entry.jsonldRaw) : null;
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
 * snippet for a page URL, or null when nothing should be injected.
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
 * The API request always carries the RAW page URL — `normalizeLite` is used
 * for the local cache key ONLY (the server normalizes authoritatively).
 *
 * Never throws.
 */
export async function getJsonLdSnippet(
  url: string,
  cache: CacheBackend,
  config: InjectorConfig
): Promise<string | null> {
  try {
    const key = normalizeLite(url);
    const cached = await cache.get(key);

    if (cached && isFresh(cached, config.cacheTtlMs)) {
      return snippetFromEntry(cached);
    }

    // Backoff memo from a previous 429/error: answer locally, no upstream call.
    if (cached?.retryNotBefore !== undefined && Date.now() < cached.retryNotBefore) {
      return snippetFromEntry(cached);
    }

    const result = await fetchJsonLd(config, url, cached?.etag);

    switch (result.status) {
      case 'ok': {
        await cache.set(key, {
          jsonldRaw: result.jsonldRaw,
          etag: result.etag,
          storedAt: Date.now(),
        });
        return buildScriptTag(result.jsonldRaw);
      }
      case 'not-modified': {
        // 304 without a cached entry should be impossible (we only send
        // If-None-Match when we hold one) — treat it like an error: nothing
        // to serve, nothing to store. Rebuilding the entry (instead of
        // spreading) drops any leftover retryNotBefore memo.
        if (!cached) return null;
        await cache.set(key, {
          jsonldRaw: cached.jsonldRaw,
          etag: cached.etag,
          storedAt: Date.now(),
        });
        return snippetFromEntry(cached);
      }
      case 'not-found': {
        // Auto-registration: the page is really being served (adapters gate on
        // 200 + text/html) but unknown to Enhancely — register it once. The
        // negative entry below suppresses further lookups (and thus further
        // registrations) for a full TTL; after expiry the next view picks up
        // the generated JSON-LD via the normal GET path.
        if (config.autoRegister) {
          await registerJsonLd(config, url);
        }
        await cache.set(key, { jsonldRaw: null, etag: null, storedAt: Date.now() });
        return null;
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
        return cached ? snippetFromEntry(cached) : null;
      }
    }
  } catch {
    return null;
  }
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
