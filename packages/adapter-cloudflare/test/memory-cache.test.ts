import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '@enhancely/injector-core';
import { CurrentConfigMemoryCache } from '../src/memory-cache.js';

const entry: CacheEntry = {
  jsonldRaw: '{"project":"a"}',
  etag: '"a"',
  storedAt: 1,
};

describe('CurrentConfigMemoryCache', () => {
  it('reuses one bounded cache for a stable Worker configuration', () => {
    const selector = new CurrentConfigMemoryCache();
    expect(selector.for('https://api.example', 'sk-a')).toBe(
      selector.for('https://api.example', 'sk-a')
    );
  });

  it('discards the fallback cache when the API base or key changes', async () => {
    const selector = new CurrentConfigMemoryCache();
    const first = selector.for('https://api.example', 'sk-a');
    await first.set('https://page.example', entry);

    const second = selector.for('https://api.example', 'sk-b');
    expect(second).not.toBe(first);
    await expect(second.get('https://page.example')).resolves.toBeUndefined();

    const third = selector.for('https://other-api.example', 'sk-b');
    expect(third).not.toBe(second);
    await expect(third.get('https://page.example')).resolves.toBeUndefined();

    // Switching back creates a fresh cache; the selector never retains a
    // 16 MiB cache per historical config identity.
    const firstAgain = selector.for('https://api.example', 'sk-a');
    expect(firstAgain).not.toBe(first);
    await expect(firstAgain.get('https://page.example')).resolves.toBeUndefined();
  });
});
