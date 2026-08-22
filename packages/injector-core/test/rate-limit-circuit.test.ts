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
const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Product"}';

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

  it('retains a legacy GET-404 follow-up POST rate limit across other URLs', async () => {
    const fetchImpl = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response('hard cap', { status: 429, headers: { 'Retry-After': '7200' } })
      )
      .mockResolvedValue(new Response(RAW_JSONLD, { status: 200 }));
    const sharedConfig = defineConfig({
      apiKey: 'sk-shared',
      autoRegister: true,
      cacheTtlMs: TTL_MS,
      fetchImpl,
    });

    const first = await getJsonLdLookup(URL_A, new MemoryCache(), sharedConfig);
    const blocked = await getJsonLdLookup(URL_B, new MemoryCache(), sharedConfig);

    expect(first).toEqual({ snippet: null, revalidateInMs: 7_200_000 });
    expect(blocked).toEqual({ snippet: null, revalidateInMs: 7_200_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('GET');
    expect(fetchImpl.mock.calls[1]?.[1].method).toBe('POST');
  });

  it('uses the already capped register deadline for a 403 across the GET path', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('hard cap', { status: 403, headers: { 'Retry-After': '999999999' } })
      )
    );
    const sharedConfig = config(fetchImpl);

    await getJsonLdRegisterLookup(URL_A, new MemoryCache(), sharedConfig);
    const blocked = await getJsonLdLookup(URL_B, new MemoryCache(), sharedConfig);

    expect(blocked).toEqual({ snippet: null, revalidateInMs: 86_400_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('extends a fresh negative result to the later org-wide circuit deadline', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response('hard cap', { status: 403, headers: { 'Retry-After': '86400' } })
      )
    );
    const sharedConfig = config(fetchImpl);
    const cache = new MemoryCache();
    await cache.set(normalizeLite(URL_B), {
      jsonldRaw: null,
      etag: null,
      storedAt: NOW,
    });

    await getJsonLdRegisterLookup(URL_A, new MemoryCache(), sharedConfig);
    const blocked = await getJsonLdLookup(URL_B, cache, sharedConfig);

    expect(blocked).toEqual({ snippet: null, revalidateInMs: 86_400_000 });
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
