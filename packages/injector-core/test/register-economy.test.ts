import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryCache,
  buildScriptTag,
  defineConfig,
  fetchJsonLd,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  getJsonLdSnippet,
  normalizeLite,
  registerOrRevalidate,
} from '../src/index.js';
import type { Fetcher } from '../src/index.js';

const PAGE_URL = 'https://example.com/pricing';
const KEY = normalizeLite(PAGE_URL);
const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Product"}';
const TTL_MS = 60_000;

/** The server's 202 body — a Problem JSON that must NEVER be injected. */
const STILL_PROCESSING_BODY = JSON.stringify({
  type: 'https://enhancely.ai/problems/still-processing',
  title: 'Still Processing',
  status: 202,
});

function withMockFetch(responses: Array<Response | (() => Response)>) {
  let call = 0;
  const fetchImpl = vi.fn<Fetcher>(() => {
    const next = responses[Math.min(call++, responses.length - 1)];
    if (next === undefined) throw new Error('mock exhausted');
    return Promise.resolve(typeof next === 'function' ? next() : next);
  });
  const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl, cacheTtlMs: TTL_MS });
  return { config, fetchImpl };
}

function lastInit(fetchImpl: ReturnType<typeof vi.fn<Fetcher>>): RequestInit {
  const call = fetchImpl.mock.calls.at(-1);
  if (!call) throw new Error('fetchImpl was never called');
  return call[1];
}

describe('fetchJsonLd — P0: 202 / ignored / empty-record are not snippets', () => {
  it('202 with Retry-After → pending with the hint, body discarded', async () => {
    const { config } = withMockFetch([
      new Response(STILL_PROCESSING_BODY, { status: 202, headers: { 'Retry-After': '30' } }),
    ]);
    const result = await fetchJsonLd(config, PAGE_URL);
    expect(result).toEqual({ status: 'pending', retryAfterSeconds: 30 });
  });

  it('202 without Retry-After → pending with null hint', async () => {
    const { config } = withMockFetch([new Response(STILL_PROCESSING_BODY, { status: 202 })]);
    const result = await fetchJsonLd(config, PAGE_URL);
    expect(result).toEqual({ status: 'pending', retryAfterSeconds: null });
  });

  it('200 + X-JsonLd-Status: ignored → terminal-negative, body discarded', async () => {
    const { config } = withMockFetch([
      new Response(RAW_JSONLD, { status: 200, headers: { 'X-JsonLd-Status': 'ignored' } }),
    ]);
    const result = await fetchJsonLd(config, PAGE_URL);
    expect(result).toEqual({ status: 'terminal-negative', reason: 'ignored' });
  });

  it('200 with body {} (fresh failed/limit-reached record) → terminal-negative', async () => {
    const { config } = withMockFetch([new Response('{}', { status: 200 })]);
    const result = await fetchJsonLd(config, PAGE_URL);
    expect(result).toEqual({ status: 'terminal-negative', reason: 'empty-record' });
  });

  it('a 2xx status other than 200 is an error, never a snippet', async () => {
    const { config } = withMockFetch([new Response('created', { status: 201 })]);
    const result = await fetchJsonLd(config, PAGE_URL);
    expect(result).toEqual({ status: 'error', reason: 'http-201' });
  });

  it('429 without Retry-After honors RateLimit-Reset as the backoff hint', async () => {
    const { config } = withMockFetch([
      new Response('slow down', { status: 429, headers: { 'RateLimit-Reset': '42' } }),
    ]);
    const result = await fetchJsonLd(config, PAGE_URL);
    expect(result).toEqual({ status: 'rate-limited', retryAfterSeconds: 42 });
  });

  it('the Problem-JSON 202 body is never injected end-to-end', async () => {
    const { config } = withMockFetch([
      new Response(STILL_PROCESSING_BODY, { status: 202, headers: { 'Retry-After': '30' } }),
    ]);
    const snippet = await getJsonLdSnippet(PAGE_URL, new MemoryCache(), config);
    expect(snippet).toBeNull();
  });
});

