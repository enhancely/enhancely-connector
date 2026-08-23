import { MemoryCache } from '@enhancely/injector-core';

/**
 * Own exactly one bounded fallback cache for the active Worker configuration.
 *
 * A production isolate receives one stable binding set. If a test harness or
 * rollout changes the API base/key in-place, discard the old cache so records
 * can never cross project identities and the documented 16 MiB process budget
 * remains a total, not a per-key multiplier.
 */
export class CurrentConfigMemoryCache {
  private identity: string | null = null;
  private cache: MemoryCache | null = null;

  for(enhancelyBase: string, apiKey: string): MemoryCache {
    const identity = JSON.stringify([enhancelyBase, apiKey]);
    if (this.cache === null || this.identity !== identity) {
      this.identity = identity;
      this.cache = new MemoryCache();
    }
    return this.cache;
  }
}
