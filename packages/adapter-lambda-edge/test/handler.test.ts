/**
 * Handler integration tests: a REAL local node:http origin server (exercising
 * the actual origin re-fetch, including the Host header), with the Enhancely
 * API mocked via the core's `fetchImpl` config seam.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAdapterConfigForTests,
  __setBakedConfigForTests,
  __setConfigOverridesForTests,
} from '../src/config.js';
import {
  GENERATED_RESPONSE_SAFETY_MARGIN_BYTES,
  MAX_GENERATED_RESPONSE_BYTES,
  MAX_ORIGIN_BODY_BYTES,
  serializedHeaderBytes,
  __resetHandlerStateForTests,
} from '../src/index.js';
import { cfHeaders, makeEvent, invoke } from './fixtures.js';

// The no-key test path would otherwise import the real SDK and walk the AWS
// credential chain; keep it hermetic.
vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {}
  class GetParameterCommand {}
  return { SSMClient, GetParameterCommand };
});

const PAGE_HTML = '<html><head><title>T</title></head><body>Hello</body></html>';
const JSONLD_RAW = '{"@context":"https://schema.org","@type":"Article","headline":"Hi"}';
/** Exactly what the core injects before `</head>` (all ASCII → bytes = length). */
const SNIPPET = `<script type="application/ld+json">${JSONLD_RAW}</script>`;

/** Body shell for the exact-size `/sized` route (all ASCII). */
const SIZED_PREFIX = '<html><head></head><body>';
const SIZED_SUFFIX = '</body></html>';