describe('registerOrRevalidate — request shape', () => {
  it('POSTs {url} with Accept ld+json and If-None-Match when an ETag is held', async () => {
    const { config, fetchImpl } = withMockFetch([new Response(null, { status: 412 })]);
    await registerOrRevalidate(config, KEY, '"abc123"');
    const init = lastInit(fetchImpl);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ url: KEY });
    const headers = init.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/ld+json');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['If-None-Match']).toBe('"abc123"');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://app.enhancely.ai/api/v1/jsonld');
  });

  it('omits If-None-Match without an ETag', async () => {
    const { config, fetchImpl } = withMockFetch([new Response(null, { status: 201 })]);
    await registerOrRevalidate(config, KEY);
    const headers = lastInit(fetchImpl).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();
  });
});

describe('registerOrRevalidate — status map', () => {
  const cases: Array<[Response, unknown]> = [
    [new Response(null, { status: 412 }), { status: 'not-modified' }],
    [new Response('processing', { status: 201 }), { status: 'pending', retryAfterSeconds: null }],
    [
      new Response(STILL_PROCESSING_BODY, { status: 202, headers: { 'Retry-After': '25' } }),
      { status: 'pending', retryAfterSeconds: 25 },
    ],
    [
      new Response('denylisted', { status: 400 }),
      { status: 'terminal-negative', reason: 'rejected' },
    ],
    [
      new Response('monthly limit', { status: 429, headers: { 'Retry-After': '604800' } }),
      { status: 'rate-limited', retryAfterSeconds: 604800 },
    ],
    [
      new Response('hard cap', { status: 403, headers: { 'Retry-After': '86400' } }),
      { status: 'registration-limited', retryAfterSeconds: 86400 },
    ],
    // 403 without Retry-After (unvalidated-domain limit): a durable
    // operator-state — must rest a full TTL, never enter the 10 s error loop.
    [
      new Response('domain not validated', { status: 403 }),
      { status: 'terminal-negative', reason: 'rejected' },
    ],
    [new Response('nope', { status: 500 }), { status: 'error', reason: 'http-500' }],
    [
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v2"' } }),
      { status: 'ok', jsonldRaw: RAW_JSONLD, etag: '"v2"' },
    ],
    [new Response('{}', { status: 200 }), { status: 'terminal-negative', reason: 'empty-record' }],
    [
      new Response(RAW_JSONLD, { status: 200, headers: { 'X-JsonLd-Status': 'ignored' } }),
      { status: 'terminal-negative', reason: 'ignored' },
    ],
  ];

  for (const [response, expected] of cases) {
    it(`maps ${response.status}${response.headers.get('x-jsonld-status') ?? ''}${
      response.headers.get('retry-after') ? '+Retry-After' : ''
    } correctly`, async () => {
      const { config } = withMockFetch([response]);
      expect(await registerOrRevalidate(config, KEY)).toEqual(expected);
    });
  }

  it('a rejecting fetch is an error result, never a throw', async () => {
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new TypeError('boom')));
    const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl });
    expect(await registerOrRevalidate(config, KEY)).toEqual({
      status: 'error',
      reason: 'TypeError',
    });
  });
});

