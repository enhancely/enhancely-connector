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
 * may carry day-scale URL-local 403/429 backoffs; expiring KV after the normal 2× stale
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

/** Hex SHA-256 without ever materializing secret input in a KV key. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Non-secret cache scope for one Enhancely API base/key identity.
 *
 * A shared KV namespace may outlive a key rotation or be bound to several
 * Worker deployments. Without this scope, a fresh record written under one
 * Enhancely project could be served under another without an API call. The
 * digest keeps the Bearer key itself out of the KV dashboard and logs.
 */
export function kvCacheScopeFor(enhancelyBase: string, apiKey: string): Promise<string> {
  return sha256Hex(JSON.stringify([enhancelyBase, apiKey]));
}

/**
 * Map a cache key (the normalized page URL) to a KV-safe key.
 *
 * Workers KV rejects keys longer than 512 bytes; because get/put errors are
 * deliberately swallowed (fail-open), an oversized key would otherwise
 * *silently* lose both caching and the 429 retry backoff — every view of a
 * long-URL page would re-hit the Enhancely API. Keys over
 * {@link MAX_VERBATIM_KEY_BYTES} including the versioned project-scope prefix
 * are therefore replaced by a stable URL digest. Short URLs remain readable
 * after that non-secret prefix. Both forms stay well under 512 bytes.
 */
export async function kvKeyFor(key: string, scope: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(scope)) {
    throw new TypeError('KV cache scope must be a lowercase SHA-256 hex digest');
  }
  const prefix = `v1:${scope}:`;
  const bytes = new TextEncoder().encode(key);
  if (new TextEncoder().encode(prefix).byteLength + bytes.byteLength <= MAX_VERBATIM_KEY_BYTES) {
    return `${prefix}${key}`;
  }

  return `${prefix}sha256:${await sha256Hex(key)}`;
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
    private readonly cacheTtlMs: number,
    private readonly scope: string
  ) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const value = await this.kv.get(await kvKeyFor(key, this.scope), 'json');
      return isCacheEntry(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    try {
      await this.kv.put(await kvKeyFor(key, this.scope), JSON.stringify(entry), {
        expirationTtl: kvEntryExpirationTtlSeconds(this.cacheTtlMs, entry),
      });
    } catch {
      // Fail-open: a lost cache write only costs a future API call.
    }
  }
}

/**
 * Stable backend identity per Worker isolate, KV binding, TTL, API base and
 * project key. Core singleflight/write serialization is keyed by the
 * CacheBackend object; a new wrapper on every request would therefore defeat
 * coalescing even though all wrappers address the same KV namespace.
 */
interface BackendMemo {
  identity: string;
  backend: Promise<KVCacheBackend>;
}

const backendMemo = new WeakMap<KVNamespaceLike, BackendMemo>();

export function getKvCacheBackend(
  kv: KVNamespaceLike,
  cacheTtlMs: number,
  enhancelyBase: string,
  apiKey: string
): Promise<KVCacheBackend> {
  const identity = JSON.stringify([cacheTtlMs, enhancelyBase, apiKey]);
  const current = backendMemo.get(kv);
  if (current?.identity === identity) return current.backend;

  // One Worker isolate has one stable binding set. Replace, rather than retain,
  // old raw API-key identities across a rollout; scoped KV records themselves
  // remain available if that project becomes active again later.
  const backend = kvCacheScopeFor(enhancelyBase, apiKey).then(
    (scope) => new KVCacheBackend(kv, cacheTtlMs, scope)
  );
  backendMemo.set(kv, { identity, backend });
  void backend.catch(() => {
    // WebCrypto is mandatory on Workers, but a transient runtime failure must
    // not poison this binding's memo for the rest of the isolate lifetime.
    if (backendMemo.get(kv)?.backend === backend) backendMemo.delete(kv);
  });
  return backend;
}
