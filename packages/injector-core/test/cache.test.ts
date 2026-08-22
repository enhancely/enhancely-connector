import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/cache.js';

const entry = (jsonldRaw: string | null = null) => ({
  jsonldRaw,
  etag: null,
  storedAt: 1,
});

describe('MemoryCache bounds', () => {
  it('evicts oldest entries at the count cap', async () => {
    const cache = new MemoryCache(2, 10_000);
    await cache.set('a', entry());
    await cache.set('b', entry());
    await cache.set('c', entry());

    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('b')).resolves.toBeDefined();
    await expect(cache.get('c')).resolves.toBeDefined();
  });

  it('evicts by estimated retained bytes even below the count cap', async () => {
    const cache = new MemoryCache(10, 600);
    await cache.set('a', entry('one'));
    await cache.set('b', entry('two'));
    await cache.set('c', entry('three'));

    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('b')).resolves.toBeDefined();
    await expect(cache.get('c')).resolves.toBeDefined();
  });

  it('does not retain a single entry larger than its byte budget', async () => {
    const cache = new MemoryCache(10, 300);
    await cache.set('large', entry('x'.repeat(100)));
    await expect(cache.get('large')).resolves.toBeUndefined();
  });
});
