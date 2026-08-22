import type { CacheBackend, CacheEntry } from './types.js';

/** Keep per-isolate cache retention comfortably below small edge runtimes. */
export const DEFAULT_MEMORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 5000;

/**
 * Conservative retained-heap estimate. V8 may keep strings as one or two
 * bytes per code unit; using two plus a fixed object/Map allowance avoids a
 * nominal 16 MiB cache turning into hundreds of MiB under large JSON-LD.
 */
function estimatedEntryBytes(key: string, entry: CacheEntry): number {
  const stringUnits = key.length + (entry.jsonldRaw?.length ?? 0) + (entry.etag?.length ?? 0);
  return 256 + stringUnits * 2;
}

/**
 * Default in-memory cache. Suitable per-isolate/per-instance; distributed
 * backends (Cloudflare KV, Redis, …) implement CacheBackend in their adapter.
 *
 * Entries are NOT expired on read — freshness is the orchestrator's decision
 * (a stale entry is still valuable: it is served when Enhancely is slow,
 * rate-limited, or down, and it carries the ETag for cheap revalidation).
 * Both entry-count and estimated-byte caps guard against unbounded growth. A
 * count-only cap is insufficient because each JSON-LD value may be 256 KiB;
 * 5000 such entries would exceed a Lambda/Worker memory limit before normal
 * JavaScript error handling could fail open.
 */
export class MemoryCache implements CacheBackend {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly entryBytes = new Map<string, number>();
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
    private readonly maxEstimatedBytes: number = DEFAULT_MEMORY_CACHE_MAX_BYTES
  ) {}

  get(key: string): Promise<CacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, entry: CacheEntry): Promise<void> {
    const existingBytes = this.entryBytes.get(key);
    if (existingBytes !== undefined) {
      this.entries.delete(key);
      this.entryBytes.delete(key);
      this.retainedBytes -= existingBytes;
    }

    const bytes = estimatedEntryBytes(key, entry);
    // A custom cache budget may be smaller than one value. Never violate the
    // hard budget merely to retain that value; the next request safely calls
    // Enhancely again (and its normal singleflight/backoff still applies).
    if (bytes > this.maxEstimatedBytes || this.maxEntries <= 0) return Promise.resolve();

    // Map preserves insertion order — drop oldest entries until BOTH caps fit.
    while (
      this.entries.size >= this.maxEntries ||
      this.retainedBytes + bytes > this.maxEstimatedBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.retainedBytes -= this.entryBytes.get(oldest) ?? 0;
      this.entryBytes.delete(oldest);
    }
    this.entries.set(key, entry);
    this.entryBytes.set(key, bytes);
    this.retainedBytes += bytes;
    return Promise.resolve();
  }
}

/** Freshness check used by the orchestrator. */
export function isFresh(entry: CacheEntry, ttlMs: number, now: number = Date.now()): boolean {
  return entry.storedAt + ttlMs > now;
}
