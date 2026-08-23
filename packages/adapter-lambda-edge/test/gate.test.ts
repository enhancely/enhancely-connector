import { describe, expect, it } from 'vitest';
import {
  buildOriginUrl,
  buildPageUrl,
  charsetOf,
  forwardedHeaders,
  resolvePageRequestTarget,
  serializedHeaderBytes,
  shouldAttemptGeneratedResponse,
} from '../src/shared.js';
import type { AttemptInput } from '../src/shared.js';
import { cfHeaders } from './fixtures.js';

function attempt(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    method: 'GET',
    status: '200',
    contentType: 'text/html; charset=utf-8',
    contentEncoding: null,
    cacheControl: null,
    contentDisposition: null,
    ...overrides,
  };
}

describe('shouldAttemptGeneratedResponse', () => {
  it('accepts GET + 200 + text/html without encoding', () => {
    expect(shouldAttemptGeneratedResponse(attempt())).toBe(true);
    expect(shouldAttemptGeneratedResponse(attempt({ contentType: 'text/html' }))).toBe(true);
    expect(
      shouldAttemptGeneratedResponse(attempt({ contentType: 'TEXT/HTML; Charset="UTF-8"' }))
    ).toBe(true);
  });

  it.each(['POST', 'HEAD', 'PUT', 'OPTIONS'])('rejects %s requests', (method) => {
    expect(shouldAttemptGeneratedResponse(attempt({ method }))).toBe(false);
  });

  it.each(['201', '204', '206', '301', '304', '404', '500'])(
    'rejects status %s (only exactly "200")',
    (status) => {
      expect(shouldAttemptGeneratedResponse(attempt({ status }))).toBe(false);
    }
  );

  it('rejects non-HTML content types', () => {
    expect(shouldAttemptGeneratedResponse(attempt({ contentType: null }))).toBe(false);
    expect(shouldAttemptGeneratedResponse(attempt({ contentType: 'application/json' }))).toBe(
      false
    );
    expect(shouldAttemptGeneratedResponse(attempt({ contentType: 'text/plain' }))).toBe(false);
    // exact media-type match, not a prefix check
    expect(shouldAttemptGeneratedResponse(attempt({ contentType: 'text/htmlx' }))).toBe(false);
  });

  it('rejects non-UTF-8-compatible charsets (no transcoding support)', () => {
    expect(
      shouldAttemptGeneratedResponse(attempt({ contentType: 'text/html; charset=iso-8859-1' }))
    ).toBe(false);
    expect(
      shouldAttemptGeneratedResponse(attempt({ contentType: 'text/html; charset=windows-1252' }))
    ).toBe(false);
    expect(
      shouldAttemptGeneratedResponse(attempt({ contentType: 'text/html; charset=us-ascii' }))
    ).toBe(true);
  });

  it('rejects a Content-Encoding because the fetched body must be identity bytes', () => {
    expect(shouldAttemptGeneratedResponse(attempt({ contentEncoding: 'gzip' }))).toBe(false);
    expect(shouldAttemptGeneratedResponse(attempt({ contentEncoding: 'br' }))).toBe(false);
  });

  it.each(['private', 'no-store', 'private, max-age=0', 's-maxage=10, no-store', 'PRIVATE'])(
    'accepts per-request Cache-Control %j because it returns the one fetched response',
    (cacheControl) => {
      expect(shouldAttemptGeneratedResponse(attempt({ cacheControl }))).toBe(true);
    }
  );

  it('rejects no-transform and attachment representations', () => {
    expect(shouldAttemptGeneratedResponse(attempt({ cacheControl: 'public, no-transform' }))).toBe(
      false
    );
    expect(
      shouldAttemptGeneratedResponse(
        attempt({ contentDisposition: 'attachment; filename="page.html"' })
      )
    ).toBe(false);
    expect(
      shouldAttemptGeneratedResponse(
        attempt({ contentDisposition: 'inline, attachment; filename="page.html"' })
      )
    ).toBe(false);
  });

  it('preserves field-instance boundaries so malformed quotes cannot heal', () => {
    expect(
      shouldAttemptGeneratedResponse(
        attempt({ contentType: ['text/html; profile="unterminated', 'application/json"'] })
      )
    ).toBe(false);
    expect(
      shouldAttemptGeneratedResponse(
        attempt({ cacheControl: ['public, ext="unterminated', 'no-transform"'] })
      )
    ).toBe(false);
    expect(
      shouldAttemptGeneratedResponse(
        attempt({ contentDisposition: ['inline; filename="unterminated', 'attachment"'] })
      )
    ).toBe(false);
  });
});

describe('charsetOf', () => {
  it('extracts the charset parameter case-insensitively', () => {
    expect(charsetOf('text/html; charset=UTF-8')).toBe('utf-8');
    expect(charsetOf('text/html;charset="iso-8859-1"')).toBe('iso-8859-1');
    expect(charsetOf('text/html')).toBeNull();
  });
});

