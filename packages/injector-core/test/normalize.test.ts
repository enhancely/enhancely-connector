import { describe, expect, it } from 'vitest';

import { normalizeForEnhancely, normalizeLite } from '../src/index.js';

describe('normalizeLite', () => {
  it('forces https (rule 1)', () => {
    expect(normalizeLite('http://example.com/page')).toBe('https://example.com/page');
  });

  it('strips the query string (rule 2)', () => {
    expect(normalizeLite('https://example.com/page?utm_source=x&b=2')).toBe(
      'https://example.com/page'
    );
  });

  it('strips the fragment (rule 3)', () => {
    expect(normalizeLite('https://example.com/page#section-2')).toBe('https://example.com/page');
  });

  it('strips a single trailing slash (rule 4)', () => {
    expect(normalizeLite('https://example.com/page/')).toBe('https://example.com/page');
  });

  it('strips only ONE trailing slash', () => {
    expect(normalizeLite('https://example.com/page//')).toBe('https://example.com/page/');
  });

  it('strips the root path slash too', () => {
    expect(normalizeLite('https://example.com/')).toBe('https://example.com');
  });

  it('applies all rules combined', () => {
    expect(normalizeLite('http://example.com/pricing/?plan=pro#faq')).toBe(
      'https://example.com/pricing'
    );
  });

  it('upgrades http even when other parts are already clean', () => {
    expect(normalizeLite('http://example.com/a/b')).toBe('https://example.com/a/b');
  });

  it('passes invalid URLs through unchanged (fail-open)', () => {
    expect(normalizeLite('not a url at all')).toBe('not a url at all');
    expect(normalizeLite('')).toBe('');
  });

  it('is idempotent on already-normalized URLs', () => {
    const once = normalizeLite('http://example.com/page/?q=1#f');
    expect(normalizeLite(once)).toBe(once);

    const clean = 'https://example.com/docs/getting-started';
    expect(normalizeLite(clean)).toBe(clean);
  });

  it('rejects a valid URL whose normalized key is not a fixed point', () => {
    expect(normalizeForEnhancely('https://example.com/page//?token=secret#fragment')).toBeNull();
  });

  it.each([
    'http://example.com/page/?token=secret#fragment',
    'https://example.com/',
    'https://example.com:8443/a/../b/',
    'https://münchen.example/straße/',
    'https://example.com/path%2F',
    'https://example.com/a//b/',
  ])('returns only safe normalization fixed points for %s', (raw) => {
    const key = normalizeForEnhancely(raw);
    expect(key).not.toBeNull();
    expect(normalizeLite(key ?? '')).toBe(key);

    const parsed = new URL(key ?? '');
    expect(parsed.protocol).toBe('https:');
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
  });
});
