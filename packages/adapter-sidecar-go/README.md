# @enhancely/adapter-sidecar-go

Reserved slot for the planned **Go single-binary** distribution of the
Enhancely sidecar proxy.

> **Not implemented yet — there is no Go code here.**
> The TypeScript sidecar ([`../adapter-sidecar`](../adapter-sidecar)) is the
> current and only sidecar path. Go is a **deliberate later second
> distribution** for ops teams that prefer a single static binary (no Node.js
> runtime, `scratch`-based container images, trivial `scp`-and-run deploys) —
> it is not a rewrite of the core and not a sign the TS sidecar is going away.

## Why Go here, but TypeScript everywhere else

- `packages/injector-core` is the single source of truth for connector logic,
  and TypeScript is the one language that covers every edge target —
  CloudFront Lambda@Edge supports **only Node.js and Python**, so Go can never
  run there (see [`../adapter-lambda-edge`](../adapter-lambda-edge)).
- A sidecar has no such runtime constraint. Once the TS sidecar's behavior is
  settled and battle-tested, a small Go port of exactly that behavior (same
  API contract, same fail-open rules, same cache/ETag semantics) becomes a
  low-risk convenience for self-hosting customers.

## Planned scope (when it happens)

- Single static binary (`CGO_ENABLED=0`) for linux/amd64 + linux/arm64.
- Same environment variables and same behavior table as the TS sidecar —
  the TS README is the spec.
- Must uphold every non-negotiable repo rule: fail-open, own cache + ETag
  revalidation, URL (never a local hash) sent to the API, `text/html` + 2xx
  gate, hard request timeout.

Until then: use the TS sidecar.
