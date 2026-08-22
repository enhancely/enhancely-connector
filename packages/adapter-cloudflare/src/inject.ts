/**
 * Buffered HTMLRewriter injection with a hard fail-open guarantee.
 *
 * Why buffered: `HTMLRewriter.transform()` returns a *streamed* response. A
 * parse/handler error that occurs while the body streams out happens *after*
 * the surrounding try/catch has already returned, and per Cloudflare's docs
 * the client can then receive a truncated body — a fail-open violation
 * (CLAUDE.md rule 3). Buffering the transformed body before responding trades
 * streaming for the guarantee that any rewrite error still serves the origin
 * bytes untouched. That trade is acceptable for HTML documents (size-bounded);
 * a streaming mode could be offered as opt-in future work for callers who
 * prefer latency over the hard guarantee.
 *
 * The structural `RewriterLike` types exist so unit tests can supply a plain
 * fake without the workers runtime — the real `HTMLRewriter` is assignable.
 */
import { findHeadInjectionPoint, isUtf8SafeHtmlBytes } from '@enhancely/injector-core';

/** Hard per-response memory bound; oversized pages pass through untouched. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

/** Structural subset of HTMLRewriter's `Element` that the head handler uses. */
export interface RewriterElementLike {
  append(content: string, options?: { html?: boolean }): void;
}

/** Structural subset of `HTMLRewriter` used by {@link injectSnippetBuffered}. */
export interface RewriterLike {
  on(selector: string, handlers: { element(element: RewriterElementLike): void }): RewriterLike;
  transform(response: Response): Response;
}

export type SnippetProvider = () => Promise<string | null>;

function asSnippetProvider(snippet: string | SnippetProvider): SnippetProvider {
  return typeof snippet === 'string' ? () => Promise.resolve(snippet) : snippet;
}

async function readBodyBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (reason: unknown): void => {
    try {
      // With Response.clone() this is one branch of a tee. Awaiting cancel can
      // wait for the untouched fallback branch to be consumed, deadlocking
      // the very fail-open return that would consume it.
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Cancellation is best-effort; the bounded reader still fails closed
      // internally and its caller returns the untouched response.
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancel('Enhancely HTML byte cap exceeded');
        throw new Error('HTML byte cap exceeded');
      }
      chunks.push(value);
    }
  } catch (error) {
    cancel(error);
    throw error;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function declaredBodyTooLarge(response: Response, maxBytes: number): boolean {
  const raw = response.headers.get('content-length');
  return raw !== null && /^\d+$/.test(raw.trim()) && Number(raw) > maxBytes;
}

/**
 * Append `snippet` as the last child of `<head>` and return a fully buffered
 * response. A provider is invoked only AFTER HTMLRewriter has successfully
 * parsed and buffered a real head insertion slot. This lets the Worker prove
 * the body is injectable before contacting Enhancely, without parsing or
 * buffering it twice. On ANY error — synchronous transform failure, a
 * mid-stream parse/handler error, or provider failure — the untouched origin
 * response (cloned before the body was consumed) is returned instead.
 *
 * A document without `<head>` makes the rewriter a no-op; the buffered output
 * is then byte-identical to the origin body, which is fine — it is returned
 * as-is.
 */
export async function injectSnippetBuffered(
  response: Response,
  snippet: string | SnippetProvider,
  createRewriter: () => RewriterLike
): Promise<Response> {
  // A trusted length lets us reject without teeing/buffering anything. The
  // bounded stream reader below covers chunked or dishonest responses.
  if (declaredBodyTooLarge(response, MAX_HTML_BYTES)) return response;

  let fallback: Response;
  try {
    // Clone before consuming the origin body. We read at most 2 MiB from the
    // other tee branch, so the unread fallback branch can never force an
    // unbounded queue inside the Worker isolate.
    fallback = response.clone();
  } catch {
    return response;
  }

  try {
    const originalBytes = await readBodyBounded(response, MAX_HTML_BYTES);
    const contentType = response.headers.get('content-type') ?? '';
    if (!isUtf8SafeHtmlBytes(originalBytes, contentType)) return fallback;
    const originalHtml = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(originalBytes);
    // HTMLRewriter's CSS selector also matches a lexical <head> in foreign or
    // inert content (SVG, MathML, body, template). Reuse the core scanner to
    // prove a real document-head close before constructing the rewriter or
    // resolving the Enhancely provider.
    if (findHeadInjectionPoint(originalHtml) === null) return fallback;

    const transformInput = new Response(originalBytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // A per-call random slot cannot collide with customer markup. The rewriter
    // proves it inserted this exact token before any Enhancely lookup starts;
    // after the lookup it is replaced without another HTML parse.
    const slot = `<!--enhancely-slot:${crypto.randomUUID()}-->`;
    let sawHead = false;
    const transformed = createRewriter()
      .on('head', {
        element(el) {
          if (sawHead) return;
          sawHead = true;
          el.append(slot, { html: true });
        },
      })
      .transform(transformInput);

    // Buffer completely; a truncated/errored rewrite stream rejects here,
    // inside the try, instead of on the wire. The second byte cap also guards
    // against a buggy or unexpectedly expansive platform rewriter.
    const transformedBytes = await readBodyBounded(transformed, MAX_HTML_BYTES);
    const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      transformedBytes
    );
    const slotIndex = sawHead ? html.indexOf(slot) : -1;
    if (slotIndex < 0) return fallback;

    const resolvedSnippet = await asSnippetProvider(snippet)();
    if (resolvedSnippet === null) return fallback;
    const injected =
      html.slice(0, slotIndex) + resolvedSnippet + html.slice(slotIndex + slot.length);
    if (new TextEncoder().encode(injected).byteLength > MAX_HTML_BYTES) return fallback;

    // The body length changed (or is now known): drop the stale
    // content-length and let the runtime recompute it for the new body.
    const headers = new Headers(transformed.headers);
    headers.delete('content-length');
    // These validators/digests describe the origin bytes, not the injected
    // representation. Retaining them could make a conditional client reuse a
    // stale injected page or accept a digest that no longer matches.
    for (const name of [
      'etag',
      'last-modified',
      'accept-ranges',
      'content-md5',
      'digest',
      'content-digest',
      'repr-digest',
    ]) {
      headers.delete(name);
    }
    headers.set('content-type', 'text/html; charset=utf-8');

    return new Response(injected, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  } catch {
    // Fail-open: serve the origin response exactly as received.
    return fallback;
  }
}
