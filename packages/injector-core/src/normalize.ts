/**
 * Local mirror of the server-side URL normalization. It serves BOTH the local
 * cache key AND the URL the connector sends to Enhancely (query strings, which
 * carry tokens/PII, are stripped here so they never leave the edge; see
 * client.ts). It is NOT a hash — the server still hashes authoritatively.
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
    parsed.protocol = 'https:';
    parsed.search = '';
    parsed.hash = '';
    const clean = parsed.toString();
    return clean.endsWith('/') ? clean.slice(0, -1) : clean;
  } catch {
    return url;
  }
}
