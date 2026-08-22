import type * as http from 'node:http';

/** Fixed RFC 9110 hop-by-hop fields plus common non-standard proxy spelling. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Remove both fixed and dynamically named hop-by-hop fields. `Connection` may
 * nominate arbitrary additional header names; forwarding those to the next
 * hop can leak connection-local proxy metadata in either direction.
 */
export function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const blocked = new Set(HOP_BY_HOP);
  for (const value of headerValues(headers['connection'])) {
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') blocked.add(name);
    }
  }

  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) out[name] = value;
  }
  return out;
}
