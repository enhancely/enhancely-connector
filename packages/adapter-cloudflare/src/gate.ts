/**
 * Response-gating logic, extracted into a pure function so it is unit-testable
 * without a Workers runtime.
 *
 * We only ever touch a response when ALL of these hold (rule 5, CLAUDE.md):
 *   - the page request was a GET (never mutate POST/HEAD/… responses),
 *   - the origin answered exactly 200,
 *   - the origin Content-Type is text/html (charset suffix allowed),
 *   - X-Robots-Tag does not contain noindex/none,
 *   - an Enhancely API key is configured.
 * Anything else → serve the origin response untouched (fail-open).
 */
import { blocksIndexing, isAttachmentDisposition } from '@enhancely/injector-core';

export interface GateInput {
  /** HTTP method of the incoming page request. */
  method: string;
  /** HTTP status of the origin response. */
  status: number;
  /** Origin `Content-Type` header, may include a charset suffix, may be null. */
  contentType: string | null;
  /** Encoded bodies cannot be safely rewritten without decompression. */
  contentEncoding: string | null;
  /** Origin Cache-Control, used for the no-transform directive. */
  cacheControl: string | null;
  /** Download responses are not page HTML even when mislabeled text/html. */
  contentDisposition: string | null;
  /** Combined origin X-Robots-Tag header. */
  xRobotsTag: string | null;
  /** Configured Enhancely API key (undefined/empty → do not inject). */
  apiKey: string | undefined;
}

export function shouldAttemptInjection(input: GateInput): boolean {
  if (input.method !== 'GET') return false;
  if (input.status !== 200) return false;
  // Compare the media type exactly (parameters like charset stripped) — a
  // prefix check would wrongly match e.g. "text/htmlx".
  const mediaType = (input.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;
  if (input.contentEncoding !== null) return false;
  if (/(?:^|[\s,])no-transform(?:$|[\s,=])/i.test(input.cacheControl ?? '')) return false;
  if (isAttachmentDisposition(input.contentDisposition)) return false;
  if (blocksIndexing(input.xRobotsTag)) return false;
  if (input.apiKey === undefined || input.apiKey === '') return false;
  return true;
}
