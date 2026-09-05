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

  it('collapses runs of slashes inside the path (rule 4)', () => {
    expect(normalizeLite('https://example.com//a///b')).toBe('https://example.com/a/b');
  });

  it('strips a single trailing slash (rule 5)', () => {
    expect(normalizeLite('https://example.com/page/')).toBe('https://example.com/page');
  });

  it('collapses a trailing run of slashes, then strips the one that remains', () => {
    expect(normalizeLite('https://example.com/page//')).toBe('https://example.com/page');
    expect(normalizeLite('https://example.com/page/////')).toBe('https://example.com/page');
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

  it('accepts a doubled trailing slash now that collapsing makes it a fixed point', () => {
    // Before the path-slash collapse this drifted /page// → /page/ → /page and
    // was rejected outright; it now normalizes in one pass.
    expect(normalizeForEnhancely('https://example.com/page//?token=secret#fragment')).toBe(
      'https://example.com/page'
    );
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

describe('path-slash collapse (enhancely #279)', () => {
  // The CMS on the affected pilot domain emits hrefs with a doubled slash at
  // the start of the path. The backend stores URLs in a column that rejects
  // `//` inside a path, so forwarding them verbatim produced a permanently
  // failing registration for every such page, on every run.
  it.each([
    [
      'https://www.agromais-qa.de//ansprechpartner/ansprechpartner-detailseite/almstedt.html',
      'https://www.agromais-qa.de/ansprechpartner/ansprechpartner-detailseite/almstedt.html',
    ],
    [
      'https://www.agromais-qa.de//profitreff/profitreff-veranstaltungen/burgbernheim-4.html',
      'https://www.agromais-qa.de/profitreff/profitreff-veranstaltungen/burgbernheim-4.html',
    ],
  ])('collapses the reported doubled slash: %s', (input, expected) => {
    expect(normalizeLite(input)).toBe(expected);
    expect(normalizeForEnhancely(input)).toBe(expected);
  });

  it('collapses multiple runs anywhere in the path', () => {
    expect(normalizeLite('https://host//a///b/')).toBe('https://host/a/b');
  });

  it('never touches the `://` after the scheme', () => {
    expect(normalizeLite('https://host/a')).toBe('https://host/a');
    expect(normalizeLite('http://host//a')).toBe('https://host/a');
  });

  it('normalizes the root URL to a bare origin', () => {
    expect(normalizeLite('https://host/')).toBe('https://host');
    expect(normalizeLite('https://host//')).toBe('https://host');
    expect(normalizeForEnhancely('https://host//')).toBe('https://host');
  });

  it('leaves an already canonical URL byte-identical', () => {
    for (const url of [
      'https://host',
      'https://host/a/b',
      'https://host/a/b.html',
      'https://host:8443/a/b',
    ]) {
      expect(normalizeLite(url)).toBe(url);
      expect(normalizeForEnhancely(url)).toBe(url);
    }
  });

  it('a `//` inside a query value cannot reach the path', () => {
    expect(normalizeLite('https://host/a?next=https://other//x#f//g')).toBe('https://host/a');
    expect(normalizeForEnhancely('https://host/a?next=https://other//x')).toBe('https://host/a');
  });

  it('keeps a non-default port and the path case', () => {
    expect(normalizeLite('https://Host:8443//Docs//GettingStarted/')).toBe(
      'https://host:8443/Docs/GettingStarted'
    );
  });

  it('is idempotent for every collapsed shape', () => {
    for (const url of [
      'https://host//a///b/',
      'https://host//',
      'https://www.agromais-qa.de//profitreff/x.html',
      'http://Host:8443//A//b/',
    ]) {
      const once = normalizeLite(url);
      expect(normalizeLite(once)).toBe(once);
      expect(normalizeForEnhancely(url)).toBe(once);
    }
  });
});
