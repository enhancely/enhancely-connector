import { describe, expect, it } from 'vitest';
import { shouldAttemptInjection } from '../src/gate.js';

const okInput = {
  method: 'GET',
  status: 200,
  contentType: 'text/html; charset=utf-8',
  contentEncoding: null,
  cacheControl: null,
  contentDisposition: null,
  xRobotsTag: null,
  apiKey: 'sk-test',
};

describe('shouldAttemptInjection', () => {
  it('allows GET + exact 200 + text/html + key', () => {
    expect(shouldAttemptInjection(okInput)).toBe(true);
  });

  it('allows bare text/html without charset', () => {
    expect(shouldAttemptInjection({ ...okInput, contentType: 'text/html' })).toBe(true);
  });

  it('is case/whitespace tolerant on content type', () => {
    expect(shouldAttemptInjection({ ...okInput, contentType: '  TEXT/HTML; charset=UTF-8' })).toBe(
      true
    );
  });

  it('rejects non-GET methods', () => {
    for (const method of ['POST', 'HEAD', 'PUT', 'OPTIONS']) {
      expect(shouldAttemptInjection({ ...okInput, method })).toBe(false);
    }
  });

  it('rejects every status other than 200', () => {
    for (const status of [199, 201, 204, 206, 301, 404, 500]) {
      expect(shouldAttemptInjection({ ...okInput, status })).toBe(false);
    }
  });

  it('rejects non-HTML content types', () => {
    for (const contentType of ['application/json', 'text/plain', 'text/htmlx', null]) {
      expect(shouldAttemptInjection({ ...okInput, contentType })).toBe(false);
    }
  });

  it('rejects encoded, no-transform, and attachment responses before body work', () => {
    expect(shouldAttemptInjection({ ...okInput, contentEncoding: 'gzip' })).toBe(false);
    expect(shouldAttemptInjection({ ...okInput, cacheControl: 'public, no-transform' })).toBe(
      false
    );
    expect(
      shouldAttemptInjection({ ...okInput, contentDisposition: 'attachment; filename="page.html"' })
    ).toBe(false);
    expect(
      shouldAttemptInjection({
        ...okInput,
        contentDisposition: 'inline, attachment; filename="page.html"',
      })
    ).toBe(false);
  });

  it('rejects folded quoted commas because Workers hides field-instance boundaries', () => {
    const folded = (name: string, values: string[]): string | null => {
      const headers = new Headers();
      for (const value of values) headers.append(name, value);
      return headers.get(name);
    };

    expect(
      shouldAttemptInjection({
        ...okInput,
        contentType: folded('content-type', [
          'text/html; profile="unterminated',
          'application/json"',
        ]),
      })
    ).toBe(false);
    expect(
      shouldAttemptInjection({
        ...okInput,
        cacheControl: folded('cache-control', ['public, ext="unterminated', 'no-transform"']),
      })
    ).toBe(false);
    expect(
      shouldAttemptInjection({
        ...okInput,
        contentDisposition: folded('content-disposition', [
          'inline; filename="unterminated',
          'attachment"',
        ]),
      })
    ).toBe(false);

    expect(
      shouldAttemptInjection({
        ...okInput,
        contentType: folded('content-type', [
          'text/html; profile="unterminated' + '\\',
          'application/json"',
        ]),
      })
    ).toBe(false);
    expect(
      shouldAttemptInjection({
        ...okInput,
        cacheControl: folded('cache-control', [
          'public, ext="unterminated' + '\\',
          'no-transform"',
        ]),
      })
    ).toBe(false);
    expect(
      shouldAttemptInjection({
        ...okInput,
        contentDisposition: folded('content-disposition', [
          'inline; filename="unterminated' + '\\',
          'attachment"',
        ]),
      })
    ).toBe(false);

    // A legitimate quoted comma is indistinguishable after Fetch folding and
    // therefore deliberately under-injects on this adapter.
    expect(
      shouldAttemptInjection({
        ...okInput,
        contentType: 'text/html; profile="one,two"',
      })
    ).toBe(false);
  });

  it('rejects noindex/none robots directives', () => {
    for (const xRobotsTag of ['noindex', 'index, nofollow, none', 'googlebot: noindex']) {
      expect(shouldAttemptInjection({ ...okInput, xRobotsTag })).toBe(false);
    }
    expect(shouldAttemptInjection({ ...okInput, xRobotsTag: 'index, follow' })).toBe(true);
  });

  it('rejects a missing or empty API key', () => {
    expect(shouldAttemptInjection({ ...okInput, apiKey: undefined })).toBe(false);
    expect(shouldAttemptInjection({ ...okInput, apiKey: '' })).toBe(false);
  });
});
