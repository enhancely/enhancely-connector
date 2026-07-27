import { describe, expect, it } from 'vitest';
import { buildOriginUrl, buildPageUrl, charsetOf, shouldAttempt } from '../src/index.js';
import type { AttemptInput } from '../src/index.js';

function attempt(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    method: 'GET',
    status: '200',
    contentType: 'text/html; charset=utf-8',
    contentEncoding: null,
    cacheControl: null,
    hasSetCookie: false,
    ...overrides,
  };
}

describe('shouldAttempt', () => {
  it('accepts GET + 200 + text/html without encoding', () => {
    expect(shouldAttempt(attempt())).toBe(true);
    expect(shouldAttempt(attempt({ contentType: 'text/html' }))).toBe(true);
    expect(shouldAttempt(attempt({ contentType: 'TEXT/HTML; Charset="UTF-8"' }))).toBe(true);
  });

  it.each(['POST', 'HEAD', 'PUT', 'OPTIONS'])('rejects %s requests', (method) => {
    expect(shouldAttempt(attempt({ method }))).toBe(false);
  });

  it.each(['201', '204', '206', '301', '304', '404', '500'])(
    'rejects status %s (only exactly "200")',
    (status) => {
      expect(shouldAttempt(attempt({ status }))).toBe(false);
    }
  );

  it('rejects non-HTML content types', () => {
    expect(shouldAttempt(attempt({ contentType: null }))).toBe(false);
    expect(shouldAttempt(attempt({ contentType: 'application/json' }))).toBe(false);
    expect(shouldAttempt(attempt({ contentType: 'text/plain' }))).toBe(false);
    // exact media-type match, not a prefix check
    expect(shouldAttempt(attempt({ contentType: 'text/htmlx' }))).toBe(false);
  });

  it('rejects non-UTF-8-compatible charsets (no transcoding support)', () => {
    expect(shouldAttempt(attempt({ contentType: 'text/html; charset=iso-8859-1' }))).toBe(false);
    expect(shouldAttempt(attempt({ contentType: 'text/html; charset=windows-1252' }))).toBe(false);
    expect(shouldAttempt(attempt({ contentType: 'text/html; charset=us-ascii' }))).toBe(true);
  });

  it('rejects any Content-Encoding (compressed bodies pass through)', () => {
    expect(shouldAttempt(attempt({ contentEncoding: 'gzip' }))).toBe(false);
    expect(shouldAttempt(attempt({ contentEncoding: 'br' }))).toBe(false);
  });

  it('rejects responses carrying Set-Cookie (per-request representation)', () => {
    expect(shouldAttempt(attempt({ hasSetCookie: true }))).toBe(false);
  });

  it.each(['private', 'no-store', 'private, max-age=0', 's-maxage=10, no-store', 'PRIVATE'])(
    'rejects Cache-Control %j (per-request representation)',
    (cacheControl) => {
      expect(shouldAttempt(attempt({ cacheControl }))).toBe(false);
    }
  );

  it.each(['public, max-age=60', 'no-cache', 'max-age=0, must-revalidate'])(
    'accepts shareable Cache-Control %j (directive match, not substring)',
    (cacheControl) => {
      expect(shouldAttempt(attempt({ cacheControl }))).toBe(true);
    }
  );
});

describe('charsetOf', () => {
  it('extracts the charset parameter case-insensitively', () => {
    expect(charsetOf('text/html; charset=UTF-8')).toBe('utf-8');
    expect(charsetOf('text/html;charset="iso-8859-1"')).toBe('iso-8859-1');
    expect(charsetOf('text/html')).toBeNull();
  });
});

describe('buildPageUrl', () => {
  it('builds https URLs from host + uri', () => {
    expect(buildPageUrl('www.example.com', '/blog/post', '')).toBe(
      'https://www.example.com/blog/post'
    );
  });

  it('appends the querystring when present', () => {
    expect(buildPageUrl('www.example.com', '/search', 'q=a&page=2')).toBe(
      'https://www.example.com/search?q=a&page=2'
    );
  });
});

describe('buildOriginUrl', () => {
  const customOrigin = (overrides: Record<string, unknown> = {}) => ({
    origin: {
      custom: {
        customHeaders: {},
        domainName: 'origin.example.com',
        keepaliveTimeout: 5,
        path: '',
        port: 443,
        protocol: 'https' as const,
        readTimeout: 30,
        sslProtocols: ['TLSv1.2'],
        ...overrides,
      },
    },
    uri: '/page',
    querystring: '',
  });

  it('builds the origin URL with protocol and domain', () => {
    expect(buildOriginUrl(customOrigin())).toBe('https://origin.example.com/page');
  });

  it('omits default ports but includes custom ones', () => {
    expect(buildOriginUrl(customOrigin({ port: 8443 }))).toBe(
      'https://origin.example.com:8443/page'
    );
    expect(buildOriginUrl(customOrigin({ protocol: 'http', port: 80 }))).toBe(
      'http://origin.example.com/page'
    );
    expect(buildOriginUrl(customOrigin({ protocol: 'http', port: 8080 }))).toBe(
      'http://origin.example.com:8080/page'
    );
  });

  it('prefixes the originPath and appends the querystring', () => {
    const input = { ...customOrigin({ path: '/blog' }), uri: '/post', querystring: 'lang=de' };
    expect(buildOriginUrl(input)).toBe('https://origin.example.com/blog/post?lang=de');
  });

  it('returns null for non-custom (S3) origins', () => {
    expect(buildOriginUrl({ origin: undefined, uri: '/page', querystring: '' })).toBeNull();
  });
});
