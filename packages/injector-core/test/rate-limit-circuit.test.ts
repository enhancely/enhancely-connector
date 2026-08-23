import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetRateLimitCircuitForTests,
  MemoryCache,
  buildScriptTag,
  defineConfig,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  normalizeLite,
} from '../src/index.js';
import type { Fetcher } from '../src/index.js';

const NOW = 1_700_000_000_000;
const TTL_MS = 60_000;
const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';
const URL_C = 'https://example.com/c';
const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Product"}';

const REGISTER_429_HEADER_CASES: ReadonlyArray<{
  name: string;
  headers: HeadersInit;
  localMs: number;
  sharedMs: number;
}> = [
  {
    name: 'Retry-After delay-seconds',
    headers: { 'Retry-After': '7200' },
    localMs: 7_200_000,
    sharedMs: 60_000,
  },
  {
    name: 'Retry-After HTTP-date',
    headers: { 'Retry-After': new Date(NOW + 7_200_000).toUTCString() },
    localMs: 7_200_000,
    sharedMs: 60_000,
  },
  {
    name: 'RateLimit-Reset fallback after an invalid Retry-After',
    headers: { 'Retry-After': 'invalid', 'RateLimit-Reset': '7200' },
    localMs: 7_200_000,
    sharedMs: 60_000,
  },
  {
    name: 'Retry-After precedence over RateLimit-Reset',
    headers: { 'Retry-After': '17', 'RateLimit-Reset': '7200' },
    localMs: 17_000,
    sharedMs: 17_000,
  },
  {
    name: 'path caps for an excessive Retry-After',
    headers: { 'Retry-After': '999999999' },
    localMs: 86_400_000,
    sharedMs: 60_000,
  },
  {
    name: 'default backoff without a usable header',
    headers: {},
    localMs: 10_000,
    sharedMs: 10_000,
  },
];

function config(fetchImpl: Fetcher, apiKey = 'sk-shared') {
  return defineConfig({ apiKey, cacheTtlMs: TTL_MS, fetchImpl });
}

