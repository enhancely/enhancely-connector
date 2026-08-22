import type { CacheBackend, CacheEntry } from '@enhancely/injector-core';

/**
 * Structural subset of Cloudflare's KVNamespace that this backend uses.
 * Declared locally so unit tests can supply a plain in-memory fake without
 * pulling in @cloudflare/workers-types at runtime. The real KVNamespace
 * binding is assignable to this shape.
 */
export interface KVNamespaceLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Minimum KV expiration Cloudflare accepts (and our floor for stale-serving). */
const MIN_EXPIRATION_TTL_SECONDS = 60;

/**
 * Compute the KV `expirationTtl` (seconds) for a cache entry.
 *
 * Entries deliberately outlive the freshness TTL (2× cacheTtlMs): a stale
 * entry is still valuable — the orchestrator serves it when Enhancely is slow,
 * rate-limited, or down, and it carries the ETag for cheap 304 revalidation.
 * KV expiration only prevents unbounded growth of dead keys.
 */
export function kvExpirationTtlSeconds(cacheTtlMs: number): number {
  return Math.max(MIN_EXPIRATION_TTL_SECONDS, Math.ceil((2 * cacheTtlMs) / 1000));
}

/**
 * Keep a negative entry at least until its retry deadline. Register responses
 * may carry day-scale 403/429 backoffs; expiring KV after the normal 2× stale
 * window would forget that deadline and resume POSTing too early.
 */
export function kvEntryExpirationTtlSeconds(
  cacheTtlMs: number,
  entry: CacheEntry,
  now: number = Date.now()
): number {
  const retrySeconds =
    entry.retryNotBefore === undefined
      ? 0
      : Math.max(0, Math.ceil((entry.retryNotBefore - now) / 1000));
  return Math.max(kvExpirationTtlSeconds(cacheTtlMs), retrySeconds);
}

/**
 * Keys at or below this UTF-8 byte length are used verbatim. Workers KV caps
 * keys at 512 bytes; 400 leaves comfortable headroom while keeping the vast
 * majority of real-world URLs human-readable in the KV dashboard.
 */
const MAX_VERBATIM_KEY_BYTES = 400;

/**
 * Map a cache key (the normalized page URL) to a KV-safe key.
 *
 * Workers KV rejects keys longer than 512 bytes; because get/put errors are
 * deliberately swallowed (fail-open), an oversized key would otherwise
 * *silently* lose both caching and the 429 retry backoff — every view of a
 * long-URL page would re-hit the Enhancely API. Keys over
 * {@link MAX_VERBATIM_KEY_BYTES} UTF-8 bytes are therefore replaced by a
 * stable digest: `sha256:` + lowercase hex SHA-256 of the key (71 bytes,
 * well under the 512-byte limit). Short keys pass through unchanged.
 */
export async function kvKeyFor(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key);
  if (bytes.byteLength <= MAX_VERBATIM_KEY_BYTES) return key;

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate['jsonldRaw'] === 'string' || candidate['jsonldRaw'] === null) &&
    (typeof candidate['etag'] === 'string' || candidate['etag'] === null) &&
    typeof candidate['storedAt'] === 'number' &&
    (candidate['registrationPending'] === undefined ||
      typeof candidate['registrationPending'] === 'boolean') &&
    (candidate['retryNotBefore'] === undefined || typeof candidate['retryNotBefore'] === 'number')
  );
}

/**
 * CacheBackend on top of Cloudflare KV (JSON values).
 *
 * Fail-open like everything else: KV read errors or malformed values behave
 * like a cache miss, KV write errors are swallowed — the worst case is an
 * extra Enhancely API call, never a broken page.
 */
export class KVCacheBackend implements CacheBackend {
  constructor(
    private readonly kv: KVNamespaceLike,
    private readonly cacheTtlMs: number
  ) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const value = await this.kv.get(await kvKeyFor(key), 'json');
      return isCacheEntry(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    try {
      await this.kv.put(await kvKeyFor(key), JSON.stringify(entry), {
        expirationTtl: kvEntryExpirationTtlSeconds(this.cacheTtlMs, entry),
      });
    } catch {
      // Fail-open: a lost cache write only costs a future API call.
    }
  }
}

/**
 * Stable backend identity per Worker isolate, KV binding and TTL. Core
 * singleflight/write serialization is keyed by the CacheBackend object; a new
 * wrapper on every request would therefore defeat coalescing even though all
 * wrappers address the same KV namespace.
 */
const backendMemo = new WeakMap<KVNamespaceLike, Map<number, KVCacheBackend>>();

export function getKvCacheBackend(kv: KVNamespaceLike, cacheTtlMs: number): KVCacheBackend {
  let byTtl = backendMemo.get(kv);
  if (byTtl === undefined) {
    byTtl = new Map();
    backendMemo.set(kv, byTtl);
  }

  let backend = byTtl.get(cacheTtlMs);
  if (backend === undefined) {
    backend = new KVCacheBackend(kv, cacheTtlMs);
    byTtl.set(cacheTtlMs, backend);
  }
  return backend;
}
