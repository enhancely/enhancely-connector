# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup
pnpm install             # Install workspace dependencies

# Build & test
pnpm -r build            # Build all packages (tsc)
pnpm -r test             # Vitest across all packages
pnpm -r typecheck        # TypeScript check across all packages

# Quality
pnpm lint                # ESLint (flat config, typescript-eslint)
pnpm format              # Prettier format
pnpm format:check        # Prettier check

# Analysis (not runtime)
pnpm asset-paths <url>…  # smallest set of CloudFront cache behaviors that keeps the
                         # injector off asset traffic; reads the adapter's own
                         # NON_HTML_EXTENSION list so it cannot drift from the code

# Adapter development
pnpm --filter @enhancely/adapter-cloudflare dev       # wrangler dev (needs .dev.vars with ENHANCELY_API_KEY)
pnpm --filter @enhancely/adapter-lambda-edge package  # three esbuild bundles + three zips:
                                                      #   dist/lambda-origin-request.zip (origin-request, recommended)
                                                      #   dist/lambda.zip                (origin-response)
                                                      #   dist/lambda-companion.zip      (companion: register + cache cap,
                                                      #                                   pairs with origin-request)
```

Node version: 22.22.0 (see `.nvmrc`). Package manager: pnpm (pinned via `packageManager` in root `package.json`).

## Architecture

- pnpm monorepo. `packages/injector-core` is the **single source of truth** for all connector logic: URL handling, API client, cache + ETag revalidation, HTML injection, fail-open orchestration.
- Adapters (`adapter-cloudflare`, `adapter-lambda-edge`, `adapter-sidecar`) are **thin**: they translate the platform's request/response shapes to core calls and wire up platform storage. No business logic in adapters.
- TypeScript for core and all edge adapters. CloudFront Lambda@Edge supports **only Node.js and Python** runtimes, so Go is impossible there — TS is the one language that covers every current target. The Go sidecar (`adapter-sidecar-go`, reserved) is a deliberate **later second distribution**, not a rewrite of the core.

## Non-negotiable rules

1. **API key never client-side.** `sk-…` / `sk-org-…` keys stay on the edge/server. Nothing that could leak the key may reach the browser.
2. **Send a URL to Enhancely, never a locally computed hash.** Specifically the query-stripped `normalizeLite(url)` (= the cache key): the server strips the query anyway so the resolved record is identical, but query strings (tokens/PII) never leave the edge. The server still hashes authoritatively.
3. **Fail-open everywhere.** Any error, timeout, oversized JSON-LD body, missing `</head>`, non-HTML, or non-2xx origin response → serve the original HTML untouched. Every Enhancely call uses `AbortSignal.timeout` (default 800 ms). JSON-LD bodies are streamed with a 256 KiB hard ceiling.
4. **Own cache + ETag revalidation is mandatory.** The API responds `Cache-Control: no-store`; the connector brings its own cache and revalidates with `If-None-Match` → 304.
5. **Two Lambda@Edge triggers, one core.** `src/origin-request.ts` (recommended) GENERATES the response: one origin hit, no cross-response reconciliation, and it DOES inject pages carrying `Set-Cookie` or `Cache-Control: private|no-store` — the re-fetch-fidelity argument behind that veto is a property of the double fetch, and abstaining would not change what CloudFront caches. `src/index.ts` (origin-response) keeps the re-fetch pattern and the veto. Since v0.9.0 `src/origin-request.ts` fetches the ORIGIN FIRST and calls Enhancely only once the response proves the URL is servable, injectable HTML — from the request alone that is unknowable (no `Accept`/`Sec-Fetch` signal works: Googlebot sends a wildcard `Accept` without `text/html`), and asking first spent an API call on every extension-less 404, redirect and JSON endpoint. Consequences: registration is precise (`autoRegister` no longer forced off), the un-injected response is generated here so `assertedDefaultTtlSeconds` bounds it directly, and only representations this adapter must not touch cost a second origin hit. `src/companion.ts` (origin-response, **pairs WITH origin-request on the SAME cache behavior**) never injects and never fetches the origin: it registers unknown pages via one register-or-revalidate POST and caps the cache lifetime of uninjected pass-throughs — since v0.9.0 the injector covers both for normal HTML, so the companion is the safety net for what the injector hands back (notably over-quota pages) — safe because a GENERATED origin-request response never fires the origin-response trigger (AWS-documented), so the companion only ever sees uninjected traffic; it also abstains loudly if it ever observes `X-Enhancely-Injected` (mis-pairing tripwire). Everything shared lives in `src/shared.ts` and `src/cache-cap.ts`; no entrypoint may duplicate another's gates. Never associate the two INJECTORS with the same cache behavior — the companion is the only designed origin-response partner for origin-request.
6. **Inject only into `text/html` responses with 2xx status.** Everything else passes through untouched. Operator `excludePaths` (TF: `exclude_paths`; CloudFront-style `*` and `?` wildcards, leading `/` optional) are checked before config/API work. Matching decodes RFC 3986 unreserved octets once, treats literal backslashes as `/`, then collapses duplicate slashes and dot-segments; reserved, non-ASCII, malformed, and double-encoded octets remain literal. `X-Robots-Tag: noindex` or `none` on either the first response or identity re-fetch vetoes injection; other robots metadata must be stable. A body `<meta name="robots">` is not visible to the origin-response layer, so use `excludePaths` for those sections.
7. **`normalizeLite` (4 rules: force https, strip query, strip fragment, strip single trailing slash) is both the cache key AND the URL sent to Enhancely.** It MUST stay byte-for-byte identical to the server's `normalizeUrl` — since the connector sends the normalized URL, a divergence would now serve the wrong record (a correctness bug), not merely a cache miss. Today they are the exact same code; keep them in lockstep.
8. **New adapters must NOT duplicate core logic.** Anything shareable goes into `injector-core`.
9. **Lambda@Edge replacement metadata must be provably safe.** Generated HTML is explicitly UTF-8. On the **origin-response** trigger only, `Cache-Control`/`Expires` and non-blocking `X-Robots-Tag` metadata must be stable across the first response and identity re-fetch (origin-request has a single response, so there is nothing to reconcile; it instead forwards the origin's own headers minus what CloudFront forbids and minus validators/digests that described the uninjected body). CSP structure must also remain stable except for rotating nonces/body hashes; the accepted re-fetch CSP is used so those values match the body. Both the 32 KB header cap and 1 MB combined response cap fail open, with headers counted as UTF-8 bytes.

## Enhancely API contract

- `GET {ENHANCELY_BASE}/api/v1/jsonld/{segment}` — `segment` is the URL-encoded page URL (the connector sends the query-stripped `normalizeLite(url)`; the server accepts a raw URL too and normalizes+hashes it authoritatively).
- `ENHANCELY_BASE` default: `https://app.enhancely.ai` — **TODO: confirm** with the Enhancely team.
- Auth required: `Authorization: Bearer <sk-… | sk-org-…>`.
- `Accept: application/ld+json` — the server does an **EXACT string match** on this header. Response body is the raw, already script-safe-escaped JSON-LD string (`<` pre-escaped as a unicode escape). It goes **verbatim** into `<script type="application/ld+json" data-source="Enhancely.ai" data-etag="…">…</script>` — never re-serialize or re-escape it. The two data attributes (Kirby-plugin parity) are debugging surface only: `data-etag` is the record's ETag (weak prefix and quotes stripped, HTML-escaped) so the page source alone reveals which record version a cached copy carries; omitted when no ETag is known. No `data-status` — the connector only injects after a successful lookup.
- `Cache-Control: no-store`, but ETag + `If-None-Match` (304) are supported for cheap revalidation.
- `404` = record missing; `429` = org rate limit (`Retry-After` header). Both → fail-open, serve original HTML. For public, non-credentialed requests with an explicit origin cache lifetime, the Lambda@Edge **origin-response** adapter shortens that lifetime to the next core/config retry and strips origin validators (since v0.9.0 the origin-request adapter fetches the origin first and GENERATES the un-injected response too, so `assertedDefaultTtlSeconds` bounds it directly on that trigger; the **companion** applies the same capping to whatever the injector still hands back). Without an explicit `max-age`, `s-maxage`, `Expires`, or `no-cache`, it leaves the response untouched by default because it cannot see (and must not increase) the distribution's DefaultTTL — unless the operator sets `assertedDefaultTtlSeconds` (TF: `asserted_default_ttl_seconds`), an assertion that every associated cache behavior's DefaultTTL is at least that many seconds; lifetime-less responses then get the retry Cache-Control capped at `min(retry, asserted)`, which arithmetically can only shorten effective cacheability (otherwise a single lookup timeout pins an uninjected page for the full DefaultTTL). Keep it 0 when any associated behavior has DefaultTTL 0. The core additionally records a short retry backoff after a `429`/error (`Retry-After` capped at 60 s; 10 s default) so page views don't hammer a rate-limited or down API. `202` = record exists, generation still running → treated as `pending` (negative entry; honors a server `Retry-After` capped at `cacheTtlMs`, else full TTL) — its Problem-JSON body must NEVER be injected. `200` with `X-JsonLd-Status: ignored` or body `{}` = terminal-negative (negative entry for a full TTL, never re-registered). A 429 without `Retry-After` uses `RateLimit-Reset` (delta seconds) as the backoff hint.
- `POST {ENHANCELY_BASE}/api/v1/jsonld { url }` is **register-or-revalidate**, not merely register: with `If-None-Match` it answers `412` (unchanged) and with `Accept: application/ld+json` a known record returns the raw script-safe body + ETag (`200`); unknown URLs are created (`201`, generation enqueued), in-flight ones answer `202`, denylisted/unregistered-hostname `400`, monthly limit `429` + `Retry-After`, plan hard cap `403`. `getJsonLdRegisterLookup` (core) wraps this for the companion — one round-trip instead of GET→404→POST — honoring day-scale `Retry-After` (cap 86400 s) for the durable 403/429 states. Duplicate POSTs are coalesced server-side.

## Doc maintenance

When behavior, commands, or the API contract change, update this file, `README.md`, and `docs/architecture/` in the same change. Docs that contradict the code are bugs.
