import { describe, expect, it } from 'vitest';
import { isHostIncluded } from '../src/host-filter.js';

describe('isHostIncluded', () => {
  it('keeps the historical unrestricted behavior for an absent list', () => {
    expect(isHostIncluded('anything.example', [])).toBe(true);
    expect(isHostIncluded('malformed host', [])).toBe(true);
  });

  it('matches exact hostnames case-insensitively after IDNA canonicalization', () => {
    expect(isHostIncluded('WWW.EXAMPLE.COM', ['www.example.com'])).toBe(true);
    expect(isHostIncluded('xn--mnchen-3ya.example', ['münchen.example'])).toBe(true);
    expect(isHostIncluded('münchen.example', ['xn--mnchen-3ya.example'])).toBe(true);
  });

  it('does not perform wildcard, suffix, or substring matching', () => {
    expect(isHostIncluded('shop.example.com', ['example.com'])).toBe(false);
    expect(isHostIncluded('example.com.evil.test', ['example.com'])).toBe(false);
    expect(isHostIncluded('evil-example.com', ['example.com'])).toBe(false);
    expect(isHostIncluded('shop.example.com', ['*.example.com'])).toBe(false);
  });

  it('keeps a final DNS dot distinct, matching the connector URL identity', () => {
    expect(isHostIncluded('example.com.', ['example.com'])).toBe(false);
    expect(isHostIncluded('example.com.', ['example.com.'])).toBe(true);
  });

  it('enforces the DNS total-length boundary with and without a final dot', () => {
    const maximum = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
    const tooLong = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(62)].join('.');
    expect(maximum).toHaveLength(253);
    expect(isHostIncluded(maximum, [maximum])).toBe(true);
    expect(isHostIncluded(`${maximum}.`, [`${maximum}.`])).toBe(true);
    expect(isHostIncluded(tooLong, [tooLong])).toBe(false);
  });

  it('accepts the viewer HTTPS default port but no other or malformed port', () => {
    expect(isHostIncluded('example.com:443', ['example.com'])).toBe(true);
    expect(isHostIncluded('example.com:0443', ['example.com'])).toBe(true);
    expect(isHostIncluded('example.com:80', ['example.com'])).toBe(false);
    expect(isHostIncluded('example.com:', ['example.com'])).toBe(false);
    expect(isHostIncluded('example.com:65536', ['example.com'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com:443'])).toBe(false);
  });

  it('rejects IPv6-literal syntax outside the DNS-hostname configuration contract', () => {
    expect(isHostIncluded('[::1]', ['[::1]'])).toBe(false);
    expect(isHostIncluded('[::1]:443', ['[::1]'])).toBe(false);
    expect(isHostIncluded('::1', ['[::1]'])).toBe(false);
  });

  it.each([
    'example.com/path',
    'example.com\\@evil.test',
    'example.com@evil.test',
    '%65xample.com',
    ' example.com',
    'example.com ',
    'example.com\n',
    '',
  ])('rejects malformed request authority %j', (host) => {
    expect(isHostIncluded(host, ['example.com'])).toBe(false);
  });

  it('fails closed for the whole non-empty policy when any entry is invalid', () => {
    expect(isHostIncluded('example.com', ['example.com', ''])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', 'https://example.com'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', 'example.com/path'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', 'example.com:443'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', '*.example.com'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', '_service.example.com'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', '-bad.example.com'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', 'example..com'])).toBe(false);
    expect(isHostIncluded('example.com', ['example.com', 'example,com'])).toBe(false);
  });
});
