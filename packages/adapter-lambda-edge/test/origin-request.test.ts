/**
 * origin-request handler tests: a REAL local node:http origin (so the actual
 * fetch, Host header and header pass-through are exercised), with the Enhancely
 * API mocked through the core's `fetchImpl` seam — same approach as
 * handler.test.ts.
 *
 * The load-bearing assertions here are the ones that differ from the
 * origin-response trigger:
 *  - origin hit COUNT (0 without a snippet, exactly 1 with one),
 *  - pass-through returns the REQUEST, not a response,
 *  - per-request state (Set-Cookie, no-store) is injected rather than skipped,
 *  - the generated response carries the origin's own headers, minus the ones
 *    CloudFront forbids and the ones that no longer describe the body.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudFrontResultResponse,
  Context,
} from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAdapterConfigForTests,
  __setBakedConfigForTests,
  __setConfigOverridesForTests,
} from '../src/config.js';
import { MAX_ORIGIN_BODY_BYTES } from '../src/shared.js';
import {
  handler,
  __resetOriginRequestStateForTests,
  __resetUpstreamMemoForTests,
} from '../src/origin-request.js';

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {}
  class GetParameterCommand {}
  return { SSMClient, GetParameterCommand };
});

const PAGE_HTML = '<html><head><title>T</title></head><body>Hello</body></html>';
const JSONLD_RAW = '{"@context":"https://schema.org","@type":"Article","headline":"Hi"}';
// Mirrors buildScriptTag output for the standard Enhancely mock (ETag W/"1" —
// the weak prefix and quotes are stripped for the data-etag attribute).
const SNIPPET = `<script type="application/ld+json" data-source="Enhancely.ai" data-etag="1">${JSONLD_RAW}</script>`;

let server: http.Server;
let originPort: number;
let originHits = 0;
let lastHostHeader: string | undefined;
let lastPath: string | undefined;
let lastRequestHeaders: http.IncomingHttpHeaders = {};
let failNextOriginRequest = true;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    originHits += 1;
    lastHostHeader = req.headers.host;
    lastPath = req.url;
    lastRequestHeaders = req.headers;
    const path = new URL(req.url ?? '/', 'http://x.invalid').pathname;

    const routes: Record<string, () => void> = {
      // Sets a session cookie AND marks itself uncacheable — the exact shape
      // the origin-response trigger refuses and this one must inject into.
      '/with-cookie': () => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'AWSALB=abc123; Path=/',
          'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
        });
        res.end(PAGE_HTML);
      },
      // Real HTML with validators but NO Enhancely record (the mock 404s on
      // anything containing "missing") — the un-injected generated path.
      '/missing-with-validators': () => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          etag: '"abc"',
          'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
        });
        res.end(PAGE_HTML);
      },
      // Carries headers that must survive, ones CloudFront forbids, and ones
      // that describe the ORIGINAL body.
      '/headers': () => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          vary: 'Accept-Encoding',
          'x-frame-options': 'DENY',
          'strict-transport-security': 'max-age=63072000',
          'content-security-policy': "default-src 'self'",
          etag: '"abc"',
          'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
          connection: 'keep-alive, X-Origin-Secret',
          'x-origin-secret': 'must-not-leak',
          te: 'trailers',
          'x-cache': 'Miss from cloudfront',
        });
        res.end(PAGE_HTML);
      },
      '/already-injected': () => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-enhancely-injected': '1',
        });
        res.end(
          '<html><head><script type="application/ld+json" data-source="Enhancely.ai">{"existing":true}</script></head><body></body></html>'
        );
      },
      // Two Set-Cookie values plus header families CloudFront forbids.
      '/multi': () => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
          'x-amz-cf-pop': 'FRA6-C1',
          'x-edge-result-type': 'Miss',
          'x-custom-keep': 'yes',
        });
        res.end(PAGE_HTML);
      },
      '/noindex': () => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-robots-tag': 'noindex',
        });
        res.end(PAGE_HTML);
      },
      '/json': () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      },
      '/conflicting-content-type': () => {
        res.writeHead(200, [
          'Content-Type',
          'text/html; charset=utf-8',
          'Content-Type',
          'application/json',
        ]);
        res.end(PAGE_HTML);
      },
      '/conflicting-content-disposition': () => {
        res.writeHead(200, [
          'Content-Type',
          'text/html; charset=utf-8',
          'Content-Disposition',
          'inline',
          'Content-Disposition',
          'attachment; filename="page.html"',
        ]);
        res.end(PAGE_HTML);
      },
      '/created': () => {
        res.writeHead(201, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
      },
      '/partial': () => {
        res.writeHead(206, {
          'content-type': 'text/html; charset=utf-8',
          'content-range': 'bytes 0-9/100',
        });
        res.end('<html>par');
      },
      '/empty-204': () => {
        res.writeHead(204, { 'cache-control': 'public, max-age=60' });
        res.end();
      },
      '/flaky-origin': () => {
        if (failNextOriginRequest) {
          failNextOriginRequest = false;
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
      },
      '/latin1': () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
        res.end(PAGE_HTML);
      },
      '/no-head': () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>no head element</body></html>');
      },
      '/big': () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<html><head></head><body>${'x'.repeat(MAX_ORIGIN_BODY_BYTES + 1024)}</body></html>`
        );
      },
      '/quota-after-lookup': () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><head></head><body>${'x'.repeat(950_000)}</body></html>`);
      },
      // Multi-byte UTF-8 in title, body and (via the mock) the JSON-LD.
      '/umlaut': () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><head><title>Zuckerrübe</title></head><body>Grüße aus München — 你好</body></html>'
        );
      },
      '/redirect': () => {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
      },
    };
    (
      routes[path] ??
      (() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
      })
    )();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  originPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Enhancely API mock: 200 + raw JSON-LD, or 404 for `/missing`. */
