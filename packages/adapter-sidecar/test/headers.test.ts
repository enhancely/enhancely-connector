import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forwardableHeaders } from '../src/headers.js';

void test('removes fixed and Connection-nominated hop-by-hop headers', () => {
  const result = forwardableHeaders({
    connection: 'keep-alive, X-Hop, X-Second-Hop',
    'keep-alive': 'timeout=5',
    'x-hop': 'secret',
    'x-second-hop': 'also-secret',
    te: 'trailers',
    'proxy-connection': 'keep-alive',
    'x-end-to-end': 'kept',
  });

  assert.deepEqual(result, { 'x-end-to-end': 'kept' });
});
