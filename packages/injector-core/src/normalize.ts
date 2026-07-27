/**
 * Local mirror of the server-side URL normalization — used ONLY for cache
 * keys, NEVER for the URL we send to Enhancely (the API always receives the
 * raw page URL; the server normalizes and hashes authoritatively). Drift here
 * can therefore never produce wrong content, only a cache miss.
 *
 * The four rules (keep in sync with the server, in this order):
 *   1. force https:
 *   2. strip query string
 *   3. strip fragment
 *   4. strip a single trailing slash
 *
 * Note on `new URL()` side effects (external review 2026-07-27, refuted):
 * URL parsing additionally lowercases the hostname, drops default ports and
 * collapses dot-segments (`/a/../b` → `/b`). That is fine here BECAUSE the
 * server's normalizeUrl uses the exact same `new URL()` parsing before
 * hashing — two raw URLs that collapse to one cache key necessarily collapse
 * to one server-side hash as well, so a shared key can never serve the wrong
 * record's JSON-LD.
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
