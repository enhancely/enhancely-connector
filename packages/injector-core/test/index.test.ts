import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryCache,
  buildScriptTag,
  defineConfig,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  getJsonLdSnippet,
  handleHtml,
  normalizeLite,
} from '../src/index.js';
import type { Fetcher, HtmlContext } from '../src/index.js';

const PAGE_URL = 'https://example.com/pricing';
const KEY = normalizeLite(PAGE_URL);
const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Product"}';
const SNIPPET = buildScriptTag(RAW_JSONLD, '"v1"');
const SNIPPET_V2 = buildScriptTag(RAW_JSONLD, '"v2"');
const TTL_MS = 60_000;

function makeConfig(fetchImpl: Fetcher, apiKey = 'sk-test-key') {
  return defineConfig({ apiKey, fetchImpl, cacheTtlMs: TTL_MS });
}

function htmlCtx(overrides: Partial<HtmlContext> = {}): HtmlContext {
  return {
    html: '<html><head><title>t</title></head><body>b</body></html>',
    url: PAGE_URL,
    contentType: 'text/html; charset=utf-8',
    status: 200,
    ...overrides,
  };
}

describe('getJsonLdSnippet', () => {
  it('serves a fresh positive cache entry without calling fetch', async () => {
    const cache = new MemoryCache();
    await cache.set(KEY, { jsonldRaw: RAW_JSONLD, etag: '"v1"', storedAt: Date.now() });
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));

    const snippet = await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(snippet).toBe(SNIPPET);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves a fresh NEGATIVE cache entry as null without calling fetch', async () => {
    const cache = new MemoryCache();
    await cache.set(KEY, { jsonldRaw: null, etag: null, storedAt: Date.now() });
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));

    const snippet = await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(snippet).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('revalidates a stale entry: 304 refreshes storedAt and serves cached JSON-LD', async () => {
    const cache = new MemoryCache();
    const staleStoredAt = Date.now() - TTL_MS - 5_000;
    await cache.set(KEY, { jsonldRaw: RAW_JSONLD, etag: '"v1"', storedAt: staleStoredAt });

    const fetchImpl = vi.fn<Fetcher>((_input, init) => {
      // Stale revalidation must carry the cached ETag.
      expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
      return Promise.resolve(new Response(null, { status: 304 }));
    });

    const before = Date.now();
    const snippet = await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(snippet).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const entry = await cache.get(KEY);
    expect(entry?.jsonldRaw).toBe(RAW_JSONLD);
    expect(entry?.etag).toBe('"v1"');
    expect(entry?.storedAt).toBeGreaterThanOrEqual(before);
  });

  it('sends the QUERY-STRIPPED (normalized) URL to the API and caches under that same key', async () => {
    const cache = new MemoryCache();
    // The query string must be stripped BEFORE the URL leaves the edge: the
    // server normalizes identically, so the resolved record is byte-for-byte
    // the same, but tokens/search terms/PII in the querystring never reach the
    // third-party API. The URL sent === the cache key === normalizeLite(raw).
    const rawUrl = 'http://example.com/pricing/?utm_source=x&b=2';
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }))
    );
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet(rawUrl, cache, config)).toBe(SNIPPET);

    const key = normalizeLite(rawUrl);
    expect(key).toBe('https://example.com/pricing');

    // The API endpoint carries the query-stripped URL (= the cache key), NOT
    // the raw request URL — no querystring leaves the edge.
    const requestedUrl = fetchImpl.mock.calls[0]?.[0];
    expect(requestedUrl).toBe(`${config.enhancelyBase}/api/v1/jsonld/${encodeURIComponent(key)}`);
    expect(requestedUrl).not.toContain('utm_source');
    expect(requestedUrl).not.toContain(encodeURIComponent('?'));

    // …and the entry is cached under that same normalized key.
    expect(await cache.get(key)).toMatchObject({ jsonldRaw: RAW_JSONLD, etag: '"v1"' });
  });

  it('shares one cache entry (and one Enhancely call) across different querystrings', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }))
    );
    const config = makeConfig(fetchImpl);

    // `?a=1` populates the cache under the normalized key…
    expect(await getJsonLdSnippet('https://example.com/page?a=1', cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // …and `?a=2` is the SAME page server-side, so it hits that entry — no
    // second Enhancely call — precisely because both look up normalizeLite(url).
    expect(await getJsonLdSnippet('https://example.com/page?a=2', cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Both querystrings resolve to a single cache entry under the stripped key.
    const key = normalizeLite('https://example.com/page?a=1');
    expect(key).toBe('https://example.com/page');
    expect(await cache.get(key)).toMatchObject({ jsonldRaw: RAW_JSONLD });
  });

  it.each([
    ['relative', '/pricing?token=relative-secret'],
    ['malformed', 'not a url?token=malformed-secret'],
    ['non-http', 'mailto:person@example.com?token=mail-secret'],
    ['credentials', 'https://person:password@example.com/pricing?token=query-secret'],
  ])('rejects a %s page URL locally without cache or network I/O', async (_label, rawUrl) => {
    const cache = {
      get: vi.fn(() => Promise.reject(new Error('must not read cache'))),
      set: vi.fn(() => Promise.reject(new Error('must not write cache'))),
    };
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));

    expect(await getJsonLdSnippet(rawUrl, cache, makeConfig(fetchImpl))).toBeNull();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lookup and register address a doubled-slash URL with byte-identical canonical URLs', async () => {
    // enhancely #279: the GET path segment and the POST body must carry the
    // exact same string, or the two calls address different records.
    const raw = 'https://example.com//pricing//?token=secret#frag';
    const canonical = 'https://example.com/pricing';

    const seen: string[] = [];
    const fetchImpl = vi.fn<Fetcher>((url, init) => {
      const target = String(url);
      if (init?.method === 'POST') {
        seen.push((JSON.parse(String(init.body)) as { url: string }).url);
      } else {
        seen.push(decodeURIComponent(target.slice(target.lastIndexOf('/') + 1)));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    await getJsonLdLookup(raw, new MemoryCache(), makeConfig(fetchImpl));
    await getJsonLdRegisterLookup(raw, new MemoryCache(), makeConfig(fetchImpl));

    expect(seen).toEqual([canonical, canonical]);
    // No token, no fragment, no doubled slash ever reaches the network.
    for (const sent of seen) {
      expect(sent).not.toContain('token');
      expect(sent).not.toContain('#');
      expect(sent.slice('https://'.length)).not.toContain('//');
    }
  });

  it('a doubled-slash URL and its canonical form share ONE cache entry', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(RAW_JSONLD, {
          status: 200,
          headers: { etag: '"v1"', 'content-type': 'application/ld+json' },
        })
      )
    );
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet('https://example.com//pricing', cache, config)).toBe(SNIPPET);
    expect(await getJsonLdSnippet('https://example.com/pricing', cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await cache.get('https://example.com/pricing')).toMatchObject({
      jsonldRaw: RAW_JSONLD,
    });
  });

  it('auto-registration uses ONE POST with the QUERY-STRIPPED URL', async () => {
    const cache = new MemoryCache();
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const fetchImpl = vi.fn<Fetcher>((url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      return Promise.resolve(new Response('', { status: 201 }));
    });
    const config = defineConfig({
      apiKey: 'sk-test-key',
      autoRegister: true,
      fetchImpl,
      cacheTtlMs: TTL_MS,
    });

    const rawUrl = 'https://example.com/pricing?token=secret&b=2';
    expect(await getJsonLdSnippet(rawUrl, cache, config)).toBeNull();

    const key = normalizeLite(rawUrl);
    expect(key).toBe('https://example.com/pricing');

    // Register-or-revalidate replaces the old GET→404→POST pair.
    expect(calls).toHaveLength(1);
    const post = calls[0];
    expect(post?.method).toBe('POST');
    expect(post?.url).toBe(`${config.enhancelyBase}/api/v1/jsonld`);
    expect(JSON.parse(String(post?.body))).toEqual({ url: key });
    expect(String(post?.body)).not.toContain('token');
  });

  it('stores fresh data on 200 and serves the snippet', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }))
    );

    const snippet = await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(snippet).toBe(SNIPPET_V2);
    const entry = await cache.get(KEY);
    expect(entry?.jsonldRaw).toBe(RAW_JSONLD);
    expect(entry?.etag).toBe('"v2"');
  });

  it('caches 404 as a negative entry and does not re-fetch while fresh', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.resolve(new Response('', { status: 404 })));
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const entry = await cache.get(KEY);
    expect(entry).toMatchObject({ jsonldRaw: null, etag: null });

    // Second call while the negative entry is fresh: no network traffic.
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves the stale entry on 429 WITHOUT refreshing storedAt', async () => {
    const cache = new MemoryCache();
    const staleStoredAt = Date.now() - TTL_MS - 5_000;
    await cache.set(KEY, { jsonldRaw: RAW_JSONLD, etag: '"v1"', storedAt: staleStoredAt });
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '30' } }))
    );

    const snippet = await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(snippet).toBe(SNIPPET);
    // storedAt untouched → the next request retries instead of trusting
    // the entry for another full TTL.
    expect((await cache.get(KEY))?.storedAt).toBe(staleStoredAt);
  });

  it('serves the stale entry when fetch errors', async () => {
    const cache = new MemoryCache();
    const staleStoredAt = Date.now() - TTL_MS - 5_000;
    await cache.set(KEY, { jsonldRaw: RAW_JSONLD, etag: '"v1"', storedAt: staleStoredAt });
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new TypeError('fetch failed')));

    expect(await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl))).toBe(SNIPPET);
    expect((await cache.get(KEY))?.storedAt).toBe(staleStoredAt);
  });

  it('returns null on error with no cached entry', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new TypeError('fetch failed')));

    expect(await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl))).toBeNull();
  });

  it('never throws, even when the cache itself throws', async () => {
    const throwingCache = {
      get: () => Promise.reject(new Error('cache down')),
      set: () => Promise.reject(new Error('cache down')),
    };
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200 }))
    );

    await expect(
      getJsonLdSnippet(PAGE_URL, throwingCache, makeConfig(fetchImpl))
    ).resolves.toBeNull();
  });
});

