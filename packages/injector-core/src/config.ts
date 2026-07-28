import type { InjectorConfig, InjectorConfigInput } from './types.js';

/** TODO: confirm the final production API base URL with the Enhancely team. */
export const DEFAULT_ENHANCELY_BASE = 'https://app.enhancely.ai';

export const DEFAULT_TIMEOUT_MS = 800;
export const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
/**
 * A JSON-LD payload is only one part of a Lambda@Edge generated response,
 * whose complete body is capped at 1 MiB. Keep the upstream payload well
 * below that ceiling so a hostile/buggy API cannot make the connector buffer
 * an unbounded body. Callers may lower this limit, but not raise it.
 */
export const DEFAULT_MAX_JSONLD_BYTES = 256 * 1024;

/** Loopback hosts that may use plain http (local development only). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Bearer key travels with every request — refuse to send it in cleartext.
 * Only https is allowed, except for loopback development targets.
 */
function assertSafeBase(base: string): void {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new TypeError(`enhancelyBase is not a valid URL: ${base}`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return;
  throw new TypeError(
    `enhancelyBase must use https (got ${parsed.protocol}//) — the API key would travel in cleartext`
  );
}

/**
 * Fill in defaults. The apiKey is required — but a missing/empty key is not an
 * exception at request time: the orchestrator fails open and serves the page
 * unmodified (adapters should still surface a loud config error at startup).
 * Throws on an unsafe (non-https, non-loopback) enhancelyBase.
 */
export function defineConfig(input: InjectorConfigInput): InjectorConfig {
  const base = (input.enhancelyBase ?? DEFAULT_ENHANCELY_BASE).replace(/\/$/, '');
  assertSafeBase(base);
  const maxJsonLdBytes = input.maxJsonLdBytes ?? DEFAULT_MAX_JSONLD_BYTES;
  if (
    !Number.isSafeInteger(maxJsonLdBytes) ||
    maxJsonLdBytes <= 0 ||
    maxJsonLdBytes > DEFAULT_MAX_JSONLD_BYTES
  ) {
    throw new RangeError(
      `maxJsonLdBytes must be a positive integer no greater than ${DEFAULT_MAX_JSONLD_BYTES}`
    );
  }
  return {
    enhancelyBase: base,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    maxJsonLdBytes,
    injectPosition: 'before-head-close',
    autoRegister: input.autoRegister ?? false,
    ...(input.fetchImpl !== undefined && { fetchImpl: input.fetchImpl }),
  };
}
