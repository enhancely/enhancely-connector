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

# Adapter development
pnpm --filter @enhancely/adapter-cloudflare dev       # wrangler dev (needs .dev.vars with ENHANCELY_API_KEY)
pnpm --filter @enhancely/adapter-lambda-edge package  # esbuild bundle + dist/lambda.zip for Lambda@Edge
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
5. **Inject only into `text/html` responses with 2xx status.** Everything else passes through untouched.
6. **`normalizeLite` (4 rules: force https, strip query, strip fragment, strip single trailing slash) is both the cache key AND the URL sent to Enhancely.** It MUST stay byte-for-byte identical to the server's `normalizeUrl` — since the connector sends the normalized URL, a divergence would now serve the wrong record (a correctness bug), not merely a cache miss. Today they are the exact same code; keep them in lockstep.
7. **New adapters must NOT duplicate core logic.** Anything shareable goes into `injector-core`.

## Enhancely API contract

- `GET {ENHANCELY_BASE}/api/v1/jsonld/{segment}` — `segment` is the URL-encoded page URL (the connector sends the query-stripped `normalizeLite(url)`; the server accepts a raw URL too and normalizes+hashes it authoritatively).
- `ENHANCELY_BASE` default: `https://app.enhancely.ai` — **TODO: confirm** with the Enhancely team.
- Auth required: `Authorization: Bearer <sk-… | sk-org-…>`.
- `Accept: application/ld+json` — the server does an **EXACT string match** on this header. Response body is the raw, already script-safe-escaped JSON-LD string (`<` pre-escaped as a unicode escape). It goes **verbatim** into `<script type="application/ld+json">…</script>` — never re-serialize or re-escape it.
- `Cache-Control: no-store`, but ETag + `If-None-Match` (304) are supported for cheap revalidation.
- `404` = record missing; `429` = org rate limit (`Retry-After` header). Both → fail-open, serve original HTML. For public, non-credentialed requests the Lambda@Edge adapter caps an uninjected response's shared-cache TTL at the next core/config retry and strips origin validators, so CloudFront cannot pin a 404, rate limit, timeout, or missing-key cooldown for its longer default TTL. The core additionally records a short retry backoff after a `429`/error (`Retry-After` capped at 60 s; 10 s default) so page views don't hammer a rate-limited or down API.

## Doc maintenance

When behavior, commands, or the API contract change, update this file, `README.md`, and `docs/architecture/` in the same change. Docs that contradict the code are bugs.
