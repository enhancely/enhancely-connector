import { describe, expect, it } from 'vitest';

import { blocksIndexing } from '../src/index.js';

describe('blocksIndexing', () => {
  it.each(['noindex', 'none', 'index, noindex', 'googlebot: none', 'NOINDEX, FOLLOW'])(
    'blocks the complete directive %s',
    (value) => expect(blocksIndexing(value)).toBe(true)
  );

  it.each([null, undefined, '', 'index, follow', 'x-noindex', 'nonetheless'])(
    'does not substring-match %s',
    (value) => expect(blocksIndexing(value)).toBe(false)
  );
});
