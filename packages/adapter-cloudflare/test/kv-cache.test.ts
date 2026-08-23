import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '@enhancely/injector-core';
import {
  KVCacheBackend,
  getKvCacheBackend,
  kvCacheScopeFor,
  kvEntryExpirationTtlSeconds,
  kvExpirationTtlSeconds,
  kvKeyFor,
  type KVNamespaceLike,
} from '../src/kv-cache.js';

const SCOPE = 'a'.repeat(64);

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

describe('kvEntryExpirationTtlSeconds', () => {
  it('keeps retry backoffs alive until their deadline', () => {
    const now = 1_000_000;
    expect(
      kvEntryExpirationTtlSeconds(
        300_000,
        { ...entry, jsonldRaw: null, retryNotBefore: now + 86_400_000 },
        now
      )
    ).toBe(86_400);
  });

  it('uses the normal stale window when it is longer', () => {
    const now = 1_000_000;
    expect(
      kvEntryExpirationTtlSeconds(
        300_000,
        { ...entry, jsonldRaw: null, retryNotBefore: now + 10_000 },
        now
      )
    ).toBe(600);
  });
});

describe('kvKeyFor', () => {
  const longUrl = `https://example.com/${'a'.repeat(500)}`;

  it('passes short keys through unchanged', async () => {
    await expect(kvKeyFor('https://example.com/page', SCOPE)).resolves.toBe(
      `v1:${SCOPE}:https://example.com/page`
    );
  });

  it('maps keys over 400 UTF-8 bytes to a stable sha256: hex digest', async () => {
    const mapped = await kvKeyFor(longUrl, SCOPE);
    expect(mapped).toMatch(new RegExp(`^v1:${SCOPE}:sha256:[0-9a-f]{64}$`));
    // Stable: the same key always maps to the same digest.
    await expect(kvKeyFor(longUrl, SCOPE)).resolves.toBe(mapped);
    // Distinct keys map to distinct digests.
    await expect(kvKeyFor(`${longUrl}x`, SCOPE)).resolves.not.toBe(mapped);
  });

  it('measures UTF-8 bytes, not code units (multi-byte URLs hash too)', async () => {
    // 200 × 'ü' (2 bytes each) = 400 bytes with the prefix pushing it over.
    const multiByte = `https://example.com/${'ü'.repeat(200)}`;
    await expect(kvKeyFor(multiByte, SCOPE)).resolves.toMatch(/:sha256:[0-9a-f]{64}$/);
  });

  it('always yields keys under the 512-byte KV limit', async () => {
    const encoder = new TextEncoder();
    for (const key of ['https://example.com/short', longUrl]) {
      const mapped = await kvKeyFor(key, SCOPE);
      expect(encoder.encode(mapped).byteLength).toBeLessThan(512);
    }
  });

  it('rejects a caller-supplied value that is not an internal SHA-256 scope', async () => {
    await expect(kvKeyFor('https://example.com/page', 'not-a-scope')).rejects.toThrow(
      'lowercase SHA-256'
    );
  });

  it('round-trips a value through the backend under a long URL', async () => {
    const kv = new FakeKV();
    const backend = new KVCacheBackend(kv, 300_000, SCOPE);

    await backend.set(longUrl, entry);
    await expect(backend.get(longUrl)).resolves.toEqual(entry);

    // The stored key is the digest, not the oversized raw URL.
    expect(kv.store.has(longUrl)).toBe(false);
    expect([...kv.store.keys()]).toEqual([await kvKeyFor(longUrl, SCOPE)]);
  });
});

describe('kvCacheScopeFor', () => {
  it('is stable, project-specific, and never contains the API key', async () => {
    const first = await kvCacheScopeFor('https://app.enhancely.ai', 'sk-project-a');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(kvCacheScopeFor('https://app.enhancely.ai', 'sk-project-a')).resolves.toBe(first);
    await expect(kvCacheScopeFor('https://app.enhancely.ai', 'sk-project-b')).resolves.not.toBe(
      first
    );
    expect(first).not.toContain('sk-project-a');
  });
});