const enhancelyFetch = vi.fn(async (input: string, _init?: RequestInit) => {
  const found = !input.includes('%2Fmissing');
  return found
    ? new Response(JSONLD_RAW, {
        status: 200,
        headers: { 'content-type': 'application/ld+json', etag: 'W/"1"' },
      })
    : new Response('', { status: 404 });
});

beforeEach(() => {
  enhancelyFetch.mockClear();
  originHits = 0;
  lastHostHeader = undefined;
  lastPath = undefined;
  lastRequestHeaders = {};
  failNextOriginRequest = true;
  __resetAdapterConfigForTests();
  __resetOriginRequestStateForTests();
  __resetUpstreamMemoForTests();
  __setBakedConfigForTests({ apiKey: 'sk-test' });
  __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });
});

function cfHeaders(headers: Record<string, string>): CloudFrontHeaders {
  const out: CloudFrontHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = [{ key: name, value }];
  }
  return out;
}

interface Options {
  method?: string;
  uri?: string;
  querystring?: string;
  host?: string | null;
  noCustomOrigin?: boolean;
  originPath?: string;
  originCustomHeaders?: Record<string, string>;
  requestHeaders?: Record<string, string>;
}

function makeRequestEvent(options: Options = {}): CloudFrontRequestEvent {
  const {
    method = 'GET',
    uri = '/page',
    querystring = '',
    host = 'www.example.com',
    noCustomOrigin = false,
    originPath = '',
    originCustomHeaders = {},
    requestHeaders = {},
  } = options;
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd111111abcdef8.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'origin-request',
            requestId: 'test-request-id',
          },
          request: {
            clientIp: '203.0.113.1',
            method,
            uri,
            querystring,
            headers: cfHeaders({ ...(host === null ? {} : { host }), ...requestHeaders }),
            ...(noCustomOrigin
              ? {}
              : {
                  origin: {
                    custom: {
                      customHeaders: cfHeaders(originCustomHeaders),
                      domainName: '127.0.0.1',
                      keepaliveTimeout: 5,
                      path: originPath,
                      port: originPort,
                      protocol: 'http' as const,
                      readTimeout: 30,
                      sslProtocols: ['TLSv1.2'],
                    },
                  },
                }),
          },
        },
      },
    ],
  };
}

