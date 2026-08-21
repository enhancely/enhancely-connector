/**
 * Companion entrypoint tests: origin-response events with the Enhancely API
 * mocked via the core's `fetchImpl` config seam. The companion never fetches
 * the origin, so unlike the injector tests no local HTTP server is needed —
 * every upstream interaction is one Enhancely call at most.
 */
import type { CloudFrontResponseEvent, CloudFrontResultResponse } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAdapterConfigForTests,
  __setBakedConfigForTests,
  __setConfigOverridesForTests,
} from '../src/config.js';
import type { BakedConnectorConfig } from '../src/config.js';
import {
  handler,
  __resetCompanionStateForTests,
  __resetUpstreamMemoForTests,
} from '../src/companion.js';
import { makeEvent } from './fixtures.js';

// Keep the no-key path hermetic (never walk the AWS credential chain).
vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {}
  class GetParameterCommand {}
  return { SSMClient, GetParameterCommand };
});

const JSONLD_RAW = '{"@context":"https://schema.org","@type":"Article","headline":"Hi"}';
const STILL_PROCESSING = JSON.stringify({
  type: 'https://enhancely.ai/problems/still-processing',
  status: 202,
});
const TTL_MS = 60_000;

type MockCall = { url: string; init: RequestInit };
let calls: MockCall[];

function setUp(
  baked: Partial<BakedConnectorConfig>,
  responses: Array<() => Response | Promise<Response>>
): void {
  calls = [];
  let index = 0;
  const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next === undefined) throw new Error('mock exhausted');
    return Promise.resolve(next());
  };
  __setBakedConfigForTests({
    apiKey: 'sk-test-key',
    cacheTtlMs: TTL_MS,
    autoRegister: true,
    ...baked,
  });
  __setConfigOverridesForTests({ fetchImpl });
}

async function invokeCompanion(event: CloudFrontResponseEvent): Promise<CloudFrontResultResponse> {
  const result = await handler(event);
  return result as CloudFrontResultResponse;
}

function cacheControlOf(result: CloudFrontResultResponse): string | undefined {
  return result.headers?.['cache-control']?.[0]?.value;
}

beforeEach(() => {
  __resetCompanionStateForTests();
  __resetUpstreamMemoForTests();
});
afterEach(() => {
  __resetAdapterConfigForTests();
});

describe('companion — registration via the single register-or-revalidate POST', () => {
  it('registers an unknown HTML page with ONE POST carrying the page URL', async () => {
    setUp({}, [() => new Response('processing', { status: 201 })]);
    await invokeCompanion(makeEvent({ uri: '/pricing' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://app.enhancely.ai/api/v1/jsonld');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      url: 'https://www.example.com/pricing',
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/ld+json');
  });

  it('suppresses repeat POSTs for the same URL within the pending window', async () => {
    setUp({}, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '300' } }),
    ]);
    await invokeCompanion(makeEvent({ uri: '/pricing' }));
    await invokeCompanion(makeEvent({ uri: '/pricing' }));
    expect(calls).toHaveLength(1);
  });

  it('REGISTERS a Set-Cookie response (the injector injects those pages)', async () => {
    setUp({}, [() => new Response('processing', { status: 201 })]);
    await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'AWSALB=abc; Path=/',
        },
      })
    );
    expect(calls).toHaveLength(1);
  });

  it('registers even when the CloudFront copy is compressed (encoding ignored)', async () => {
    setUp({}, [() => new Response('processing', { status: 201 })]);
    await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'br',
        },
      })
    );
    expect(calls).toHaveLength(1);
  });

  it('uses the conditional GET instead when autoRegister is off (cap-only mode)', async () => {
    setUp({ autoRegister: false }, [() => new Response('not found', { status: 404 })]);
    await invokeCompanion(makeEvent({ uri: '/pricing' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.url).toContain('/api/v1/jsonld/');
    // 404 on the GET path with autoRegister disabled → no follow-up POST.
  });
});

describe('companion — gates (no Enhancely call, response untouched)', () => {
  const gateCases: Array<[string, Parameters<typeof makeEvent>[0]]> = [
    ['non-GET', { method: 'POST' }],
    ['non-200', { status: '404' }],
    ['non-HTML', { responseHeaders: { 'content-type': 'application/json' } }],
    ['legacy charset', { responseHeaders: { 'content-type': 'text/html; charset=iso-8859-1' } }],
    [
      'noindex',
      {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'x-robots-tag': 'noindex',
        },
      },
    ],
    ['no custom origin', { noCustomOrigin: true }],
    ['path escape', { uri: '/../secret', originPath: '/de' }],
    ['missing host', { host: null, originDomain: '' }],
  ];

  for (const [name, options] of gateCases) {
    it(`${name} → no call, byte-identical pass-through`, async () => {
      setUp({}, [() => new Response('never', { status: 500 })]);
      const event = makeEvent(options);
      const result = await invokeCompanion(event);
      expect(calls).toHaveLength(0);
      expect(result).toBe(event.Records[0]?.cf.response);
    });
  }

  it('excluded path → no call, untouched (checked before config work)', async () => {
    setUp({ excludePaths: ['/private/*'] }, [() => new Response('never', { status: 500 })]);
    const event = makeEvent({ uri: '/private/page' });
    const result = await invokeCompanion(event);
    expect(calls).toHaveLength(0);
    expect(result).toBe(event.Records[0]?.cf.response);
  });

  it('tripwire: X-Enhancely-Injected on the response → abstain entirely', async () => {
    setUp({}, [() => new Response('never', { status: 500 })]);
    const event = makeEvent({
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'x-enhancely-injected': '1',
      },
    });
    const result = await invokeCompanion(event);
    expect(calls).toHaveLength(0);
    expect(result).toBe(event.Records[0]?.cf.response);
  });
});

