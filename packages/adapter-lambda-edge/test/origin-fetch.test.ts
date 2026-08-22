/**
 * fetchOriginHtml TLS SNI.
 *
 * An https custom origin is addressed by its internal DNS name (for example an
 * ALB `…elb.amazonaws.com`), but its certificate is issued for the PUBLIC
 * domain and selected by SNI. The re-fetch must present the public Host as the
 * TLS servername, otherwise cert verification fails and the injector silently
 * falls open. This works for any name-based virtual-hosted origin without
 * per-site logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_RESPONSE_HEADER_BYTES } from '../src/shared.js';

const h = vi.hoisted(() => {
  const captured: { https?: Record<string, unknown>; http?: Record<string, unknown> } = {};
  const scenario: { ready: boolean; error: Error & { code?: string } } = {
    ready: false,
    error: new Error('stub'),
  };
  const makeReq = (protocol: 'http' | 'https') => {
    const requestHandlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const socketHandlers: Record<string, (() => void) | undefined> = {};
    const socket = {
      connecting: true,
      once: (event: string, cb: () => void) => {
        socketHandlers[event] = cb;
        return socket;
      },
    };
    const req: Record<string, unknown> = {
      on: (event: string, cb: (arg: unknown) => void) => {
        requestHandlers[event] = cb;
        return req;
      },
      once: (event: string, cb: (arg: unknown) => void) => {
        requestHandlers[event] = cb;
        return req;
      },
      end: () => {
        // Fire only after fetchOriginHtml has installed all lifecycle handlers.
        setImmediate(() => {
          requestHandlers['socket']?.(socket);
          if (scenario.ready) {
            socket.connecting = false;
            socketHandlers[protocol === 'https' ? 'secureConnect' : 'connect']?.();
          }
          requestHandlers['error']?.(scenario.error);
        });
      },
      destroy: () => {},
    };
    return req;
  };
  return {
    captured,
    scenario,
    httpsRequest: vi.fn((opts: unknown) => {
      captured.https = opts as Record<string, unknown>;
      return makeReq('https');
    }),
    httpRequest: vi.fn((opts: unknown) => {
      captured.http = opts as Record<string, unknown>;
      return makeReq('http');
    }),
  };
});

vi.mock('node:https', () => ({ request: h.httpsRequest }));
vi.mock('node:http', () => ({ request: h.httpRequest }));

const { fetchOriginHtml } = await import('../src/origin-fetch.js');

describe('fetchOriginHtml TLS SNI', () => {
  beforeEach(() => {
    delete h.captured.https;
    delete h.captured.http;
    h.scenario.ready = false;
    h.scenario.error = new Error('stub');
  });

  it('sets servername to the public Host for an https origin, not the origin DNS name', async () => {
    await fetchOriginHtml(
      'https://origin-a.internal.example/de/de/',
      'www.example.com',
      1000,
      1000,
      MAX_RESPONSE_HEADER_BYTES
    ).catch(() => undefined);

    const o = h.captured.https ?? {};
    expect(o['hostname']).toBe('origin-a.internal.example');
    expect(o['servername']).toBe('www.example.com');
    expect((o['headers'] as Record<string, string>)['host']).toBe('www.example.com');
  });

  it('is generic: a different public host flows straight through as servername', async () => {
    await fetchOriginHtml(
      'https://origin-b.internal.example/',
      'shop.example.net',
      1000,
      1000,
      MAX_RESPONSE_HEADER_BYTES
    ).catch(() => undefined);
    expect((h.captured.https ?? {})['servername']).toBe('shop.example.net');
  });

  it('still sets servername on a plain-http origin, which node ignores there', async () => {
    await fetchOriginHtml(
      'http://origin.internal/',
      'demo.example.com',
      1000,
      1000,
      MAX_RESPONSE_HEADER_BYTES
    ).catch(() => undefined);
    expect((h.captured.http ?? {})['servername']).toBe('demo.example.com');
  });

  it('raises Node response-header parsing to the connector/CloudFront 32 KiB limit', async () => {
    await fetchOriginHtml(
      'https://origin.internal/',
      'www.example.com',
      1000,
      1000,
      MAX_RESPONSE_HEADER_BYTES
    ).catch(() => undefined);
    expect((h.captured.https ?? {})['maxHeaderSize']).toBe(32_768);
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ABORT_ERR'])(
    'classifies pre-connect %s as endpoint-wide',
    async (code) => {
      h.scenario.error = Object.assign(new Error(code), { code });

      await expect(
        fetchOriginHtml(
          'http://origin.internal/page',
          'www.example.com',
          1000,
          1000,
          MAX_RESPONSE_HEADER_BYTES
        )
      ).rejects.toMatchObject({ name: 'OriginFetchError', scope: 'endpoint' });
    }
  );

  it('classifies a TLS failure before secureConnect as endpoint-wide', async () => {
    h.scenario.error = Object.assign(new Error('certificate mismatch'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });

    await expect(
      fetchOriginHtml(
        'https://origin.internal/page',
        'www.example.com',
        1000,
        1000,
        MAX_RESPONSE_HEADER_BYTES
      )
    ).rejects.toMatchObject({ name: 'OriginFetchError', scope: 'endpoint' });
  });

  it.each(['ECONNRESET', 'ABORT_ERR'])(
    'keeps post-connect %s scoped to the exact request',
    async (code) => {
      h.scenario.ready = true;
      h.scenario.error = Object.assign(new Error(code), { code });

      await expect(
        fetchOriginHtml(
          'http://origin.internal/problem-path',
          'www.example.com',
          1000,
          1000,
          MAX_RESPONSE_HEADER_BYTES
        )
      ).rejects.toMatchObject({ name: 'OriginFetchError', scope: 'request' });
    }
  );

  it('keeps unknown pre-connect errors request-scoped', async () => {
    h.scenario.error = Object.assign(new Error('invalid forwarded header'), {
      code: 'ERR_INVALID_CHAR',
    });

    await expect(
      fetchOriginHtml(
        'http://origin.internal/problem-path',
        'www.example.com',
        1000,
        1000,
        MAX_RESPONSE_HEADER_BYTES
      )
    ).rejects.toMatchObject({ name: 'OriginFetchError', scope: 'request' });
  });
});
