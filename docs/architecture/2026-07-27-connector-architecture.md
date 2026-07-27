# Enhancely Connector — Architecture

Date: 2026-07-27
Status: BINDING — decisions below are settled unless explicitly revisited.

## 1. Context

Enhancely today is **pull-only**: it generates and stores JSON-LD for customer pages, and customers must integrate it themselves (fetch from the API, template it into their pages). That integration step is the biggest adoption hurdle.

This repository adds the missing **delivery layer**: a connector that sits in the customer's HTTP path (edge worker, CDN function, or reverse-proxy sidecar) and injects the JSON-LD into the HTML response automatically — the same deployment model as prerender.io or redirection.io. The customer installs a connector once; Enhancely structured data appears on every page without further site changes.

## 2. Hard API facts (verified against the main repo)

These are contract facts, not choices. Implement against them; do not re-derive.

- **Read endpoint:** `GET {ENHANCELY_BASE}/api/v1/jsonld/{segment}` where `segment` is the URL-encoded **raw page URL**. We always send the URL, never a locally computed hash — the server normalizes and hashes authoritatively.
- **`ENHANCELY_BASE`:** default `https://app.enhancely.ai` — TODO: confirm.
- **Auth required:** `Authorization: Bearer <sk-… | sk-org-…>`. The key must never reach the browser.
- **`Accept: application/ld+json`** — the server performs an **exact string match** on this header. The response is the raw, already script-safe-escaped JSON-LD string (`<` pre-escaped as a unicode escape). It goes verbatim into `<script type="application/ld+json">…</script>`; the connector must never parse, re-serialize, or re-escape it.
- **Caching:** the API sets `Cache-Control: no-store` but supports `ETag` + `If-None-Match` (304). The connector therefore brings its **own cache** and uses the ETag for cheap revalidation.
- **Errors:** `404` = record missing; `429` = org rate limit with `Retry-After`. Both fail open.
- **Server normalization** (mirrored only as `normalizeLite` for cache keys): force https, strip query, strip fragment, strip a single trailing slash.

## 3. Binding architecture decisions

### 3.1 Monorepo with a single shared core

One repo, one `packages/injector-core`, thin per-platform adapters.

Rationale: **one core = one source of truth, one CI, one conformance suite.** Every fail-open rule, cache behavior, and API-contract detail is implemented and tested exactly once. Heterogeneity exists only in the **built artifacts** (worker bundle, Lambda zip, container image) — never in the logic. An adapter that needs logic the core lacks contributes it to the core.

### 3.2 TypeScript for core and all current adapters

Rationale: CloudFront **Lambda@Edge supports only Node.js and Python** runtimes — Go is impossible there. TypeScript is the single language that natively covers Cloudflare Workers, Lambda@Edge, and a Node sidecar, so it maximizes code sharing through the core. A Go sidecar (`adapter-sidecar-go`) is reserved as a deliberate **later second distribution** (single static binary for customers who won't run Node/containers), not as a replacement for the core.

### 3.3 Depth-first: core + Cloudflare adapter first

Build the core to production quality with one reference adapter (Cloudflare Workers) before spreading breadth-wise to Lambda@Edge and the sidecar. The reference adapter proves the core's API is sufficient; subsequent adapters are then mechanical.

### 3.4 URL, not hash — correctness principle

The connector always sends the raw URL; the server owns normalization and hashing. The mirrored `normalizeLite` (4 rules, §2) is used **only** for local cache keys. Consequence: **local drift costs only cache efficiency, never correctness.** If the server's normalization evolves, the worst case is a redundant cache entry or an extra revalidation — never a wrong or missing injection.

### 3.5 Fail-open everywhere

Any error, timeout, missing `</head>`, non-HTML content type, or non-2xx origin status → serve the original response untouched. Every Enhancely call runs under `AbortSignal.timeout` (default 800 ms). After a `429` or an error the core stores a short retry-backoff memo in its cache (`Retry-After` capped at 60 s; 10 s for plain errors), so consecutive page views serve stale/nothing locally instead of re-hitting a rate-limited or down API and paying the timeout each time. The connector must never be the reason a customer page breaks or slows down materially; missing structured data on one view is an acceptable cost, a broken page is not.

## 4. Target → artifact → install

| Target                 | Artifact                                                          | Install / operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cloudflare Workers** | Bundled `worker.js` via wrangler                                  | `wrangler deploy`; API key as a Worker secret; KV or Cache API for the JSON-LD cache; route on the customer zone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **CloudFront**         | Lambda@Edge function (us-east-1), attached to **origin-response** | No environment variables at the edge → key baked at deploy time or via SSM Parameter Store (implemented, in that fallback order, memoized per execution environment, SSM call bounded by AbortSignal.timeout). Origin-response triggers cannot read the origin body → the function **re-fetches the page from the origin** and replaces the body (within CloudFront's 1 MB generated-response quota — headers **and** body; the adapter reserves 16 KB header headroom and fails open above the cap) — one extra origin roundtrip per CloudFront cache miss; CloudFront then caches the injected page. |
| **Sidecar**            | Container image now; Go static binary later                       | Runs next to the origin; nginx `proxy_pass` / apache `ProxyPass` points at the sidecar, which proxies the origin and injects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 5. Future option: Proxy-Wasm for the Envoy family

A Rust→Wasm build of the injector (Proxy-Wasm ABI) would slot into Envoy, Nginx-with-Wasm, Kong, and APISIX with a single artifact.

- It is a **portability play only**: one more artifact family, not a new core. It does **not** cover Lambda@Edge (Node/Python only) or classic Apache.
- Explicitly: **Wasm is a portability win, not a performance win.** The workload is I/O-bound (one upstream fetch, one string splice). The speed levers are cache-hit ratio, ETag revalidation, and prefetch — not the execution language. Do not justify a Wasm build on latency grounds.
