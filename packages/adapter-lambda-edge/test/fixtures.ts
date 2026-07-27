/**
 * Typed CloudFront origin-response event fixtures for the adapter tests.
 */
import type {
  CloudFrontHeaders,
  CloudFrontResponseEvent,
  CloudFrontResponseResult,
  Context,
} from 'aws-lambda';
import { handler } from '../src/index.js';

/** Build CloudFront's header map (lowercase keys, array-of-values shape). */
export function cfHeaders(headers: Record<string, string>): CloudFrontHeaders {
  const out: CloudFrontHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = [{ key: name, value }];
  }
  return out;
}

export interface EventOptions {
  method?: string;
  uri?: string;
  querystring?: string;
  /** Incoming Host header; null omits it entirely. */
  host?: string | null;
  /** Extra request headers (cookie, authorization, …) on the origin request. */
  requestHeaders?: Record<string, string>;
  status?: string;
  responseHeaders?: Record<string, string>;
  originProtocol?: 'http' | 'https';
  originDomain?: string;
  originPort?: number;
  originPath?: string;
  /** Simulate a non-custom (e.g. S3) origin. */
  noCustomOrigin?: boolean;
  /** Static origin custom headers (e.g. x-enhancely-page-host). */
  originCustomHeaders?: Record<string, string>;
}

export function makeEvent(options: EventOptions = {}): CloudFrontResponseEvent {
  const {
    method = 'GET',
    uri = '/page',
    querystring = '',
    host = 'www.example.com',
    requestHeaders = {},
    status = '200',
    responseHeaders = { 'content-type': 'text/html; charset=utf-8' },
    originProtocol = 'http',
    originDomain = 'origin.example.com',
    originPort = 80,
    originPath = '',
    noCustomOrigin = false,
    originCustomHeaders = {},
  } = options;

  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd111111abcdef8.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'origin-response',
            requestId: 'test-request-id',
          },
          request: {
            clientIp: '203.0.113.1',
            method,
            uri,
            querystring,
            headers: cfHeaders({ ...(host === null ? {} : { host }), ...requestHeaders }),
            ...(noCustomOrigin
              ? {}
              : {
                  origin: {
                    custom: {
                      customHeaders: cfHeaders(originCustomHeaders),
                      domainName: originDomain,
                      keepaliveTimeout: 5,
                      path: originPath,
                      port: originPort,
                      protocol: originProtocol,
                      readTimeout: 30,
                      sslProtocols: ['TLSv1.2'],
                    },
                  },
                }),
          },
          response: {
            status,
            statusDescription: 'OK',
            headers: cfHeaders(responseHeaders),
          },
        },
      },
    ],
  };
}

/** Invoke the handler the way Lambda does (context/callback are unused). */
export async function invoke(event: CloudFrontResponseEvent): Promise<CloudFrontResponseResult> {
  const result = await handler(event, {} as Context, () => undefined);
  return result as CloudFrontResponseResult;
}