async function invoke(event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> {
  return (await handler(event, {} as Context, () => undefined)) as CloudFrontRequestResult;
}

/** A pass-through result is the request object: it has `uri`, not `status`. */
function isPassThrough(result: CloudFrontRequestResult): boolean {
  return result !== undefined && result !== null && 'uri' in result;
}

function asResponse(result: CloudFrontRequestResult): CloudFrontResultResponse {
  expect(isPassThrough(result)).toBe(false);
  return result as CloudFrontResultResponse;
}

function headerValue(response: CloudFrontResultResponse, name: string): string | undefined {
  return response.headers?.[name]?.[0]?.value;
}

describe('origin-request — happy path', () => {
  it('generates a response with the snippet injected, from exactly ONE origin hit', async () => {
    const result = await invoke(makeRequestEvent());
    const response = asResponse(result);

    expect(response.status).toBe('200');
    expect(response.body).toContain(SNIPPET);
    expect(response.body).toContain('</head>');
    expect(response.bodyEncoding).toBe('text');
    expect(originHits).toBe(1);
  });

  it('presents the public Host to the origin so vhosts resolve', async () => {
    await invoke(makeRequestEvent());
    expect(lastHostHeader).toBe('www.example.com');
  });

  it('labels the generated body UTF-8 explicitly', async () => {
    const response = asResponse(await invoke(makeRequestEvent()));
    expect(headerValue(response, 'content-type')).toBe('text/html; charset=utf-8');
  });

  it('preserves multi-byte UTF-8 in the generated body', async () => {
    // The body budget is measured in BYTES while the injected string is
    // measured in code units, so a multi-byte page is the case where a naive
    // length check would silently corrupt or over-run.
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/umlaut' })));
    expect(response.body).toContain('Grüße aus München — 你好');
    expect(response.body).toContain('<title>Zuckerrübe</title>');
    expect(response.body!.indexOf('application/ld+json')).toBeLessThan(
      response.body!.indexOf('</head>')
    );
  });

  it('sends the query-stripped page URL to Enhancely', async () => {
    await invoke(makeRequestEvent({ uri: '/page', querystring: 'utm_source=x' }));
    const sent = String(enhancelyFetch.mock.calls[0]?.[0]);
    expect(sent).toContain(encodeURIComponent('https://www.example.com/page'));
    expect(sent).not.toContain('utm_source');
  });
});

describe('origin-request — no snippet still costs exactly ONE origin hit (v0.9.0)', () => {
  it("generates the origin's own bytes instead of handing the request back", async () => {
    const result = await invoke(makeRequestEvent({ uri: '/missing' }));
    const response = asResponse(result);
    expect(response.body).toBe(PAGE_HTML);
    expect(response.body).not.toContain('application/ld+json');
    // One hit, not two: handing back would make CloudFront fetch the same page
    // again — and it is what lets the retry cap bound this response.
    expect(originHits).toBe(1);
  });

  it('does not mark an un-injected response as injected', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/missing' })));
    expect(response.headers?.['x-enhancely-injected']).toBeUndefined();
  });

  it('keeps the origin validators when the body is unmodified and uncapped', async () => {
    // The route serves an ETag and no Cache-Control, and no DefaultTTL is
    // asserted → the retry cap declines, so nothing is rewritten. The bytes
    // ARE the origin's, so its ETag still describes them truthfully.
    const response = asResponse(
      await invoke(makeRequestEvent({ uri: '/missing-with-validators' }))
    );
    expect(response.body).toBe(PAGE_HTML);
    expect(headerValue(response, 'etag')).toBe('"abc"');
    expect(headerValue(response, 'last-modified')).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('caps the pass-through and drops validators once a DefaultTTL is asserted', async () => {
    __resetAdapterConfigForTests();
    __resetOriginRequestStateForTests();
    __resetUpstreamMemoForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', assertedDefaultTtlSeconds: 86_400 });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });

    // This is what v0.7.0/v0.8.0 could NOT do on this trigger: the un-injected
    // response is ours now, so its lifetime is bounded by the retry delay.
    const response = asResponse(
      await invoke(makeRequestEvent({ uri: '/missing-with-validators' }))
    );
    expect(headerValue(response, 'cache-control')).toMatch(
      /^max-age=0, s-maxage=\d+, must-revalidate$/
    );
    expect(response.headers?.['etag']).toBeUndefined();
    expect(response.headers?.['last-modified']).toBeUndefined();
  });
});

describe('origin-request — injection feasibility is proven before Enhancely', () => {
  it('generates no-head HTML unchanged with one origin hit and zero API calls', async () => {
    __resetAdapterConfigForTests();
    __resetOriginRequestStateForTests();
    __resetUpstreamMemoForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', autoRegister: true });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });

    const response = asResponse(await invoke(makeRequestEvent({ uri: '/no-head' })));
    expect(response.body).toBe('<html><body>no head element</body></html>');
    expect(response.bodyEncoding).toBe('text');
    expect(originHits).toBe(1);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('returns the original page after a post-lookup quota veto without a second origin fetch', async () => {
    const largeJsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      description: 'y'.repeat(120_000),
    });
    const largeLookup = vi.fn(
      async () =>
        new Response(largeJsonLd, {
          status: 200,
          headers: { 'content-type': 'application/ld+json', etag: 'W/"large"' },
        })
    );
    __setConfigOverridesForTests({ fetchImpl: largeLookup });

    const response = asResponse(await invoke(makeRequestEvent({ uri: '/quota-after-lookup' })));
    expect(response.body).toContain('<html><head></head><body>');
    expect(response.body).not.toContain('application/ld+json');
    expect(originHits).toBe(1);
    expect(largeLookup).toHaveBeenCalledTimes(1);
  });
});

describe('origin-request — per-request state IS injected (differs from origin-response)', () => {
  it('injects into a response carrying Set-Cookie and no-store', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/with-cookie' })));
    expect(response.body).toContain(SNIPPET);
  });

  it('passes the origin Set-Cookie through verbatim', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/with-cookie' })));
    expect(headerValue(response, 'set-cookie')).toBe('AWSALB=abc123; Path=/');
  });

  it('keeps the origin Cache-Control', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/with-cookie' })));
    expect(headerValue(response, 'cache-control')).toBe(
      'no-cache, no-store, max-age=0, must-revalidate'
    );
  });
});

