/**
 * Shared types for the Enhancely connector core.
 *
 * The core never throws into the adapter: every failure mode collapses into
 * "no snippet" so the page is always served unmodified (fail-open).
 */

/** Minimal fetch signature so adapters can supply their platform fetch. */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface InjectorConfig {
  /** Enhancely API base; production defaults to https://app.enhancely.ai. */
  enhancelyBase: string;
  /** Project (`sk-…`) or organization (`sk-org-…`) API key. NEVER expose client-side. */
  apiKey: string;
  /** Hard timeout for every Enhancely call (AbortSignal.timeout). */
  timeoutMs: number;
  /** How long a cache entry (positive or negative) is considered fresh. */
  cacheTtlMs: number;
  /**
   * Maximum UTF-8 byte length accepted from a successful JSON-LD response.
   * The body is streamed and cancelled as soon as this limit is exceeded.
   */
  maxJsonLdBytes: number;
  /**
   * When true, snippet lookup uses ONE register-or-revalidate
   * `POST /api/v1/jsonld {url}`: known pages return their snippet in that same
   * call, while unknown pages are registered and start generation. The
   * negative cache still suppresses repeats until the next retry deadline.
   * Default false.
   */
  autoRegister: boolean;
  /** Platform fetch override (defaults to globalThis.fetch). */
  fetchImpl?: Fetcher;
}

/** User-facing partial config; defaults are filled in by defineConfig(). */
export type InjectorConfigInput = Partial<InjectorConfig> & Pick<InjectorConfig, 'apiKey'>;

/**
 * One cached lookup result per normalized URL.
 * `jsonldRaw === null` is a negative entry: Enhancely answered without a
 * usable snippet (404, 202 pending, terminal-negative, or a rejected/limited
 * registration) — do not call again until the entry expires or its
 * `retryNotBefore` passes (protects the API from dead-URL polling). A pending
 * entry with a server `Retry-After` hint uses `storedAt: 0` (permanently
 * stale) plus `retryNotBefore`, so only the hint gates the next call.
 */
export interface CacheEntry {
  jsonldRaw: string | null;
  etag: string | null;
  storedAt: number;
  /**
   * Backoff memo (epoch ms), set after a 429, registration-limit 403, or an
   * upstream error/timeout.
   * While `Date.now() < retryNotBefore` the orchestrator answers from this
   * entry (stale positive → snippet, negative → nothing) WITHOUT calling
   * Enhancely, so a rate-limited or down API is not re-hit — and the page
   * does not pay the fetch timeout — on every single view. Cleared by the
   * next successful 200/304/404. Absent on healthy entries.
   */
  retryNotBefore?: number;
}

/** Rich lookup result for adapters that also manage a downstream page cache. */
export interface JsonLdLookupResult {
  /** Ready-to-inject script tag, or null when the page stays untouched. */
  snippet: string | null;
  /**
   * Milliseconds until a currently missing/transiently unavailable record
   * should be looked up again. Downstream caches should not retain the
   * uninjected representation beyond this delay. Null for positive entries.
   */
  revalidateInMs: number | null;
}

/** Pluggable cache. Implementations: MemoryCache (core), KV (Cloudflare adapter), … */
export interface CacheBackend {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/**
 * Result of one call against the Enhancely API — the conditional GET
 * (`fetchJsonLd`) and the register-or-revalidate POST (`registerOrRevalidate`)
 * share this shape so one orchestrator switch handles both.
 *
 * - `pending`: the record exists but generation has not produced content yet
 *   (HTTP 202; a 201 from the POST — record just created — maps here too).
 *   `retryAfterSeconds` carries the server's Retry-After hint when present.
 * - `terminal-negative`: the server answered definitively "there is no
 *   snippet for this URL and asking again will not change that soon" —
 *   an `ignored` record, a record whose generation never succeeded (body
 *   `{}`), or a rejected registration (denylist / unregistered hostname).
 *   Stored as a negative entry for a full TTL; the server already knows the
 *   URL, so another registration attempt would only add load.
 * - `registration-limited`: the register endpoint refused this URL because a
 *   plan/registration cap was reached (HTTP 403 with `Retry-After`). The
 *   deadline is URL-local: it must never open the API-key-wide read circuit.
 */
export type JsonLdFetchResult =
  | { status: 'ok'; jsonldRaw: string; etag: string | null }
  | { status: 'not-modified' }
  | { status: 'not-found' }
  | { status: 'pending'; retryAfterSeconds: number | null }
  | { status: 'terminal-negative'; reason: 'ignored' | 'empty-record' | 'rejected' }
  | { status: 'rate-limited'; retryAfterSeconds: number | null }
  | { status: 'registration-limited'; retryAfterSeconds: number }
  | { status: 'error'; reason: string };

/** Everything the orchestrator needs to know about the upstream response. */
export interface HtmlContext {
  html: string;
  /** The full request URL of the page being served. */
  url: string;
  /** Upstream Content-Type header (may include charset). */
  contentType: string | null;
  /** Upstream HTTP status. */
  status: number;
}
