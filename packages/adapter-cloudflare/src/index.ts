/**
 * Enhancely Cloudflare Worker reference adapter.
 *
 * Flow per request:
 *   1. Pass the request through to the origin unchanged.
 *   2. Gate: GET + exact 200 + text/html + API key configured — else return.
 *   3. Parse and fully buffer through HTMLRewriter to prove a real <head>
 *      insertion slot (see src/inject.ts).
 *   4. Only then ask injector-core for JSON-LD and replace that slot. Cache,
 *      ETag, timeout and fail-open behavior all live in the core.
 *
 * Fail-open invariant: everything after the origin fetch is wrapped in
 * try/catch; any surprise returns the untouched origin response. A document
 * without <head> makes HTMLRewriter a no-op — content still passes through.
 */
import { defineConfig, getJsonLdSnippet, MemoryCache } from '@enhancely/injector-core';
import type { CacheBackend } from '@enhancely/injector-core';
import { shouldAttemptInjection } from './gate.js';
import { injectSnippetBuffered } from './inject.js';
import { getKvCacheBackend } from './kv-cache.js';

export { shouldAttemptInjection } from './gate.js';
export type { GateInput } from './gate.js';
export { injectSnippetBuffered } from './inject.js';
export type { RewriterElementLike, RewriterLike } from './inject.js';
export {
  getKvCacheBackend,
  KVCacheBackend,
  kvEntryExpirationTtlSeconds,
  kvExpirationTtlSeconds,
  kvKeyFor,
} from './kv-cache.js';
export type { KVNamespaceLike } from './kv-cache.js';

export interface Env {
  /** Required. Set via `wrangler secret put ENHANCELY_API_KEY` — never in wrangler.toml. */
  ENHANCELY_API_KEY?: string;
  /** Optional API base override (official API default: https://app.enhancely.ai). */
  ENHANCELY_BASE?: string;
  /** Optional numeric override for the per-call AbortSignal timeout (default 800). */
  ENHANCELY_TIMEOUT_MS?: string;
  /** Optional numeric override for cache freshness TTL (default 300000 = 5 min). */
  ENHANCELY_CACHE_TTL_MS?: string;
  /** "true" uses one register-or-revalidate POST for lookup or self-registration. */
  ENHANCELY_AUTO_REGISTER?: string;
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
          status: response.status,
          contentType: response.headers.get('content-type'),
          contentEncoding: response.headers.get('content-encoding'),
          cacheControl: response.headers.get('cache-control'),
          contentDisposition: response.headers.get('content-disposition'),
          xRobotsTag: response.headers.get('x-robots-tag'),
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
        ...(env.ENHANCELY_AUTO_REGISTER === 'true' && { autoRegister: true }),
      });

      const cache: CacheBackend =
        env.JSONLD_CACHE !== undefined
          ? getKvCacheBackend(env.JSONLD_CACHE, config.cacheTtlMs)
          : memoryCache;

      // HTMLRewriter must first prove and buffer a real insertion slot. Only
      // then does the provider touch cache/Enhancely, so headless or malformed
      // HTML costs no API request. A null lookup restores the untouched clone.
      return await injectSnippetBuffered(
        response,
        () => getJsonLdSnippet(request.url, cache, config),
        () => new HTMLRewriter()
      );
    } catch {
      // Fail-open: any unexpected error serves the untouched origin response.
      return response;
    }
  },
} satisfies ExportedHandler<Env>;
