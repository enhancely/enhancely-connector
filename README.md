# enhancely-connector

Edge/server-side connector that injects Enhancely JSON-LD into customer HTML responses — the delivery layer for [Enhancely](https://enhancely.ai), comparable to how prerender.io or redirection.io sit in front of a site.

On every HTML page view, the connector asks the Enhancely API for the page's JSON-LD and injects it as

```html
<script type="application/ld+json">
  …
</script>
```

immediately before `</head>`. If anything goes wrong — timeout, missing record, rate limit, non-HTML response, no `</head>` — the connector **fails open** and serves the original HTML untouched. The customer's site is never at risk. After an API error or `429`, the connector additionally remembers a short backoff (`Retry-After`, capped at 60 s; 10 s for plain errors) so page views don't repeatedly re-hit — or wait out the timeout of — a rate-limited or down API.

## Packages

| Package                                                           | Status                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/injector-core` (`@enhancely/injector-core`)             | **Implemented + tested.** Shared core: API client, cache + ETag revalidation, HTML injection, fail-open orchestration.                                                                                                                                                                                                                                                     |
| `packages/adapter-cloudflare` (`@enhancely/adapter-cloudflare`)   | **Reference adapter.** Cloudflare Worker wrapping the core.                                                                                                                                                                                                                                                                                                                |
| `packages/adapter-lambda-edge` (`@enhancely/adapter-lambda-edge`) | **Implemented + tested.** CloudFront Lambda@Edge, two entrypoints sharing one core. **`origin-request` (recommended)** generates the response: one origin hit, no cross-response reconciliation, and it also injects pages that set cookies. `origin-response` keeps the re-fetch pattern (two origin hits, metadata must match across both). Key via baked config or SSM. |
| `packages/adapter-sidecar` (`@enhancely/adapter-sidecar`)         | **Functional skeleton.** Node HTTP reverse proxy for nginx/apache setups.                                                                                                                                                                                                                                                                                                  |
| `packages/adapter-sidecar-go`                                     | **Reserved.** Planned Go single-binary distribution of the sidecar.                                                                                                                                                                                                                                                                                                        |

All adapters are thin wrappers — connector logic lives exclusively in `injector-core`.

## Quickstart

Requires Node 22.22.0 (`.nvmrc`) and pnpm (pinned via `packageManager` in `package.json`).

```bash
pnpm install
pnpm -r build
pnpm -r test
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

| Setting                     | Default                    | Notes                                                                                                                      |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ENHANCELY_API_KEY`         | — (required)               | `sk-…` or `sk-org-…`. Server-side only, never reaches the browser.                                                         |
| `ENHANCELY_BASE`            | `https://app.enhancely.ai` | **TODO: confirm** final production API base URL.                                                                           |
| `timeoutMs`                 | `800`                      | `AbortSignal.timeout` applied to every Enhancely API call.                                                                 |
| `cacheTtlMs`                | `300000` (5 min)           | Connector-side cache TTL; configurable. ETag revalidation after expiry.                                                    |
| `maxJsonLdBytes`            | `262144` (256 KiB)         | Streamed response limit; may be lowered but not raised.                                                                    |
| `autoRegister`              | `false`                    | Register unknown pages after a 404; adapters still fail open.                                                              |
| `excludePaths`              | `[]`                       | Lambda@Edge-only path exclusions, checked before config/API work.                                                          |
| `assertedDefaultTtlSeconds` | `0` (off)                  | `origin-response` trigger only — asserted minimum DefaultTTL for bounded retry caching. Has no effect on `origin-request`. |

Lambda@Edge path exclusions use CloudFront-style `*`/`?` patterns. Before
matching, the raw path is canonicalized once: RFC 3986 unreserved escapes are
decoded, literal backslashes become `/`, and duplicate slashes/dot-segments
collapse. Reserved, non-ASCII, malformed, and double-encoded octets stay
literal, so configure patterns in canonical literal form. A response carrying
`X-Robots-Tag: noindex` or `none` is never injected; the same veto is applied
to the identity re-fetch that supplies the replacement body.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — commands, rules, and the Enhancely API contract.
- [`docs/architecture/2026-07-27-connector-architecture.md`](docs/architecture/2026-07-27-connector-architecture.md) — full architecture writeup and binding decisions.

## Terraform module (recommended for CloudFront customers)

New integrations should use the reusable module instead of vendoring files —
see [`infra/modules/lambda-edge-injector/`](infra/modules/lambda-edge-injector/):

```hcl
module "enhancely_injector" {
  source    = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=v0.6.1"
  providers = { aws = aws.us_east_1 }
  auto_register = true
}
```

Upgrades are a `?ref=` bump. Environments without egress to GitHub can fall
back to vendoring the release assets below.

> The module currently wires the **`origin-response`** trigger only. For the
> recommended `origin-request` trigger, vendor
> `lambda-edge-origin-request-index.js` and set `EventType = "origin-request"`
> yourself until the module gains a trigger option.

## Consuming releases (for integrators)

Every tag `vX.Y.Z` publishes a [GitHub Release](https://github.com/enhancely/enhancely-connector/releases) with versioned, checksummed artifacts:

| Asset                                   | Purpose                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lambda-edge-origin-request-index.js`   | **Recommended.** Self-contained Lambda@Edge bundle for the `origin-request` trigger (CommonJS, Node 20). One origin hit per injected cache miss, and it also injects pages that set cookies. |
| `lambda-edge-origin-request-bundle.zip` | The same bundle pre-zipped, as `index.js` (no config inside).                                                                                                                                |
| `lambda-edge-index.js`                  | Bundle for the `origin-response` trigger (origin re-fetch pattern). Two origin hits per injected cache miss; skips pages that set cookies.                                                   |
| `lambda-edge-bundle.zip`                | The same bundle pre-zipped (no config inside).                                                                                                                                               |
| `SHA256SUMS`                            | Checksums for all assets — verify after download.                                                                                                                                            |

Both bundles expose `index.handler`; the CloudFront `EventType` (and the zip you
deploy) is what selects the trigger. See
[`packages/adapter-lambda-edge/README.md`](packages/adapter-lambda-edge/README.md#which-trigger)
for the trade-off.

Recommended vendoring flow (Terraform, for reproducible deployments):

```bash
VERSION=v0.6.1
curl -fsSLO "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/lambda-edge-index.js"
curl -fsSL  "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/SHA256SUMS" | sha256sum -c --ignore-missing
# commit index.js into your infra repo; note ${VERSION} in the commit message
```

Terraform picks up the new file via `source_code_hash`, publishes a new Lambda
version and rolls the CloudFront association automatically. Updating the
connector is therefore: download new version -> verify checksum -> commit -> MR.
