import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryCache,
  buildScriptTag,
  defineConfig,
  getJsonLdSnippet,
  handleHtml,
  normalizeLite,
} from '../src/index.js';
import type { Fetcher, HtmlContext } from '../src/index.js';

const PAGE_URL = 'https://example.com/pricing';
const KEY = normalizeLite(PAGE_URL);
const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Product"}';
const SNIPPET = buildScriptTag(RAW_JSONLD);
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

  it('sends the RAW page URL to the API while caching under the normalized key', async () => {
    const cache = new MemoryCache();
    // Query string, http scheme and trailing slash must all reach the API
    // untouched — normalizeLite is for the local cache key ONLY.
    const rawUrl = 'http://example.com/pricing/?utm_source=x&b=2';
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }))
    );
    const config = makeConfig(fetchImpl);

    expect(await getJsonLdSnippet(rawUrl, cache, config)).toBe(SNIPPET);

    const requestedUrl = fetchImpl.mock.calls[0]?.[0];
    expect(requestedUrl).toBe(
      `${config.enhancelyBase}/api/v1/jsonld/${encodeURIComponent(rawUrl)}`
    );

    // …while the cache key is the lite-normalized URL.
    const key = normalizeLite(rawUrl);
    expect(key).toBe('https://example.com/pricing');
    expect(await cache.get(key)).toMatchObject({ jsonldRaw: RAW_JSONLD, etag: '"v1"' });
  });

  it('stores fresh data on 200 and serves the snippet', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }))
    );

    const snippet = await getJsonLdSnippet(PAGE_URL, cache, makeConfig(fetchImpl));

    expect(snippet).toBe(SNIPPET);
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
    expect(await getJsonLdSnippet(PAGE_URL, cache, config)).toBe(SNIPPET);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const entry = await cache.get(KEY);
    expect(entry?.jsonldRaw).toBe(RAW_JSONLD);
    expect(entry?.retryNotBefore).toBeUndefined();
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

  it('passes non-2xx statuses through untouched', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new Error('must not fetch')));
    const config = makeConfig(fetchImpl);

    for (const status of [199, 301, 304, 404, 500]) {
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