describe('API-key-wide rate-limit circuit', () => {
  beforeEach(() => {
    __resetRateLimitCircuitForTests();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    __resetRateLimitCircuitForTests();
    vi.useRealTimers();
  });

  it('shares a GET 429 across URLs and the register-or-revalidate POST path', async () => {
    const fetchImpl = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } })
      )
      .mockResolvedValue(new Response(RAW_JSONLD, { status: 200 }));
    const sharedConfig = config(fetchImpl);

    const first = await getJsonLdLookup(URL_A, new MemoryCache(), sharedConfig);
    const blocked = await getJsonLdRegisterLookup(URL_B, new MemoryCache(), sharedConfig);

    expect(first).toEqual({ snippet: null, revalidateInMs: 30_000 });
    expect(blocked).toEqual({ snippet: null, revalidateInMs: 30_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    const recovered = await getJsonLdRegisterLookup(URL_B, new MemoryCache(), sharedConfig);
    expect(recovered.snippet).toBe(buildScriptTag(RAW_JSONLD, null));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1].method).toBe('POST');
  });

  describe('register 429 header handling', () => {
    it.each(REGISTER_429_HEADER_CASES)('$name', async ({ headers, localMs, sharedMs }) => {
      const fetchImpl = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers }))
        .mockResolvedValue(new Response(RAW_JSONLD, { status: 200 }));

      const sharedConfig = defineConfig({
        apiKey: 'sk-shared',
        cacheTtlMs: TTL_MS,
        fetchImpl,
      });
      const cacheA = new MemoryCache();
      const cacheB = new MemoryCache();

      await expect(getJsonLdRegisterLookup(URL_A, cacheA, sharedConfig)).resolves.toEqual({
        snippet: null,
        revalidateInMs: localMs,
      });
      await expect(getJsonLdRegisterLookup(URL_B, cacheB, sharedConfig)).resolves.toEqual({
        snippet: null,
        revalidateInMs: sharedMs,
      });
      expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual(['POST']);

      if (localMs > 60_000) {
        vi.advanceTimersByTime(60_001);
        const recovered = await getJsonLdRegisterLookup(URL_B, cacheB, sharedConfig);
        expect(recovered.snippet).toBe(buildScriptTag(RAW_JSONLD, null));
        await expect(getJsonLdRegisterLookup(URL_A, cacheA, sharedConfig)).resolves.toEqual({
          snippet: null,
          revalidateInMs: localMs - 60_001,
        });
        expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'POST']);
      }
    });
  });

  it('keeps a Retry-After register 403 URL-local while cold GET and POST records still load', async () => {
    const fetchImpl = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        new Response('hard cap', { status: 403, headers: { 'Retry-After': '999999999' } })
      )
      .mockResolvedValueOnce(new Response(RAW_JSONLD, { status: 200 }))
      .mockResolvedValueOnce(new Response(RAW_JSONLD, { status: 200 }));
    const sharedConfig = config(fetchImpl);
    const limitedCache = new MemoryCache();

    const limited = await getJsonLdRegisterLookup(URL_A, limitedCache, sharedConfig);
    const viaGet = await getJsonLdLookup(URL_B, new MemoryCache(), sharedConfig);
    const viaPost = await getJsonLdRegisterLookup(URL_C, new MemoryCache(), sharedConfig);

    expect(limited).toEqual({ snippet: null, revalidateInMs: 86_400_000 });
    expect(viaGet.snippet).toBe(buildScriptTag(RAW_JSONLD, null));
    expect(viaPost.snippet).toBe(buildScriptTag(RAW_JSONLD, null));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'GET', 'POST']);

    vi.advanceTimersByTime(3_600_000);
    await expect(getJsonLdRegisterLookup(URL_A, limitedCache, sharedConfig)).resolves.toEqual({
      snippet: null,
      revalidateInMs: 82_800_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('extends a fresh negative only to the 60 s shared POST-429 deadline', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '86400' } })
      )
    );
    const sharedConfig = config(fetchImpl);
    const cache = new MemoryCache();
    await cache.set(normalizeLite(URL_B), {
      jsonldRaw: null,
      etag: null,
      storedAt: NOW,
    });

    vi.advanceTimersByTime(30_000);
    await getJsonLdRegisterLookup(URL_A, new MemoryCache(), sharedConfig);
    const blocked = await getJsonLdLookup(URL_B, cache, sharedConfig);

    expect(blocked).toEqual({ snippet: null, revalidateInMs: 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves a stale positive for another URL while the circuit is open', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } })
      )
    );
    const sharedConfig = config(fetchImpl);
    const cache = new MemoryCache();
    await cache.set(normalizeLite(URL_B), {
      jsonldRaw: RAW_JSONLD,
      etag: '"old"',
      storedAt: NOW - TTL_MS - 1,
    });

    await getJsonLdLookup(URL_A, new MemoryCache(), sharedConfig);
    const blocked = await getJsonLdLookup(URL_B, cache, sharedConfig);

    expect(blocked).toEqual({ snippet: buildScriptTag(RAW_JSONLD, '"old"'), revalidateInMs: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await cache.get(normalizeLite(URL_B)))?.storedAt).toBe(NOW - TTL_MS - 1);
  });

  it('returns the circuit deadline for stale negative and missing URLs', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } })
      )
    );
    const sharedConfig = config(fetchImpl);
    const negativeCache = new MemoryCache();
    await negativeCache.set(normalizeLite(URL_B), {
      jsonldRaw: null,
      etag: null,
      storedAt: NOW - TTL_MS - 1,
    });

    await getJsonLdLookup(URL_A, new MemoryCache(), sharedConfig);
    vi.advanceTimersByTime(5_000);

    await expect(getJsonLdLookup(URL_B, negativeCache, sharedConfig)).resolves.toEqual({
      snippet: null,
      revalidateInMs: 25_000,
    });
    await expect(
      getJsonLdRegisterLookup('https://example.com/missing', new MemoryCache(), sharedConfig)
    ).resolves.toEqual({ snippet: null, revalidateInMs: 25_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('isolates identical base/key scopes that use different custom fetch implementations', async () => {
    const limitedFetch = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } })
      )
    );
    const healthyFetch = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200 }))
    );

    await getJsonLdLookup(URL_A, new MemoryCache(), config(limitedFetch));
    const isolated = await getJsonLdLookup(URL_B, new MemoryCache(), config(healthyFetch));

    expect(isolated.snippet).toBe(buildScriptTag(RAW_JSONLD, null));
    expect(limitedFetch).toHaveBeenCalledTimes(1);
    expect(healthyFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds retained API-key scopes per fetch implementation', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } })
      )
    );

    for (let index = 0; index < 129; index += 1) {
      await getJsonLdLookup(URL_A, new MemoryCache(), config(fetchImpl, `sk-scope-${index}`));
    }

    // The oldest of 129 live scopes was evicted from the 128-entry map. A new
    // cache avoids its URL-local memo, proving the process-wide map is bounded.
    await getJsonLdLookup(URL_B, new MemoryCache(), config(fetchImpl, 'sk-scope-0'));
    expect(fetchImpl).toHaveBeenCalledTimes(130);
  });
});
