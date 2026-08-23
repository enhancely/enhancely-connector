/** Characters that can turn a hostname into another URL component. */
function hasForbiddenHostCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || '\\/?#@%'.includes(character)) return true;
  }
  return false;
}

/** Validate the ASCII hostname emitted by WHATWG parsing against DNS labels. */
function isDnsHostname(hostname: string): boolean {
  if (hostname === '' || hostname.length > 254) return false;
  const bare = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (bare === '' || bare.length > 253) return false;

  for (const label of bare.split('.')) {
    if (label.length === 0 || label.length > 63) return false;
    for (let index = 0; index < label.length; index += 1) {
      const code = label.charCodeAt(index);
      const alphaNumeric =
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x41 && code <= 0x5a);
      if (!alphaNumeric && code !== 0x2d) return false;
    }
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }
  return true;
}

/** Parse one pre-screened HTTPS authority and return its canonical DNS host. */
function parsedDnsHostname(authority: string): string | null {
  try {
    const parsed = new URL(`https://${authority}/`);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.hostname === ''
    ) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    return isDnsHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize one configured public hostname.
 *
 * `includeHosts` is deliberately hostname-only: schemes, credentials, paths,
 * query strings, fragments, wildcards and ports are configuration mistakes.
 * WHATWG parsing gives us the same ASCII case-folding and IDNA conversion as
 * the page URL boundary without maintaining a second hostname parser.
 */
function canonicalConfiguredHost(value: string): string | null {
  if (value === '' || value !== value.trim() || hasForbiddenHostCharacter(value)) return null;

  // A configured DNS hostname has no colon; one therefore denotes either a
  // forbidden port or unsupported IPv6-literal syntax.
  if (value.includes(':')) return null;

  return parsedDnsHostname(value);
}

/**
 * Canonicalize the public Host authority carried by a request.
 *
 * Lambda@Edge serves viewer HTTPS, so an explicit `:443` is harmless; every
 * other port is a different authority and is rejected. Credentials and URL
 * delimiters are never valid in an HTTP Host value. A final DNS dot is kept:
 * the connector's URL normalization keeps it too, so `example.com` and
 * `example.com.` remain distinct Enhancely record identities.
 */
function canonicalRequestHost(value: string): string | null {
  if (value === '' || value !== value.trim() || hasForbiddenHostCharacter(value)) return null;

  let hostnamePart = value;
  let portPart: string | null = null;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return null;
    hostnamePart = value.slice(0, close + 1);
    const suffix = value.slice(close + 1);
    if (suffix !== '') {
      if (!suffix.startsWith(':')) return null;
      portPart = suffix.slice(1);
    }
  } else {
    const colon = value.lastIndexOf(':');
    if (colon >= 0) {
      // Unbracketed IPv6 is ambiguous as an authority and therefore rejected.
      if (value.indexOf(':') !== colon) return null;
      hostnamePart = value.slice(0, colon);
      portPart = value.slice(colon + 1);
    }
  }

  if (hostnamePart === '') return null;
  if (portPart !== null && !/^0*443$/.test(portPart)) return null;

  return parsedDnsHostname(value);
}

/**
 * Whether connector work is enabled for a public request Host authority.
 *
 * An absent/empty list preserves the historical unrestricted behavior. Once
 * a list is non-empty, every configured item must be valid; one malformed
 * item makes the whole policy match nothing instead of silently widening it.
 * Matching is exact after WHATWG case/IDNA canonicalization. No suffix or
 * wildcard matching is performed.
 */
export function isHostIncluded(host: string, includeHosts: readonly string[]): boolean {
  if (includeHosts.length === 0) return true;

  const candidate = canonicalRequestHost(host);
  if (candidate === null) return false;

  let matched = false;
  for (const configured of includeHosts) {
    const canonical = canonicalConfiguredHost(configured);
    if (canonical === null) return false;
    if (canonical === candidate) matched = true;
  }
  return matched;
}
