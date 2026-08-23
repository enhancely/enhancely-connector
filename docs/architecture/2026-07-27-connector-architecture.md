# Enhancely Connector — Architecture

Date: 2026-07-27

Status: BINDING — decisions below are settled unless explicitly revisited.

The detailed current request flow, Mermaid diagrams, request counts, and every
cache/retry duration are maintained in
[`current-runtime-architecture.md`](current-runtime-architecture.md). This file
records the binding architecture decisions.

## 1. Context

Enhancely stores JSON-LD for page URLs. This repository supplies the delivery
layer: a connector in the server/edge HTTP path fetches the JSON-LD and injects
it immediately before a parser-safe `</head>`. The API key stays server-side.
If any prerequisite is uncertain, the connector serves the original response.

## 2. API contract

- Read-only lookup: `GET {ENHANCELY_BASE}/api/v1/jsonld/{segment}`.
- Register-or-revalidate: `POST {ENHANCELY_BASE}/api/v1/jsonld { url }`.
- `getJsonLdLookup` is always read-only GET. `autoRegister` uses one direct
  register-or-revalidate POST. There is no GET→404→POST fallback and no separate
  `registerJsonLd` API.
- The wire URL and logical cache key are the same query-stripped,
  normalization-stable `normalizeLite(url)`. The server remains authoritative
  for hashing.
- Authentication is `Authorization: Bearer <sk-… | sk-org-…>`.
- `Accept: application/ld+json` must be exact.
- A successful body is already script-safe JSON-LD and is inserted verbatim;
  never parse, serialize, or re-escape it.
- The API sets `Cache-Control: no-store`; the connector owns its cache and uses
  ETag conditional revalidation.
- `429` uses `Retry-After`, falling back to `RateLimit-Reset`, and is the only
  status that opens the shared API-key circuit. A registration `403` is
  URL-local and must never suppress other URLs.

The production default is `https://app.enhancely.ai`.

## 3. One core, thin adapters

`packages/injector-core` is the single source of truth for:

- strict URL handling;
- cache, ETag revalidation, single-flight, and write ordering;
- API calls and rate-limit circuits;
- HTML structural preflight and injection;
- fail-open orchestration.

Cloudflare, Lambda@Edge, and the Node sidecar translate platform request and
response shapes only. Shared behavior must move into core rather than being
copied across adapters.

TypeScript is the common implementation language because it covers all current
targets, including Lambda@Edge's Node runtime. A possible Go sidecar remains a
separate future distribution, not a rewrite of core.

## 4. Fail-open contract

Injection requires exact status `200`, exactly one unambiguous `text/html`
media type, a safe charset, no blocking robots/transform/disposition metadata,
a parser-safe head close, and sufficient platform body/header quota.

Malformed or duplicate singleton headers, unexpected encodings, timeouts,
oversized bodies, missing records, and every internal error leave the original
response untouched. JSON-LD is streamed under a 256 KiB hard ceiling. The
default Enhancely timeout is 800 ms.

The query-stripped normalized URL is accepted at the network boundary only if
it is an absolute HTTP(S) URL without credentials and normalization is a fixed
point. Multi-trailing-slash inputs that violate that rule fail locally before
cache or network access.

## 5. CloudFront binding architecture

CloudFront has exactly one supported deployment shape:

| Event             | Function                 | Network work                                                                                                             |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `origin-request`  | Injector                 | Fetches the Custom Origin once; after a proven injectable response, performs zero or at most one Enhancely request.      |
| `origin-response` | Cache-cap-only companion | Never fetches origin or Enhancely and never injects; it can only shorten an eligible handback response's cache lifetime. |

Both functions must be associated with the same cache behavior. A generated
origin-request response does not invoke origin-response, so normal injected and
safely reproducible responses cost one origin fetch. Only a hard handback lets
CloudFront fetch the origin and subsequently invoke the companion.

Version 0.10.0 deliberately removes the unused standalone origin-response
injector, its double-origin-fetch path, deployment mode switch, compatibility
output, tests, and artifacts. The only release assets are the injector and
companion JavaScript/ZIP pairs plus `SHA256SUMS`.

The direct fetch requires an externally reachable Custom Origin. S3 REST/OAC,
private VPC, signature-protected, and otherwise inaccessible origins cannot be
injected. Origin Group, Shield, and CloudFront retry semantics do not wrap the
Lambda's direct fetch.

### Host and query prerequisites

