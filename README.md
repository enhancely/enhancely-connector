# enhancely-connector

Edge/server-side connector that injects Enhancely JSON-LD into customer HTML responses — the delivery layer for [Enhancely](https://enhancely.ai), comparable to how prerender.io or redirection.io sit in front of a site.

On an eligible HTML cache miss, the connector resolves the page's JSON-LD from
its own cache or the Enhancely API and injects it as

```html
<script type="application/ld+json" data-source="Enhancely.ai" data-etag="8f0c…">
  …
</script>
```

immediately before `</head>`. If anything goes wrong — timeout, missing record,
rate limit, non-HTML response, `Cache-Control: no-transform`, a valid non-`inline`
`Content-Disposition`, or no parser-safe document-head close — the connector **fails
open** and serves the original HTML untouched. The shared scanner accounts for
HTML's scripting-dependent head-level `noscript` rules rather than trusting a
later lexical `</head>`. Ambiguous duplicate media types, unbalanced HTTP
quoted strings, and malformed separators that still expose an explicit
`no-transform`, `noindex`, or `none` directive also fail locally before any
Enhancely call. On Cloudflare, where Fetch folds field instances before exposing
them, any comma inside a quoted gate value is conservatively ambiguous and also
skips injection. The customer's site is never at risk. A plain API
error creates a URL-local 10-second backoff. A `429` follows `Retry-After`
(delay-seconds or HTTP-date), falling back to `RateLimit-Reset` when needed.
Only HTTP `429` additionally opens
an execution-environment-local circuit for the same Enhancely base/API key:
other URLs serve stale data or a bounded miss locally for at most 60 seconds.
Register-or-revalidate may retain a longer URL-local `429` or `403` `Retry-After`
backoff for up to 24 hours; a registration-limit `403` never suppresses reads
or registrations for other URLs.
When separate GET and register lookups race for one URL, a newly successful
`200`/`304`/`412` wins over retry-only state. A successful `404` may retire a
stale positive while inheriting the longest concurrent retry deadline; racing
transient results retain stale positive data and that longest deadline. Thus a
day-scale `Retry-After` cannot be shortened to the normal cache TTL.
The in-process cache is bounded by entry count and a conservative 16 MiB
retained-string budget, so large valid JSON-LD records cannot exhaust an edge
runtime before fail-open handling can run.

For the default Lambda origin-first adapter, a proven DNS/TCP/TLS setup failure
opens a bounded 10-second endpoint circuit. Resets, timeouts, malformed
responses, and unknown errors after the connection is ready are memoized only
for the exact origin request, so a single failing path cannot suppress
injection on healthy pages while repeated failures still avoid a wasted fetch.

The query-stripped normalized page URL is both the cache key and the exact URL
sent to Enhancely. The API boundary accepts only absolute HTTP(S) URLs without
credentials whose normalized form is stable when normalization runs again.
Normalization forces `https`, drops query and fragment, collapses runs of `/`
inside the path, and strips one trailing slash — so a CMS-emitted
`//section/page.html` addresses the same record and the same cache entry as
`/section/page.html`. A URL whose normalized form would still change on a
second pass passes through locally without a cache read or Enhancely request
instead of risking a mismatched record.

## Packages

| Package                                                           | Status                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/injector-core` (`@enhancely/injector-core`)             | **Implemented + tested.** Shared core: strict URL boundary, single-flight cache + ETag revalidation, API-key-wide rate-limit circuit, structural HTML preflight, API client, injection, and fail-open orchestration.                                                                                                                                                                                          |
| `packages/adapter-cloudflare` (`@enhancely/adapter-cloudflare`)   | **Reference adapter.** Cloudflare Worker wrapping the core.                                                                                                                                                                                                                                                                                                                                                   |
| `packages/adapter-lambda-edge` (`@enhancely/adapter-lambda-edge`) | **Implemented + tested.** CloudFront Lambda@Edge with one supported pairing: the `origin-request` injector fetches the origin once, proves exact-200 injectable HTML before Enhancely, and generates the response; safe vetoes are reproduced from that same fetch. The `origin-response` companion is cache-cap-only: it never calls Enhancely, injects, or fetches the origin. Key via baked config or SSM. |
| `packages/adapter-sidecar` (`@enhancely/adapter-sidecar`)         | **Functional skeleton.** Node HTTP reverse proxy for nginx/apache setups.                                                                                                                                                                                                                                                                                                                                     |
| `packages/adapter-sidecar-go`                                     | **Reserved.** Planned Go single-binary distribution of the sidecar.                                                                                                                                                                                                                                                                                                                                           |

All adapters are thin wrappers — connector logic lives exclusively in `injector-core`.

## Quickstart

Requires Node 22.22.0 (`.nvmrc`) and pnpm (pinned via `packageManager` in `package.json`).

```bash
pnpm install
pnpm -r build
pnpm -r test

# Which CloudFront path patterns keep the injector off asset traffic?
pnpm asset-paths https://www.example.com/ [more urls…]
```

Run the Cloudflare reference adapter locally:

```bash
# packages/adapter-cloudflare/.dev.vars
ENHANCELY_API_KEY=sk-…
```

```bash
pnpm --filter @enhancely/adapter-cloudflare dev   # wrangler dev
```

The API key is a secret — it must never be exposed client-side or committed. `.dev.vars` is gitignored.

## Configuration

| Setting                     | Default                    | Notes                                                                                                                                                                                                      |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENHANCELY_API_KEY`         | — (required)               | `sk-…` or `sk-org-…`. Server-side only, never reaches the browser.                                                                                                                                         |
| `ENHANCELY_BASE`            | `https://app.enhancely.ai` | The [official Enhancely API endpoint definitions](https://docs.enhancely.ai/) list `https://app.enhancely.ai/api/v1/jsonld`; override only for an explicitly selected environment.                         |
| `timeoutMs`                 | `800`                      | `AbortSignal.timeout` applied to every Enhancely API call. Its effective sum with `originTimeoutMs` must be ≤ 6000 ms in the Lambda module.                                                                |
| `originTimeoutMs`           | `2000`                     | Lambda@Edge-only direct origin-fetch timeout. Together with `timeoutMs`, limited to 6000 ms by the Terraform module.                                                                                       |
| `ssmTimeoutMs`              | `2000`                     | Lambda@Edge-only SSM config timeout. The module's API + origin + SSM budget is at most 8000 ms under Lambda's fixed 10-second limit, leaving at least 2000 ms for fail-open settlement.                    |
| `cacheTtlMs`                | `300000` (5 min)           | Connector-side cache TTL; configurable. ETag revalidation after expiry.                                                                                                                                    |
| `maxJsonLdBytes`            | `262144` (256 KiB)         | Streamed response limit; may be lowered but not raised.                                                                                                                                                    |
| `autoRegister`              | `false`                    | `false`: one read-only conditional GET. `true`: exactly one direct register-or-revalidate POST for lookup or registration. There is no GET→404→POST fallback.                                              |
| `excludePaths`              | `[]`                       | Lambda@Edge-only path exclusions, checked before config/API work.                                                                                                                                          |
| `includeHosts`              | `[]`                       | Lambda@Edge-only exact public-host selector (TF: `include_hosts`). A non-matching host skips SSM, connector-origin fetch, Enhancely, registration, and companion cache rewriting. Empty enables all hosts. |
| `assertedDefaultTtlSeconds` | `0` (off)                  | Asserted minimum DefaultTTL for bounded retry caching. Applied by origin-request-generated misses and the companion's safe handback cap.                                                                   |
| `nonPageMemoTtlMs`          | `1800000` (30 min)         | origin-request only: how long a hard-veto verdict is remembered, so repeats skip its classification fetch.                                                                                                 |
| `capSetCookieResponses`     | `false`                    | Lambda pair-wide: extend the retry cap to `Set-Cookie` responses (credential-less requests only). Never enable on origins minting session cookies for anonymous requests.                                  |

The companion checks credential, per-request-cache, Set-Cookie-policy,
cache-field, and available-lifetime vetoes before resolving config. A response
that cannot be capped therefore performs no SSM request.

Lambda@Edge path exclusions use CloudFront-style `*`/`?` patterns. Before
matching, the raw path is canonicalized once: RFC 3986 unreserved escapes are
decoded, literal backslashes become `/`, and duplicate slashes/dot-segments
collapse. Reserved, non-ASCII, malformed, and double-encoded octets stay
literal, so configure patterns in canonical literal form. A response carrying
`X-Robots-Tag: noindex` or `none` is never injected.

`includeHosts` accepts exact hostnames only: no wildcard, scheme, path,
credentials, or port. Matching is case-insensitive after IDNA/Punycode
canonicalization; a final DNS dot remains a distinct record identity. An
explicitly supplied malformed hand-written policy value matches nothing rather
than widening to every host. The filter prevents downstream connector work,
but it cannot prevent the already-associated Lambda@Edge invocation itself;
use narrower cache behaviors or separate distributions when invocation cost
must also be avoided. This filter runs only on CloudFront cache misses. If
multiple aliases share a distribution/behavior, the viewer `Host` must
therefore also be in that behavior's **cache policy** (not only its origin
request policy), or the aliases must use separate distributions. Otherwise a
cached object can be reused across aliases without invoking either Lambda.

## Documentation

- [`docs/architecture/current-runtime-architecture.md`](docs/architecture/current-runtime-architecture.md) — kundenneutrale Referenz für den aktuellen Laufzeitfluss, Request-Zahlen, Cache-Ebenen und Mermaid-Diagramme.
- [`CLAUDE.md`](CLAUDE.md) — commands, rules, and the Enhancely API contract.
- [`docs/architecture/2026-07-27-connector-architecture.md`](docs/architecture/2026-07-27-connector-architecture.md) — full architecture writeup and binding decisions.

## Terraform module (recommended for CloudFront customers)

New integrations should use the reusable module instead of vendoring files —
see [`infra/modules/lambda-edge-injector/`](infra/modules/lambda-edge-injector/):

```hcl
module "enhancely_injector" {
  source        = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=vX.Y.Z"
  providers     = { aws = aws.us_east_1 }
  auto_register = true
  include_hosts = ["www.example.com"]
  host_in_cache_key_asserted = true # after checking the behavior's cache policy
}
```

The module creates the only supported pair: an `origin-request` injector and its
non-injecting `origin-response` companion. Attach both to the same cache
behavior through the pairing-safe output:

```hcl
# Inside a terraform-aws-modules/cloudfront cache-behavior object:
lambda_function_association = module.enhancely_injector.lambda_function_associations
```

Version 0.10.0 deliberately removes the unused standalone origin-response
injector. See the [module README](infra/modules/lambda-edge-injector/README.md)
for plain Terraform wiring and the complete pairing contract.

Upgrades are a `?ref=` bump. Environments without egress to GitHub can fall
back to vendoring the release assets below.

## Consuming releases (for integrators)

Every tag `vX.Y.Z` publishes a [GitHub Release](https://github.com/enhancely/enhancely-connector/releases) with versioned, checksummed artifacts:

| Asset                                   | Purpose                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lambda-edge-origin-request-index.js`   | Self-contained Lambda@Edge injector for the `origin-request` trigger (CommonJS, Node 22). One origin hit per injected cache miss, and it also injects pages that set cookies.                                                   |
| `lambda-edge-origin-request-bundle.zip` | The same bundle pre-zipped, as `index.js` (no config inside).                                                                                                                                                                   |
| `lambda-edge-companion-index.js`        | Cache-cap-only companion for the `origin-request` trigger: associate on **origin-response of the SAME behavior**. It safely bounds eligible handback cache lifetimes and never calls Enhancely, injects, or fetches the origin. |
| `lambda-edge-companion-bundle.zip`      | The same companion bundle pre-zipped, as `index.js` (no config inside).                                                                                                                                                         |
| `SHA256SUMS`                            | Checksums for all assets — verify after download.                                                                                                                                                                               |

Every bundle exposes `index.handler`; the CloudFront `EventType` (and the zip you
deploy) is what selects the trigger. See
[`packages/adapter-lambda-edge/README.md`](packages/adapter-lambda-edge/README.md#runtime-architecture)
for the deployment contract.

Recommended manual vendoring flow when the reusable module cannot be consumed
directly:

```bash
VERSION=vX.Y.Z
curl -fsSLO "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/lambda-edge-origin-request-index.js"
curl -fsSLO "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/lambda-edge-companion-index.js"
curl -fsSL  "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/SHA256SUMS" | sha256sum -c --ignore-missing
# commit both files and associate origin-request + origin-response companion
```

Terraform picks up the new file via `source_code_hash`, publishes a new Lambda
version and rolls the CloudFront association automatically. Updating the
connector is therefore: download new version -> verify checksum -> commit -> MR.
