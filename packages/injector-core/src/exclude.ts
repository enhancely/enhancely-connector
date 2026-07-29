/**
 * Operator-declared path exclusions.
 *
 * Pages the customer never wants decorated (login/account areas, paths their
 * robots.txt disallows, anything noindex by policy) should not pay ANY
 * connector cost: no lookup, no auto-registration, no cache-TTL rewriting,
 * no added latency. Adapters check the request path against these patterns
 * first and pass matching responses through byte-identical.
 *
 * Pattern model: the CloudFront path-pattern wildcard. `*` matches any run of
 * characters including `/`; every other character is literal. Matching is
 * case-sensitive and anchored to the WHOLE path (`/account` does not match
 * `/account/settings`; write `/account/*` or `/account*` for subtrees).
 */

/** Escape regex metacharacters so pattern text outside `*` stays literal. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `pathname` matches any exclude pattern. Non-string or empty
 * entries are ignored (config junk must never throw at the edge).
 */
export function matchesExcludedPath(patterns: readonly string[], pathname: string): boolean {
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    if (regex.test(pathname)) return true;
  }
  return false;
}