Lambda `includeHosts` / Terraform `include_hosts` is an exact public DNS-host
selector. It runs before SSM, direct origin fetch, Enhancely, registration, and
companion cache work. Empty means all hosts; malformed non-empty hand config
matches nothing.

When aliases share a behavior and host policy differs, viewer `Host` must be in
the CloudFront **cache policy**, or aliases must use separate distributions. An
origin request policy alone cannot partition cache hits. Terraform therefore
requires the explicit `host_in_cache_key_asserted = true` operator assertion
for a non-empty host list.

Every query string that changes the origin representation must be exposed
through the cache or origin request policy so the direct fetch can reproduce
the viewer request. The URL sent to Enhancely remains queryless.

Path-scoped behaviors without Lambda associations are the preferred way to
exclude assets and media. `excludePaths` and the extension gate avoid downstream
work but cannot avoid an invocation after CloudFront selects an associated
behavior.

### Request counts

Per CloudFront viewer request:

| Case                                                              | Origin responses |                    Enhancely requests |
| ----------------------------------------------------------------- | ---------------: | ------------------------------------: |
| Cache hit                                                         |                0 |                                     0 |
| Injectable HTML, fresh JSON-LD                                    |                1 |                                     0 |
| Injectable HTML, stale/missing JSON-LD                            |                1 |                             at most 1 |
| Reproducible redirect/error/non-HTML, no head, or safe local veto |                1 |                                     0 |
| Hard handback, first classification                               |                2 | 0 or at most 1 before a quota verdict |
| Hard handback while memoized                                      |                1 |                                     0 |

The companion contributes no network requests in every case.

## 6. Cache and concurrency decisions

The JSON-LD cache is separate from the page/CDN cache. Its default freshness is
5 minutes. Stale positives remain available for ETag revalidation and
stale-on-error behavior. The default in-process cache is bounded to 5,000
entries and a conservative 16 MiB retained-string estimate.

Concurrent cold/stale lookups for the same normalized URL, cache object, lookup
mode, and execution environment are single-flighted. GET and
register-or-revalidate remain distinct lookup modes. Local writes are serialized
so newer successful positive results cannot be overwritten by older transient
or negative results. A distributed backend must supply its own CAS semantics;
Workers KV is eventually consistent.

Workers KV and Cloudflare's memory fallback are scoped by Enhancely base/API-key
identity. Persisted keys contain only a non-secret SHA-256 scope, never the API
key itself.

Retry clocks are intentionally separate:

- normal API failure: 10 seconds URL-local;
- shared circuit: only `429`, at most 60 seconds;
- register `429`/`403`: URL-local hint up to 24 hours;
- Lambda origin failure circuits: 10 seconds;
- hard-handback memo: 30 minutes by default;
- missing Lambda config/SSM: 30 seconds.

The companion may shorten only a proven existing cache lifetime. With no
explicit safe lifetime and `assertedDefaultTtlSeconds = 0`, it changes nothing.
Credentialed, `private`, `no-store`, ambiguous, and unapproved `Set-Cookie`
responses are never rewritten.

## 7. Platform artifacts

| Target             | Artifact / deployment                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | Bundled Worker; secret key plus optional Workers KV.                                                  |
| CloudFront         | Lambda@Edge origin-request injector + origin-response companion in `us-east-1`, on the same behavior. |
| Node sidecar       | Reverse proxy process/container using the shared core.                                                |

The Terraform module is the preferred CloudFront installation. It emits one
pairing-safe association map and enforces the 10-second Lambda timeout budget.
Manual consumers must deploy both versioned functions and verify release
checksums.

## 8. Security invariants

- The API key never reaches the browser, response, or normal logs.
- The cache key and Enhancely wire URL are byte-identical.
- Queries and fragments never leave the connector toward Enhancely.
- Only exact `200 text/html` is injectable.
- JSON-LD remains verbatim script-safe data.
- Generated Lambda responses enforce the 32 KiB header and 1 MiB combined
  response limits and drop validators/digests describing the uninjected body.
- `X-Enhancely-Injected` is a never-touch-injected-content invariant.
- Any uncertainty produces under-injection, never a broken page or a wrong
  cached record.

## 9. Future option: Proxy-Wasm

A Rust-to-Wasm build could cover Envoy-family platforms. It is a portability
option only, not a performance argument and not a replacement for the shared
core. It does not cover Lambda@Edge.