describe('origin-request — generated response headers', () => {
  it('preserves already-injected upstream content without another Enhancely call', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/already-injected' })));
    const body = Buffer.from(response.body ?? '', 'base64').toString('utf8');

    expect(response.bodyEncoding).toBe('base64');
    expect(body.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(body).toContain('{"existing":true}');
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('preserves the origin security and caching headers', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/headers' })));
    expect(headerValue(response, 'vary')).toBe('Accept-Encoding');
    expect(headerValue(response, 'x-frame-options')).toBe('DENY');
    expect(headerValue(response, 'strict-transport-security')).toBe('max-age=63072000');
    expect(headerValue(response, 'content-security-policy')).toBe("default-src 'self'");
  });

  it('strips headers CloudFront forbids in a generated response', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/headers' })));
    expect(response.headers?.['connection']).toBeUndefined();
    expect(response.headers?.['x-origin-secret']).toBeUndefined();
    expect(response.headers?.['te']).toBeUndefined();
    expect(response.headers?.['x-cache']).toBeUndefined();
    expect(response.headers?.['content-length']).toBeUndefined();
    expect(response.headers?.['transfer-encoding']).toBeUndefined();
  });

  it('strips validators and digests that described the uninjected body', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/headers' })));
    expect(response.headers?.['etag']).toBeUndefined();
    expect(response.headers?.['last-modified']).toBeUndefined();
    expect(response.headers?.['content-encoding']).toBeUndefined();
  });

  it('uses canonical header casing in the key field', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/headers' })));
    expect(response.headers?.['x-frame-options']?.[0]?.key).toBe('X-Frame-Options');
  });
});

