import type { CacheBackend, CacheEntry } from './types.js';

/**
 * Default in-memory cache. Suitable per-isolate/per-instance; distributed
 * backends (Cloudflare KV, Redis, …) implement CacheBackend in their adapter.
 *
 * Entries are NOT expired on read — freshness is the orchestrator's decision
 * (a stale entry is still valuable: it is served when Enhancely is slow,
 * rate-limited, or down, and it carries the ETag for cheap revalidation).
 * The size cap only guards against unbounded growth.
 */
export class MemoryCache implements CacheBackend {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries: number = 5000) {}

  get(key: string): Promise<CacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, entry: CacheEntry): Promise<void> {
    // Map preserves insertion order — drop oldest entries when over cap.
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
    return Promise.resolve();
  }
}

/** Freshness check used by the orchestrator. */
export function isFresh(entry: CacheEntry, ttlMs: number, now: number = Date.now()): boolean {
  return entry.storedAt + ttlMs > now;
}
