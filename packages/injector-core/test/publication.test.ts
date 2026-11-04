import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryCache,
  buildScriptTag,
  defineConfig,
  fetchJsonLd,
  getJsonLdLookup,
  getJsonLdRegisterLookup,
  registerOrRevalidate,
} from '../src/index.js';
import type { Fetcher } from '../src/index.js';

const URL = 'https://example.com/page';
const RAW = '{"@type":"WebPage","name":"Published"}';
const TTL = 60_000;
const NOW = 1_800_000_000_000;
const STALE = { jsonldRaw: RAW, etag: '"v1"', storedAt: NOW - TTL - 1 };
const TYPE_BASE = 'https://api.enhancely.ai/problems/';

function problem(status: number, type: string): Response {
  return Response.json(
    { status, type: TYPE_BASE + type, detail: 'private diagnostic', page_id: 'private-id' },
    { status }
  );
}

const withdrawals = [
  [
    'GET ignored 304',
    getJsonLdLookup,
    () => new Response(null, { status: 304, headers: { 'X-JsonLd-Status': 'ignored' } }),
  ],
  [
    'POST ignored 412',
    getJsonLdRegisterLookup,
    () => new Response(null, { status: 412, headers: { 'X-JsonLd-Status': 'ignored' } }),
  ],
  ['GET retired 409', getJsonLdLookup, () => problem(409, 'page-retired')],
  ['POST retired 409', getJsonLdRegisterLookup, () => problem(409, 'page-retired')],
  ['GET withdrawn 404', getJsonLdLookup, () => problem(404, 'jsonld-withdrawn')],
  ['POST withdrawn 404', getJsonLdRegisterLookup, () => problem(404, 'jsonld-withdrawn')],
] as const;

afterEach(() => vi.restoreAllMocks());

describe('publication state revalidation', () => {
  it.each(withdrawals)(
    '%s removes a stale snippet and ETag for a full TTL in one call',
    async (_label, lookup, response) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const cache = new MemoryCache();
      await cache.set(URL, STALE);
      const fetchImpl = vi.fn<Fetcher>(async () => response());
      const config = defineConfig({ apiKey: 'sk-test', fetchImpl, cacheTtlMs: TTL });
      expect(await lookup(URL, cache, config)).toEqual({ snippet: null, revalidateInMs: TTL });
      expect(await cache.get(URL)).toEqual({ jsonldRaw: null, etag: null, storedAt: NOW });
      expect(fetchImpl.mock.calls[0]?.[1].headers).toMatchObject({ 'If-None-Match': '"v1"' });
      expect(await lookup(URL, cache, config)).toEqual({ snippet: null, revalidateInMs: TTL });
      expect(fetchImpl).toHaveBeenCalledOnce();

      // Withdrawal is rechecked after its TTL, so an explicitly restored page
      // can publish again. The withdrawn version's ETag must not be reused.
      vi.mocked(Date.now).mockReturnValue(NOW + TTL);
      fetchImpl.mockResolvedValueOnce(new Response(RAW, { headers: { ETag: '"v2"' } }));
      expect((await lookup(URL, cache, config)).snippet).toBe(buildScriptTag(RAW, '"v2"'));
      expect(fetchImpl.mock.calls[1]?.[1].headers).not.toHaveProperty('If-None-Match');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it.each([getJsonLdLookup, getJsonLdRegisterLookup])(
    'retains stale content for unrelated 409 conflicts',
    async (lookup) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const cache = new MemoryCache();
      await cache.set(URL, STALE);
      const fetchImpl = vi.fn<Fetcher>(async () => problem(409, 'conflict'));
      const config = defineConfig({ apiKey: 'sk-test', fetchImpl, cacheTtlMs: TTL });
      expect((await lookup(URL, cache, config)).snippet).toBe(buildScriptTag(RAW, STALE.etag));
      expect(await cache.get(URL)).toEqual({ ...STALE, retryNotBefore: NOW + 10_000 });
    }
  );

  it('retains stale content for an ordinary POST 404', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const cache = new MemoryCache();
    await cache.set(URL, STALE);
    const config = defineConfig({
      apiKey: 'sk-test',
      cacheTtlMs: TTL,
      fetchImpl: async () => problem(404, 'not-found'),
    });
    expect((await getJsonLdRegisterLookup(URL, cache, config)).snippet).toBe(
      buildScriptTag(RAW, STALE.etag)
    );
    expect(await cache.get(URL)).toEqual({ ...STALE, retryNotBefore: NOW + 10_000 });
  });

  it.each(withdrawals)(
    '%s preserves newer successful content during a race',
    async (_label, lookup, response) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const cache = new MemoryCache();
      await cache.set(URL, STALE);
      let finish!: (response: Response) => void;
      const fetchImpl = vi.fn<Fetcher>(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
      const config = defineConfig({ apiKey: 'sk-test', fetchImpl, cacheTtlMs: TTL });
      const pending = lookup(URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
      const newer = { jsonldRaw: '{"name":"Restored"}', etag: '"v2"', storedAt: NOW };
      await cache.set(URL, newer);
      finish(response());
      expect((await pending).snippet).toBe(buildScriptTag(newer.jsonldRaw, newer.etag));
      expect(await cache.get(URL)).toEqual(newer);
    }
  );

  it.each(withdrawals)(
    '%s removes stale content despite a racing retry-only memo',
    async (_label, lookup, response) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const cache = new MemoryCache();
      await cache.set(URL, STALE);
      let finish!: (response: Response) => void;
      const fetchImpl = vi.fn<Fetcher>(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
      const config = defineConfig({ apiKey: 'sk-test', fetchImpl, cacheTtlMs: TTL });
      const pending = lookup(URL, cache, config);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
      await cache.set(URL, { ...STALE, retryNotBefore: NOW + 86_400_000 });
      finish(response());
      expect(await pending).toEqual({ snippet: null, revalidateInMs: 86_400_000 });
      expect(await cache.get(URL)).toEqual({
        jsonldRaw: null,
        etag: null,
        storedAt: NOW,
        retryNotBefore: NOW + 86_400_000,
      });
    }
  );
});