describe('origin-request — pass-through gates', () => {
  const cases: Array<[string, Options, number]> = [
    ['non-GET is never replayed', { method: 'POST' }, 0],
    ['asset extension skips before any work', { uri: '/app.js' }, 0],
    ['image extension skips before any work', { uri: '/logo.png' }, 0],
    ['non-custom origin', { noCustomOrigin: true }, 0],
  ];
  for (const [name, options, expectedHits] of cases) {
    it(`${name} → request, ${expectedHits} origin hits`, async () => {
      const result = await invoke(makeRequestEvent(options));
      expect(isPassThrough(result)).toBe(true);
      expect(originHits).toBe(expectedHits);
    });
  }

  it('does not alter unrelated viewer/configured headers on an early return', async () => {
    const header = 'x-enhancely-handback';
    const result = await invoke(
      makeRequestEvent({
        uri: '/app.js',
        requestHeaders: { [header]: 'customer-value' },
        originCustomHeaders: { [header]: 'configured-value' },
      })
    );
    expect(isPassThrough(result)).toBe(true);
    const request = result as import('aws-lambda').CloudFrontRequest;
    expect(request.headers?.[header]?.[0]?.value).toBe('customer-value');
    expect(request.origin?.custom?.customHeaders[header]?.[0]?.value).toBe('configured-value');
  });

  it('falls back to the origin domain when the viewer Host header is absent', async () => {
    // Mirrors the origin-response adapter: an origin request policy that does
    // not forward Host still has to work, so the origin's own domain name is
    // the fallback for both the fetch and the Enhancely page URL.
    const response = asResponse(await invoke(makeRequestEvent({ host: null })));
    expect(response.body).toContain(SNIPPET);
    expect(lastHostHeader).toBe('127.0.0.1');
    expect(String(enhancelyFetch.mock.calls[0]?.[0])).toContain(
      encodeURIComponent('https://127.0.0.1/page')
    );
  });

  const afterFetch: Array<[string, string]> = [['body over the fetch cap', '/big']];
  for (const [name, uri] of afterFetch) {
    it(`${name} → request (one discarded fetch)`, async () => {
      const result = await invoke(makeRequestEvent({ uri }));
      expect(isPassThrough(result)).toBe(true);
    });
  }
});

describe('origin-request — the fetch must be the one CloudFront would have made', () => {
  it('refuses a URI that escapes the configured origin path', async () => {
    // `new URL()` resolves dot-segments, so "/prefix" + "/../secret" would
    // silently become "/secret" — outside the subtree CloudFront's own request
    // could ever reach. Declining hands the request back untouched.
    const result = await invoke(makeRequestEvent({ uri: '/../secret', originPath: '/prefix' }));
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(0);
  });

  it('refuses the percent-encoded form of the same escape', async () => {
    const result = await invoke(
      makeRequestEvent({ uri: '/x/%2e%2e/%2e%2e/secret', originPath: '/prefix' })
    );
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(0);
  });

  it('sends the RAW path, without resolving dot-segments', async () => {
    // CloudFront forwards the path verbatim and lets the origin decide. If this
    // fetch normalized it first, the origin could answer with a different
    // document than the viewer is entitled to.
    await invoke(makeRequestEvent({ uri: '/a/%2e%2e/b' }));
    expect(lastPath).toBe('/a/%2e%2e/b');
  });

  it('prefixes the origin path like CloudFront does', async () => {
    await invoke(makeRequestEvent({ uri: '/page', originPath: '/prefix' }));
    expect(lastPath).toBe('/prefix/page');
  });

  it('adds the origin custom headers CloudFront would have added', async () => {
    // These live on the ORIGIN, never in request.headers. Without them the
    // origin sees a request CloudFront would never have made — a shared-secret
    // header would be missing, and any origin varying on them answers with a
    // different variant.
    await invoke(makeRequestEvent({ originCustomHeaders: { 'x-origin-secret': 'shhh' } }));
    expect(lastRequestHeaders['x-origin-secret']).toBe('shhh');
  });

  it('lets an origin custom header win over a same-named viewer header', async () => {
    await invoke(
      makeRequestEvent({
        requestHeaders: { 'x-both': 'from-viewer' },
        originCustomHeaders: { 'x-both': 'from-origin' },
      })
    );
    expect(lastRequestHeaders['x-both']).toBe('from-origin');
  });

  it('strips conditional headers so the origin cannot answer 304', async () => {
    // A viewer holding a cached copy sends If-None-Match; forwarding it makes
    // the origin reply 304 with no body, the gate rejects it, and the fetch was
    // spent for nothing.
    await invoke(
      makeRequestEvent({
        requestHeaders: {
          'if-none-match': 'W/"abc"',
          'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
        },
      })
    );
    expect(lastRequestHeaders['if-none-match']).toBeUndefined();
    expect(lastRequestHeaders['if-modified-since']).toBeUndefined();
  });
});

