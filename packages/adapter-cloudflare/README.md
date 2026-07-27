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

All connector logic (URL normalization for cache keys, API client, caching,
ETag revalidation, timeouts, fail-open orchestration) lives in
[`@enhancely/injector-core`](../injector-core). This adapter only translates
Workers primitives: `fetch` pass-through, env/bindings → config, KV →
`CacheBackend`, and `HTMLRewriter` for streaming injection.

## Fail-open guarantees

The origin response is returned **untouched** whenever any of these holds:

- request method is not `GET`, or the origin response is not 2xx
- origin `Content-Type` is not `text/html`
- `ENHANCELY_API_KEY` is not configured
- the Enhancely API times out (default 800 ms `AbortSignal.timeout`), errors,
  answers 404 (no record) or 429 (rate limit)
- the document has no `<head>` (HTMLRewriter simply never fires)
- anything else throws — the whole post-fetch path is wrapped in try/catch

The customer's site can never break because of the connector; the worst case
is a page without JSON-LD.

## Why a KV cache?

The Enhancely read API deliberately responds `Cache-Control: no-store` — the
connector is expected to bring its **own** cache. This adapter stores one JSON
entry per normalized URL in Workers KV (shared across all edge locations) and
revalidates expired entries cheaply via `ETag` / `If-None-Match` → 304.
Entries are kept in KV for `max(60s, 2 × cacheTtlMs)` so a stale entry can
still be served while Enhancely is slow, rate-limited, or down. Without the KV
binding the worker falls back to a per-isolate in-memory cache (fine for dev,
modest hit rates in production).

## Env vars & bindings

| Name                     | Kind           | Default                    | Notes                                                                                   |
| ------------------------ | -------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `ENHANCELY_API_KEY`      | **secret**     | — (required)               | `sk-…` / `sk-org-…`. `wrangler secret put` — never in wrangler.toml, never client-side. |
| `ENHANCELY_BASE`         | var (optional) | `https://app.enhancely.ai` | **TODO: confirm** final production API base URL.                                        |
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
`kvExpirationTtlSeconds` (`src/kv-cache.ts`) and `shouldAttemptInjection`
(`src/gate.ts`).
