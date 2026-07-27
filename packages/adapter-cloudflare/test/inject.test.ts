import { describe, expect, it } from 'vitest';
import {
  injectSnippetBuffered,
  type RewriterElementLike,
  type RewriterLike,
} from '../src/inject.js';

const SNIPPET = '<script type="application/ld+json">{"@context":"https://schema.org"}</script>';
const HTML = '<html><head><title>t</title></head><body>hello</body></html>';

/**
 * Streaming fake mimicking HTMLRewriter: transform() returns immediately with
 * a streamed body; the head handler fires (and the snippet is appended before
 * </head>) only while the body streams out — exactly like the real thing.
 */
class FakeRewriter implements RewriterLike {
  private handlers: { element(element: RewriterElementLike): void } | undefined;

  on(_selector: string, handlers: { element(element: RewriterElementLike): void }): RewriterLike {
    this.handlers = handlers;
    return this;
  }

  transform(response: Response): Response {
    const handlers = this.handlers;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const html = await response.text();
        let appended = '';
        if (handlers !== undefined && html.includes('</head>')) {
          handlers.element({
            append(content) {
              appended += content;
            },
          });
        }
        controller.enqueue(new TextEncoder().encode(html.replace('</head>', `${appended}</head>`)));
        controller.close();
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

/**
 * Fake reproducing the finding: transform() succeeds synchronously, then the
 * streamed body errors mid-flight (Cloudflare's documented truncation case).
 * transformed.text() rejects during buffering.
 */
class MidStreamErrorRewriter implements RewriterLike {
  on(): RewriterLike {
    return this;
  }

  transform(response: Response): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><head>truncat'));
        controller.error(new Error('parse error mid-stream'));
      },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  }
}

class ThrowingTransformRewriter implements RewriterLike {
  on(): RewriterLike {
    return this;
  }

  transform(): Response {
    throw new Error('transform blew up synchronously');
  }
}

function htmlResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
  });
}

describe('injectSnippetBuffered', () => {
  it('injects the snippet before </head> on the success path', async () => {
    const result = await injectSnippetBuffered(
      htmlResponse(HTML),
      SNIPPET,
      () => new FakeRewriter()
    );

    await expect(result.text()).resolves.toBe(
      `<html><head><title>t</title>${SNIPPET}</head><body>hello</body></html>`
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('serves the original body intact when transform().text() rejects mid-stream (fail-open)', async () => {
    const result = await injectSnippetBuffered(
      htmlResponse(HTML),
      SNIPPET,
      () => new MidStreamErrorRewriter()
    );

    await expect(result.text()).resolves.toBe(HTML);
    expect(result.status).toBe(200);
  });

  it('serves the original body intact when transform() throws synchronously (fail-open)', async () => {
    const result = await injectSnippetBuffered(
      htmlResponse(HTML),
      SNIPPET,
      () => new ThrowingTransformRewriter()
    );

    await expect(result.text()).resolves.toBe(HTML);
  });

  it('returns the buffered body as-is when the rewriter is a no-op (no <head>)', async () => {
    const headless = '<html><body>no head here</body></html>';
    const result = await injectSnippetBuffered(
      htmlResponse(headless),
      SNIPPET,
      () => new FakeRewriter()
    );

    await expect(result.text()).resolves.toBe(headless);
  });

  it('drops the stale content-length header on the rewritten response', async () => {
    const result = await injectSnippetBuffered(
      htmlResponse(HTML, { 'content-length': String(HTML.length), 'x-custom': 'kept' }),
      SNIPPET,
      () => new FakeRewriter()
    );

    // The pre-transform content-length no longer matches the injected body;
    // it must not be forwarded verbatim (the runtime recomputes it on send).
    expect(result.headers.get('content-length')).not.toBe(String(HTML.length));
    expect(result.headers.get('x-custom')).toBe('kept');
    await expect(result.text()).resolves.toContain(SNIPPET);
  });
});
