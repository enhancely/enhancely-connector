import { describe, expect, it, vi } from 'vitest';

import { defineConfig, fetchJsonLd } from '../src/index.js';
import type { Fetcher } from '../src/index.js';

const PAGE_URL = 'https://example.com/pricing';
const RAW_JSONLD = '{"@context":"https://schema.org","@type":"Product","name":"\\u003cX\\u003e"}';

/** Build a config whose fetchImpl records the request and returns `response`. */
function withMockFetch(response: Response | Promise<Response>) {
  const fetchImpl = vi.fn<Fetcher>(() => Promise.resolve(response));
  const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl });
  return { config, fetchImpl };
}

function lastRequest(fetchImpl: ReturnType<typeof vi.fn<Fetcher>>): {
  input: string;
  init: RequestInit;
} {
  const call = fetchImpl.mock.calls.at(-1);
  if (!call) throw new Error('fetchImpl was never called');
  return { input: call[0], init: call[1] };
}

function headersOf(init: RequestInit): Record<string, string> {
  // The client always passes a plain object.
  return init.headers as Record<string, string>;
}

describe('fetchJsonLd — request shape', () => {
  it('calls GET {base}/api/v1/jsonld/{encodeURIComponent(url)}', async () => {
    const { config, fetchImpl } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    await fetchJsonLd(config, PAGE_URL);

    const { input, init } = lastRequest(fetchImpl);
    expect(init.method).toBe('GET');
    expect(input).toBe(`${config.enhancelyBase}/api/v1/jsonld/${encodeURIComponent(PAGE_URL)}`);
    // The raw URL is sent encoded — never a locally computed hash.
    expect(input).toContain('https%3A%2F%2Fexample.com%2Fpricing');
  });

  it('sends Authorization: Bearer <apiKey>', async () => {
    const { config, fetchImpl } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    await fetchJsonLd(config, PAGE_URL);
    expect(headersOf(lastRequest(fetchImpl).init).Authorization).toBe('Bearer sk-test-key');
  });

  it("sends Accept EXACTLY 'application/ld+json' (server does exact match)", async () => {
    const { config, fetchImpl } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    await fetchJsonLd(config, PAGE_URL);
    expect(headersOf(lastRequest(fetchImpl).init).Accept).toBe('application/ld+json');
  });

  it('omits If-None-Match when no etag is given', async () => {
    const { config, fetchImpl } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    await fetchJsonLd(config, PAGE_URL);
    expect(headersOf(lastRequest(fetchImpl).init)).not.toHaveProperty('If-None-Match');

    await fetchJsonLd(config, PAGE_URL, null);
    expect(headersOf(lastRequest(fetchImpl).init)).not.toHaveProperty('If-None-Match');
  });

  it('sends If-None-Match when an etag is given', async () => {
    const { config, fetchImpl } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    await fetchJsonLd(config, PAGE_URL, '"abc123"');
    expect(headersOf(lastRequest(fetchImpl).init)['If-None-Match']).toBe('"abc123"');
  });

  it('passes an abort signal on every call (timeout enforcement)', async () => {
    const { config, fetchImpl } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    await fetchJsonLd(config, PAGE_URL);
    expect(lastRequest(fetchImpl).init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchJsonLd — response handling', () => {
  it('200 → ok with body and etag', async () => {
    const { config } = withMockFetch(
      new Response(RAW_JSONLD, { status: 200, headers: { ETag: '"v1"' } })
    );
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'ok',
      jsonldRaw: RAW_JSONLD,
      etag: '"v1"',
    });
  });

  it('200 without ETag → ok with etag null', async () => {
    const { config } = withMockFetch(new Response(RAW_JSONLD, { status: 200 }));
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'ok',
      jsonldRaw: RAW_JSONLD,
      etag: null,
    });
  });

  it('304 → not-modified', async () => {
    const { config } = withMockFetch(new Response(null, { status: 304 }));
    expect(await fetchJsonLd(config, PAGE_URL, '"v1"')).toEqual({ status: 'not-modified' });
  });

  it('404 → not-found', async () => {
    const { config } = withMockFetch(new Response('', { status: 404 }));
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({ status: 'not-found' });
  });

  it('429 with Retry-After → rate-limited with seconds', async () => {
    const { config } = withMockFetch(
      new Response('', { status: 429, headers: { 'Retry-After': '17' } })
    );
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'rate-limited',
      retryAfterSeconds: 17,
    });
  });

  it('429 without Retry-After → rate-limited with null', async () => {
    const { config } = withMockFetch(new Response('', { status: 429 }));
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'rate-limited',
      retryAfterSeconds: null,
    });
  });

  it('non-ok status (500) → error', async () => {
    const { config } = withMockFetch(new Response('boom', { status: 500 }));
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({ status: 'error', reason: 'http-500' });
  });

  it('fetch rejecting with an AbortError (timeout) → error, never throws', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(abortError));
    const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl });

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'AbortError',
    });
  });

  it('fetch rejecting with a network error → error, never throws', async () => {
    const fetchImpl = vi.fn<Fetcher>(() => Promise.reject(new TypeError('fetch failed')));
    const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl });

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'TypeError',
    });
  });

  it('200 with an empty body → error (nothing to inject)', async () => {
    const { config } = withMockFetch(new Response('   ', { status: 200 }));
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'empty-body',
    });
  });
});