describe('origin-request — multi-value and wildcard headers', () => {
  it('keeps every Set-Cookie value as its own entry', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/multi' })));
    const cookies = response.headers?.['set-cookie']?.map((entry) => entry.value);
    expect(cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('strips the x-amz-cf-* and x-edge-* families', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/multi' })));
    expect(response.headers?.['x-amz-cf-pop']).toBeUndefined();
    expect(response.headers?.['x-edge-result-type']).toBeUndefined();
    // …while an unrelated custom header survives.
    expect(headerValue(response, 'x-custom-keep')).toBe('yes');
  });
});

describe('origin-request — a non-page is fetched ONCE, then remembered (v0.9.1)', () => {
  // Origin-first pays one extra origin hit for things it must not touch: it
  // fetches to find out, then hands back so CloudFront fetches again. The
  // first time that is unavoidable; the second time it is pure waste.
  for (const [name, uri] of [['a non-reproducible 2xx status', '/created']] as const) {
    it(`${name}: the repeat costs no adapter fetch at all`, async () => {
      const first = await invoke(makeRequestEvent({ uri }));
      expect(isPassThrough(first)).toBe(true);
      expect(originHits).toBe(1);

      const second = await invoke(makeRequestEvent({ uri }));
      expect(isPassThrough(second)).toBe(true);
      // Still 1: the verdict was remembered, so this request costs exactly
      // what it cost before origin-first — one CloudFront fetch, nothing else.
      expect(originHits).toBe(1);
    });
  }

  it('remembers per URL, not globally', async () => {
    await invoke(makeRequestEvent({ uri: '/created' }));
    expect(originHits).toBe(1);
    // A DIFFERENT url must still be examined.
    const other = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));
    expect(other.body).toContain(SNIPPET);
    expect(originHits).toBe(2);
  });

  it('outlives the JSON-LD cache TTL — the verdict is stable, a record is not', async () => {
    __resetAdapterConfigForTests();
    __resetOriginRequestStateForTests();
    __resetUpstreamMemoForTests();
    // Record TTL 1 ms, memo TTL 60 s: the two must not share a lifetime.
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      cacheTtlMs: 1,
      nonPageMemoTtlMs: 60_000,
    });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });

    await invoke(makeRequestEvent({ uri: '/created' }));
    expect(originHits).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await invoke(makeRequestEvent({ uri: '/created' }));
    expect(originHits).toBe(1);
  });

  it('never memoizes a real page', async () => {
    const first = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));
    expect(first.body).toContain(SNIPPET);
    const second = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));
    expect(second.body).toContain(SNIPPET);
    expect(originHits).toBe(2);
  });
});