let server: http.Server;
let originPort: number;
let closedPort: number;
let lastHostHeader: string | undefined;
let lastPath: string | undefined;
let lastRequestHeaders: http.IncomingHttpHeaders = {};
let originHits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    originHits += 1;
    lastHostHeader = req.headers.host;
    lastPath = req.url;
    lastRequestHeaders = req.headers;
    const url = new URL(req.url ?? '/', 'http://sized.invalid');
    const path = url.pathname;

    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head></head><body>${'x'.repeat(MAX_ORIGIN_BODY_BYTES + 1024)}</body></html>`);
      return;
    }
    if (path === '/sized') {
      // Valid HTML whose TOTAL byte length is exactly ?n= (boundary tests).
      const total = Number(url.searchParams.get('n'));
      const padding = 'x'.repeat(total - SIZED_PREFIX.length - SIZED_SUFFIX.length);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`${SIZED_PREFIX}${padding}${SIZED_SUFFIX}`);
      return;
    }
    if (path === '/latin1-bytes') {
      // No charset parameter, but the BYTES are ISO-8859-1 (0xE9 = é): a
      // lossy utf8 decode would mangle them into U+FFFD.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        Buffer.concat([
          Buffer.from('<html><head></head><body>caf', 'ascii'),
          Buffer.from([0xe9]),
          Buffer.from('</body></html>', 'ascii'),
        ])
      );
      return;
    }
    if (path === '/cookie-setter') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'session=abc; Path=/',
      });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/slow') {
      return; // never answers — the client's AbortSignal.timeout must fire
    }
    if (path === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/gzipped') {
      // Origin that ignores Accept-Encoding: identity.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
      });
      res.end('not-really-gzip');
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/page' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  originPort = (server.address() as AddressInfo).port;

  // Reserve a port, then free it → connecting to it is refused.
  const throwaway = http.createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, '127.0.0.1', resolve));
  closedPort = (throwaway.address() as AddressInfo).port;
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Enhancely API mock, wired in through the core's fetchImpl config seam. */
const enhancelyFetch = vi.fn((_input: string, _init: RequestInit): Promise<Response> =>
  Promise.resolve(new Response(JSONLD_RAW, { status: 200, headers: { etag: '"v1"' } }))
);

function eventFor(uri: string, options: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    uri,
    originDomain: '127.0.0.1',
    originPort,
    originProtocol: 'http',
    responseHeaders: { 'content-type': 'text/html; charset=utf-8', 'content-length': '58' },
    ...options,
  });
}

beforeEach(() => {
  enhancelyFetch.mockClear();
  originHits = 0;
  lastHostHeader = undefined;
  lastPath = undefined;
  lastRequestHeaders = {};
  __resetAdapterConfigForTests();
  __resetHandlerStateForTests();
  __setBakedConfigForTests({ apiKey: 'sk-test' });
  __setConfigOverridesForTests({ fetchImpl: enhancelyFetch });
});

afterEach(() => {
  __resetAdapterConfigForTests();
  vi.restoreAllMocks();
});

describe('handler — happy path', () => {
  it('re-fetches the page from the origin and injects the JSON-LD snippet', async () => {
    const event = eventFor('/page', { querystring: 'a=1' });
    const result = await invoke(event);

    // Injected before </head>, verbatim body, marked as text.
    expect(result?.body).toContain(`<script type="application/ld+json">${JSONLD_RAW}</script>`);
    expect(result?.body).toContain('</head>');
    expect(result?.body?.indexOf('application/ld+json')).toBeLessThan(
      result?.body?.indexOf('</head>') ?? -1
    );
    expect(result?.bodyEncoding).toBe('text');

    // The origin saw the re-fetch with the incoming Host header (vhosts!).
    expect(originHits).toBe(1);
    expect(lastHostHeader).toBe('www.example.com');
    expect(lastPath).toBe('/page?a=1');

    // Enhancely got the QUERY-STRIPPED public page URL, encoded, with auth —
    // the querystring never leaves the edge (server normalizes identically).
    const [endpoint, init] = enhancelyFetch.mock.calls[0] ?? [];
    expect(endpoint).toContain(encodeURIComponent('https://www.example.com/page'));
    expect(endpoint).not.toContain('a%3D1'); // no `a=1` querystring in the URL
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');

    // Stale Content-Length removed → CloudFront recomputes it from the body.
    expect(result?.headers?.['content-length']).toBeUndefined();
    // Everything else preserved.
    expect(result?.headers?.['content-type']?.[0]?.value).toBe('text/html; charset=utf-8');
    expect(result?.status).toBe('200');
  });

  it('includes originPath in the origin re-fetch but not in the page URL', async () => {
    const event = eventFor('/post', { originPath: '/blog' });
    const result = await invoke(event);

    expect(lastPath).toBe('/blog/post');
    const [endpoint] = enhancelyFetch.mock.calls[0] ?? [];
    expect(endpoint).toContain(encodeURIComponent('https://www.example.com/post'));
    expect(result?.body).toContain('application/ld+json');
  });

  it('uses x-enhancely-page-host for the page URL when the origin cannot see the viewer Host (S3 website pattern)', async () => {
    // S3-style distribution: viewer Host is NOT forwarded, so the request's
    // Host header is the origin's own domain; the public hostname arrives as
    // a static origin custom header instead.
    const event = eventFor('/page', {
      host: '127.0.0.1',
      originCustomHeaders: { 'x-enhancely-page-host': 'demo.example.org' },
    });
    const result = await invoke(event);

    // Enhancely lookup uses the PUBLIC page URL…
    const [endpoint] = enhancelyFetch.mock.calls[0] ?? [];
    expect(endpoint).toContain(encodeURIComponent('https://demo.example.org/page'));
    // …while the origin re-fetch keeps the origin-facing Host header.
    expect(lastHostHeader).toBe('127.0.0.1');
    expect(result?.body).toContain('application/ld+json');
  });

  it('serves the second hit for the same URL from the core cache', async () => {
    await invoke(eventFor('/page'));
    await invoke(eventFor('/page'));

    expect(enhancelyFetch).toHaveBeenCalledTimes(1); // cached JSON-LD
    expect(originHits).toBe(2); // but every CloudFront miss re-fetches HTML
  });

  it('forwards ALL origin-request headers on the re-fetch (same representation, Vary respected)', async () => {
    const event = eventFor('/page', {
      requestHeaders: {
        cookie: 'session=s1; theme=dark',
        authorization: 'Bearer viewer-token',
        'accept-language': 'de-DE,de;q=0.9',
        accept: 'text/html,application/xhtml+xml',
        'x-forwarded-for': '203.0.113.1',
        'cloudfront-viewer-country': 'DE',
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain('application/ld+json');
    expect(lastRequestHeaders['cookie']).toBe('session=s1; theme=dark');
    expect(lastRequestHeaders['authorization']).toBe('Bearer viewer-token');
    expect(lastRequestHeaders['accept-language']).toBe('de-DE,de;q=0.9');
    expect(lastRequestHeaders['accept']).toBe('text/html,application/xhtml+xml');
    expect(lastRequestHeaders['x-forwarded-for']).toBe('203.0.113.1');
    expect(lastRequestHeaders['cloudfront-viewer-country']).toBe('DE');
  });

  it('forwards User-Agent and device headers; Accept-Encoding stays identity; hop-by-hop dropped', async () => {
    const event = eventFor('/page', {
      requestHeaders: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'cloudfront-is-mobile-viewer': 'true',
        // Must NEVER reach the origin re-fetch as-is: injection needs raw bytes.
        'accept-encoding': 'gzip, br',
        // Hop-by-hop — never replayed end-to-end.
        te: 'trailers',
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain('application/ld+json');
    // The viewer UA overrides the connector's fallback identity.
    expect(lastRequestHeaders['user-agent']).toBe(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    );
    expect(lastRequestHeaders['cloudfront-is-mobile-viewer']).toBe('true');
    expect(lastRequestHeaders['accept-encoding']).toBe('identity');
    expect(lastRequestHeaders['te']).toBeUndefined();
    // Host is still the explicit viewer Host, not overridden by forwarding.
    expect(lastHostHeader).toBe('www.example.com');
  });

  it('falls back to the origin domain when the request carries no Host header', async () => {
    const event = eventFor('/page', { host: null });
    const result = await invoke(event);

    expect(result?.body).toContain('application/ld+json');
    // Re-fetch presents the origin domain as Host…
    expect(lastHostHeader).toBe('127.0.0.1');
    // …and the Enhancely page URL is built from it too.
    const [endpoint] = enhancelyFetch.mock.calls[0] ?? [];
    expect(endpoint).toContain(encodeURIComponent('https://127.0.0.1/page'));
  });

  it('drops stale validators AND integrity digests when the body is replaced', async () => {
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        etag: '"original-body"',
        'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
        'content-md5': 'Q2h1Y2sgSW51ZwDIAXR5IQ==',
        digest: 'sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=',
        'content-digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
        'repr-digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain('application/ld+json');
    expect(result?.headers?.['etag']).toBeUndefined();
    expect(result?.headers?.['last-modified']).toBeUndefined();
    expect(result?.headers?.['content-md5']).toBeUndefined();
    expect(result?.headers?.['digest']).toBeUndefined();
    expect(result?.headers?.['content-digest']).toBeUndefined();
    expect(result?.headers?.['repr-digest']).toBeUndefined();
    expect(result?.headers?.['content-type']?.[0]?.value).toBe('text/html; charset=utf-8');
  });
});

describe('handler — gating pass-through (original response, no origin contact)', () => {
  it.each([
    ['non-GET request', { method: 'POST' as const }],
    ['non-200 status', { status: '404' }],
    ['non-HTML content type', { responseHeaders: { 'content-type': 'application/json' } }],
    [
      'Content-Encoding on the CloudFront response',
      {
        responseHeaders: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      },
    ],
    [
      'non-UTF-8 charset on the CloudFront response',
      { responseHeaders: { 'content-type': 'text/html; charset=iso-8859-1' } },
    ],
    [
      'Set-Cookie on the CloudFront response (per-request representation)',
      {
        responseHeaders: { 'content-type': 'text/html', 'set-cookie': 'session=new; Path=/' },
      },
    ],
    [
      'Cache-Control: private on the CloudFront response',
      {
        responseHeaders: { 'content-type': 'text/html', 'cache-control': 'private, max-age=0' },
      },
    ],
    [
      'Cache-Control: no-store on the CloudFront response',
      { responseHeaders: { 'content-type': 'text/html', 'cache-control': 'no-store' } },
    ],
  ])('%s → untouched response', async (_name, overrides) => {
    const event = eventFor('/page', overrides);
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(originHits).toBe(0);
    expect(enhancelyFetch).not.toHaveBeenCalled();
  });

  it('non-custom (S3) origin → untouched response', async () => {
    const event = eventFor('/page', { noCustomOrigin: true });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(originHits).toBe(0);
  });
});

describe('handler — generated-response size boundary (502 territory, must fail open)', () => {
  it('fetched HTML far above the origin-fetch cap → truncated, untouched response', async () => {
    const event = eventFor('/big');
    const result = await invoke(event);

    // Enhancely is asked FIRST (has a snippet), but the re-fetched body is far
    // over the origin-fetch cap → truncated → original response, no body.
    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('fetched HTML of exactly MAX_ORIGIN_BODY_BYTES + 1 → truncated, untouched (Enhancely called first)', async () => {
    const event = eventFor('/sized', { querystring: `n=${MAX_ORIGIN_BODY_BYTES + 1}` });
    const result = await invoke(event);

    // Reorder: the snippet is fetched before the origin re-fetch, so Enhancely
    // IS called; the one-byte-over body then truncates → untouched original.
    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('normal headers: body at the origin-fetch cap fits the header-aware budget → injected', async () => {
    // The fetch cap reserves worst-case (32 KB) headers; with a normal small
    // header set the real budget is far larger, so injection proceeds. (Under
    // the old fixed 16 KB allowance this exact size passed through.)
    const event = eventFor('/sized', { querystring: `n=${MAX_ORIGIN_BODY_BYTES}` });
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result?.body).toContain(SNIPPET);
    expect(Buffer.byteLength(result?.body ?? '', 'utf8')).toBe(
      MAX_ORIGIN_BODY_BYTES + SNIPPET.length
    );
  });

  it('~30 KB of headers + body that fit the OLD 16 KB allowance but not the real budget → passthrough', async () => {
    // Regression for the fixed-allowance bug: this body is below the old
    // 1 MB − 16 KB cap, so the old code fetched AND injected it — and the
    // generated response (headers + body) blew the 1 MB quota → viewer 502.
    // Now the conservative fetch cap (1 MB − 33 KB) truncates it → fail-open.
    const n = MAX_GENERATED_RESPONSE_BYTES - 16_384 - 4_096;
    const event = eventFor('/sized', {
      querystring: `n=${n}`,
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'x-heavy': 'h'.repeat(30_000),
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  // Header set heavy enough (near CloudFront's 32,768-byte header cap) that
  // the ACTUAL header-aware body budget dips to the origin-fetch cap region —
  // exercising the serializedHeaderBytes gate itself, not truncation.
  const heavyHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'x-heavy': 'h'.repeat(32_650),
  };
  const heavyBudget =
    MAX_GENERATED_RESPONSE_BYTES -
    serializedHeaderBytes(cfHeaders(heavyHeaders)) -
    GENERATED_RESPONSE_SAFETY_MARGIN_BYTES;

  it('heavy headers: injected body one byte over the real budget → passthrough (would 502)', async () => {
    const n = heavyBudget - SNIPPET.length + 1;
    // Sanity: below the fetch cap, so this exercises the budget gate.
    expect(n).toBeLessThanOrEqual(MAX_ORIGIN_BODY_BYTES);

    const event = eventFor('/sized', { querystring: `n=${n}`, responseHeaders: heavyHeaders });
    const result = await invoke(event);

    // Distinguish from truncation: the core DID run (Enhancely was called),
    // but the injected result would not fit → original response returned.
    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('heavy headers: injected body exactly at the real budget → body replaced', async () => {
    const n = heavyBudget - SNIPPET.length;
    expect(n).toBeLessThanOrEqual(MAX_ORIGIN_BODY_BYTES);

    const event = eventFor('/sized', { querystring: `n=${n}`, responseHeaders: heavyHeaders });
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(Buffer.byteLength(result?.body ?? '', 'utf8')).toBe(heavyBudget);
  });
});

describe('handler — fail-open on the re-fetch path', () => {
  it('origin connection error → untouched response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = eventFor('/page', { originPort: closedPort });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(consoleError).toHaveBeenCalled(); // loud fail-open
  });

  // Reorder note: Enhancely is now called FIRST and returns a 200 snippet (the
  // default mock), so the origin re-fetch IS reached in each case below — and
  // it is the BAD origin answer that drives the fail-open to the untouched
  // original response.
  it('re-fetch answers with a redirect → untouched response', async () => {
    const event = eventFor('/redirect');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1); // snippet fetched → re-fetch reached
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('re-fetch declares a non-UTF-8 charset → untouched response', async () => {
    // CloudFront response claims utf-8, but the origin re-fetch says latin1.
    const event = eventFor('/latin1');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('no charset parameter but non-UTF-8 BYTES (lossy decode) → untouched response', async () => {
    // Would pass the header gates, but the utf8 decode is provably lossy —
    // injecting would cache mojibake at CloudFront.
    const event = eventFor('/latin1-bytes', {
      responseHeaders: { 'content-type': 'text/html' },
    });
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('re-fetch answers with Set-Cookie → untouched response', async () => {
    const event = eventFor('/cookie-setter');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('origin re-fetch timeout (AbortSignal.timeout) → untouched response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    __setBakedConfigForTests({ apiKey: 'sk-test', originTimeoutMs: 100 });

    const event = eventFor('/slow');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(consoleError).toHaveBeenCalled(); // loud fail-open
  });

  it('origin ignores Accept-Encoding: identity → untouched response', async () => {
    const event = eventFor('/gzipped');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('Enhancely has no record (404) → untouched response, no generated body', async () => {
    enhancelyFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const event = eventFor('/page');
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('Enhancely fetch rejects (network error) → untouched response via the core', async () => {
    enhancelyFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const event = eventFor('/page');
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });
});

describe('handler — Enhancely-first reorder (no snippet ⇒ no origin re-fetch)', () => {
  it('404 from Enhancely (no snippet) → ZERO origin re-fetch, untouched response', async () => {
    enhancelyFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const event = eventFor('/page');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(0); // the origin is NOT re-fetched when there is nothing to inject
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('rate-limited (429) from Enhancely → ZERO origin re-fetch, untouched response', async () => {
    enhancelyFetch.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } })
    );
    const event = eventFor('/page');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(0);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('a successful snippet → re-fetches the origin EXACTLY once and injects', async () => {
    // Default mock returns a 200 snippet.
    const event = eventFor('/page');
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(1);
    expect(result?.body).toContain(SNIPPET);
  });
});

describe('handler — placeholder key guard (no re-fetch when key not configured)', () => {
  it('a baked REPLACE_ME key → config null → untouched response, no origin re-fetch', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Overwrite the beforeEach sk-test key with the SSM placeholder value.
    __setBakedConfigForTests({ apiKey: 'REPLACE_ME' });

    const event = eventFor('/page');
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(originHits).toBe(0); // never pays the doubled origin load
    expect(enhancelyFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled(); // loud "not configured"
  });
});

describe('handler — config failures', () => {
  it('no API key resolvable → untouched response (loud, once)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    __setBakedConfigForTests({}); // no apiKey; mocked SSM has no usable client
    __setConfigOverridesForTests(null);

    const event = eventFor('/page');
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(originHits).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Second invocation: memoized null → still pass-through, no second log.
    const secondEvent = eventFor('/page');
    const again = await invoke(secondEvent);
    expect(again).toBe(secondEvent.Records[0]?.cf.response);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
