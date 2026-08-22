/**
 * Local mirror of the server-side URL normalization. For valid absolute page
 * URLs it serves BOTH the local cache key AND the URL the connector sends to
 * Enhancely (query strings, which carry tokens/PII, are stripped here so they
 * never leave the edge; see client.ts). API-facing callers additionally pass
 * through `normalizeForEnhancely`, which rejects unsafe inputs rather than
 * using this function's backwards-compatible raw fallback. It is NOT a hash —
 * the server still hashes authoritatively.
 *
 * The four rules — MUST stay byte-for-byte identical to the server's
 * `normalizeUrl` (amplify/functions/shared/url-hash.ts), in this order:
 *   1. force https:
 *   2. strip query string
 *   3. strip fragment
 *   4. strip a single trailing slash
 *
 * SYNC REQUIREMENT (load-bearing): because the connector now sends this
 * normalized URL rather than the raw one, the server can no longer recover the
 * original — so any divergence between this function and the server's
 * normalizeUrl would become a CORRECTNESS bug (wrong record served), not just a
 * cache miss. Today the two are the exact same code (verified 2026-07-27:
 * identical `new URL()` handling, same trailing-slash strip), so they agree on
 * every input including `new URL()` side effects (host lowercasing, default
 * ports, dot-segment collapse like `/a/../b` → `/b`). Keep them in lockstep.
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
 * The server and generation pipeline may normalize the received URL again.
 * Because the mirrored legacy rule removes exactly one trailing slash, an
 * input ending in two or more literal slashes is not a normalization fixed
 * point: /page// becomes /page/ locally and then /page upstream. Using the
 * first value as our cache key would associate it with the second value's
 * record. Until normalization is made idempotent across the whole platform,
 * reject those rare unstable inputs before cache or network access. `null`
 * always means "serve without Enhancely".
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