describe('origin-request — safe origin answers are returned verbatim, not re-fetched', () => {
  it('returns the origin answer with ONE origin hit and no Enhancely call', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/redirect' })));
    expect(response.status).toBe('302');
    expect(headerValue(response, 'location')).toBe('/elsewhere');
    expect(originHits).toBe(1);
    // An error is not a page: Enhancely is never asked.
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('never marks such a response as injected', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/redirect' })));
    expect(response.headers?.['x-enhancely-injected']).toBeUndefined();
  });

  it('returns a small status-200 non-HTML answer with one origin hit and no API call', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/json' })));
    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');
    expect(Buffer.from(response.body ?? '', 'base64').toString('utf8')).toBe('{}');
    expect(originHits).toBe(1);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('combines conflicting origin Content-Type instances and preserves them verbatim', async () => {
    const response = asResponse(
      await invoke(makeRequestEvent({ uri: '/conflicting-content-type' }))
    );
    expect(response.headers?.['content-type']?.map((entry) => entry.value)).toEqual([
      'text/html; charset=utf-8',
      'application/json',
    ]);
    expect(response.bodyEncoding).toBe('base64');
    expect(enhancelyFetch).not.toHaveBeenCalled();
    expect(originHits).toBe(1);
  });

  it('combines every origin Content-Disposition instance before gating', async () => {
    const response = asResponse(
      await invoke(makeRequestEvent({ uri: '/conflicting-content-disposition' }))
    );
    expect(response.headers?.['content-disposition']?.map((entry) => entry.value)).toEqual([
      'inline',
      'attachment; filename="page.html"',
    ]);
    expect(response.bodyEncoding).toBe('base64');
    expect(enhancelyFetch).not.toHaveBeenCalled();
    expect(originHits).toBe(1);
  });

  it.each([
    ['a noindex HTML page', '/noindex'],
    ['a legacy-charset HTML page', '/latin1'],
  ])('returns %s verbatim without contacting Enhancely', async (_name, uri) => {
    const response = asResponse(await invoke(makeRequestEvent({ uri })));
    expect(response.status).toBe('200');
    expect(response.bodyEncoding).toBe('base64');
    expect(Buffer.from(response.body ?? '', 'base64').toString('utf8')).toBe(PAGE_HTML);
    expect(originHits).toBe(1);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('hands back Range before our fetch without adding an origin-visible coordination header', async () => {
    const result = await invoke(
      makeRequestEvent({ uri: '/page', requestHeaders: { range: 'bytes=0-99' } })
    );
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(0);
    expect(enhancelyFetch).not.toHaveBeenCalled();
    const request = result as import('aws-lambda').CloudFrontRequest;
    expect(request.headers['range']?.[0]?.value).toBe('bytes=0-99');
    expect(request.headers['x-enhancely-handback']).toBeUndefined();
  });

  it('keeps 206 on the conservative handback path without an API call', async () => {
    const result = await invoke(makeRequestEvent({ uri: '/partial' }));
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(1);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('returns an empty 204 from the existing fetch without a second origin request', async () => {
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/empty-204' })));
    expect(response.status).toBe('204');
    expect(response.body).toBeUndefined();
    expect(originHits).toBe(1);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });
});

describe('origin-request — registration is precise on this trigger (v0.9.0)', () => {
  function enableRegistration(): void {
    __resetAdapterConfigForTests();
    __resetOriginRequestStateForTests();
    __resetUpstreamMemoForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', autoRegister: true });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });
  }

  it('registers a real HTML page with ONE register-or-revalidate POST', async () => {
    enableRegistration();
    await invoke(makeRequestEvent({ uri: '/missing' }));

    const calls = enhancelyFetch.mock.calls.map((call) => ({
      url: String(call[0]),
      method: (call[1] as RequestInit | undefined)?.method ?? 'GET',
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toMatch(/\/api\/v1\/jsonld$/);
  });

  it('never registers a non-HTML body — gated before any API call', async () => {
    enableRegistration();
    const result = await invoke(makeRequestEvent({ uri: '/json' }));
    expect(asResponse(result).bodyEncoding).toBe('base64');
    // The decisive property of origin-first: NOTHING reached Enhancely.
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('never registers a redirect — it is returned verbatim, unasked', async () => {
    enableRegistration();
    const response = asResponse(await invoke(makeRequestEvent({ uri: '/redirect' })));
    expect(response.status).toBe('302');
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('never contacts Enhancely for an extension-filtered asset', async () => {
    enableRegistration();
    const result = await invoke(makeRequestEvent({ uri: '/style.css' }));
    expect(isPassThrough(result)).toBe(true);
    expect(enhancelyFetch).not.toHaveBeenCalled();
    expect(originHits).toBe(0);
  });
});

describe('origin-request — a slow Enhancely parks ALL lookups, not just one URL', () => {
  it('skips the lookup entirely for other URLs after one timeout', async () => {
    // The core's retryNotBefore is keyed by URL, so on its own every distinct
    // page pays the full timeout once. The execution-environment-wide memo
    // prevents that repeated outage latency.
    __resetAdapterConfigForTests();
    __resetOriginRequestStateForTests();
    __resetUpstreamMemoForTests();
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      timeoutMs: 60,
      assertedDefaultTtlSeconds: 86_400,
    });
    const slow = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response('', { status: 504 })), 200);
        })
    );
    __setConfigOverridesForTests({ fetchImpl: slow });

    const first = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));
    expect(first.body).toBe(PAGE_HTML);
    expect(slow).toHaveBeenCalledTimes(1);

    // A DIFFERENT url must not pay the timeout again — and it still gets the
    // page we already fetched, rather than a second origin round-trip.
    const second = asResponse(await invoke(makeRequestEvent({ uri: '/other' })));
    expect(second.body).toBe(PAGE_HTML);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(headerValue(second, 'cache-control')).toMatch(
      /^max-age=0, s-maxage=\d+, must-revalidate$/
    );

    // Origin-first: both pages WERE fetched (that is how we can still serve
    // them), but neither paid the Enhancely timeout a second time. One origin
    // hit per request — never two.
    expect(originHits).toBe(2);
  });

  it('still injects a stale positive cache hit while the global breaker is open', async () => {
    __resetAdapterConfigForTests();
    __resetOriginRequestStateForTests();
    __resetUpstreamMemoForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', timeoutMs: 60, cacheTtlMs: 1 });
    const selective = vi.fn(async (input: string) => {
      if (input.includes('%2Fpage')) {
        return new Response(JSONLD_RAW, {
          status: 200,
          headers: { 'content-type': 'application/ld+json', etag: 'W/"1"' },
        });
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response('', { status: 504 })), 100);
      });
    });
    __setConfigOverridesForTests({ fetchImpl: selective });

    const first = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));
    expect(first.body).toContain(SNIPPET);
    await new Promise((resolve) => setTimeout(resolve, 10)); // positive entry is stale

    await invoke(makeRequestEvent({ uri: '/slow' })); // opens the global breaker
    const cached = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));

    expect(cached.body).toContain(SNIPPET);
    expect(selective).toHaveBeenCalledTimes(2);
    expect(originHits).toBe(3);
  });
});

