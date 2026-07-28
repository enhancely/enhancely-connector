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
  MAX_RESPONSE_HEADER_BYTES,
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
const UNICODE_JSONLD_RAW = '{"@context":"https://schema.org","@type":"Place","name":"München"}';
const OVERSIZED_REFETCH_CSP = `default-src 'self'; report-uri /${'a'.repeat(12_000)}`;

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
    if (path === '/ascii') {
      res.writeHead(200, { 'content-type': 'text/html; charset=us-ascii' });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/ascii-non-ascii') {
      res.writeHead(200, { 'content-type': 'text/html; charset=us-ascii' });
      res.end('<html><head></head><body>München</body></html>');
      return;
    }
    if (path === '/charsetless-utf8-meta') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><meta charset="utf-8"></head><body>München</body></html>');
      return;
    }
    if (path === '/charsetless-utf8-bom') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('<html><head></head><body>München</body></html>', 'utf8'),
        ])
      );
      return;
    }
    if (path === '/charsetless-comment-meta') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><!-- <meta charset="utf-8"> --></head><body>München</body></html>');
      return;
    }
    if (path === '/charsetless-data-charset') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><meta data-charset="utf-8"></head><body>München</body></html>');
      return;
    }
    if (path === '/charsetless-windows-meta') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><meta charset="windows-1252"></head><body>München</body></html>');
      return;
    }
    if (path === '/charsetless-no-meta') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body>München</body></html>');
      return;
    }
    if (path === '/cache-control') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=17',
      });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/expires') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        expires: 'Wed, 29 Jul 2026 12:00:00 GMT',
      });
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
    if (path === '/csp') {
      // Origin mints a per-response CSP nonce that matches THIS body.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'nonce-ABC'",
      });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/csp-weaker') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src *; script-src 'nonce-ABC'",
      });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/csp-report-only') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy-report-only': "script-src 'nonce-RO'",
      });
      res.end(PAGE_HTML);
      return;
    }
    if (path === '/large-csp') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': OVERSIZED_REFETCH_CSP,
      });
      res.end(PAGE_HTML);
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

describe('handler — Content-Encoding on the FIRST response (gzip fix)', () => {
  it('a gzip/br FIRST response still PROCEEDS to lookup + re-fetch and injects (identity re-fetch)', async () => {
    // With Compress on, CloudFront forwards Accept-Encoding, so most real-viewer
    // first responses arrive gzip/br. The first gate ignores content-encoding —
    // we re-fetch the origin with Accept-Encoding: identity anyway.
    const event = eventFor('/page', {
      responseHeaders: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
    });
    const result = await invoke(event);

    // NOT passed through: the lookup ran, the origin was re-fetched, and the
    // JSON-LD was injected into the identity body.
    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(1);
    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.body).toContain(SNIPPET);
  });

  it('deletes the stale content-encoding header on the generated (identity) response', async () => {
    // The injected body is the uncompressed re-fetch; keeping the first
    // response's gzip Content-Encoding would make the viewer gunzip plain HTML.
    const event = eventFor('/page', {
      responseHeaders: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' },
    });
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['content-encoding']).toBeUndefined();
  });

  it('but if the ORIGIN RE-FETCH answer carries content-encoding, THAT passes through untouched', async () => {
    // First response gzip (ignored by the first gate) → proceed → the origin
    // ignores Accept-Encoding: identity and answers gzip → second gate fails.
    const event = eventFor('/gzipped', {
      responseHeaders: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
    });
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1); // snippet fetched → re-fetch reached
    expect(originHits).toBe(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });
});

describe('handler — CSP passthrough from the re-fetch (per-response nonce)', () => {
  it('copies the re-fetch content-security-policy onto the generated response', async () => {
    // The first response carries a DIFFERENT nonce; the generated body is the
    // re-fetch's, so its CSP (with the matching nonce) must win.
    const event = eventFor('/csp', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'nonce-FIRST'",
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['content-security-policy']?.[0]?.value).toBe("script-src 'nonce-ABC'");
    expect(result?.headers?.['content-security-policy']?.[0]?.key).toBe('Content-Security-Policy');
  });

  it('fails open when the re-fetch weakens the non-nonce CSP structure', async () => {
    const event = eventFor('/csp-weaker', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'nonce-FIRST'",
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['content-security-policy']?.[0]?.value).toBe(
      "default-src 'none'; script-src 'nonce-FIRST'"
    );
  });

  it('copies the re-fetch content-security-policy-report-only onto the generated response', async () => {
    const event = eventFor('/csp-report-only', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy-report-only': "script-src 'nonce-FIRST-RO'",
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['content-security-policy-report-only']?.[0]?.value).toBe(
      "script-src 'nonce-RO'"
    );
    expect(result?.headers?.['content-security-policy-report-only']?.[0]?.key).toBe(
      'Content-Security-Policy-Report-Only'
    );
  });

  it('when the re-fetch has no CSP, the generated response does not gain one', async () => {
    // Neither the first response nor the /page re-fetch declares a CSP.
    const event = eventFor('/page');
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['content-security-policy']).toBeUndefined();
    expect(result?.headers?.['content-security-policy-report-only']).toBeUndefined();
  });

  it('fails open instead of dropping CSP headers when the re-fetch has none', async () => {
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'nonce-FIRST'",
        'content-security-policy-report-only': "script-src 'nonce-FIRST-RO'",
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['content-security-policy']?.[0]?.value).toBe(
      "script-src 'nonce-FIRST'"
    );
    expect(result?.headers?.['content-security-policy-report-only']?.[0]?.value).toBe(
      "script-src 'nonce-FIRST-RO'"
    );
  });
});

