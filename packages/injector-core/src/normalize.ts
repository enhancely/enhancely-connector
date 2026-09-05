/**
 * Local mirror of the server-side URL normalization. For valid absolute page
 * URLs it serves BOTH the local cache key AND the URL the connector sends to
 * Enhancely (query strings, which carry tokens/PII, are stripped here so they
 * never leave the edge; see client.ts). API-facing callers additionally pass
 * through `normalizeForEnhancely`, which rejects unsafe inputs rather than
 * using this function's backwards-compatible raw fallback. It is NOT a hash —
 * the server still hashes authoritatively.
 *
 * The five rules — MUST stay byte-for-byte identical to the server's
 * `normalizeUrl` (amplify/functions/shared/url-hash.ts), in this order:
 *   1. force https:
 *   2. strip query string
 *   3. strip fragment
 *   4. collapse runs of `/` inside the path to a single `/`
 *   5. strip a single trailing slash
 *
 * SYNC REQUIREMENT (load-bearing): because the connector now sends this
 * normalized URL rather than the raw one, the server can no longer recover the
 * original — so any divergence between this function and the server's
 * normalizeUrl would become a CORRECTNESS bug (wrong record served), not just a
 * cache miss. Today the two are the exact same code (re-verified 2026-08-24
 * when the server added the path-slash collapse: identical `new URL()`
 * handling, same collapse, same trailing-slash strip), so they agree on every
 * input including `new URL()` side effects (host lowercasing, default ports,
 * dot-segment collapse like `/a/../b` → `/b`). Keep them in lockstep.
 *
 * Rule 4 exists because CMSes emit hrefs like `//section/page.html`, which
 * `new URL()` preserves verbatim in the path. The server stores the URL in a
 * column that rejects `//` inside a path (RFC 1738), so forwarding it produced
 * a permanently failing registration for such a page. Collapsing here also
 * makes `//a` and `/a` share one cache entry.
 */
export function normalizeLite(url: string): string {
  try {
    const parsed = new URL(url);
    return normalizeParsedUrl(parsed);
  } catch {
    return url;
  }
}

/** Apply the server-mirrored normalization to an already parsed URL. */
function normalizeParsedUrl(parsed: URL): string {
  parsed.protocol = 'https:';
  parsed.search = '';
  parsed.hash = '';
  // Operating on `pathname` cannot reach the `//` after the scheme, and query
  // and fragment are already gone, so a `//` inside either can never be
  // rewritten here.
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  const clean = parsed.toString();
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

/**
 * Safe normalization boundary for values that may leave the connector.
 *
 * `normalizeLite` deliberately retains its historical best-effort contract:
 * invalid input is returned unchanged. That is useful to existing callers but
 * is unsafe at the API boundary because an unchanged relative/malformed value
 * may still contain a query token. Every lookup/client call therefore passes
 * through this stricter helper before it is allowed to perform network I/O.
 *
 * Page requests must be absolute HTTP(S) URLs. URL credentials are never part
 * of a normal browser page URL and may contain secrets, so they fail closed as
 * well.
 *
 * The server and generation pipeline may normalize the received URL again, so
 * whatever we send must survive that second pass unchanged. Collapsing path
 * slashes (rule 4) made the mirrored normalization idempotent — `/page//` now
 * reaches `/page` in one pass instead of drifting to `/page/` locally and
 * `/page` upstream — so the fixed-point check below no longer rejects that
 * shape. It is kept as a standing guard: it is the invariant itself, not the
 * list of rules that currently satisfy it, and it fails closed if a future
 * rule change reintroduces drift. `null` always means "serve without
 * Enhancely".
 */
export function normalizeForEnhancely(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname === '') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    const normalized = normalizeParsedUrl(parsed);
    // A URL sent to Enhancely must remain byte-for-byte identical if the
    // authoritative server normalizer runs again. This preserves the
    // non-negotiable cache-key === wire-URL === record-URL invariant.
    return normalizeLite(normalized) === normalized ? normalized : null;
  } catch {
    return null;
  }
}