describe('getJsonLdLookup — pending & terminal-negative economics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pending with Retry-After re-polls exactly then (capped below the TTL)', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response(STILL_PROCESSING_BODY, { status: 202, headers: { 'Retry-After': '30' } }),
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdLookup(PAGE_URL, cache, config);
    expect(first.snippet).toBeNull();
    expect(first.revalidateInMs).toBe(30_000);

    // Within the hint: answered locally, no upstream call.
    vi.advanceTimersByTime(10_000);
    await getJsonLdLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the hint: re-polls and picks up the now-ready record.
    vi.advanceTimersByTime(21_000);
    const third = await getJsonLdLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(third.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));
  });

  it('caps a huge Retry-After at cacheTtlMs', async () => {
    const { config } = withMockFetch([
      new Response(STILL_PROCESSING_BODY, { status: 202, headers: { 'Retry-After': '999999' } }),
    ]);
    const result = await getJsonLdLookup(PAGE_URL, new MemoryCache(), config);
    expect(result.revalidateInMs).toBe(TTL_MS);
  });

  it('pending without a hint rests for a full TTL', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response(STILL_PROCESSING_BODY, { status: 202 }),
    ]);
    const cache = new MemoryCache();
    const result = await getJsonLdLookup(PAGE_URL, cache, config);
    expect(result.revalidateInMs).toBe(TTL_MS);

    vi.advanceTimersByTime(TTL_MS - 1);
    await getJsonLdLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('terminal-negative NEVER triggers auto-registration', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response(RAW_JSONLD, { status: 200, headers: { 'X-JsonLd-Status': 'ignored' } }),
    ]);
    const cache = new MemoryCache();
    const registerConfig = { ...config, autoRegister: true };

    const result = await getJsonLdLookup(PAGE_URL, cache, registerConfig);
    expect(result.snippet).toBeNull();
    expect(result.revalidateInMs).toBe(TTL_MS);
    // Exactly one call (the GET) — no follow-up register POST.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pending drops a stale positive entry (dead record incarnation)', async () => {
    const { config } = withMockFetch([
      new Response(STILL_PROCESSING_BODY, { status: 202, headers: { 'Retry-After': '30' } }),
    ]);
    const cache = new MemoryCache();
    await cache.set(KEY, {
      jsonldRaw: RAW_JSONLD,
      etag: '"old"',
      storedAt: Date.now() - TTL_MS - 1,
    });
    const result = await getJsonLdLookup(PAGE_URL, cache, config);
    expect(result.snippet).toBeNull();
    expect((await cache.get(KEY))?.jsonldRaw).toBeNull();
  });
});

describe('getJsonLdRegisterLookup — single-POST register economy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unknown URL: ONE POST registers it; the negative entry suppresses repeats', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(first.snippet).toBeNull();
    expect(first.revalidateInMs).toBe(45_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lastInit(fetchImpl).method).toBe('POST');

    vi.advanceTimersByTime(30_000);
    await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('known-ready URL: the POST fills the cache so the next lookup is local', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(first.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));

    const second = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(second.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The SAME cache serves the GET-based lookup path too (shared shape).
    const viaGet = await getJsonLdLookup(PAGE_URL, cache, config);
    expect(viaGet.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('revalidates with If-None-Match after TTL expiry; 412 refreshes the entry', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }),
      new Response(null, { status: 412 }),
    ]);
    const cache = new MemoryCache();

    await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    vi.advanceTimersByTime(TTL_MS + 1);

    const revalidated = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(revalidated.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((lastInit(fetchImpl).headers as Record<string, string>)['If-None-Match']).toBe('"v1"');

    // 412 refreshed storedAt: fresh again for another TTL.
    await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors a day-scale Retry-After on 403 far beyond the 60 s lookup cap', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response('hard cap', { status: 403, headers: { 'Retry-After': '7200' } }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(first.snippet).toBeNull();

    // One hour later — still parked, no re-POST.
    vi.advanceTimersByTime(3_600_000);
    await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the Retry-After window the next view retries.
    vi.advanceTimersByTime(3_600_001);
    await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a 403 without Retry-After rests a full TTL instead of the 10 s error loop', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response('domain not validated', { status: 403 }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(first.snippet).toBeNull();
    expect(first.revalidateInMs).toBe(TTL_MS);

    // 30 s later (three error-backoff windows): still resting, no re-POST.
    vi.advanceTimersByTime(30_000);
    await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps a beyond-bound Retry-After at MAX_REGISTER_BACKOFF (86400 s)', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response('hard cap', { status: 403, headers: { 'Retry-After': '999999999' } }),
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(first.revalidateInMs).toBe(86_400_000);

    vi.advanceTimersByTime(86_400_001);
    const second = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(second.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejected registration (400) rests a full TTL, then self-heals', async () => {
    const { config, fetchImpl } = withMockFetch([
      new Response('hostname mismatch', { status: 400 }),
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } }),
    ]);
    const cache = new MemoryCache();

    const first = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(first.snippet).toBeNull();
    expect(first.revalidateInMs).toBe(TTL_MS);

    vi.advanceTimersByTime(TTL_MS + 1);
    const second = await getJsonLdRegisterLookup(PAGE_URL, cache, config);
    expect(second.snippet).toBe(buildScriptTag(RAW_JSONLD, '"v1"'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
