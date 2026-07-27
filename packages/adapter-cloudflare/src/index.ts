/**
 * Enhancely Cloudflare Worker reference adapter.
 *
 * Flow per request:
 *   1. Pass the request through to the origin unchanged.
 *   2. Gate: GET + 2xx + text/html + API key configured — else return as-is.
 *   3. Ask injector-core for the page's JSON-LD snippet (cache + ETag + timeout
 *      + fail-open all live in the core).
 *   4. Append the snippet as the last child of <head> via HTMLRewriter,
 *      fully buffered (see src/inject.ts) so a mid-stream rewrite error can
 *      never truncate the body on the wire.
 *
 * Fail-open invariant: everything after the origin fetch is wrapped in
 * try/catch; any surprise returns the untouched origin response. A document
 * without <head> makes HTMLRewriter a no-op — content still passes through.
 */
import { defineConfig, getJsonLdSnippet, MemoryCache } from '@enhancely/injector-core';
import type { CacheBackend } from '@enhancely/injector-core';
import { shouldAttemptInjection } from './gate.js';
import { injectSnippetBuffered } from './inject.js';
import { KVCacheBackend } from './kv-cache.js';

export { shouldAttemptInjection } from './gate.js';
export type { GateInput } from './gate.js';
export { injectSnippetBuffered } from './inject.js';
export type { RewriterElementLike, RewriterLike } from './inject.js';
export { KVCacheBackend, kvExpirationTtlSeconds, kvKeyFor } from './kv-cache.js';
export type { KVNamespaceLike } from './kv-cache.js';

export interface Env {
  /** Required. Set via `wrangler secret put ENHANCELY_API_KEY` — never in wrangler.toml. */
  ENHANCELY_API_KEY?: string;
  /** Optional API base override (default: https://app.enhancely.ai — TODO: confirm). */
  ENHANCELY_BASE?: string;
  /** Optional numeric override for the per-call AbortSignal timeout (default 800). */
  ENHANCELY_TIMEOUT_MS?: string;
  /** Optional numeric override for cache freshness TTL (default 300000 = 5 min). */
  ENHANCELY_CACHE_TTL_MS?: string;
  /** Optional KV namespace for a distributed cache; falls back to per-isolate memory. */
  JSONLD_CACHE?: KVNamespace;
}

/** Parse an optional numeric env var; anything non-positive/non-numeric → undefined. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Per-isolate fallback cache, used only when no JSONLD_CACHE KV binding is
 * configured. Isolates are recycled by the platform, so hit rates are modest —
 * KV is the recommended production setup (see README).
 */
const memoryCache = new MemoryCache();

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    // 1. Origin pass-through — this response is the fail-open answer for
    //    every path below.
    const response = await fetch(request);

    try {
      const apiKey = env.ENHANCELY_API_KEY;
      if (
        apiKey === undefined ||
        !shouldAttemptInjection({
          method: request.method,
          responseOk: response.ok,
          contentType: response.headers.get('content-type'),
          apiKey,
        })
      ) {
        return response;
      }

      const timeoutMs = parsePositiveInt(env.ENHANCELY_TIMEOUT_MS);
      const cacheTtlMs = parsePositiveInt(env.ENHANCELY_CACHE_TTL_MS);
      const config = defineConfig({
        apiKey,
        ...(env.ENHANCELY_BASE !== undefined &&
          env.ENHANCELY_BASE !== '' && { enhancelyBase: env.ENHANCELY_BASE }),
        ...(timeoutMs !== undefined && { timeoutMs }),
        ...(cacheTtlMs !== undefined && { cacheTtlMs }),
      });

      const cache: CacheBackend =
        env.JSONLD_CACHE !== undefined
          ? new KVCacheBackend(env.JSONLD_CACHE, config.cacheTtlMs)
          : memoryCache;

      // Core handles normalization, caching, ETag revalidation, timeout and
      // all fail-open cases; null means "leave the page alone".
      const snippet = await getJsonLdSnippet(request.url, cache, config);
      if (snippet === null) return response;

      // Append as last child of <head> ≙ immediately before </head>.
      // No <head> in the document → handler never fires → original content.
      // Buffered (not streamed) so a mid-stream HTMLRewriter error fails open
      // to the untouched origin response instead of truncating the body —
      // see src/inject.ts for the trade-off notes.
      return await injectSnippetBuffered(response, snippet, () => new HTMLRewriter());
    } catch {
      // Fail-open: any unexpected error serves the untouched origin response.
      return response;
    }
  },
} satisfies ExportedHandler<Env>;
