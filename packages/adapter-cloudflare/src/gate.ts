/**
 * Response-gating logic, extracted into a pure function so it is unit-testable
 * without a Workers runtime.
 *
 * We only ever touch a response when ALL of these hold (rule 5, CLAUDE.md):
 *   - the page request was a GET (never mutate POST/HEAD/… responses),
 *   - the origin answered 2xx (`response.ok`),
 *   - the origin Content-Type is text/html (charset suffix allowed),
 *   - an Enhancely API key is configured.
 * Anything else → serve the origin response untouched (fail-open).
 */
export interface GateInput {
  /** HTTP method of the incoming page request. */
  method: string;
  /** `response.ok` of the origin response (true for 2xx). */
  responseOk: boolean;
  /** Origin `Content-Type` header, may include a charset suffix, may be null. */
  contentType: string | null;
  /** Configured Enhancely API key (undefined/empty → do not inject). */
  apiKey: string | undefined;
}

export function shouldAttemptInjection(input: GateInput): boolean {
  if (input.method !== 'GET') return false;
  if (!input.responseOk) return false;
  // Compare the media type exactly (parameters like charset stripped) — a
  // prefix check would wrongly match e.g. "text/htmlx".
  const mediaType = (input.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') return false;
  if (input.apiKey === undefined || input.apiKey === '') return false;
  return true;
}
