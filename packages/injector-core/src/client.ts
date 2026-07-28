import type { InjectorConfig, JsonLdFetchResult } from './types.js';

type BodyReadResult = { status: 'ok'; text: string } | { status: 'error'; reason: string };

/** Cancel an unused response body without letting cancellation failures escape. */
function cancelResponseBody(response: Response, reason: string): void {
  if (response.body === null || response.body.locked) return;
  try {
    void response.body.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort; the connector still fails open.
  }
}

/** Return a trustworthy non-negative Content-Length, or null when absent/invalid. */
function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

function errorName(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    error.name !== ''
  ) {
    return error.name;
  }
  return fallback;
}

/**
 * Read a successful JSON-LD body with a hard byte cap.
 *
 * `response.text()` would buffer an attacker-controlled body before we could
 * inspect its size. Reading the stream lets us stop and cancel immediately
 * after the configured byte limit. The same timeout signal passed to fetch
 * remains active for the complete body read, including a stalled stream.
 */
async function readJsonLdBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<BodyReadResult> {
  const contentLength = declaredContentLength(response);
  if (contentLength !== null && contentLength > maxBytes) {
    cancelResponseBody(response, 'body-too-large');
    return { status: 'error', reason: 'body-too-large' };
  }

  if (response.body === null) return { status: 'ok', text: '' };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let aborted = signal.aborted;

  const cancelReader = (reason: unknown): void => {
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Cancellation is best-effort; the bounded result is still an error.
    }
  };
  const onAbort = (): void => {
    aborted = true;
    cancelReader(signal.reason);
  };

  if (aborted) {
    cancelReader(signal.reason);
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (aborted) {
        return {
          status: 'error',
          reason: errorName(signal.reason, 'body-read-failed'),
        };
      }
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader('body-too-large');
        return { status: 'error', reason: 'body-too-large' };
      }
      chunks.push(value);
    }

    if (aborted) {
      return {
        status: 'error',
        reason: errorName(signal.reason, 'body-read-failed'),
      };
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: 'ok', text: new TextDecoder().decode(bytes) };
  } catch (error) {
    cancelReader(error);
    return {
      status: 'error',
      reason: signal.aborted ? errorName(signal.reason, 'body-read-failed') : 'body-read-failed',
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A platform may still be settling cancellation; there is nothing else to do.
    }
  }
}

/**
 * One conditional GET against `GET {base}/api/v1/jsonld/{url}`.
 *
 * Contract notes (verified against the Enhancely main repo):
 * - We send a URL, never a locally computed hash — the server normalizes and
 *   hashes authoritatively. The caller passes the query-stripped URL
 *   (`normalizeLite`, = the cache key): the server strips the query anyway, so
 *   the resolved record is identical, but query strings (tokens/PII) never
 *   leave the edge and the looked-up URL matches the cached one.
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
  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(config.timeoutMs);
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers,
      signal,
    });
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.name : 'fetch-failed' };
  }

  if (response.status === 304) {
    cancelResponseBody(response, 'not-modified');
    return { status: 'not-modified' };
  }
  if (response.status === 404) {
    cancelResponseBody(response, 'not-found');
    return { status: 'not-found' };
  }
  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
    cancelResponseBody(response, 'rate-limited');
    return {
      status: 'rate-limited',
      retryAfterSeconds,
    };
  }
  if (!response.ok) {
    cancelResponseBody(response, `http-${response.status}`);
    return { status: 'error', reason: `http-${response.status}` };
  }

  let body: BodyReadResult;
  try {
    body = await readJsonLdBody(response, config.maxJsonLdBytes, signal);
  } catch {
    // A non-standard/locked response stream may throw while acquiring its
    // reader. Direct client callers receive the same fail-open result as the
    // orchestrator instead of an escaping rejection.
    return { status: 'error', reason: 'body-read-failed' };
  }
  if (body.status === 'error') return body;
  if (body.text.trim() === '') return { status: 'error', reason: 'empty-body' };
  return { status: 'ok', jsonldRaw: body.text, etag: response.headers.get('etag') };
}

/**
 * Register a page at Enhancely: `POST /api/v1/jsonld { url }` creates the
 * record and starts generation (201/202). Called at most once per URL per
 * cache TTL (guarded by the caller's negative cache). Fire-and-forget
 * semantics: the boolean result is informational, failures never propagate.
 */
export async function registerJsonLd(config: InjectorConfig, pageUrl: string): Promise<boolean> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${config.enhancelyBase}/api/v1/jsonld`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: pageUrl }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const accepted = response.status === 201 || response.status === 200 || response.status === 202;
    cancelResponseBody(response, accepted ? 'body-unused' : `http-${response.status}`);
    return accepted;
  } catch {
    return false;
  }
}
