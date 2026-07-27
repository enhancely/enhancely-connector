/**
 * Upstream-response gating for the sidecar, extracted into pure functions so
 * it is unit-testable without sockets (mirrors adapter-cloudflare/src/gate.ts).
 *
 * We only buffer + inject when ALL of these hold (rule 5, CLAUDE.md):
 *   - an Enhancely API key is configured (no key → pure streaming proxy: the
 *     body must not even be buffered, let alone decoded),
 *   - the page request was a GET,
 *   - the upstream answered 2xx,
 *   - the upstream Content-Type media type is exactly text/html,
 *   - the declared charset (if any) is UTF-8-compatible — the buffered path
 *     decodes/re-encodes as UTF-8, and transcoding legacy charsets
 *     (iso-8859-1, windows-1252, …) is not supported: those responses stream
 *     through byte-identical and uninjected (fail-open, never corrupt),
 *   - no Content-Encoding (TODO(gzip): no decode support).
 */

/** Charsets whose bytes survive a Buffer utf8 decode/re-encode round-trip. */
const UTF8_COMPATIBLE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/** Lower-cased `charset` parameter of a Content-Type header value, or null. */
export function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

export interface UpstreamGateInput {
  /** HTTP method of the incoming page request. */
  method: string | undefined;
  /** Upstream response status code. */
  status: number | undefined;
  /** Upstream Content-Type header (may include a charset parameter). */
  contentType: string | undefined;
  /** Upstream Content-Encoding header (any value → pass through). */
  contentEncoding: string | undefined;
  /** Whether an Enhancely API key is configured. */
  apiKeyPresent: boolean;
}

/** True only when the buffered injection path may handle this response. */
export function isInjectableUpstream(input: UpstreamGateInput): boolean {
  if (!input.apiKeyPresent) return false;
  if (input.method !== 'GET') return false;
  if (input.status === undefined || input.status < 200 || input.status > 299) return false;

  const contentType = input.contentType ?? '';
  // Compare the media type exactly (parameters stripped) — a prefix check
  // would wrongly match e.g. "text/htmlx".
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;

  const charset = charsetOf(contentType);
  if (charset !== null && !UTF8_COMPATIBLE_CHARSETS.has(charset)) return false;

  // TODO(gzip): compressed bodies pass through unchanged — no decode support.
  return input.contentEncoding === undefined;
}
