import { describe, expect, it } from 'vitest';

import { blocksIndexing } from '../src/index.js';

describe('blocksIndexing', () => {
  it.each([
    'noindex',
    'none',
    'index, noindex',
    'googlebot: none',
    'NOINDEX, FOLLOW',
    'nofollow noindex',
    'index noindex',
    'nofollow none',
    'a:b:c:noindex',
  ])('blocks the complete directive %s', (value) => expect(blocksIndexing(value)).toBe(true));

  it.each([null, undefined, '', 'index, follow', 'x-noindex', 'nonetheless'])(
    'does not substring-match %s',
    (value) => expect(blocksIndexing(value)).toBe(false)
  );

  it.each([
    'max-image-preview:none',
    'max-image-preview: none',
    'googlebot: max-image-preview:none',
    'max-snippet: none',
    'max-video-preview: none',
    'unavailable_after: Wed, 25 Jun 2027 15:00:00 GMT',
  ])('does not confuse the value in %s with the standalone none directive', (value) => {
    expect(blocksIndexing(value)).toBe(false);
  });

  it.each([
    'max-image-preview:none, noindex',
    'googlebot: max-image-preview:none, googlebot: none',
    'unavailable_after: Mon, 25 Jun 2027 15:00:00 GMT, noindex',
    'max-image-preview:none noindex',
    'googlebot: max-image-preview:none noindex',
    'none max-image-preview:none',
    'none; max-image-preview: none',
    'nofollow;none;max-snippet:none',
    'noindex; max-image-preview: none',
  ])('still blocks a real indexing directive alongside a parameterized rule: %s', (value) => {
    expect(blocksIndexing(value)).toBe(true);
  });
});
