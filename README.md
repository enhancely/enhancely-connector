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

| Package                                                           | Status                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/injector-core` (`@enhancely/injector-core`)             | **Implemented + tested.** Shared core: API client, cache + ETag revalidation, HTML injection, fail-open orchestration.                                                                                                                                                                                                |
| `packages/adapter-cloudflare` (`@enhancely/adapter-cloudflare`)   | **Reference adapter.** Cloudflare Worker wrapping the core.                                                                                                                                                                                                                                                           |
| `packages/adapter-lambda-edge` (`@enhancely/adapter-lambda-edge`) | **Implemented + tested.** CloudFront Lambda@Edge (origin-response) adapter — cannot read the origin body, so it re-fetches the page from the origin (one extra roundtrip per CloudFront cache miss), synchronizes replacement metadata, and fails open on CloudFront body/header quotas; key via baked config or SSM. |
| `packages/adapter-sidecar` (`@enhancely/adapter-sidecar`)         | **Functional skeleton.** Node HTTP reverse proxy for nginx/apache setups.                                                                                                                                                                                                                                             |
| `packages/adapter-sidecar-go`                                     | **Reserved.** Planned Go single-binary distribution of the sidecar.                                                                                                                                                                                                                                                   |

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

| Setting             | Default                    | Notes                                                                   |
| ------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `ENHANCELY_API_KEY` | — (required)               | `sk-…` or `sk-org-…`. Server-side only, never reaches the browser.      |
| `ENHANCELY_BASE`    | `https://app.enhancely.ai` | **TODO: confirm** final production API base URL.                        |
| `timeoutMs`         | `800`                      | `AbortSignal.timeout` applied to every Enhancely API call.              |
| `cacheTtlMs`        | `300000` (5 min)           | Connector-side cache TTL; configurable. ETag revalidation after expiry. |
| `maxJsonLdBytes`    | `262144` (256 KiB)         | Streamed response limit; may be lowered but not raised.                 |
| `autoRegister`      | `false`                    | Register unknown pages after a 404; adapters still fail open.           |

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — commands, rules, and the Enhancely API contract.
- [`docs/architecture/2026-07-27-connector-architecture.md`](docs/architecture/2026-07-27-connector-architecture.md) — full architecture writeup and binding decisions.

## Terraform module (recommended for CloudFront customers)

New integrations should use the reusable module instead of vendoring files —
see [`infra/modules/lambda-edge-injector/`](infra/modules/lambda-edge-injector/):

```hcl
module "enhancely_injector" {
  source    = "git::https://github.com/enhancely/enhancely-connector.git//infra/modules/lambda-edge-injector?ref=v0.5.1"
  providers = { aws = aws.us_east_1 }
  auto_register = true
}
```

Upgrades are a `?ref=` bump. Environments without egress to GitHub can fall
back to vendoring the release assets below.

## Consuming releases (for integrators)

Every tag `vX.Y.Z` publishes a [GitHub Release](https://github.com/enhancely/enhancely-connector/releases) with versioned, checksummed artifacts:

| Asset                    | Purpose                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lambda-edge-index.js`   | Self-contained Lambda@Edge bundle (CommonJS, Node 20). Vendor it next to your Terraform and zip it together with your deploy-specific `connector-config.json`. |
| `lambda-edge-bundle.zip` | The same bundle pre-zipped (no config inside).                                                                                                                 |
| `SHA256SUMS`             | Checksums for both assets — verify after download.                                                                                                             |

Recommended vendoring flow (Terraform, as used in the KWS pilot):

```bash
VERSION=v0.1.0
curl -fsSLO "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/lambda-edge-index.js"
curl -fsSL  "https://github.com/enhancely/enhancely-connector/releases/download/${VERSION}/SHA256SUMS" | sha256sum -c --ignore-missing
# commit index.js into your infra repo; note ${VERSION} in the commit message
```

Terraform picks up the new file via `source_code_hash`, publishes a new Lambda
version and rolls the CloudFront association automatically. Updating the
connector is therefore: download new version -> verify checksum -> commit -> MR.