describe('origin-request — fail-open', () => {
  it('scopes a post-connect reset to its exact request instead of the whole origin', async () => {
    const first = await invoke(makeRequestEvent({ uri: '/flaky-origin' }));
    expect(isPassThrough(first)).toBe(true);
    expect(originHits).toBe(1);

    // The same known-bad request skips our pre-fetch during the short memo.
    const repeated = await invoke(makeRequestEvent({ uri: '/flaky-origin' }));
    expect(isPassThrough(repeated)).toBe(true);
    expect(originHits).toBe(1);

    // A healthy path on the same endpoint/vhost must still be fetched and
    // injected: the reset happened after TCP connected and may be path-specific.
    const second = asResponse(await invoke(makeRequestEvent({ uri: '/page' })));
    expect(second.body).toContain(SNIPPET);
    expect(originHits).toBe(2);
    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
  });

  it('opens an endpoint-wide circuit for a pre-connect failure', async () => {
    const firstEvent = makeRequestEvent({ uri: '/page' });
    const firstOrigin = firstEvent.Records[0]!.cf.request.origin;
    if (firstOrigin?.custom) firstOrigin.custom.port = 1; // nothing listens here
    const first = await invoke(firstEvent);
    expect(isPassThrough(first)).toBe(true);

    // A different URL on the same endpoint/vhost is handed straight back. This
    // assertion is intentionally behavioral: no origin server or API is hit.
    const secondEvent = makeRequestEvent({ uri: '/other' });
    const secondOrigin = secondEvent.Records[0]!.cf.request.origin;
    if (secondOrigin?.custom) secondOrigin.custom.port = 1;
    const second = await invoke(secondEvent);
    expect(isPassThrough(second)).toBe(true);
    expect(originHits).toBe(0);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('returns the request when the origin is unreachable', async () => {
    const event = makeRequestEvent();
    const origin = event.Records[0]!.cf.request.origin;
    if (origin?.custom) origin.custom.port = 1; // nothing listens here
    const result = await invoke(event);
    expect(isPassThrough(result)).toBe(true);
  });

  it('returns the request when no API key resolves', async () => {
    __resetAdapterConfigForTests();
    __setBakedConfigForTests(null);
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });
    const result = await invoke(makeRequestEvent());
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(0);
  });

  it('returns the request when the excludePaths policy matches', async () => {
    __resetAdapterConfigForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', excludePaths: ['/private/*'] });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });
    const result = await invoke(makeRequestEvent({ uri: '/private/secret' }));
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(0);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('returns before config, connector-origin, and Enhancely work for an excluded host', async () => {
    __resetAdapterConfigForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', includeHosts: ['www.example.com'] });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });

    const result = await invoke(makeRequestEvent({ host: 'media.example.com' }));
    expect(isPassThrough(result)).toBe(true);
    expect(originHits).toBe(0);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('uses the static public page-host override for filtering and lookup identity', async () => {
    __resetAdapterConfigForTests();
    __setBakedConfigForTests({ apiKey: 'sk-test', includeHosts: ['public.example.com'] });
    __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });

    const response = asResponse(
      await invoke(
        makeRequestEvent({
          host: 'origin.example.com',
          originCustomHeaders: { 'x-enhancely-page-host': 'public.example.com' },
        })
      )
    );
    expect(response.body).toContain(SNIPPET);
    expect(originHits).toBe(1);
    expect(String(enhancelyFetch.mock.calls[0]?.[0])).toContain(
      encodeURIComponent('https://public.example.com/page')
    );
  });
});
