# @enhancely/adapter-cloudflare

Cloudflare Worker reference adapter for the Enhancely connector. It sits on a
route in front of the customer's site, passes every request through to the
origin, and — for successful HTML pages — injects the page's Enhancely JSON-LD
as the last child of `<head>`:

```html
<script type="application/ld+json">
  …
</script>
```

All connector logic (URL normalization for the cache key and the query-stripped
lookup URL, API client, caching, ETag revalidation, timeouts, fail-open
orchestration) lives in
[`@enhancely/injector-core`](../injector-core). This adapter only translates
Workers primitives: `fetch` pass-through, env/bindings → config, KV →
`CacheBackend`, and `HTMLRewriter` for the injection itself.

## Fail-open guarantees

The origin response is returned **untouched** whenever any of these holds:

- request method is not `GET`, or the origin response is not exactly 200
- origin `Content-Type` is not `text/html`
- the response is encoded, marked `no-transform`, served as an attachment, or
  carries `X-Robots-Tag: noindex|none`
- the body exceeds 2 MiB or its bytes cannot be proven safe to decode/re-emit
  as UTF-8
- `ENHANCELY_API_KEY` is not configured
- the page URL is unsafe or not a normalization fixed point (notably two or
  more literal trailing slashes), so cache key and upstream record cannot be
  proven identical
- the Enhancely API times out (default 800 ms `AbortSignal.timeout`), errors,
  answers 404 (no record) or 429 (rate limit)
- the document has no real `<head>` insertion slot
- anything else throws — the whole post-fetch path is wrapped in try/catch

The customer's site can never break because of the connector; the worst case
is a page without JSON-LD.

### Buffered injection (why the response is not streamed)

`HTMLRewriter.transform()` returns a _streamed_ response: a parse or handler
error while the body streams out happens after the worker has already started
responding, and the client can receive a **truncated page** — a fail-open
violation. The adapter therefore clones the origin response first, reads the
origin and rewritten streams with a strict 2 MiB byte cap (`src/inject.ts`),
and only then responds; any error during buffering serves the untouched origin
clone instead. Encoding safety and a real `<head>` slot are proven before the
snippet provider touches cache or Enhancely, so malformed, legacy-encoded,
headless, and oversized pages cost no API call.

## Why a KV cache?

The Enhancely read API deliberately responds `Cache-Control: no-store` — the
connector is expected to bring its **own** cache. This adapter stores one JSON
entry per normalized URL in Workers KV (shared across all edge locations) and
revalidates expired entries cheaply via `ETag` / `If-None-Match` → 304.
Entries are kept in KV for at least `max(60s, 2 × cacheTtlMs)` so a stale entry
can still be served while Enhancely is slow, rate-limited, or down. A longer
server retry deadline extends that lifetime, preventing a day-scale 403/429
backoff from being forgotten after ten minutes. Without the KV binding the
worker falls back to a per-isolate in-memory cache bounded by both entry count
and a conservative 16 MiB retained-string estimate (fine for dev, modest hit
rates in production).

Workers KV is eventually consistent and has no compare-and-swap operation.
The core prevents positive/negative write races inside one isolate, but a rare
cross-isolate conflict cannot be made atomic with KV alone; choosing a cache
with CAS/transaction semantics is part of the later distributed-cache phase.

Workers KV limits keys to 512 bytes. Cache keys longer than 400 UTF-8 bytes
(very long URLs) are transparently replaced by a stable
`sha256:<hex-of-SHA-256>` digest (`kvKeyFor` in `src/kv-cache.ts`) so that
long-URL pages keep their cache entries and 429 retry backoff instead of
silently failing every KV read/write.

## Env vars & bindings

| Name                     | Kind           | Default                    | Notes                                                                                   |
| ------------------------ | -------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `ENHANCELY_API_KEY`      | **secret**     | — (required)               | `sk-…` / `sk-org-…`. `wrangler secret put` — never in wrangler.toml, never client-side. |
| `ENHANCELY_BASE`         | var (optional) | `https://app.enhancely.ai` | Confirmed production API base; override only for an explicitly selected environment.    |
| `ENHANCELY_TIMEOUT_MS`   | var (optional) | `800`                      | Per-call `AbortSignal.timeout` for the Enhancely API.                                   |
| `ENHANCELY_CACHE_TTL_MS` | var (optional) | `300000` (5 min)           | Cache freshness window; ETag revalidation afterwards.                                   |
| `JSONLD_CACHE`           | KV (optional)  | — (memory fallback)        | Distributed JSON-LD cache; strongly recommended in production.                          |

## Deploy

```bash
cd packages/adapter-cloudflare

wrangler login
wrangler kv namespace create JSONLD_CACHE     # then paste the id into wrangler.toml
wrangler secret put ENHANCELY_API_KEY         # paste the sk-… key when prompted

# uncomment + fill [[kv_namespaces]] and [[routes]] in wrangler.toml, then:
wrangler deploy
```

A fully filled-in config (route `www.example.com/*` + KV binding) is at
[`examples/cloudflare/wrangler.toml`](../../examples/cloudflare/wrangler.toml).

## Local development

```bash
# packages/adapter-cloudflare/.dev.vars   (gitignored)
ENHANCELY_API_KEY=sk-…
# ENHANCELY_BASE=http://localhost:3000   # point at a local Enhancely API if needed

pnpm --filter @enhancely/adapter-cloudflare dev   # wrangler dev
```

`wrangler dev` without a KV binding uses the in-memory cache fallback — no
extra setup needed.

## Build & test

There is no separate bundling step in this package: **wrangler bundles
`src/index.ts` itself** at `dev`/`deploy` time. `pnpm build` /
`pnpm typecheck` therefore run `tsc --noEmit` (build `@enhancely/injector-core`
first — `pnpm -r build` at the repo root handles the order).

```bash
pnpm --filter @enhancely/adapter-cloudflare test   # vitest: KV backend + response gating
```

The unit-testable pieces are exported: `KVCacheBackend` /
`kvExpirationTtlSeconds` / `kvKeyFor` (`src/kv-cache.ts`),
`shouldAttemptInjection` (`src/gate.ts`), and `injectSnippetBuffered`
(`src/inject.ts` — takes a rewriter-like factory so it is testable without
the workers runtime).
