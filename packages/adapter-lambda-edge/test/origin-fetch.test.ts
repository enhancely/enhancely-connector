/**
 * fetchOriginHtml TLS SNI.
 *
 * An https custom origin is addressed by its internal DNS name (for example an
 * ALB `…elb.amazonaws.com`), but its certificate is issued for the PUBLIC
 * domain and selected by SNI. The re-fetch must present the public Host as the
 * TLS servername, otherwise cert verification fails and the injector silently
 * falls open. This is generic: it works for any name-based virtual-hosted
 * origin (betaseed, kws.com, agromais and so on) with no per-site config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const captured: { https?: Record<string, unknown>; http?: Record<string, unknown> } = {};
  const makeReq = () => {
    const req: Record<string, unknown> = {
      on: (event: string, cb: (arg: unknown) => void) => {
        // Reject on the next tick, after the options have been captured.
        if (event === 'error') setImmediate(() => cb(new Error('stub')));
        return req;
      },
      end: () => {},
      destroy: () => {},
    };
    return req;
  };
  return {
    captured,
    httpsRequest: vi.fn((opts: unknown) => {
      captured.https = opts as Record<string, unknown>;
      return makeReq();
    }),
    httpRequest: vi.fn((opts: unknown) => {
      captured.http = opts as Record<string, unknown>;
      return makeReq();
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
  });

  it('sets servername to the public Host for an https origin, not the origin DNS name', async () => {
    await fetchOriginHtml(
      'https://euaw-qa-websites-123.eu-central-1.elb.amazonaws.com/de/de/',
      'www.betaseed-qa.com',
      1000,
      1000
    ).catch(() => undefined);

    const o = h.captured.https ?? {};
    expect(o['hostname']).toBe('euaw-qa-websites-123.eu-central-1.elb.amazonaws.com');
    expect(o['servername']).toBe('www.betaseed-qa.com');
    expect((o['headers'] as Record<string, string>)['host']).toBe('www.betaseed-qa.com');
  });

  it('is generic: a different public host flows straight through as servername', async () => {
    await fetchOriginHtml(
      'https://euaw-prod-websites-9.eu-central-1.elb.amazonaws.com/',
      'www.kws.com',
      1000,
      1000
    ).catch(() => undefined);
    expect((h.captured.https ?? {})['servername']).toBe('www.kws.com');
  });

  it('still sets servername on a plain-http origin, which node ignores there', async () => {
    await fetchOriginHtml('http://origin.internal/', 'demo.example.com', 1000, 1000).catch(
      () => undefined
    );
    expect((h.captured.http ?? {})['servername']).toBe('demo.example.com');
  });
});
