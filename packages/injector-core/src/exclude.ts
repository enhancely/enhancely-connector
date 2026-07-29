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
 * Before matching, the path is normalized in three steps, because CloudFront
 * forwards the RAW viewer path while both origins and the URL parsers
 * downstream canonicalize it:
 *
 * 1. Percent-decoding of RFC 3986 UNRESERVED octets only (ALPHA / DIGIT /
 *    `-._~`). Per RFC 3986 §2.3 those encodings are equivalent to their
 *    literal characters, so `/%61ccount` is `/account` and `%2e` is `.` —
 *    without this, `/%2e%2e/login` would slip past an exclusion of `/login`
 *    and then be canonicalized to exactly that page by the URL layer.
 *    RESERVED octets (`%2F`, `%3F`, …) stay encoded: decoding those would
 *    CHANGE the path structure, not normalize it.
 * 2. WHATWG-compatible slash normalization: a literal backslash becomes `/`.
 *    The adapter constructs HTTPS URLs downstream, whose parser treats `\` as
 *    a path separator too; matching the raw spelling would otherwise let
 *    `/public\..\login` bypass `/login`.
 * 3. Structural normalization: duplicate slashes collapse and dot-segments
 *    resolve (`/public/../account` matches `/account/*`).
 *
 * Encoded reserved/non-ASCII octets remain a deliberate boundary: an origin
 * that decodes those differently can still under-exclude, causing a lookup or
 * auto-registration for that encoded URL (but never response corruption).
 * Treat patterns as a conservative operational gate, not as the sole privacy
 * boundary; their safe failure direction is skipped injection.
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
 * Decode ONLY percent-encodings of RFC 3986 unreserved characters (§2.3:
 * ALPHA / DIGIT / `-` / `.` / `_` / `~`), which are defined as equivalent to
 * their literals. Everything else (reserved characters, `%25` itself,
 * non-ASCII, malformed sequences) stays byte-for-byte. Because unreserved
 * characters never include `%`, a single pass cannot create new decodable
 * sequences (no double-decoding).
 */
function decodeUnreservedOctets(pathname: string): string {
  return pathname.replace(/%([0-9A-Fa-f]{2})/g, (encoded, hex: string) => {
    const code = parseInt(hex, 16);
    const isUnreserved =
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x2d || // -
      code === 0x2e || // .
      code === 0x5f || // _
      code === 0x7e; // ~
    return isUnreserved ? String.fromCharCode(code) : encoded;
  });
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
  // Decode and normalize separators BEFORE resolving dot-segments:
  // `/%2e%2e/login` and `/public\..\login` must both collapse to `/login`.
  const normalized = normalizePathForMatch(decodeUnreservedOctets(pathname).replaceAll('\\', '/'));
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > 255) continue;
    // CloudFront parity: a pattern without a leading slash or wildcard is
    // matched as if it had the slash (request paths always start with `/`).
    const anchored = pattern.startsWith('/') || pattern.startsWith('*') ? pattern : `/${pattern}`;
    if (globMatch(anchored, normalized)) return true;
  }
  return false;
}
