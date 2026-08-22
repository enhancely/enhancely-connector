/**
 * The paired origin-response companion is cache-cap-only. These tests make the
 * request-economy invariant executable: no path can reach Enhancely.
 */
import type { CloudFrontResponseEvent, CloudFrontResultResponse } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAdapterConfigForTests,
  __setBakedConfigForTests,
  __setConfigOverridesForTests,
} from '../src/config.js';
import type { BakedConnectorConfig } from '../src/config.js';
import { handler } from '../src/companion.js';
import { makeEvent } from './fixtures.js';

// Keep the missing-key path hermetic (never walk the AWS credential chain).
vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {}
  class GetParameterCommand {}
  return { SSMClient, GetParameterCommand };
});

let enhancelyFetch: ReturnType<typeof vi.fn>;

function setUp(baked: Partial<BakedConnectorConfig> = {}): void {
  enhancelyFetch = vi.fn(async () => {
    throw new Error('the cache-cap-only companion must never call Enhancely');
  });
  __setBakedConfigForTests({
    apiKey: 'sk-test-key',
    cacheTtlMs: 60_000,
    nonPageMemoTtlMs: 60_000,
    autoRegister: true,
    ...baked,
  });
  __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });
}

async function invokeCompanion(event: CloudFrontResponseEvent): Promise<CloudFrontResultResponse> {
  return (await handler(event)) as CloudFrontResultResponse;
}

function cacheControlOf(result: CloudFrontResultResponse): string | undefined {
  return result.headers?.['cache-control']?.[0]?.value;
}

beforeEach(() => {
  __resetAdapterConfigForTests();
  setUp();
});

afterEach(() => {
  __resetAdapterConfigForTests();
});

describe('companion — zero Enhancely calls', () => {
  it('caps eligible handback HTML without any Enhancely lookup or registration', async () => {
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'max-age=3600',
        },
      })
    );

    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=60, must-revalidate');
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('ignores autoRegister because this trigger can never prove body injectability', async () => {
    setUp({ autoRegister: false });
    await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'max-age=3600',
        },
      })
    );
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('uses only the local config-retry cap when the API key is unavailable', async () => {
    __resetAdapterConfigForTests();
    setUp({ apiKey: 'not-a-valid-key', assertedDefaultTtlSeconds: 3600 });

    const result = await invokeCompanion(makeEvent());

    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=30, must-revalidate');
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });
});

describe('companion — cache-lifetime capping', () => {
  it('caps a lifetime-less pass-through only under the operator assertion', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 });
    const result = await invokeCompanion(makeEvent());
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=60, must-revalidate');
  });

  it('does not create cacheability without an explicit lifetime or assertion', async () => {
    const event = makeEvent();
    const result = await invokeCompanion(event);
    expect(result).toBe(event.Records[0]?.cf.response);
  });

  it('preserves an already shorter explicit origin lifetime', async () => {
    const result = await invokeCompanion(
      makeEvent({
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'max-age=15',
        },
      })
    );
    expect(cacheControlOf(result)).toBe('max-age=0, s-maxage=15, must-revalidate');
  });

  it('does not cap Set-Cookie unless the operator explicitly allows it', async () => {
    setUp({ assertedDefaultTtlSeconds: 86_400 });
    const event = makeEvent({
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'session=abc; Path=/',
      },
    });
    expect(await invokeCompanion(event)).toBe(event.Records[0]?.cf.response);

    __resetAdapterConfigForTests();
    setUp({ assertedDefaultTtlSeconds: 86_400, capSetCookieResponses: true });
    const capped = await invokeCompanion(event);
    expect(cacheControlOf(capped)).toBe('max-age=0, s-maxage=60, must-revalidate');
  });

  it.each([
    ['request Cookie', { requestHeaders: { cookie: 'session=abc' } }],
    ['request Authorization', { requestHeaders: { authorization: 'Bearer test' } }],
    [
      'private response',
      {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, max-age=3600',
        },
      },
    ],
    [
      'no-store response',
      {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, max-age=3600',
        },
      },
    ],
  ])('does not rewrite %s', async (_name, options) => {
    const event = makeEvent(options);
    const result = await invokeCompanion(event);
    expect(result).toBe(event.Records[0]?.cf.response);
  });
});

describe('companion — permanent gates stay untouched', () => {
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
    [
      'no-transform',
      {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600, no-transform',
        },
      },
    ],
    [
      'attachment',
      {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': 'attachment; filename="page.html"',
        },
      },
    ],
    ['known non-HTML extension', { uri: '/bundle.css' }],
    ['Range request', { requestHeaders: { range: 'bytes=0-99' } }],
    ['no custom origin', { noCustomOrigin: true }],
    ['path escape', { uri: '/../secret', originPath: '/de' }],
  ];

  for (const [name, options] of gateCases) {
    it(`${name} → untouched and no Enhancely call`, async () => {
      const event = makeEvent(options);
      const result = await invokeCompanion(event);
      expect(result).toBe(event.Records[0]?.cf.response);
      expect(enhancelyFetch).not.toHaveBeenCalled();
    });
  }

  it('excluded path is checked before config work', async () => {
    setUp({ excludePaths: ['/private/*'] });
    const event = makeEvent({ uri: '/private/page' });
    const result = await invokeCompanion(event);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('an injected marker is a never-touch invariant', async () => {
    const event = makeEvent({
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'x-enhancely-injected': '1',
      },
    });
    const result = await invokeCompanion(event);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });
});

describe('companion — fail-open', () => {
  it('returns undefined for a malformed event without records', async () => {
    await expect(handler({ Records: [] } as unknown as CloudFrontResponseEvent)).resolves.toBe(
      undefined
    );
  });

  it('returns the original response if an unexpected error occurs', async () => {
    const event = makeEvent();
    const response = event.Records[0]?.cf.response;
    if (response === undefined) throw new Error('fixture missing response');
    response.headers = null as never;
    await expect(handler(event)).resolves.toBe(response);
  });
});
