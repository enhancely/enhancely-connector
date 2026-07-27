/**
 * Regression tests for the external (Codex) review findings, 2026-07-27.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildScriptTag,
  defineConfig,
  getJsonLdSnippet,
  injectIntoHead,
  isHtmlMediaType,
  MemoryCache,
} from '../src/index.js';
import { parseRetryAfter } from '../src/client.js';
import type { CacheBackend, CacheEntry, Fetcher } from '../src/index.js';

const SNIP = '<x/>';

describe('injectIntoHead — raw-text elements (finding 1)', () => {
  it.each([
    ['style', '<head><style>.x{content:"</head>"}</style></head><body/>'],
    ['title', '<head><title>broken </head> title</title></head><body/>'],
    ['textarea', '<head><textarea></head></textarea></head><body/>'],
    ['noscript', '<head><noscript></head></noscript></head><body/>'],
  ])('skips a literal </head> inside <%s>', (_tag, html) => {
    const out = injectIntoHead(html, SNIP);
    const closer = out.lastIndexOf('</head>');
    expect(out.slice(closer - SNIP.length, closer)).toBe(SNIP);
    // Exactly one insertion, placed before the REAL (last) closer.
    expect(out.split(SNIP)).toHaveLength(2);
  });

  it('still injects before a plain </head>', () => {
    expect(injectIntoHead('<head></head>', SNIP)).toBe(`<head>${SNIP}</head>`);
  });
});

describe('parseRetryAfter (finding 10)', () => {
  it('parses delay-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });
  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-07-27T10:00:00Z');
    expect(parseRetryAfter('Mon, 27 Jul 2026 10:00:45 GMT', now)).toBe(45);
  });
  it('clamps past dates to 0 and rejects junk', () => {
    const now = Date.parse('2026-07-27T10:00:00Z');
    expect(parseRetryAfter('Mon, 27 Jul 2026 09:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('defineConfig — cleartext key protection (finding 4)', () => {
  it('rejects a plain-http remote base', () => {
    expect(() => defineConfig({ apiKey: 'k', enhancelyBase: 'http://api.example.com' })).toThrow(
      /https/
    );
  });
  it('allows http for loopback development', () => {
    expect(
      defineConfig({ apiKey: 'k', enhancelyBase: 'http://localhost:3000' }).enhancelyBase
    ).toBe('http://localhost:3000');
  });
});

describe('isHtmlMediaType (finding 9)', () => {
  it.each([
    ['text/html', true],
    ['text/html; charset=utf-8', true],
    ['TEXT/HTML;charset=ISO-8859-1', true],
    ['text/htmlx', false],
    ['application/xhtml+xml', false],
    [null, false],
  ])('%s → %s', (value, expected) => {
    expect(isHtmlMediaType(value)).toBe(expected);
  });
});

describe('backoff memo race (finding 3)', () => {
  it('does not clobber a concurrently stored fresh entry with a stale backoff memo', async () => {
    const fresh: CacheEntry = { jsonldRaw: '{"new":1}', etag: '"v2"', storedAt: Date.now() };
    let reads = 0;
    const sets: CacheEntry[] = [];
    const cache: CacheBackend = {
      // 1st read (orchestrator entry): miss. 2nd read (pre-memo check): a
      // parallel request has stored a fresh entry in the meantime.
      get: () => Promise.resolve(++reads === 1 ? undefined : fresh),
      set: (_k, e) => {
        sets.push(e);
        return Promise.resolve();
      },
    };
    const failingFetch = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response('nope', { status: 500 }))
    );
    const config = defineConfig({ apiKey: 'k', fetchImpl: failingFetch });

    const snippet = await getJsonLdSnippet('https://ex.com/p', cache, config);

    expect(snippet).toBeNull(); // our request saw a miss and failed
    expect(sets).toHaveLength(0); // but the fresh parallel entry survived
  });

  it('still writes the memo when nothing changed concurrently', async () => {
    const cache = new MemoryCache();
    const failingFetch = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response('nope', { status: 500 }))
    );
    const config = defineConfig({ apiKey: 'k', fetchImpl: failingFetch });

    await getJsonLdSnippet('https://ex.com/p', cache, config);
    const entry = await cache.get('https://ex.com/p');
    expect(entry?.retryNotBefore).toBeGreaterThan(Date.now());
  });
});

describe('buildScriptTag stays verbatim', () => {
  it('wraps without re-escaping', () => {
    expect(buildScriptTag('{"a":"\\u003c"}')).toBe(
      '<script type="application/ld+json">{"a":"\\u003c"}</script>'
    );
  });
});

describe('autoRegister (self-populating connector)', () => {
  const notFound = () => Promise.resolve(new Response('nf', { status: 404 }));

  it('POSTs the page once on 404, then stays quiet for the negative-cache TTL', async () => {
    const cache = new MemoryCache();
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const fetchImpl = vi.fn<Fetcher>((url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      return init.method === 'POST'
        ? Promise.resolve(new Response('{"status":"processing"}', { status: 201 }))
        : notFound();
    });
    const config = defineConfig({ apiKey: 'k', autoRegister: true, fetchImpl });

    expect(await getJsonLdSnippet('https://ex.com/new-page', cache, config)).toBeNull();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('/api/v1/jsonld');
    expect(JSON.parse(String(posts[0]?.body))).toEqual({ url: 'https://ex.com/new-page' });

    // Second view within the TTL: negative cache answers, no GET, no POST.
    await getJsonLdSnippet('https://ex.com/new-page', cache, config);
    expect(fetchImpl.mock.calls).toHaveLength(2); // 1 GET + 1 POST only
  });

  it('does not POST when autoRegister is off (default)', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>(() => notFound());
    await getJsonLdSnippet('https://ex.com/p', cache, defineConfig({ apiKey: 'k', fetchImpl }));
    expect(fetchImpl.mock.calls.filter(([, i]) => i.method === 'POST')).toHaveLength(0);
  });

  it('stays fail-open when the registration POST rejects', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn<Fetcher>((_u, init) =>
      init.method === 'POST' ? Promise.reject(new Error('boom')) : notFound()
    );
    const config = defineConfig({ apiKey: 'k', autoRegister: true, fetchImpl });
    expect(await getJsonLdSnippet('https://ex.com/p', cache, config)).toBeNull();
    const entry = await cache.get('https://ex.com/p');
    expect(entry?.jsonldRaw).toBeNull(); // negative entry still stored
  });
});