describe('companion — cache-lifetime capping', () => {
  it('caps a lifetime-less pass-through under the operator assertion', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const result = await invokeCompanion(makeEvent());
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=45, must-revalidate');
  });

  it('never caps without the assertion when the origin declared no lifetime', async () => {
    setUp({}, [() => new Response('processing', { status: 201 })]);
    const event = makeEvent();
    const result = await invokeCompanion(event);
    expect(result).toBe(event.Records[0]?.cf.response);
  });

  it('shortens an explicit origin lifetime without any assertion', async () => {
    setUp({}, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'max-age=3600',
        },
      })
    );
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=45, must-revalidate');
  });

  it('invalid Expires (e.g. "0") means already-stale: capped to s-maxage=0, never freshened', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          expires: '0',
        },
      })
    );
    // RFC 9111: invalid Expires = expired. The assertion path must not turn
    // that into 45 s of shared freshness.
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=0, must-revalidate');
  });

  it('Set-Cookie response: registered but NOT capped without the flag', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'AWSALB=abc; Path=/',
        },
      })
    );
    expect(calls).toHaveLength(1); // registered …
    expect(cacheControlOf(result)).toBeUndefined(); // … but not rewritten
  });

  it('Set-Cookie response IS capped under capSetCookieResponses', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400, capSetCookieResponses: true }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'AWSALB=abc; Path=/',
        },
      })
    );
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=45, must-revalidate');
    // The rewrite keeps the Set-Cookie itself untouched.
    expect(result.headers?.['set-cookie']?.[0]?.value).toBe('AWSALB=abc; Path=/');
  });

  it('private/no-store responses are never capped, flag or not', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400, capSetCookieResponses: true }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const event = makeEvent({
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
    const result = await invokeCompanion(event);
    expect(calls).toHaveLength(1); // still registered
    expect(result).toBe(event.Records[0]?.cf.response); // never rewritten
  });

  it('requests carrying credentials are registered but never capped', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400, capSetCookieResponses: true }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const event = makeEvent({ requestHeaders: { authorization: 'Basic abc' } });
    const result = await invokeCompanion(event);
    expect(calls).toHaveLength(1);
    expect(result).toBe(event.Records[0]?.cf.response);
  });

  it('strips validators when capping so a 304 cannot re-pin the uninjected body', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response('processing', { status: 201, headers: { 'Retry-After': '45' } }),
    ]);
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          etag: '"origin-etag"',
          'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
      })
    );
    expect(result.headers?.['etag']).toBeUndefined();
    expect(result.headers?.['last-modified']).toBeUndefined();
  });
});

describe('companion — ready-record skew and cache filling', () => {
  it('caps an uninjected response although the record is ready (skew outcome)', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response(JSONLD_RAW, { status: 200, headers: { ETag: '"v1"' } }),
    ]);
    const result = await invokeCompanion(makeEvent());
    // revalidate = cacheTtlMs → s-maxage = 60 (TTL_MS / 1000).
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=60, must-revalidate');
  });

  it('the fetched snippet fills the cache: the second event needs no call', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response(JSONLD_RAW, { status: 200, headers: { ETag: '"v1"' } }),
    ]);
    await invokeCompanion(makeEvent());
    await invokeCompanion(makeEvent());
    expect(calls).toHaveLength(1);
  });
});

describe('companion — resilience', () => {
  it('202 Problem-JSON is never mistaken for content', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => new Response(STILL_PROCESSING, { status: 202, headers: { 'Retry-After': '30' } }),
    ]);
    const result = await invokeCompanion(makeEvent());
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=30, must-revalidate');
  });

  it('a rejecting Enhancely call fails open (capped by the error backoff)', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 }, [
      () => {
        throw new TypeError('network down');
      },
    ]);
    const result = await invokeCompanion(makeEvent());
    // Core error backoff = 10 s.
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=10, must-revalidate');
  });

  it('a lookup that consumes the whole budget opens the global upstream memo', async () => {
    setUp({ timeoutMs: 20, assertedDefaultTtlSeconds: 86_400 }, [
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response('slow', { status: 500 })), 30)
        ),
    ]);
    await invokeCompanion(makeEvent({ uri: '/first' }));
    expect(calls).toHaveLength(1);

    // Different URL, same environment: parked — no upstream call, still capped.
    const second = await invokeCompanion(makeEvent({ uri: '/second' }));
    expect(calls).toHaveLength(1);
    const capValue = cacheControlOf(second);
    expect(capValue).toMatch(/^max-age=0, s-maxage=(\d+), must-revalidate$/);
    const sMaxage = Number(/s-maxage=(\d+)/.exec(capValue ?? '')?.[1]);
    expect(sMaxage).toBeGreaterThanOrEqual(1);
    expect(sMaxage).toBeLessThanOrEqual(10);
  });

  it('a thrown error inside the handler fails open to the original response', async () => {
    setUp({}, [() => new Response('processing', { status: 201 })]);
    const event = makeEvent();
    // Sabotage: a response object whose headers getter throws.
    Object.defineProperty(event.Records[0]?.cf.response, 'headers', {
      get() {
        throw new Error('boom');
      },
    });
    const result = await handler(event);
    expect(result).toBe(event.Records[0]?.cf.response);
  });
});
