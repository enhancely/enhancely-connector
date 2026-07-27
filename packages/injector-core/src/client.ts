import type { InjectorConfig, JsonLdFetchResult } from './types.js';

/**
 * One conditional GET against `GET {base}/api/v1/jsonld/{url}`.
 *
 * Contract notes (verified against the Enhancely main repo):
 * - We always send the RAW page URL — never a locally computed hash and never
 *   a locally normalized variant (normalizeLite is for cache keys only). The
 *   server normalizes + hashes authoritatively.
 * - `Accept: application/ld+json` must be the EXACT header value (the server
 *   does an exact string match, no q-values) — it selects the raw, already
 *   script-safe-escaped JSON-LD string (`<` is pre-escaped as the unicode
 *   escape `\u003c`; never re-escape or re-serialize the body).
 * - The API responds `Cache-Control: no-store` by design; caching is OUR job,
 *   revalidation happens via ETag / If-None-Match (304).
 */
/**
 * RFC 9110 §10.2.3: Retry-After is either delay-seconds or an HTTP-date.
 * Returns whole seconds from now (≥ 0), or null when absent/unparsable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  if (/^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export async function fetchJsonLd(
  config: InjectorConfig,
  pageUrl: string,
  etag?: string | null
): Promise<JsonLdFetchResult> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const endpoint = `${config.enhancelyBase}/api/v1/jsonld/${encodeURIComponent(pageUrl)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'application/ld+json',
  };
  if (etag) headers['If-None-Match'] = etag;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.name : 'fetch-failed' };
  }

  if (response.status === 304) return { status: 'not-modified' };
  if (response.status === 404) return { status: 'not-found' };
  if (response.status === 429) {
    return {
      status: 'rate-limited',
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    };
  }
  if (!response.ok) return { status: 'error', reason: `http-${response.status}` };

  try {
    const jsonldRaw = await response.text();
    if (jsonldRaw.trim() === '') return { status: 'error', reason: 'empty-body' };
    return { status: 'ok', jsonldRaw, etag: response.headers.get('etag') };
  } catch {
    return { status: 'error', reason: 'body-read-failed' };
  }
}
