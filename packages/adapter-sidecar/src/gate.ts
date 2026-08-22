/**
 * Upstream-response gating for the sidecar, extracted into pure functions so
 * it is unit-testable without sockets (mirrors adapter-cloudflare/src/gate.ts).
 *
 * We only buffer + inject when ALL of these hold (rule 5, CLAUDE.md):
 *   - an Enhancely API key is configured (no key → pure streaming proxy: the
 *     body must not even be buffered, let alone decoded),
 *   - the page request was a GET,
 *   - the upstream answered exactly 200,
 *   - the upstream Content-Type media type is exactly text/html,
 *   - X-Robots-Tag does not contain noindex/none,
 *   - the declared charset (if any) is UTF-8-compatible — the buffered path
 *     decodes/re-encodes as UTF-8, and transcoding legacy charsets
 *     (iso-8859-1, windows-1252, …) is not supported: those responses stream
 *     through byte-identical and uninjected (fail-open, never corrupt),
 *   - no Content-Encoding (TODO(gzip): no decode support).
 */

import { blocksIndexing, charsetOf, isAttachmentDisposition } from '@enhancely/injector-core';
export { charsetOf } from '@enhancely/injector-core';

/** Hard buffering cap; larger HTML stays on the streaming pass-through path. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

/** Charsets whose bytes survive a Buffer utf8 decode/re-encode round-trip. */
const UTF8_COMPATIBLE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

export interface UpstreamGateInput {
  /** HTTP method of the incoming page request. */
  method: string | undefined;
  /** Upstream response status code. */
  status: number | undefined;
  /** Upstream Content-Type header (may include a charset parameter). */
  contentType: string | undefined;
  /** Upstream Content-Encoding header (any value → pass through). */
  contentEncoding: string | undefined;
  /** Combined upstream X-Robots-Tag header. */
  xRobotsTag: string | undefined;
  /** Upstream Cache-Control, used for the no-transform directive. */
  cacheControl: string | undefined;
  /** Download responses are not page HTML even when mislabeled text/html. */
  contentDisposition: string | undefined;
  /** Valid upstream Content-Length, if present, enables a zero-buffer veto. */
  contentLength: string | undefined;
  /** Whether an Enhancely API key is configured. */
  apiKeyPresent: boolean;
}

/** True only when the buffered injection path may handle this response. */
export function isInjectableUpstream(input: UpstreamGateInput): boolean {
  if (!input.apiKeyPresent) return false;
  if (input.method !== 'GET') return false;
  if (input.status !== 200) return false;

  const contentType = input.contentType ?? '';
  // Compare the media type exactly (parameters stripped) — a prefix check
  // would wrongly match e.g. "text/htmlx".
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;
  if (blocksIndexing(input.xRobotsTag)) return false;
  if (/(?:^|[\s,])no-transform(?:$|[\s,=])/i.test(input.cacheControl ?? '')) return false;
  if (isAttachmentDisposition(input.contentDisposition)) return false;

  const contentLength = input.contentLength?.trim();
  if (
    contentLength !== undefined &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_HTML_BYTES
  ) {
    return false;
  }

  const charset = charsetOf(contentType);
  if (charset !== null && !UTF8_COMPATIBLE_CHARSETS.has(charset)) return false;

  // TODO(gzip): compressed bodies pass through unchanged — no decode support.
  return input.contentEncoding === undefined;
}
