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
});
