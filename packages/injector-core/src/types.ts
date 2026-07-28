/**
 * Shared types for the Enhancely connector core.
 *
 * The core never throws into the adapter: every failure mode collapses into
 * "no snippet" so the page is always served unmodified (fail-open).
 */

/** Minimal fetch signature so adapters can supply their platform fetch. */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface InjectorConfig {
  /** Enhancely API base, e.g. https://app.enhancely.ai — TODO: confirm final base URL. */
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
  /** Only supported position today; kept in config for forward compatibility. */
  injectPosition: 'before-head-close';
  /**
   * When true, a 404 from Enhancely triggers ONE fire-and-forget
   * `POST /api/v1/jsonld {url}` that registers the page and starts
   * generation — the connector becomes self-populating for every really
   * visited page. The negative cache entry still suppresses re-lookups for a
   * full TTL, so each URL registers at most once per TTL. Default false.
   */
  autoRegister: boolean;
  /** Platform fetch override (defaults to globalThis.fetch). */
  fetchImpl?: Fetcher;
}

/** User-facing partial config; defaults are filled in by defineConfig(). */
export type InjectorConfigInput = Partial<InjectorConfig> & Pick<InjectorConfig, 'apiKey'>;

/**
 * One cached lookup result per normalized URL.
 * `jsonldRaw === null` is a negative entry: Enhancely answered 404, do not
 * re-fetch until the entry expires (protects the API from dead-URL polling).
 */
export interface CacheEntry {
  jsonldRaw: string | null;
  etag: string | null;
  storedAt: number;
  /**
   * True when this negative entry came from a 404 while auto-registration was
   * enabled. Adapters can use this signal to cap downstream cache lifetime so
   * a generated record is discovered after the core TTL instead of leaving an
   * uninjected page in a CDN cache for its much longer default TTL.
   */
  registrationPending?: boolean;
  /**
   * Backoff memo (epoch ms), set after a 429 or an upstream error/timeout.
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

/** Result of one conditional GET against the Enhancely read endpoint. */
export type JsonLdFetchResult =
  | { status: 'ok'; jsonldRaw: string; etag: string | null }
  | { status: 'not-modified' }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterSeconds: number | null }
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
