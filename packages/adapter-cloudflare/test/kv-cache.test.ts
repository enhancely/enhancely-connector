import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '@enhancely/injector-core';
import {
  KVCacheBackend,
  kvExpirationTtlSeconds,
  kvKeyFor,
  type KVNamespaceLike,
} from '../src/kv-cache.js';

/** In-memory KV fake recording put() options, mimicking type:'json' reads. */
class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, { value: string; expirationTtl?: number }>();

  get(key: string, _type: 'json'): Promise<unknown> {
    const entry = this.store.get(key);
    return Promise.resolve(entry === undefined ? null : JSON.parse(entry.value));
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      ...(options?.expirationTtl !== undefined && { expirationTtl: options.expirationTtl }),
    });
    return Promise.resolve();
  }
}

const entry: CacheEntry = {
  jsonldRaw: '{"@context":"https://schema.org"}',
  etag: 'W/"abc123"',
  storedAt: 1_753_600_000_000,
};

describe('kvExpirationTtlSeconds', () => {
  it('is 2x the freshness TTL in seconds (stale-serving window)', () => {
    expect(kvExpirationTtlSeconds(300_000)).toBe(600);
  });

  it('never drops below the 60s KV minimum', () => {
    expect(kvExpirationTtlSeconds(1_000)).toBe(60);
    expect(kvExpirationTtlSeconds(29_999)).toBe(60);
  });
});

describe('kvKeyFor', () => {
  const longUrl = `https://example.com/${'a'.repeat(500)}`;

  it('passes short keys through unchanged', async () => {
    await expect(kvKeyFor('https://example.com/page')).resolves.toBe('https://example.com/page');
  });

  it('maps keys over 400 UTF-8 bytes to a stable sha256: hex digest', async () => {
    const mapped = await kvKeyFor(longUrl);
    expect(mapped).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Stable: the same key always maps to the same digest.
    await expect(kvKeyFor(longUrl)).resolves.toBe(mapped);
    // Distinct keys map to distinct digests.
    await expect(kvKeyFor(`${longUrl}x`)).resolves.not.toBe(mapped);
  });

  it('measures UTF-8 bytes, not code units (multi-byte URLs hash too)', async () => {
    // 200 × 'ü' (2 bytes each) = 400 bytes with the prefix pushing it over.
    const multiByte = `https://example.com/${'ü'.repeat(200)}`;
    await expect(kvKeyFor(multiByte)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('always yields keys under the 512-byte KV limit', async () => {
    const encoder = new TextEncoder();
    for (const key of ['https://example.com/short', longUrl]) {
      const mapped = await kvKeyFor(key);
      expect(encoder.encode(mapped).byteLength).toBeLessThan(512);
    }
  });

  it('round-trips a value through the backend under a long URL', async () => {
    const kv = new FakeKV();
    const backend = new KVCacheBackend(kv, 300_000);

    await backend.set(longUrl, entry);
    await expect(backend.get(longUrl)).resolves.toEqual(entry);

    // The stored key is the digest, not the oversized raw URL.
    expect(kv.store.has(longUrl)).toBe(false);
    expect([...kv.store.keys()]).toEqual([await kvKeyFor(longUrl)]);
  });
});

describe('KVCacheBackend', () => {
  it('round-trips a cache entry as JSON', async () => {
    const kv = new FakeKV();
    const backend = new KVCacheBackend(kv, 300_000);

    await backend.set('https://example.com/page', entry);
    await expect(backend.get('https://example.com/page')).resolves.toEqual(entry);
  });

  it('round-trips a negative (404) entry with jsonldRaw: null', async () => {
    const kv = new FakeKV();
    const backend = new KVCacheBackend(kv, 300_000);
    const negative: CacheEntry = { jsonldRaw: null, etag: null, storedAt: 123 };

    await backend.set('k', negative);
    await expect(backend.get('k')).resolves.toEqual(negative);
  });

  it('writes with expirationTtl = max(60, 2 * cacheTtlMs / 1000)', async () => {
    const kv = new FakeKV();
    await new KVCacheBackend(kv, 300_000).set('long', entry);
    await new KVCacheBackend(kv, 5_000).set('short', entry);

    expect(kv.store.get('long')?.expirationTtl).toBe(600);
    expect(kv.store.get('short')?.expirationTtl).toBe(60);
  });

  it('treats a missing key as a cache miss', async () => {
    const backend = new KVCacheBackend(new FakeKV(), 300_000);
    await expect(backend.get('nope')).resolves.toBeUndefined();
  });

  it('treats malformed stored values as a cache miss (fail-open)', async () => {
    const kv = new FakeKV();
    kv.store.set('bad-shape', { value: JSON.stringify({ hello: 'world' }) });
    kv.store.set('wrong-types', {
      value: JSON.stringify({ jsonldRaw: 1, etag: 2, storedAt: 'x' }),
    });

    const backend = new KVCacheBackend(kv, 300_000);
    await expect(backend.get('bad-shape')).resolves.toBeUndefined();
    await expect(backend.get('wrong-types')).resolves.toBeUndefined();
  });

  it('swallows KV read errors (fail-open)', async () => {
    const throwingKv: KVNamespaceLike = {
      get: () => Promise.reject(new Error('kv down')),
      put: () => Promise.reject(new Error('kv down')),
    };
    const backend = new KVCacheBackend(throwingKv, 300_000);

    await expect(backend.get('k')).resolves.toBeUndefined();
    await expect(backend.set('k', entry)).resolves.toBeUndefined();
  });
});
