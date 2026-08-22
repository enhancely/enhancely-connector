import { test } from 'node:test';
import assert from 'node:assert/strict';

import { charsetOf, isInjectableUpstream } from '../src/gate.js';
import type { UpstreamGateInput } from '../src/gate.js';

const BASE: UpstreamGateInput = {
  method: 'GET',
  status: 200,
  contentType: 'text/html; charset=utf-8',
  contentEncoding: undefined,
  xRobotsTag: undefined,
  cacheControl: undefined,
  contentDisposition: undefined,
  contentLength: undefined,
  apiKeyPresent: true,
};

void test('charsetOf extracts the charset parameter, lower-cased', () => {
  assert.equal(charsetOf('text/html; charset=UTF-8'), 'utf-8');
  assert.equal(charsetOf('text/html;charset="ISO-8859-1"'), 'iso-8859-1');
  assert.equal(charsetOf('text/html'), null);
});

void test('accepts exact-200 GET text/html with utf-8 or no charset', () => {
  assert.equal(isInjectableUpstream(BASE), true);
  assert.equal(isInjectableUpstream({ ...BASE, contentType: 'text/html' }), true);
  assert.equal(isInjectableUpstream({ ...BASE, contentType: 'text/html; charset=us-ascii' }), true);
});

void test('rejects non-UTF-8 declared charsets (would be byte-corrupted)', () => {
  assert.equal(
    isInjectableUpstream({ ...BASE, contentType: 'text/html; charset=iso-8859-1' }),
    false
  );
  assert.equal(
    isInjectableUpstream({ ...BASE, contentType: 'text/html; charset=windows-1252' }),
    false
  );
});

void test('rejects when no API key is configured (pure streaming passthrough)', () => {
  assert.equal(isInjectableUpstream({ ...BASE, apiKeyPresent: false }), false);
});

void test('rejects noindex/none robots directives', () => {
  assert.equal(isInjectableUpstream({ ...BASE, xRobotsTag: 'noindex' }), false);
  assert.equal(isInjectableUpstream({ ...BASE, xRobotsTag: 'googlebot: none' }), false);
  assert.equal(isInjectableUpstream({ ...BASE, xRobotsTag: 'index, follow' }), true);
  assert.equal(
    isInjectableUpstream({ ...BASE, xRobotsTag: 'none; max-image-preview: none' }),
    false
  );
});

void test('rejects non-GET, non-200, non-HTML and encoded responses', () => {
  assert.equal(isInjectableUpstream({ ...BASE, method: 'POST' }), false);
  assert.equal(isInjectableUpstream({ ...BASE, method: undefined }), false);
  assert.equal(isInjectableUpstream({ ...BASE, status: 301 }), false);
  for (const status of [199, 201, 204, 206, 299, 404, 500]) {
    assert.equal(isInjectableUpstream({ ...BASE, status }), false);
  }
  assert.equal(isInjectableUpstream({ ...BASE, status: undefined }), false);
  assert.equal(isInjectableUpstream({ ...BASE, contentType: 'application/json' }), false);
  assert.equal(isInjectableUpstream({ ...BASE, contentType: undefined }), false);
  // Exact media type — "text/htmlx" must not match.
  assert.equal(isInjectableUpstream({ ...BASE, contentType: 'text/htmlx' }), false);
  assert.equal(
    isInjectableUpstream({ ...BASE, contentType: 'text/html; charset=utf-8, application/json' }),
    false
  );
  assert.equal(
    isInjectableUpstream({ ...BASE, contentType: 'text/html; profile="unterminated' }),
    false
  );
  assert.equal(isInjectableUpstream({ ...BASE, contentEncoding: 'gzip' }), false);
});

void test('rejects no-transform, attachments, and declared oversized bodies', () => {
  assert.equal(isInjectableUpstream({ ...BASE, cacheControl: 'public, no-transform' }), false);
  assert.equal(isInjectableUpstream({ ...BASE, cacheControl: 'public; no-transform' }), false);
  assert.equal(
    isInjectableUpstream({ ...BASE, contentDisposition: 'attachment; filename="page.html"' }),
    false
  );
  assert.equal(
    isInjectableUpstream({
      ...BASE,
      contentDisposition: 'inline, attachment; filename="page.html"',
    }),
    false
  );
  assert.equal(
    isInjectableUpstream({ ...BASE, contentDisposition: 'inline; filename="unterminated' }),
    false
  );
  assert.equal(
    isInjectableUpstream({ ...BASE, contentLength: String(2 * 1024 * 1024 + 1) }),
    false
  );
});

void test('preserves field-instance boundaries so malformed quotes cannot heal', () => {
  assert.equal(
    isInjectableUpstream({
      ...BASE,
      contentType: ['text/html; profile="unterminated', 'application/json"'],
    }),
    false
  );
  assert.equal(
    isInjectableUpstream({
      ...BASE,
      cacheControl: ['public, ext="unterminated', 'no-transform"'],
    }),
    false
  );
  assert.equal(
    isInjectableUpstream({
      ...BASE,
      contentDisposition: ['inline; filename="unterminated', 'attachment"'],
    }),
    false
  );
});