describe.each([fetchJsonLd, registerOrRevalidate])(
  'bounded withdrawal Problem validation (%s)',
  (call) => {
    it.each([404, 409])(
      'recognizes only canonical identity for HTTP %s without leaking metadata',
      async (status) => {
        const type = status === 404 ? 'jsonld-withdrawn' : 'page-retired';
        const config = defineConfig({
          apiKey: 'sk-test',
          fetchImpl: async () => problem(status, type),
        });
        expect(await call(config, URL)).toEqual({
          status: 'terminal-negative',
          reason: 'withdrawn',
        });
        const rfc = new Response(JSON.stringify({ status, type: TYPE_BASE + type }), {
          status,
          headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
        });
        expect(await call({ ...config, fetchImpl: async () => rfc }, URL)).toEqual({
          status: 'terminal-negative',
          reason: 'withdrawn',
        });
      }
    );

    it.each([
      { status: 409, type: 'https://foreign.example/problems/page-retired' },
      { status: 404, type: TYPE_BASE + 'page-retired' },
      { status: '409', type: TYPE_BASE + 'page-retired' },
      { type: TYPE_BASE + 'page-retired' },
      { status: 409, type: TYPE_BASE + 'conflict', detail: 'page-retired' },
      { status: 409, type: TYPE_BASE + 'page-reactivation-required' },
    ])('leaves an unproven conflict transient: %j', async (body) => {
      const config = defineConfig({
        apiKey: 'sk-test',
        fetchImpl: async () => Response.json(body, { status: 409 }),
      });
      expect(await call(config, URL)).toEqual({ status: 'error', reason: 'http-409' });
    });

    it.each(['not JSON', 'null', '[]', '{"type":'])(
      'fails open for malformed Problem JSON: %s',
      async (body) => {
        const config = defineConfig({
          apiKey: 'sk-test',
          fetchImpl: async () =>
            new Response(body, { status: 409, headers: { 'Content-Type': 'application/json' } }),
        });
        expect(await call(config, URL)).toEqual({ status: 'error', reason: 'http-409' });
      }
    );

    it('requires a JSON media type', async () => {
      const config = defineConfig({
        apiKey: 'sk-test',
        fetchImpl: async () =>
          new Response(JSON.stringify({ status: 409, type: TYPE_BASE + 'page-retired' }), {
            status: 409,
          }),
      });
      expect(await call(config, URL)).toEqual({ status: 'error', reason: 'http-409' });
    });

    it.each([undefined, '1', '9000'])(
      'enforces the streamed byte cap with Content-Length %s',
      async (length) => {
        const cancel = vi.fn();
        const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
          controller.enqueue(new TextEncoder().encode('é'.repeat(4097)))
        );
        const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (length !== undefined) headers['Content-Length'] = length;
        const config = defineConfig({
          apiKey: 'sk-test',
          fetchImpl: async () => new Response(body, { status: 409, headers }),
        });
        expect(await call(config, URL)).toEqual({ status: 'error', reason: 'http-409' });
        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).toHaveBeenCalledTimes(length === '9000' ? 0 : 1);
      }
    );

    it('cancels a stalled Problem body at the request deadline', async () => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      });
      const config = defineConfig({
        apiKey: 'sk-test',
        timeoutMs: 20,
        fetchImpl: async () =>
          new Response(body, { status: 409, headers: { 'Content-Type': 'application/json' } }),
      });
      expect(await call(config, URL)).toEqual({ status: 'error', reason: 'http-409' });
      expect(cancel).toHaveBeenCalledOnce();
    });
  }
);
