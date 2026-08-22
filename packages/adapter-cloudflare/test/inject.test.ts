import { describe, expect, it, vi } from 'vitest';
import {
  injectSnippetBuffered,
  MAX_HTML_BYTES,
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

  it('does not resolve the snippet provider until a real head slot was buffered', async () => {
    const provider = vi.fn(async () => SNIPPET);
    const headless = '<html><body>no head here</body></html>';

    const result = await injectSnippetBuffered(
      htmlResponse(headless),
      provider,
      () => new FakeRewriter()
    );

    expect(provider).not.toHaveBeenCalled();
    await expect(result.text()).resolves.toBe(headless);
  });

  it.each([
    '<svg><head></head></svg>',
    '<math><head></head></math>',
    '<html><body><head></head></body></html>',
    '<html><body><template><head></head></template></body></html>',
  ])('does not treat a foreign/inert lexical head as injectable: %s', async (document) => {
    const provider = vi.fn(async () => SNIPPET);
    const createRewriter = vi.fn(() => new FakeRewriter());

    const result = await injectSnippetBuffered(htmlResponse(document), provider, createRewriter);

    expect(provider).not.toHaveBeenCalled();
    expect(createRewriter).not.toHaveBeenCalled();
    await expect(result.text()).resolves.toBe(document);
  });

  it('does not resolve the snippet provider when rewriting fails mid-stream', async () => {
    const provider = vi.fn(async () => SNIPPET);
    const result = await injectSnippetBuffered(
      htmlResponse(HTML),
      provider,
      () => new MidStreamErrorRewriter()
    );

    expect(provider).not.toHaveBeenCalled();
    await expect(result.text()).resolves.toBe(HTML);
  });

  it('resolves the snippet provider once after successful head preflight', async () => {
    const provider = vi.fn(async () => SNIPPET);
    const result = await injectSnippetBuffered(
      htmlResponse(HTML),
      provider,
      () => new FakeRewriter()
    );

    expect(provider).toHaveBeenCalledTimes(1);
    await expect(result.text()).resolves.toContain(SNIPPET);
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

  it('does not call the provider for a declared legacy charset', async () => {
    const provider = vi.fn(async () => SNIPPET);
    const response = new Response(new Uint8Array([0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e]), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=windows-1252' },
    });

    const result = await injectSnippetBuffered(response, provider, () => new FakeRewriter());

    expect(provider).not.toHaveBeenCalled();
    expect(result.headers.get('content-type')).toBe('text/html; charset=windows-1252');
  });

  it('does not call the provider when a chunked body exceeds the hard byte cap', async () => {
    const provider = vi.fn(async () => SNIPPET);
    const chunk = new Uint8Array(MAX_HTML_BYTES + 1).fill(0x61);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );

    const result = await injectSnippetBuffered(response, provider, () => new FakeRewriter());

    expect(provider).not.toHaveBeenCalled();
    expect((await result.arrayBuffer()).byteLength).toBe(MAX_HTML_BYTES + 1);
  });

  it('removes validators/ranges and declares UTF-8 after injection', async () => {
    const result = await injectSnippetBuffered(
      htmlResponse(HTML, {
        etag: '"origin"',
        'last-modified': 'Sat, 22 Aug 2026 00:00:00 GMT',
        'accept-ranges': 'bytes',
      }),
      SNIPPET,
      () => new FakeRewriter()
    );

    expect(result.headers.get('etag')).toBeNull();
    expect(result.headers.get('last-modified')).toBeNull();
    expect(result.headers.get('accept-ranges')).toBeNull();
    expect(result.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});
