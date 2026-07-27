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

/** Structural subset of HTMLRewriter's `Element` that the head handler uses. */
export interface RewriterElementLike {
  append(content: string, options?: { html?: boolean }): void;
}

/** Structural subset of `HTMLRewriter` used by {@link injectSnippetBuffered}. */
export interface RewriterLike {
  on(selector: string, handlers: { element(element: RewriterElementLike): void }): RewriterLike;
  transform(response: Response): Response;
}

/**
 * Append `snippet` as the last child of `<head>` and return a fully buffered
 * response. On ANY error — synchronous transform failure or a mid-stream
 * parse/handler error surfacing during buffering — the untouched origin
 * response (cloned before the body was consumed) is returned instead.
 *
 * A document without `<head>` makes the rewriter a no-op; the buffered output
 * is then byte-identical to the origin body, which is fine — it is returned
 * as-is.
 */
export async function injectSnippetBuffered(
  response: Response,
  snippet: string,
  createRewriter: () => RewriterLike
): Promise<Response> {
  // Clone BEFORE transforming: transform() consumes the original body, so
  // this clone is the only intact fail-open copy once streaming starts.
  const fallback = response.clone();

  try {
    const transformed = createRewriter()
      .on('head', {
        element(el) {
          el.append(snippet, { html: true });
        },
      })
      .transform(response);

    // Buffer completely; a truncated/errored rewrite stream rejects here,
    // inside the try, instead of on the wire.
    const html = await transformed.text();

    // The body length changed (or is now known): drop the stale
    // content-length and let the runtime recompute it for the new body.
    const headers = new Headers(transformed.headers);
    headers.delete('content-length');

    return new Response(html, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  } catch {
    // Fail-open: serve the origin response exactly as received.
    return fallback;
  }
}