describe('getJsonLdSnippet — retry backoff (429/error memo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('honors Retry-After on 429: serves stale locally until the window passes', async () => {
    const cache = new MemoryCache();
    const staleStoredAt = Date.now() - TTL_MS - 5_000;
    await cache.set(KEY, { jsonldRaw: RAW_JSONLD, etag: '"v1"', storedAt: staleStoredAt });
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '30' } }))
    );
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Inside the Retry-After window: stale served WITHOUT an upstream call.
    vi.advanceTimersByTime(29_000);
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the window: the API is retried.
    vi.advanceTimersByTime(2_000);
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('backs off briefly after an error even with no cached entry', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new TypeError('fetch failed')));
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Within the default backoff (10 s): no second upstream attempt, so the
    // page view does not pay the fetch timeout again.
    vi.advanceTimersByTime(5_000);
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the backoff: retried.
    vi.advanceTimersByTime(6_000);
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a successful refetch clears the backoff memo', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValue(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }));
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBeNull();

    vi.advanceTimersByTime(6_000);
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBe(SNIPPET_V2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const entry = await cache.get(KEY);
    expect(entry?.jsonldRaw).toBe(RAW_JSONLD);
    expect(entry?.retryNotBefore).toBeUndefined();
  });
});

describe('lookup single-flight and cross-mode races', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces concurrent conditional GET misses for one cache and URL', async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn<Fetcher>(() => response.promise);
    const cache = new MemoryCache();
    const config = makeConfig(fetchImpl);

    const lookups = Array.from({ length: 16 }, () => getJsonLdSnippet(PAGE_URL, cache, config));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    response.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }));

    await expect(Promise.all(lookups)).resolves.toEqual(Array(16).fill(SNIPPET));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent auto-registration into one register-or-revalidate POST', async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn<Fetcher>(() => response.promise);
    const cache = new MemoryCache();
    const config = defineConfig({
      apiKey: 'sk-test-key',
      autoRegister: true,
      cacheTtlMs: TTL_MS,
      fetchImpl,
    });

    const lookups = Array.from({ length: 16 }, () => getJsonLdSnippet(PAGE_URL, cache, config));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('POST');
    response.resolve(new Response('', { status: 201, headers: { 'Retry-After': '30' } }));

    await expect(Promise.all(lookups)).resolves.toEqual(Array(16).fill(null));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('removes a completed flight so a later uncached lookup can retry', async () => {
    const cache = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
    };
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response('temporary', { status: 500 }))
    );
    const config = makeConfig(fetchImpl);

    await getJsonLdSnippet(PAGE_URL, cache, config);
    await getJsonLdSnippet(PAGE_URL, cache, config);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['negative-first', 'positive-first'] as const)(
    'keeps the positive result across a concurrent GET/POST race (%s)',
    async (order) => {
      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const cache = new MemoryCache();
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      if (order === 'negative-first') {
        getResponse.resolve(new Response('', { status: 404 }));
        await getLookup;
        postResponse.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }));
      } else {
        postResponse.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }));
        await postLookup;
        getResponse.resolve(new Response('', { status: 404 }));
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toMatchObject({ jsonldRaw: RAW_JSONLD, etag: '"v2"' });
    }
  );

  it('keeps a concurrent POST 200 when GET 404 commits read the same cache snapshot', async () => {
    const getResponse = deferred<Response>();
    const postResponse = deferred<Response>();
    const releaseCommitReads = deferred<void>();
    const fetchImpl = vi.fn<Fetcher>((_url, init) =>
      init.method === 'POST' ? postResponse.promise : getResponse.promise
    );

    let stored: Awaited<ReturnType<MemoryCache['get']>>;
    let delayReads = false;
    let delayedReadCount = 0;
    const cache = {
      async get() {
        const snapshot = stored;
        if (delayReads) {
          delayedReadCount += 1;
          await releaseCommitReads.promise;
        }
        return snapshot;
      },
      async set(_key: string, entry: NonNullable<typeof stored>) {
        stored = entry;
      },
    };
    const config = makeConfig(fetchImpl);

    const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
    const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    // Both initial misses have completed. Hold later cache reads after taking
    // their snapshot so the old non-atomic get-then-set implementation lets
    // both commits observe `undefined` before either write is visible.
    delayReads = true;
    postResponse.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }));
    await vi.waitFor(() => expect(delayedReadCount).toBe(1));
    getResponse.resolve(new Response('', { status: 404 }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseCommitReads.resolve();

    const [getResult, postResult] = await Promise.all([getLookup, postLookup]);
    expect(getResult.snippet).toBe(SNIPPET_V2);
    expect(postResult.snippet).toBe(SNIPPET_V2);
    expect(stored).toMatchObject({ jsonldRaw: RAW_JSONLD, etag: '"v2"' });
  });

  it.each([
    ['403 registration limit', '403', 'short-first'],
    ['403 registration limit', '403', 'long-first'],
    ['long 429', '429', 'short-first'],
    ['long 429', '429', 'long-first'],
  ] as const)(
    'merges the longest concurrent negative backoff (%s, %s)',
    async (_label, responseKind, order) => {
      const now = 1_700_000_000_000;
      let currentTime = now;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const cache = new MemoryCache();
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const shortResponse =
        responseKind === '429'
          ? new Response('', { status: 429, headers: { 'Retry-After': '86400' } })
          : new Response('temporary', { status: 500 });
      const longResponse = new Response('', {
        status: responseKind === '429' ? 429 : 403,
        headers: { 'Retry-After': '86400' },
      });

      if (order === 'short-first') {
        getResponse.resolve(shortResponse);
        await getLookup;
        postResponse.resolve(longResponse);
      } else {
        postResponse.resolve(longResponse);
        await postLookup;
        getResponse.resolve(shortResponse);
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: null,
        etag: null,
        storedAt: 0,
        retryNotBefore: now + 86_400_000,
      });

      // The normal negative TTL and the shared 429 circuit have both elapsed,
      // but the URL-local register deadline must still suppress a second POST.
      currentTime += TTL_MS + 1_000;
      expect(await getJsonLdRegisterLookup(PAGE_URL, cache, config)).toMatchObject({
        snippet: null,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['failure-first', 'positive-first'] as const)(
    'never lets a concurrent 403 backoff overwrite a positive result (%s)',
    async (order) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const cache = new MemoryCache();
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const positive = new Response(RAW_JSONLD, {
        status: 200,
        headers: { ETag: '"v2"' },
      });
      const limited = new Response('', {
        status: 403,
        headers: { 'Retry-After': '86400' },
      });

      if (order === 'failure-first') {
        postResponse.resolve(limited);
        await postLookup;
        getResponse.resolve(positive);
      } else {
        getResponse.resolve(positive);
        await getLookup;
        postResponse.resolve(limited);
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: RAW_JSONLD,
        etag: '"v2"',
        storedAt: now,
      });
    }
  );

  it.each(['get-first', 'post-first'] as const)(
    'merges an exact concurrent GET 404 and POST 403 result (%s)',
    async (order) => {
      const now = 1_700_000_000_000;
      let currentTime = now;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const cache = new MemoryCache();
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      if (order === 'get-first') {
        getResponse.resolve(new Response('', { status: 404 }));
        await getLookup;
        postResponse.resolve(
          new Response('', { status: 403, headers: { 'Retry-After': '86400' } })
        );
      } else {
        postResponse.resolve(
          new Response('', { status: 403, headers: { 'Retry-After': '86400' } })
        );
        await postLookup;
        getResponse.resolve(new Response('', { status: 404 }));
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: null,
        etag: null,
        storedAt: now,
        retryNotBefore: now + 86_400_000,
      });

      currentTime += TTL_MS + 1_000;
      expect(await getJsonLdRegisterLookup(PAGE_URL, cache, config)).toMatchObject({
        snippet: null,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    ['403', 'get-first'],
    ['403', 'post-first'],
    ['429', 'get-first'],
    ['429', 'post-first'],
  ] as const)(
    'merges GET 404 with a limited POST over a stale positive (%s, %s)',
    async (status, order) => {
      const now = 1_700_000_000_000;
      let currentTime = now;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      const staleStoredAt = now - TTL_MS - 5_000;
      const cache = new MemoryCache();
      await cache.set(KEY, {
        jsonldRaw: RAW_JSONLD,
        etag: '"old"',
        storedAt: staleStoredAt,
      });

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const limited = new Response('', {
        status: Number(status),
        headers: { 'Retry-After': '86400' },
      });
      if (order === 'get-first') {
        getResponse.resolve(new Response('', { status: 404 }));
        await getLookup;
        postResponse.resolve(limited);
      } else {
        postResponse.resolve(limited);
        await postLookup;
        getResponse.resolve(new Response('', { status: 404 }));
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: null,
        etag: null,
        storedAt: now,
        retryNotBefore: now + 86_400_000,
      });

      currentTime += TTL_MS + 61_000;
      expect(await getJsonLdRegisterLookup(PAGE_URL, cache, config)).toMatchObject({
        snippet: null,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['get-first', 'post-first'] as const)(
    'lets a new 200 replace a retry-only stale-positive memo (%s)',
    async (order) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = new MemoryCache();
      await cache.set(KEY, {
        jsonldRaw: '{"version":1}',
        etag: '"old"',
        storedAt: now - TTL_MS - 5_000,
      });

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const updated = new Response('{"version":2}', {
        status: 200,
        headers: { ETag: '"new"' },
      });
      const limited = new Response('', {
        status: 403,
        headers: { 'Retry-After': '86400' },
      });
      if (order === 'get-first') {
        getResponse.resolve(updated);
        await getLookup;
        postResponse.resolve(limited);
      } else {
        postResponse.resolve(limited);
        await postLookup;
        getResponse.resolve(updated);
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: '{"version":2}',
        etag: '"new"',
        storedAt: now,
      });
    }
  );

  it.each([
    ['terminal-negative', '403', 'get-first'],
    ['terminal-negative', '403', 'post-first'],
    ['terminal-negative', '429', 'get-first'],
    ['terminal-negative', '429', 'post-first'],
    ['pending', '403', 'get-first'],
    ['pending', '403', 'post-first'],
    ['pending', '429', 'get-first'],
    ['pending', '429', 'post-first'],
  ] as const)(
    'merges authoritative GET negative state with durable POST backoff (%s, %s, %s)',
    async (getStatus, postStatus, order) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = new MemoryCache();
      await cache.set(KEY, {
        jsonldRaw: null,
        etag: null,
        storedAt: now - TTL_MS - 5_000,
      });

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const negative =
        getStatus === 'pending'
          ? new Response('', { status: 202, headers: { 'Retry-After': '5' } })
          : new Response('{}', { status: 200 });
      const limited = new Response('', {
        status: Number(postStatus),
        headers: { 'Retry-After': '86400' },
      });
      if (order === 'get-first') {
        getResponse.resolve(negative);
        await getLookup;
        postResponse.resolve(limited);
      } else {
        postResponse.resolve(limited);
        await postLookup;
        getResponse.resolve(negative);
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: null,
        etag: null,
        storedAt: getStatus === 'pending' ? 0 : now,
        retryNotBefore: now + 86_400_000,
      });
    }
  );

  it.each([
    ['403', 'get-first'],
    ['403', 'post-first'],
    ['429', 'get-first'],
    ['429', 'post-first'],
  ] as const)(
    'lets a successful 304 revalidation replace a retry-only memo (%s, %s)',
    async (status, order) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cache = new MemoryCache();
      await cache.set(KEY, {
        jsonldRaw: RAW_JSONLD,
        etag: '"old"',
        storedAt: now - TTL_MS - 5_000,
      });

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const revalidated = new Response(null, { status: 304 });
      const limited = new Response('', {
        status: Number(status),
        headers: { 'Retry-After': '86400' },
      });
      if (order === 'get-first') {
        getResponse.resolve(revalidated);
        await getLookup;
        postResponse.resolve(limited);
      } else {
        postResponse.resolve(limited);
        await postLookup;
        getResponse.resolve(revalidated);
      }

      await Promise.all([getLookup, postLookup]);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: RAW_JSONLD,
        etag: '"old"',
        storedAt: now,
      });
    }
  );

  it.each([
    ['403', 'get-first'],
    ['403', 'post-first'],
    ['429', 'get-first'],
    ['429', 'post-first'],
  ] as const)(
    'merges transient GET and durable POST backoffs over stale positive data (%s, %s)',
    async (status, order) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const staleStoredAt = now - TTL_MS - 5_000;
      const cache = new MemoryCache();
      await cache.set(KEY, {
        jsonldRaw: RAW_JSONLD,
        etag: '"old"',
        storedAt: staleStoredAt,
      });

      const getResponse = deferred<Response>();
      const postResponse = deferred<Response>();
      const fetchImpl = vi.fn<Fetcher>((_url, init) =>
        init.method === 'POST' ? postResponse.promise : getResponse.promise
      );
      const config = makeConfig(fetchImpl);

      const getLookup = getJsonLdLookup(PAGE_URL, cache, config);
      const postLookup = getJsonLdRegisterLookup(PAGE_URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      const transient = new Response('', { status: 500 });
      const limited = new Response('', {
        status: Number(status),
        headers: { 'Retry-After': '86400' },
      });
      if (order === 'get-first') {
        getResponse.resolve(transient);
        await getLookup;
        postResponse.resolve(limited);
      } else {
        postResponse.resolve(limited);
        await postLookup;
        getResponse.resolve(transient);
      }

      const [getResult, postResult] = await Promise.all([getLookup, postLookup]);
      expect(getResult.snippet ?? postResult.snippet).toContain(RAW_JSONLD);
      expect(await cache.get(KEY)).toEqual({
        jsonldRaw: RAW_JSONLD,
        etag: '"old"',
        storedAt: staleStoredAt,
        retryNotBefore: now + 86_400_000,
      });
    }
  );

  it('persists a failure memo when the cache evicts its original snapshot in flight', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const snapshot = {
      jsonldRaw: null,
      etag: null,
      storedAt: now - TTL_MS - 1,
    };
    let stored: (typeof snapshot & { retryNotBefore: number }) | undefined;
    let reads = 0;
    const cache = {
      async get() {
        reads += 1;
        if (reads === 1) return snapshot;
        if (reads === 2) return undefined;
        return stored;
      },
      async set(_key: string, entry: typeof stored) {
        stored = entry;
      },
    };
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response('', { status: 403, headers: { 'Retry-After': '86400' } }))
    );

    await getJsonLdRegisterLookup(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(stored).toEqual({
      ...snapshot,
      retryNotBefore: now + 86_400_000,
    });
  });
});

