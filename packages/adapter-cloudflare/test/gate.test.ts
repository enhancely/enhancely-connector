import { describe, expect, it } from 'vitest';
import { shouldAttemptInjection } from '../src/gate.js';

const okInput = {
  method: 'GET',
  responseOk: true,
  contentType: 'text/html; charset=utf-8',
  apiKey: 'sk-test',
};

describe('shouldAttemptInjection', () => {
  it('allows GET + 2xx + text/html + key', () => {
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

  it('rejects non-2xx origin responses', () => {
    expect(shouldAttemptInjection({ ...okInput, responseOk: false })).toBe(false);
  });

  it('rejects non-HTML content types', () => {
    for (const contentType of ['application/json', 'text/plain', 'text/htmlx', null]) {
      expect(shouldAttemptInjection({ ...okInput, contentType })).toBe(false);
    }
  });

  it('rejects a missing or empty API key', () => {
    expect(shouldAttemptInjection({ ...okInput, apiKey: undefined })).toBe(false);
    expect(shouldAttemptInjection({ ...okInput, apiKey: '' })).toBe(false);
  });
});
