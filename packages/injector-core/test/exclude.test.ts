import { describe, expect, it } from 'vitest';
import { matchesExcludedPath } from '../src/exclude.js';

describe('matchesExcludedPath', () => {
  it('matches exact paths only when identical', () => {
    expect(matchesExcludedPath(['/login'], '/login')).toBe(true);
    expect(matchesExcludedPath(['/login'], '/login/')).toBe(false);
    expect(matchesExcludedPath(['/login'], '/account/login')).toBe(false);
    expect(matchesExcludedPath(['/login'], '/LOGIN')).toBe(false); // case-sensitive
  });

  it('supports the CloudFront wildcard for subtrees and extensions', () => {
    expect(matchesExcludedPath(['/account/*'], '/account/settings')).toBe(true);
    expect(matchesExcludedPath(['/account/*'], '/account/orders/42')).toBe(true);
    expect(matchesExcludedPath(['/account/*'], '/account')).toBe(false);
    expect(matchesExcludedPath(['/account*'], '/account')).toBe(true);
    expect(matchesExcludedPath(['*.pdf'], '/docs/manual.pdf')).toBe(true);
    expect(matchesExcludedPath(['*.pdf'], '/docs/manual.pdf.html')).toBe(false);
  });

  it('supports the CloudFront single-character wildcard `?`', () => {
    expect(matchesExcludedPath(['/page-?'], '/page-1')).toBe(true);
    expect(matchesExcludedPath(['/page-?'], '/page-12')).toBe(false);
    expect(matchesExcludedPath(['/page-?'], '/page-')).toBe(false);
    expect(matchesExcludedPath(['/?/intern/*'], '/a/intern/x')).toBe(true);
  });

  it('treats a missing leading slash like CloudFront (equivalent to /pattern)', () => {
    expect(matchesExcludedPath(['account/*'], '/account/settings')).toBe(true);
    expect(matchesExcludedPath(['login'], '/login')).toBe(true);
    expect(matchesExcludedPath(['*.jpg'], '/img/a.jpg')).toBe(true); // wildcard start unchanged
  });

  it('normalizes dot-segments and duplicate slashes before matching', () => {
    expect(matchesExcludedPath(['/account/*'], '/public/../account/orders')).toBe(true);
    expect(matchesExcludedPath(['/account/*'], '//account//orders')).toBe(true);
    expect(matchesExcludedPath(['/account/*'], '/account/x/./y')).toBe(true);
    expect(matchesExcludedPath(['/login'], '/a/../login')).toBe(true);
    // `..` never climbs above the root.
    expect(matchesExcludedPath(['/login'], '/../../login')).toBe(true);
    // Directory-ness is preserved.
    expect(matchesExcludedPath(['/account/'], '/account/x/..')).toBe(true);
  });

  it('does NOT decode percent-encoding (documented under-exclusion)', () => {
    expect(matchesExcludedPath(['/account/*'], '/%61ccount/orders')).toBe(false);
  });

  it('treats regex metacharacters as literals', () => {
    expect(matchesExcludedPath(['/a.b'], '/a.b')).toBe(true);
    expect(matchesExcludedPath(['/a.b'], '/axb')).toBe(false);
    expect(matchesExcludedPath(['/price(1)'], '/price(1)')).toBe(true);
  });

  it('any pattern in the list may match', () => {
    const patterns = ['/login', '/account/*', '/intern*'];
    expect(matchesExcludedPath(patterns, '/interna/seite')).toBe(true);
    expect(matchesExcludedPath(patterns, '/produkte')).toBe(false);
  });

  it('ignores junk entries and empty lists without throwing', () => {
    expect(matchesExcludedPath([], '/login')).toBe(false);
    expect(
      matchesExcludedPath(['', 42 as unknown as string, null as unknown as string], '/x')
    ).toBe(false);
  });

  it('stays linear on adversarial multi-wildcard patterns (regression: ReDoS)', () => {
    // The old regex translation (`*` → `.*`) hung for minutes on this input;
    // the vitest per-test timeout fails this test if matching regresses to
    // super-linear behavior.
    const hostilePattern = `/${'aa*'.repeat(10)}zz`;
    const hostilePath = `/${'a'.repeat(8000)}b`;
    expect(matchesExcludedPath([hostilePattern], hostilePath)).toBe(false);
    const matching = `/${'a'.repeat(4000)}${'aa'.repeat(10)}zz`;
    expect(matchesExcludedPath([hostilePattern], matching)).toBe(true);
  });
});