describe('KVCacheBackend', () => {
  it('reuses one backend identity per KV binding, TTL, base, and project', async () => {
    const firstKv = new FakeKV();
    const secondKv = new FakeKV();

    const first = await getKvCacheBackend(firstKv, 300_000, 'https://api.example', 'sk-a');
    expect(first).toBe(await getKvCacheBackend(firstKv, 300_000, 'https://api.example', 'sk-a'));
    expect(first).not.toBe(await getKvCacheBackend(firstKv, 60_000, 'https://api.example', 'sk-a'));
    expect(first).not.toBe(
      await getKvCacheBackend(secondKv, 300_000, 'https://api.example', 'sk-a')
    );
    expect(first).not.toBe(
      await getKvCacheBackend(firstKv, 300_000, 'https://other-api.example', 'sk-a')
    );
    expect(first).not.toBe(
      await getKvCacheBackend(firstKv, 300_000, 'https://api.example', 'sk-b')
    );
  });

  it('does not retain an old backend identity after configuration rotation', async () => {
    const kv = new FakeKV();
    const first = await getKvCacheBackend(kv, 300_000, 'https://api.example', 'sk-a');
    await getKvCacheBackend(kv, 300_000, 'https://api.example', 'sk-b');
    const firstAgain = await getKvCacheBackend(kv, 300_000, 'https://api.example', 'sk-a');
    expect(firstAgain).not.toBe(first);
  });

  it('keeps records for different Enhancely projects separate in one KV namespace', async () => {
    const kv = new FakeKV();
    const first = await getKvCacheBackend(kv, 300_000, 'https://api.example', 'sk-a');
    const second = await getKvCacheBackend(kv, 300_000, 'https://api.example', 'sk-b');
    const url = 'https://example.com/page';

    await first.set(url, { ...entry, jsonldRaw: '{"project":"a"}' });
    await second.set(url, { ...entry, jsonldRaw: '{"project":"b"}' });

    await expect(first.get(url)).resolves.toMatchObject({ jsonldRaw: '{"project":"a"}' });
    await expect(second.get(url)).resolves.toMatchObject({ jsonldRaw: '{"project":"b"}' });
    expect(kv.store.size).toBe(2);
  });

  it('round-trips a cache entry as JSON', async () => {
    const kv = new FakeKV();
    const backend = new KVCacheBackend(kv, 300_000, SCOPE);

    await backend.set('https://example.com/page', entry);
    await expect(backend.get('https://example.com/page')).resolves.toEqual(entry);
  });

  it('round-trips a negative (404) entry with jsonldRaw: null', async () => {
    const kv = new FakeKV();
    const backend = new KVCacheBackend(kv, 300_000, SCOPE);
    const negative: CacheEntry = {
      jsonldRaw: null,
      etag: null,
      storedAt: 123,
      registrationPending: true,
    };

    await backend.set('k', negative);
    await expect(backend.get('k')).resolves.toEqual(negative);
  });

  it('writes with expirationTtl = max(60, 2 * cacheTtlMs / 1000)', async () => {
    const kv = new FakeKV();
    await new KVCacheBackend(kv, 300_000, SCOPE).set('long', entry);
    await new KVCacheBackend(kv, 5_000, SCOPE).set('short', entry);

    expect(kv.store.get(`v1:${SCOPE}:long`)?.expirationTtl).toBe(600);
    expect(kv.store.get(`v1:${SCOPE}:short`)?.expirationTtl).toBe(60);
  });

  it('treats a missing key as a cache miss', async () => {
    const backend = new KVCacheBackend(new FakeKV(), 300_000, SCOPE);
    await expect(backend.get('nope')).resolves.toBeUndefined();
  });

  it('treats malformed stored values as a cache miss (fail-open)', async () => {
    const kv = new FakeKV();
    kv.store.set(`v1:${SCOPE}:bad-shape`, { value: JSON.stringify({ hello: 'world' }) });
    kv.store.set(`v1:${SCOPE}:wrong-types`, {
      value: JSON.stringify({ jsonldRaw: 1, etag: 2, storedAt: 'x' }),
    });

    const backend = new KVCacheBackend(kv, 300_000, SCOPE);
    await expect(backend.get('bad-shape')).resolves.toBeUndefined();
    await expect(backend.get('wrong-types')).resolves.toBeUndefined();
  });

  it('swallows KV read errors (fail-open)', async () => {
    const throwingKv: KVNamespaceLike = {
      get: () => Promise.reject(new Error('kv down')),
      put: () => Promise.reject(new Error('kv down')),
    };
    const backend = new KVCacheBackend(throwingKv, 300_000, SCOPE);

    await expect(backend.get('k')).resolves.toBeUndefined();
    await expect(backend.set('k', entry)).resolves.toBeUndefined();
  });
});
