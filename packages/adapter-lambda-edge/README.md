# @enhancely/adapter-lambda-edge

CloudFront **Lambda@Edge** adapter for the Enhancely JSON-LD injector.

> **Status: honest stub.** The handler currently returns the origin response
> **unchanged** (safe to deploy, does nothing). The intended flow is documented
> as a TODO block in [`src/index.ts`](src/index.ts). All real logic will come
> from `@enhancely/injector-core` — this adapter only translates CloudFront
> event shapes.

## Platform constraints (read before implementing/deploying)

### Runtime: Node.js or Python only — hence TypeScript, no Go

Lambda@Edge supports **only the Node.js and Python runtimes** (no Go, no
custom runtimes, no container images). That is why this adapter is
TypeScript and why a Go build of the connector can never target
Lambda@Edge — see `packages/adapter-sidecar-go` for where Go fits instead.

### Deployment region: us-east-1

Lambda@Edge functions **must be created/published in `us-east-1`**
(N. Virginia). CloudFront replicates the published version to edge locations
globally; you still deploy and version it in us-east-1 only.

### Trigger: origin-response

Attach the function to the CloudFront behavior as an **origin-response**
trigger. That is the only event where we can read the origin's HTML body,
modify it, and let CloudFront cache the modified result.

### CRITICAL STOLPERSTEIN: no environment variables

**Lambda@Edge supports NO environment variables.** `process.env` is empty at
the edge, so the usual `ENHANCELY_API_KEY=sk-…` pattern does not work. Two
viable options:

| Option                                                             | How                                                                                                                                                               | Trade-offs                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Config file baked in at deploy time**                         | CI writes `config.json` (API key + base URL) next to the handler before `zip`/publish; the handler `import`s it.                                                  | Simple, zero runtime latency, no extra IAM. But the key is embedded in every function version (visible to anyone who can download the function code), and rotating the key requires a redeploy + republish + CloudFront propagation.                                                                                |
| **2. Fetch at runtime from SSM Parameter Store / Secrets Manager** | On cold start, the handler calls SSM/Secrets Manager in `us-east-1`, then caches the key **in module scope** (the execution context survives across invocations). | Key rotation without redeploy; key never sits in the bundle. But: adds cold-start latency (one AWS API call, do it lazily and cache), needs IAM permissions on the function's execution role, and the call itself must respect the fail-open rule (SSM unreachable → serve HTML uninjected, retry next cold start). |

Either way the key stays server-side — it must never appear in anything sent
to the browser (non-negotiable rule #1 of this repo).

### Body size limits: 1 MB, larger responses pass through

For **origin-response** triggers, Lambda@Edge exposes the response body to
the function only up to **1 MB**. Consequences:

- HTML pages ≤ 1 MB can be buffered, modified, and returned.
- Responses **larger than 1 MB pass through unmodified** — CloudFront does
  not hand the body to the function (or truncates access to it), so the
  adapter must detect this and fail open rather than emit a corrupted page.
- The modified response we return is also subject to the same 1 MB
  generated-response limit; injecting a JSON-LD snippet into a page already
  at the limit can push it over — the implementation must check the final
  size and fall back to the original body if exceeded.

### Compressed origin bodies

If the origin serves `Content-Encoding: gzip/br`, the function sees
compressed bytes. This adapter will **not** decompress — such responses pass
through untouched (fail-open). Recommended setup: origin serves identity
encoding to CloudFront and CloudFront's own compression handles the viewer
leg.

## Intended usage (once implemented)

```ts
// bundled entry point, published as a Lambda@Edge function in us-east-1
export { handler } from '@enhancely/adapter-lambda-edge';
```

Deploy: bundle (esbuild), zip, `aws lambda publish-version --region us-east-1`,
attach the published version ARN to the CloudFront behavior's
origin-response event. Remember: Lambda@Edge triggers require a **published
version**, never `$LATEST`.

## Development

```bash
pnpm --filter @enhancely/adapter-lambda-edge typecheck
pnpm --filter @enhancely/adapter-lambda-edge build
```

There are no tests yet (`pnpm test` says so honestly).
