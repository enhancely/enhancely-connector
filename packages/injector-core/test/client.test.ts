import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_JSONLD_BYTES,
  defineConfig,
  fetchJsonLd,
  registerJsonLd,
} from '../src/index.js';
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

function streamingResponse(
  chunks: Uint8Array[],
  init: ResponseInit = {}
): { response: Response; cancel: ReturnType<typeof vi.fn>; pulls: ReturnType<typeof vi.fn> } {
  let index = 0;
  const cancel = vi.fn();
  const pulls = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls();
        const chunk = chunks[index++];
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
      cancel(reason) {
        cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return { response: new Response(body, init), cancel, pulls };
}

describe('defineConfig — JSON-LD body limit', () => {
  it('defaults to the exported conservative hard maximum', () => {
    expect(defineConfig({ apiKey: 'sk-test-key' }).maxJsonLdBytes).toBe(DEFAULT_MAX_JSONLD_BYTES);
  });

  it('allows a lower per-deployment limit but rejects invalid or unsafe values', () => {
    expect(defineConfig({ apiKey: 'sk-test-key', maxJsonLdBytes: 1024 }).maxJsonLdBytes).toBe(1024);
    expect(() => defineConfig({ apiKey: 'sk-test-key', maxJsonLdBytes: 0 })).toThrow(RangeError);
    expect(() =>
      defineConfig({ apiKey: 'sk-test-key', maxJsonLdBytes: DEFAULT_MAX_JSONLD_BYTES + 1 })
    ).toThrow(RangeError);
  });
});

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

  it('invalid timeout configuration fails open before fetch instead of throwing', async () => {
    const fetchImpl = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(RAW_JSONLD, { status: 200 }))
    );
    const config = defineConfig({ apiKey: 'sk-test-key', timeoutMs: -1, fetchImpl });

    await expect(fetchJsonLd(config, PAGE_URL)).resolves.toEqual({
      status: 'error',
      reason: 'RangeError',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a successful response whose body is already locked fails open', async () => {
    const response = new Response(RAW_JSONLD, { status: 200 });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('expected a response body');
    const { config } = withMockFetch(response);

    await expect(fetchJsonLd(config, PAGE_URL)).resolves.toEqual({
      status: 'error',
      reason: 'body-read-failed',
    });
    await reader.cancel();
    reader.releaseLock();
  });

  it('200 with an empty body → error (nothing to inject)', async () => {
    const { config } = withMockFetch(new Response('   ', { status: 200 }));
    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'empty-body',
    });
  });

  it('accepts a streamed body exactly at the configured UTF-8 byte limit', async () => {
    const raw = '{"name":"€"}';
    const bytes = new TextEncoder().encode(raw);
    const { response } = streamingResponse([bytes.slice(0, 5), bytes.slice(5)], { status: 200 });
    const fetchImpl = vi.fn<Fetcher>(() => Promise.resolve(response));
    const config = defineConfig({
      apiKey: 'sk-test-key',
      fetchImpl,
      maxJsonLdBytes: bytes.byteLength,
    });

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'ok',
      jsonldRaw: raw,
      etag: null,
    });
  });

  it('rejects and cancels immediately when Content-Length exceeds the cap', async () => {
    const { response, cancel, pulls } = streamingResponse([new TextEncoder().encode('not read')], {
      status: 200,
      headers: { 'Content-Length': '9' },
    });
    const fetchImpl = vi.fn<Fetcher>(() => Promise.resolve(response));
    const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl, maxJsonLdBytes: 8 });

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'body-too-large',
    });
    expect(cancel).toHaveBeenCalledWith('body-too-large');
    expect(pulls).not.toHaveBeenCalled();
  });

  it('enforces the byte cap while streaming when Content-Length is absent or wrong', async () => {
    const { response, cancel } = streamingResponse(
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      {
        status: 200,
        // Deliberately lies; the streamed byte count remains authoritative.
        headers: { 'Content-Length': '1' },
      }
    );
    const fetchImpl = vi.fn<Fetcher>(() => Promise.resolve(response));
    const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl, maxJsonLdBytes: 5 });

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'body-too-large',
    });
    expect(cancel).toHaveBeenCalledWith('body-too-large');
  });

  it('keeps the request timeout active while the response body stream is stalled', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel(reason) {
        cancel(reason);
      },
    });
    const fetchImpl = vi.fn<Fetcher>(() => Promise.resolve(new Response(body, { status: 200 })));
    const config = defineConfig({
      apiKey: 'sk-test-key',
      fetchImpl,
      timeoutMs: 20,
    });

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'TimeoutError',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels non-success response bodies instead of leaving them unread', async () => {
    const { response, cancel } = streamingResponse([new Uint8Array([1, 2, 3])], { status: 500 });
    const { config } = withMockFetch(response);

    expect(await fetchJsonLd(config, PAGE_URL)).toEqual({
      status: 'error',
      reason: 'http-500',
    });
    expect(cancel).toHaveBeenCalledWith('http-500');
  });
});

describe('registerJsonLd — response body cleanup', () => {
  it('cancels the unused response body for both accepted and rejected registrations', async () => {
    const accepted = streamingResponse([new Uint8Array([1])], { status: 201 });
    const rejected = streamingResponse([new Uint8Array([2])], { status: 500 });
    const fetchImpl = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(accepted.response)
      .mockResolvedValueOnce(rejected.response);
    const config = defineConfig({ apiKey: 'sk-test-key', fetchImpl });

    expect(await registerJsonLd(config, PAGE_URL)).toBe(true);
    expect(await registerJsonLd(config, PAGE_URL)).toBe(false);
    expect(accepted.cancel).toHaveBeenCalledWith('body-unused');
    expect(rejected.cancel).toHaveBeenCalledWith('http-500');
  });
});
