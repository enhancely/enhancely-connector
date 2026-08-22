import type { CloudFrontHeaders } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { retryablePassThroughResponse, retrySharedTtlSeconds } from '../src/cache-cap.js';

function headers(values: Record<string, string[]>): CloudFrontHeaders {
  return Object.fromEntries(
    Object.entries(values).map(([name, entries]) => [
      name,
      entries.map((value) => ({ key: name, value })),
    ])
  );
}

describe('retrySharedTtlSeconds — ambiguous origin freshness', () => {
  it('treats duplicate max-age values as already stale', () => {
    const result = retrySharedTtlSeconds(
      headers({ 'cache-control': ['public, max-age=600, max-age=0'] }),
      10_000,
      86_400
    );

    expect(result).toBe(0);
  });

  it('treats malformed max-age as already stale instead of using DefaultTTL', () => {
    const result = retrySharedTtlSeconds(
      headers({ 'cache-control': ['public, max-age=bogus'] }),
      10_000,
      86_400
    );

    expect(result).toBe(0);
  });

  it('does not fall back to max-age when duplicate s-maxage is ambiguous', () => {
    const result = retrySharedTtlSeconds(
      headers({ 'cache-control': ['max-age=600, s-maxage=600, s-maxage=0'] }),
      10_000,
      86_400
    );

    expect(result).toBe(0);
  });

  it('treats either freshness directive as ambiguous even when the other has precedence', () => {
    const result = retrySharedTtlSeconds(
      headers({
        'cache-control': ['s-maxage=600, max-age=600, max-age=0'],
      }),
      10_000,
      86_400
    );

    expect(result).toBe(0);
  });

  it.each(['max-age =600', 'max-age= 600', 'max-age = 600'])(
    'treats forbidden whitespace around equals as stale: %s',
    (policy) => {
      expect(retrySharedTtlSeconds(headers({ 'cache-control': [policy] }), 10_000, 86_400)).toBe(0);
    }
  );

  it.each(['\u00a0max-age=600', 'max-age=600\u00a0'])(
    'does not mistake non-HTTP whitespace for OWS: %s',
    (policy) => {
      expect(retrySharedTtlSeconds(headers({ 'cache-control': [policy] }), 10_000, 86_400)).toBe(0);
    }
  );

  it('accepts only SP/HTAB as list-element OWS', () => {
    expect(
      retrySharedTtlSeconds(headers({ 'cache-control': [' \tmax-age=10\t '] }), 900_000, 86_400)
    ).toBe(10);
  });

  it('treats multiple Expires field values as already stale', () => {
    const result = retrySharedTtlSeconds(
      headers({
        date: ['Sat, 22 Aug 2026 10:00:00 GMT'],
        expires: ['Sat, 22 Aug 2026 11:00:00 GMT', 'Sat, 22 Aug 2026 10:00:00 GMT'],
      }),
      10_000,
      86_400
    );

    expect(result).toBe(0);
  });

  it('does not parse a directive name hidden inside a quoted extension value', () => {
    const result = retrySharedTtlSeconds(
      headers({
        'cache-control': ['foo="x,s-maxage=600,y", max-age=10'],
      }),
      900_000,
      86_400
    );

    expect(result).toBe(10);
  });

  it('does not parse no-cache hidden inside a quoted extension value', () => {
    const result = retrySharedTtlSeconds(
      headers({
        'cache-control': ['foo="x,no-cache,y", max-age="10"'],
      }),
      900_000,
      86_400
    );

    expect(result).toBe(10);
  });

  it('treats malformed or escaped quoted syntax as already stale', () => {
    expect(
      retrySharedTtlSeconds(
        headers({ 'cache-control': ['foo="unterminated, max-age=600'] }),
        900_000,
        86_400
      )
    ).toBe(0);
    expect(
      retrySharedTtlSeconds(
        headers({ 'cache-control': ['foo="escaped\\"quote", max-age=600'] }),
        900_000,
        86_400
      )
    ).toBe(0);
  });

  it('does not let separate malformed field instances heal each other', () => {
    expect(
      retrySharedTtlSeconds(
        headers({ 'cache-control': ['foo="unterminated', '", max-age=3600'] }),
        600_000,
        86_400
      )
    ).toBe(0);
  });

  it('leaves an ambiguous multi-instance policy byte-for-byte untouched', () => {
    const response = {
      status: '200',
      headers: headers({
        'cache-control': ['foo="unterminated', 'no-store", max-age=600'],
      }),
    };

    expect(
      retryablePassThroughResponse(response, {}, 30_000, {
        assertedDefaultTtlSeconds: 86_400,
        capSetCookieResponses: false,
      })
    ).toBe(response);
  });

  it('accepts a strict IMF-fixdate and caps it to the retry window', () => {
    const result = retrySharedTtlSeconds(
      headers({
        date: ['Sat, 22 Aug 2026 10:00:00 GMT'],
        expires: ['Sat, 22 Aug 2026 11:00:00 GMT'],
      }),
      900_000,
      86_400
    );

    expect(result).toBe(900);
  });

  it.each(['2027-12-31', 'Sun, 31 Feb 2027 11:00:00 GMT'])(
    'treats non-HTTP or impossible Expires %s as already stale',
    (expires) => {
      const result = retrySharedTtlSeconds(
        headers({
          date: ['Sat, 22 Aug 2026 10:00:00 GMT'],
          expires: [expires],
        }),
        900_000,
        86_400
      );

      expect(result).toBe(0);
    }
  );

  it('treats a malformed Date field as already stale', () => {
    const result = retrySharedTtlSeconds(
      headers({
        date: ['2026-08-22T10:00:00Z'],
        expires: ['Sat, 22 Aug 2026 11:00:00 GMT'],
      }),
      900_000,
      86_400
    );

    expect(result).toBe(0);
  });

  it('never rounds a sub-second remaining Expires lifetime upward', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-22T10:00:00.500Z'));
      const result = retrySharedTtlSeconds(
        headers({ expires: ['Sat, 22 Aug 2026 10:00:01 GMT'] }),
        10_000,
        86_400
      );

      expect(result).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
