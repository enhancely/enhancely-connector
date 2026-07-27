import type { InjectorConfig, InjectorConfigInput } from './types.js';

/** TODO: confirm the final production API base URL with the Enhancely team. */
export const DEFAULT_ENHANCELY_BASE = 'https://app.enhancely.ai';

export const DEFAULT_TIMEOUT_MS = 800;
export const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes

/**
 * Fill in defaults. The apiKey is required — but a missing/empty key is not an
 * exception at request time: the orchestrator fails open and serves the page
 * unmodified (adapters should still surface a loud config error at startup).
 */
export function defineConfig(input: InjectorConfigInput): InjectorConfig {
  return {
    enhancelyBase: (input.enhancelyBase ?? DEFAULT_ENHANCELY_BASE).replace(/\/$/, ''),
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    injectPosition: 'before-head-close',
    ...(input.fetchImpl !== undefined && { fetchImpl: input.fetchImpl }),
  };
}