describe('forwardedHeaders', () => {
  it('forwards ALL request headers, not just a fixed trio', () => {
    const out = forwardedHeaders(
      cfHeaders({
        cookie: 'session=s1',
        authorization: 'Bearer t',
        'accept-language': 'de-DE',
        'user-agent': 'Mozilla/5.0 (iPhone)',
        accept: 'text/html,application/xhtml+xml',
        'cloudfront-is-mobile-viewer': 'true',
        'cloudfront-viewer-country': 'DE',
        'x-forwarded-for': '203.0.113.1',
      })
    );
    expect(out).toEqual({
      cookie: 'session=s1',
      authorization: 'Bearer t',
      'accept-language': 'de-DE',
      'user-agent': 'Mozilla/5.0 (iPhone)',
      accept: 'text/html,application/xhtml+xml',
      'cloudfront-is-mobile-viewer': 'true',
      'cloudfront-viewer-country': 'DE',
      'x-forwarded-for': '203.0.113.1',
    });
  });

  it('excludes host, accept-encoding and every hop-by-hop header', () => {
    const out = forwardedHeaders(
      cfHeaders({
        host: 'www.example.com',
        'accept-encoding': 'gzip, br',
        connection: 'keep-alive, x-connection-local',
        'x-connection-local': 'must-not-forward',
        'proxy-connection': 'keep-alive',
        'keep-alive': 'timeout=5',
        'proxy-authenticate': 'Basic',
        'proxy-authorization': 'Basic Zm9v',
        te: 'trailers',
        trailer: 'Expires',
        'transfer-encoding': 'chunked',
        upgrade: 'h2c',
        'user-agent': 'UA',
      })
    );
    expect(out).toEqual({ 'user-agent': 'UA' });
  });

  it('recombines repeated entries: cookies with "; ", others with ", "', () => {
    const out = forwardedHeaders({
      cookie: [
        { key: 'Cookie', value: 'a=1' },
        { key: 'Cookie', value: 'b=2' },
      ],
      accept: [
        { key: 'Accept', value: 'text/html' },
        { key: 'Accept', value: 'application/xhtml+xml' },
      ],
    });
    expect(out['cookie']).toBe('a=1; b=2');
    expect(out['accept']).toBe('text/html, application/xhtml+xml');
  });
});

describe('serializedHeaderBytes', () => {
  it('sums key + value + 4 per header value, plus the 64-byte overhead', () => {
    // 64 + ('Content-Type' 12 + 'text/html' 9 + 4) + ('X-A' 3 + 'b' 1 + 4)
    const bytes = serializedHeaderBytes(cfHeaders({ 'Content-Type': 'text/html', 'X-A': 'b' }));
    expect(bytes).toBe(64 + (12 + 9 + 4) + (3 + 1 + 4));
  });

  it('counts every value of a repeated header and falls back to the map key', () => {
    const bytes = serializedHeaderBytes({
      'set-cookie': [{ key: 'Set-Cookie', value: 'a=1' }, { value: 'b=2' }],
    });
    // 64 + ('Set-Cookie' 10 + 'a=1' 3 + 4) + ('set-cookie' 10 + 'b=2' 3 + 4)
    expect(bytes).toBe(64 + (10 + 3 + 4) + (10 + 3 + 4));
  });

  it('counts UTF-8 bytes rather than JavaScript characters in header values', () => {
    const value = 'München 😀';
    const bytes = serializedHeaderBytes(cfHeaders({ 'X-Title': value }));
    expect(bytes).toBe(
      64 + Buffer.byteLength('X-Title', 'utf8') + Buffer.byteLength(value, 'utf8') + 4
    );
    expect(bytes).toBeGreaterThan(64 + 'X-Title'.length + value.length + 4);
  });

  it('counts an unusually long UTF-8 statusDescription instead of assuming 64 bytes', () => {
    const description = 'Ü'.repeat(100);
    const bytes = serializedHeaderBytes({}, '200', description);
    expect(bytes).toBe(Buffer.byteLength(`HTTP/1.1 200 ${description}\r\n`, 'utf8') + 2);
    expect(bytes).toBeGreaterThan(64);
  });

  it('is 64 (overhead only) for an empty header map', () => {
    expect(serializedHeaderBytes({})).toBe(64);
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

describe('resolvePageRequestTarget', () => {
  const request = () => ({
    headers: cfHeaders({ host: 'www.example.com' }),
    origin: {
      custom: {
        customHeaders: {},
        domainName: 'origin.example.com',
        keepaliveTimeout: 5,
        path: '',
        port: 443,
        protocol: 'https' as const,
        readTimeout: 30,
        sslProtocols: ['TLSv1.2' as const],
      },
    },
    uri: '/page',
    querystring: 'a=1',
  });

  it('resolves one shared origin/public target', () => {
    expect(resolvePageRequestTarget(request())).toEqual({
      originHost: 'www.example.com',
      pageHost: 'www.example.com',
      pageUrl: 'https://www.example.com/page?a=1',
    });
  });

  it('gives the static public page-host override precedence', () => {
    const input = request();
    input.origin.custom.customHeaders = cfHeaders({
      'x-enhancely-page-host': 'public.example.com',
    });
    expect(resolvePageRequestTarget(input)?.pageHost).toBe('public.example.com');
  });

  it('rejects duplicate Host or public page-host field instances', () => {
    const duplicateHost = request();
    duplicateHost.headers = cfHeaders({ host: ['www.example.com', 'evil.example'] });
    expect(resolvePageRequestTarget(duplicateHost)).toBeNull();

    const duplicateOverride = request();
    duplicateOverride.origin.custom.customHeaders = cfHeaders({
      'x-enhancely-page-host': ['public.example.com', 'evil.example'],
    });
    expect(resolvePageRequestTarget(duplicateOverride)).toBeNull();
  });

  it('rejects an explicitly empty public page-host override instead of using the origin host', () => {
    const input = request();
    input.origin.custom.customHeaders = cfHeaders({ 'x-enhancely-page-host': '' });
    expect(resolvePageRequestTarget(input)).toBeNull();
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