describe('handleHtml', () => {
  it('passes non-HTML content types through untouched (no fetch)', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));
    const ctx = htmlCtx({ contentType: 'application/json' });

    expect(await handleHtml(ctx, cache, makeConfig(fetchImpl))).toBe(ctx.html);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes a missing content type through untouched', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));
    const ctx = htmlCtx({ contentType: null });

    expect(await handleHtml(ctx, cache, makeConfig(fetchImpl))).toBe(ctx.html);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes every status other than exact 200 through untouched', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));
    const config = makeConfig(fetchImpl);

    for (const status of [199, 201, 204, 206, 299, 301, 304, 404, 500]) {
      const ctx = htmlCtx({ status });
      expect(await handleHtml(ctx, cache, config)).toBe(ctx.html);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes through untouched when the API key is missing', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));
    const ctx = htmlCtx();

    expect(await handleHtml(ctx, cache, makeConfig(fetchImpl, ''))).toBe(ctx.html);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails open when the fetch throws: original HTML served', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new TypeError('fetch failed')));
    const ctx = htmlCtx();

    expect(await handleHtml(ctx, cache, makeConfig(fetchImpl))).toBe(ctx.html);
  });

  it('fails open when there is no </head>: original HTML served', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200 }))
    );
    const ctx = htmlCtx({ html: '<body>headless page</body>' });

    expect(await handleHtml(ctx, cache, makeConfig(fetchImpl))).toBe(ctx.html);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fetch when the only </head> is inert raw text', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200 }))
    );
    const ctx = htmlCtx({ html: '<head><iframe>template </head> without an end tag' });

    expect(await handleHtml(ctx, cache, makeConfig(fetchImpl))).toBe(ctx.html);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('injects end-to-end: fetch → MemoryCache → snippet before </head>', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }))
    );
    const config = makeConfig(fetchImpl);
    const ctx = htmlCtx();

    const result = await handleHtml(ctx, cache, config);
    expect(result).toBe(`<html><head><title>t</title>${SNIPPET}</head><body>b</body></html>`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Second request for the same page is answered from cache.
    const again = await handleHtml(ctx, cache, config);
    expect(again).toBe(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
