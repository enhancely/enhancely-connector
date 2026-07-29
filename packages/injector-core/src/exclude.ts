/**
 * Operator-declared path exclusions.
 *
 * Pages the customer never wants decorated (login/account areas, paths their
 * robots.txt disallows, anything noindex by policy) should not pay ANY
 * connector cost: no lookup, no auto-registration, no cache-TTL rewriting,
 * no added latency. Adapters check the request path against these patterns
 * first and pass matching responses through byte-identical.
 *
 * Pattern grammar (CloudFront path-pattern compatible): `*` matches any run
 * of characters including `/`; `?` matches exactly one character; a missing
 * leading `/` is normalized in (CloudFront treats `images/*.jpg` and
 * `/images/*.jpg` as equivalent); everything else is literal. Matching is
 * case-sensitive and anchored to the WHOLE path (`/account` does not match
 * `/account/settings`; write `/account/*` or `/account*` for subtrees).
 *
 * Before matching, the path is structurally normalized: duplicate slashes
 * collapse and dot-segments resolve (`/public/../account` matches
 * `/account/*`), because CloudFront forwards the RAW viewer path while many
 * origins normalize it — without this, a crafted `..` path would reach an
 * excluded page unmatched. Percent-encoding is NOT decoded: an encoded
 * variant the origin also accepts (`/%61ccount`) is not excluded. The fail
 * direction of both choices is bounded: worst case under-exclusion costs a
 * lookup on an excluded page (never response corruption), worst case
 * over-exclusion skips an injection.
 *
 * Deliberately NOT a regex: patterns are operator config and paths are
 * viewer-controlled, so matching cost must stay bounded. The two-pointer
 * glob below is O(path × pattern) in the worst case — quadratic at the
 * theoretical extreme, but never the exponential backtracking blowup a
 * naive `*`→`.*` regex translation exhibits on multi-wildcard patterns
 * (which can hang an edge function on a crafted URL). Patterns longer than
 * CloudFront's own 255-character path-pattern limit are ignored, which
 * bounds the quadratic term to ~255 × path.
 */

/** Classic iterative glob match: `*` = any run, `?` = exactly one char. */
function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1; // position of the last `*` seen in the pattern
  let mark = 0; // text position that `*` is currently assumed to cover up to

  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (star !== -1) {
      // Mismatch after a `*`: let the star swallow one more character.
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Structural path normalization before matching: collapse empty segments
 * (duplicate slashes), drop `.`, resolve `..` (never above the root). RFC
 * 3986 remove_dot_segments in spirit; directory-ness (trailing `/`, `/.` or
 * `/..`) is preserved as a trailing slash.
 */
function normalizePathForMatch(pathname: string): string {
  const segments: string[] = [];
  for (const segment of pathname.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const endsAsDirectory = /\/\.{0,2}$/.test(pathname);
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}${endsAsDirectory ? '/' : ''}`;
}

/**
 * True when `pathname` matches any exclude pattern. Non-string or empty
 * entries are ignored (config junk must never throw at the edge).
 */
export function matchesExcludedPath(patterns: readonly string[], pathname: string): boolean {
  const normalized = normalizePathForMatch(pathname);
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > 255) continue;
    // CloudFront parity: a pattern without a leading slash or wildcard is
    // matched as if it had the slash (request paths always start with `/`).
    const anchored = pattern.startsWith('/') || pattern.startsWith('*') ? pattern : `/${pattern}`;
    if (globMatch(anchored, normalized)) return true;
  }
  return false;
}