describe('handler — representation headers follow the re-fetch body', () => {
  it('advertises generated text as UTF-8 when Unicode JSON-LD is injected into ASCII HTML', async () => {
    enhancelyFetch.mockResolvedValueOnce(
      new Response(UNICODE_JSONLD_RAW, { status: 200, headers: { etag: '"unicode"' } })
    );
    const event = eventFor('/ascii', {
      responseHeaders: { 'content-type': 'text/html; charset=us-ascii' },
    });
    const result = await invoke(event);

    expect(result?.body).toContain(UNICODE_JSONLD_RAW);
    expect(result?.headers?.['content-type']?.[0]).toEqual({
      key: 'Content-Type',
      value: 'text/html; charset=utf-8',
    });
  });

  it('fails open when an ASCII-labeled origin body actually contains non-ASCII bytes', async () => {
    const event = eventFor('/ascii-non-ascii', {
      responseHeaders: { 'content-type': 'text/html; charset=us-ascii' },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('accepts charset-less non-ASCII HTML only with an unambiguous UTF-8 BOM', async () => {
    const event = eventFor('/charsetless-utf8-bom', {
      responseHeaders: { 'content-type': 'text/html' },
    });
    const result = await invoke(event);

    expect(result?.body).toContain('München');
    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['content-type']?.[0]?.value).toBe('text/html; charset=utf-8');
  });

  it.each([
    '/charsetless-utf8-meta',
    '/charsetless-windows-meta',
    '/charsetless-no-meta',
    '/charsetless-comment-meta',
    '/charsetless-data-charset',
  ])('fails open for ambiguous charset-less non-ASCII HTML at %s', async (uri) => {
    const event = eventFor(uri, {
      responseHeaders: { 'content-type': 'text/html' },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

  it('fails open when Cache-Control changes between the first response and re-fetch', async () => {
    const event = eventFor('/cache-control', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]).toEqual({
      key: 'cache-control',
      value: 'public, max-age=86400',
    });
  });

  it('retains and copies a stable Cache-Control policy for the generated body', async () => {
    const event = eventFor('/cache-control', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'PUBLIC, MAX-AGE=17',
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['cache-control']?.[0]).toEqual({
      key: 'Cache-Control',
      value: 'public, max-age=17',
    });
  });

  it('fails open when the first response has Cache-Control but the re-fetch does not', async () => {
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]?.value).toBe('public, max-age=86400');
  });

  it('copies Expires from the re-fetch whose body is generated', async () => {
    const event = eventFor('/expires', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        expires: 'Wed, 29 Jul 2026 12:00:00 GMT',
      },
    });
    const result = await invoke(event);

    expect(result?.body).toContain(SNIPPET);
    expect(result?.headers?.['expires']?.[0]).toEqual({
      key: 'Expires',
      value: 'Wed, 29 Jul 2026 12:00:00 GMT',
    });
  });

  it('fails open when Expires changes between the first response and re-fetch', async () => {
    const event = eventFor('/expires', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        expires: 'Wed, 29 Jul 2026 11:00:00 GMT',
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['expires']?.[0]?.value).toBe('Wed, 29 Jul 2026 11:00:00 GMT');
  });

  it('fails open when the first response has Expires but the re-fetch does not', async () => {
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        expires: 'Wed, 29 Jul 2026 11:00:00 GMT',
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['expires']?.[0]?.value).toBe('Wed, 29 Jul 2026 11:00:00 GMT');
  });
});

describe('handler — gating pass-through (original response, no origin contact)', () => {
  it.each([
    ['non-GET request', { method: 'POST' as const }],
    ['non-200 status', { status: '404' }],
    ['non-HTML content type', { responseHeaders: { 'content-type': 'application/json' } }],
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

  it('honors restrictive directives in every Cache-Control header entry', async () => {
    const event = eventFor('/page');
    const response = event.Records[0]?.cf.response;
    if (response === undefined) throw new Error('expected response fixture');
    response.headers['cache-control'] = [
      { key: 'Cache-Control', value: 'public, max-age=86400' },
      { key: 'Cache-Control', value: 'no-store' },
    ];

    const result = await invoke(event);

    expect(result).toBe(response);
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
  it('a larger re-fetch CSP that pushes generated headers over 32 KB → passthrough', async () => {
    const firstHeaders = {
      'content-type': 'text/html; charset=utf-8',
      'x-heavy': 'h'.repeat(21_000),
    };
    expect(
      serializedHeaderBytes(
        cfHeaders({
          ...firstHeaders,
          'content-security-policy': OVERSIZED_REFETCH_CSP,
        })
      )
    ).toBeGreaterThan(MAX_RESPONSE_HEADER_BYTES);

    const event = eventFor('/large-csp', { responseHeaders: firstHeaders });
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(1);
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
  });

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

  it('a long UTF-8 statusDescription is included in the generated-response budget', async () => {
    const n = heavyBudget - SNIPPET.length;
    const event = eventFor('/sized', {
      querystring: `n=${n}`,
      responseHeaders: heavyHeaders,
    });
    const response = event.Records[0]?.cf.response;
    if (response === undefined) throw new Error('expected response fixture');
    response.statusDescription = 'Ü'.repeat(1_024);

    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(response);
    expect(result?.body).toBeUndefined();
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

  it('Enhancely has no record (404) → no body replacement and a bounded retry TTL', async () => {
    enhancelyFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    // The origin declares an explicit (long) shared-cache lifetime, so the
    // retry TTL is free to SHORTEN it to the bounded retry window.
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=');
  });

  it('Enhancely fetch rejects → no body replacement and the core backoff TTL', async () => {
    enhancelyFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=10');
  });
});

describe('handler — Enhancely-first reorder (no snippet ⇒ no origin re-fetch)', () => {
  it('404 from Enhancely (no snippet) → ZERO origin re-fetch, bounded cache TTL', async () => {
    enhancelyFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(0); // the origin is NOT re-fetched when there is nothing to inject
    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=');
  });

  it('rate-limited (429) → ZERO origin re-fetch and Retry-After cache TTL', async () => {
    enhancelyFetch.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } })
    );
    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    expect(enhancelyFetch).toHaveBeenCalledTimes(1);
    expect(originHits).toBe(0);
    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=30');
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

describe('handler — pending auto-registration cache policy', () => {
  it('caps CloudFront caching at the core TTL and removes origin validators', async () => {
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const responseHeaders = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      etag: '"uninjected"',
      'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
      expires: 'Thu, 01 Jan 2027 00:00:00 GMT',
    };
    const first = await invoke(eventFor('/new-page', { responseHeaders }));

    expect(first?.body).toBeUndefined();
    expect(originHits).toBe(0);
    expect(enhancelyFetch).toHaveBeenCalledTimes(2); // one GET + one registration POST
    expect(first?.headers?.['etag']).toBeUndefined();
    expect(first?.headers?.['last-modified']).toBeUndefined();
    expect(first?.headers?.['expires']).toBeUndefined();
    const firstPolicy = first?.headers?.['cache-control']?.[0]?.value ?? '';
    expect(firstPolicy).toMatch(/^max-age=0, s-maxage=\d+, must-revalidate$/);
    const firstTtl = Number(/s-maxage=(\d+)/.exec(firstPolicy)?.[1]);
    expect(firstTtl).toBeGreaterThanOrEqual(19);
    expect(firstTtl).toBeLessThanOrEqual(20);

    // A different CloudFront variant of the same normalized page is answered
    // from the core's pending negative cache and receives the same short policy
    // without another Enhancely GET/POST or origin re-fetch.
    const second = await invoke(
      eventFor('/new-page', { querystring: 'variant=2', responseHeaders })
    );
    expect(second?.body).toBeUndefined();
    expect(second?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=');
    expect(enhancelyFetch).toHaveBeenCalledTimes(2);
    expect(originHits).toBe(0);
  });

  it.each([
    ['no-cache', 0],
    ['public, max-age=4', 4],
    ['public, s-maxage=3, max-age=100', 3],
  ])('never lengthens the origin cache policy %j', async (originPolicy, expectedTtl) => {
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const result = await invoke(
      eventFor('/short-origin-ttl', {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': originPolicy,
        },
      })
    );

    expect(result?.headers?.['cache-control']?.[0]?.value).toContain(`s-maxage=${expectedTtl}`);
    expect(enhancelyFetch).toHaveBeenCalledTimes(2);
    expect(originHits).toBe(0);
  });

  it('honors no-cache in a second Cache-Control entry when setting the retry policy', async () => {
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const event = eventFor('/multi-cache-control');
    const response = event.Records[0]?.cf.response;
    if (response === undefined) throw new Error('expected response fixture');
    response.headers['cache-control'] = [
      { key: 'Cache-Control', value: 'public, max-age=86400' },
      { key: 'Cache-Control', value: 'no-cache' },
    ];

    const result = await invoke(event);

    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=0');
    expect(originHits).toBe(0);
  });

  it('uses Expires when Cache-Control has no explicit freshness lifetime', async () => {
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const result = await invoke(
      eventFor('/expires-fallback', {
        responseHeaders: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public',
          date: 'Mon, 27 Jul 2026 12:00:00 GMT',
          expires: 'Mon, 27 Jul 2026 12:00:04 GMT',
        },
      })
    );

    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=4');
  });

  it.each([
    ['authorization', 'Bearer viewer-secret'],
    ['cookie', 'session=viewer-secret'],
  ])('does not add shared cacheability to a request carrying %s', async (name, value) => {
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const event = eventFor('/credentialed-miss', {
      requestHeaders: { [name]: value },
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'max-age=86400',
        etag: '"credentialed"',
      },
    });
    const result = await invoke(event);

    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.headers?.['cache-control']?.[0]?.value).toBe('max-age=86400');
    expect(result?.headers?.['etag']?.[0]?.value).toBe('"credentialed"');
    expect(enhancelyFetch).toHaveBeenCalledTimes(2);
    expect(originHits).toBe(0);
  });

  it('origin declared NO cache lifetime → response returned UNCHANGED (never made cacheable)', async () => {
    // Invariant: with no explicit origin lifetime (no Cache-Control freshness,
    // no Expires) the response's cacheability is the distribution's DefaultTTL,
    // which the adapter cannot see. Introducing an s-maxage here could make an
    // origin-uncacheable response (DefaultTTL=0) shared-cacheable — the opposite
    // of "never make a response more cacheable than it already was". So the
    // pass-through is byte-for-byte the original, with Cache-Control untouched.
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const event = eventFor('/no-lifetime-miss', {
      responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
    });
    const result = await invoke(event);

    // Same object back, no injected shared-cache directive introduced.
    expect(result).toBe(event.Records[0]?.cf.response);
    expect(result?.headers?.['cache-control']).toBeUndefined();
    // The lookup still ran (GET + registration POST); the origin was not re-fetched.
    expect(enhancelyFetch).toHaveBeenCalledTimes(2);
    expect(originHits).toBe(0);
  });

  it('a long explicit max-age is still CAPPED (shortened) to the retry window', async () => {
    // Counterpart to the invariant above: when the origin DOES declare a
    // lifetime, the retry TTL shortens (never lengthens) it. A 3600 s origin
    // max-age is capped to the ~20 s retry window.
    __setBakedConfigForTests({
      apiKey: 'sk-test',
      autoRegister: true,
      cacheTtlMs: 20_000,
    });
    enhancelyFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const event = eventFor('/long-lifetime-miss', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    const policy = result?.headers?.['cache-control']?.[0]?.value ?? '';
    expect(policy).toMatch(/^max-age=0, s-maxage=\d+, must-revalidate$/);
    const ttl = Number(/s-maxage=(\d+)/.exec(policy)?.[1]);
    expect(ttl).toBeGreaterThanOrEqual(19);
    expect(ttl).toBeLessThanOrEqual(20); // shortened from 3600 to the retry window
    expect(originHits).toBe(0);
  });
});

describe('handler — placeholder key guard (no re-fetch when key not configured)', () => {
  it('a baked REPLACE_ME key → pass-through body with a bounded config-retry TTL', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Overwrite the beforeEach sk-test key with the SSM placeholder value.
    __setBakedConfigForTests({ apiKey: 'REPLACE_ME' });

    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.body).toBeUndefined();
    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=30');
    expect(originHits).toBe(0); // never pays the doubled origin load
    expect(enhancelyFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled(); // loud "not configured"
  });
});

describe('handler — config failures', () => {
  it('no API key resolvable → pass-through body with cooldown TTL (loud, once)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    __setBakedConfigForTests({}); // no apiKey; mocked SSM has no usable client
    __setConfigOverridesForTests(null);

    const event = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const result = await invoke(event);

    expect(result).not.toBe(event.Records[0]?.cf.response);
    expect(result?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=30');
    expect(originHits).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // Second invocation: inside the 30-second cooldown → no retry or second log.
    const secondEvent = eventFor('/page', {
      responseHeaders: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
    const again = await invoke(secondEvent);
    expect(again).not.toBe(secondEvent.Records[0]?.cf.response);
    expect(again?.headers?.['cache-control']?.[0]?.value).toContain('s-maxage=30');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
